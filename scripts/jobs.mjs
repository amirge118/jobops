#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadJobsConfig, readCandidateContext } from './jobs/config.mjs';
import { syncConfiguredCompanyEntries } from './jobs/company-catalog.mjs';
import { deduplicateJobs, resumeGapInputHash } from './jobs/core.mjs';
import { createJobPageFetcher } from './jobs/fetch-page.mjs';
import { openJobUrls } from './jobs/open.mjs';
import { appendMatchingJobs } from './jobs/pipeline.mjs';
import { renderMinimalReport } from './jobs/report.mjs';
import { createResumeGapAnalyzer } from './jobs/resume-gap.mjs';
import { createGapCoverageChecker, refreshGapCoverage } from './jobs/gap-coverage.mjs';
import { createJobScorer } from './jobs/score-job.mjs';
import { checkCodexQuota, readCodexRateLimits, setCodexUsageRecorder } from './jobs/llm-usage.mjs';
import { createJobStore, sourceKindOf } from './jobs/store.mjs';
import { queueJobNotifications } from './jobs/notifications.mjs';
import { scanAts } from './jobs/sources/ats.mjs';
import { scanWhatsApp, scanWhatsAppBacklog } from './jobs/sources/whatsapp.mjs';
import { scanLinkedIn } from './jobs/sources/linkedin.mjs';
import { createRunLifecycle, describeFailure, hasFailureReason, safeTargetUrl } from './jobs/diagnostics.mjs';
import { acquireSingleInstance } from './jobs/single-instance.mjs';
import { NON_RETRYABLE_FAILURE_CODES } from './liveness-browser.mjs';
import { buildNegativeTitleFilter, buildTitleFilter, loadTitleFilterNegative, loadTitleFilterPositive } from './scan.mjs';

function numericFlag(argv, name, { max = Infinity } = {}) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = Number(argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0 || value > max) {
    throw new Error(`${name} requires a positive number${Number.isFinite(max) ? ` up to ${max}` : ''}`);
  }
  return value;
}

export function parseArgs(argv) {
  const daysIndex = argv.indexOf('--days');
  const days = daysIndex >= 0 ? Number(argv[daysIndex + 1]) : null;
  if (daysIndex >= 0 && (!Number.isFinite(days) || days <= 0)) {
    throw new Error('--days requires a positive number');
  }
  const onlyFlags = ['--ats-only', '--whatsapp-only', '--linkedin-only'].filter((flag) => argv.includes(flag));
  if (onlyFlags.length > 1) {
    throw new Error(`Use only one source-only flag, not ${onlyFlags.join(' and ')}`);
  }
  if (argv.includes('--retry-only') && onlyFlags.length) {
    throw new Error('--retry-only cannot be combined with source-only flags');
  }
  if (argv.includes('--whatsapp-backlog') && (onlyFlags.length || argv.includes('--retry-only'))) {
    throw new Error('--whatsapp-backlog cannot be combined with source-only or retry flags');
  }
  const linkedinHours = numericFlag(argv, '--linkedin-hours', { max: 24 * 14 });
  if (linkedinHours != null && ['--retry-only', '--whatsapp-backlog', '--ats-only', '--whatsapp-only'].some((flag) => argv.includes(flag))) {
    throw new Error('--linkedin-hours applies only to runs that include LinkedIn');
  }
  return {
    days,
    atsOnly: argv.includes('--ats-only'),
    whatsappOnly: argv.includes('--whatsapp-only'),
    linkedinOnly: argv.includes('--linkedin-only'),
    linkedinHours,
    waitForLockMinutes: numericFlag(argv, '--wait-for-lock', { max: 120 }),
    open: argv.includes('--open'),
    dryRun: argv.includes('--dry-run'),
    retryOnly: argv.includes('--retry-only'),
    whatsappBacklog: argv.includes('--whatsapp-backlog'),
  };
}

export function scanWindow({ config, store, requestedDays, sources = [], now = Date.now() }) {
  const maxDays = Number(config.scan.maxLookbackDays);
  const explicitDays = requestedDays == null ? null : Math.min(requestedDays, maxDays);
  const lastRun = store.getLastSuccessfulRun(sources);
  const overlapMs = Number(config.scan.overlapHours) * 60 * 60 * 1000;
  const defaultMs = Number(config.scan.defaultLookbackDays) * 24 * 60 * 60 * 1000;
  const from = explicitDays != null
    ? now - explicitDays * 24 * 60 * 60 * 1000
    : lastRun?.finished_at
      ? lastRun.finished_at - overlapMs
      : now - defaultMs;
  // The automatic window is capped too: otherwise one long-past gap keeps
  // every later run partial, so the window never closes and only grows.
  return { from: Math.max(from, now - maxDays * 24 * 60 * 60 * 1000), to: now };
}

function uniqueCandidates(candidates) {
  return [...new Map(candidates.map((candidate) => [candidate.jobKey, candidate])).values()];
}

const isLinkedInCandidate = (candidate) => String(candidate.source || '').startsWith('LinkedIn:');

// Pending LinkedIn postings are only read when LinkedIn is part of the run
// (or a retry while the source is enabled): a disabled source must not keep
// making requests to LinkedIn through the retry queue.
export function filterPendingCandidatesForSources(candidates, sources, { linkedinEnabled = sources.includes('linkedin') } = {}) {
  if (sources.includes('retry')) {
    return linkedinEnabled ? candidates : candidates.filter((candidate) => !isLinkedInCandidate(candidate));
  }
  const includeAll = sources.includes('ats') && sources.includes('whatsapp');
  return candidates.filter((candidate) => {
    const source = String(candidate.source || '');
    if (isLinkedInCandidate(candidate)) return sources.includes('linkedin');
    return includeAll ||
      (sources.includes('ats') && source.startsWith('ATS:')) ||
      ((sources.includes('whatsapp') || sources.includes('whatsapp-backlog')) && source.startsWith('WhatsApp:'));
  });
}

export function processingScope(candidate) {
  const source = String(candidate.source || '');
  if (source.startsWith('WhatsApp: ')) {
    return { source: 'whatsapp', name: source.slice('WhatsApp: '.length).trim() || 'WhatsApp' };
  }
  if (source.startsWith('LinkedIn: ')) {
    return { source: 'linkedin', name: source.slice('LinkedIn: '.length).trim() || 'LinkedIn' };
  }
  return { source: 'ats', name: 'ATS' };
}

export function summarizeProcessingResults(candidates, outcomes) {
  const scopes = new Map();
  const seen = new Set();

  for (const candidate of candidates) {
    const scope = processingScope(candidate);
    const sightingKey = `${scope.source}:${scope.name}:${candidate.jobKey}`;
    if (seen.has(sightingKey)) continue;
    seen.add(sightingKey);

    const scopeKey = `${scope.source}:${scope.name}`;
    const row = scopes.get(scopeKey) || {
      source: scope.source,
      name: scope.name,
      links: 0,
      processed: 0,
      suitable: 0,
      notSuitable: 0,
      failed: 0,
      alreadyProcessed: 0,
      filtered: 0,
      deferred: 0,
      failureReasons: {},
    };
    row.links += 1;

    const outcome = outcomes.get(candidate.jobKey);
    if (!outcome || outcome.status === 'failed') {
      row.failed += 1;
      const code = outcome?.code || 'unknown_failure';
      row.failureReasons[code] = Number(row.failureReasons[code] || 0) + 1;
    } else if (outcome.status === 'already-processed' || outcome.status === 'duplicate') {
      // A duplicate is the same company+role already known from another
      // link: no scoring tokens were spent on it.
      row.alreadyProcessed += 1;
    } else if (outcome.status === 'deferred') {
      // LinkedIn cooldown: not read on purpose, still pending — not a failure.
      row.deferred += 1;
    } else if (outcome.status === 'filtered') {
      // Screened locally by the negative-keyword filter, before ever
      // reaching Codex — kept out of `processed` so per-source cost
      // comparisons only count items that actually cost scoring tokens.
      row.filtered += 1;
    } else {
      row.processed += 1;
      if (outcome.status === 'suitable') row.suitable += 1;
      else row.notSuitable += 1;
    }
    scopes.set(scopeKey, row);
  }

  const rows = [...scopes.values()];
  const totals = rows.reduce((summary, row) => {
    for (const field of ['links', 'processed', 'suitable', 'notSuitable', 'failed', 'alreadyProcessed', 'filtered', 'deferred']) {
      summary[field] += row[field];
    }
    for (const [code, count] of Object.entries(row.failureReasons)) {
      summary.failureReasons[code] = Number(summary.failureReasons[code] || 0) + Number(count);
    }
    return summary;
  }, { links: 0, processed: 0, suitable: 0, notSuitable: 0, failed: 0, alreadyProcessed: 0, filtered: 0, deferred: 0, failureReasons: {} });

  return { totals, scopes: rows };
}

function summarizeLinkedIn(linkedin) {
  if (!linkedin) return null;
  const searches = (linkedin.searches || []).map((search) => ({
    id: search.id,
    label: search.label,
    status: search.status,
    reason: search.reason || null,
    endedBy: search.endedBy || null,
    capped: Boolean(search.capped),
    pages: Number(search.pages || 0),
    window: search.window || null,
    warning: search.warning || null,
    gap: search.gap || null,
    advanced: Boolean(search.advanced),
    found: Number(search.found || 0),
    new: Number(search.new || 0),
    known: Number(search.known || 0),
    filtered: Number(search.filtered || 0),
    stale: Number(search.stale || 0),
  }));
  return {
    candidates: linkedin.candidates?.length || 0,
    discovery: linkedin.discovery || null,
    requests: Number(linkedin.requests || 0),
    haltedBy: linkedin.haltedBy || null,
    failure: linkedin.failure || null,
    searches,
    coverageStatus: !linkedin.failure && searches.every((search) => search.status === 'complete') ? 'complete' : 'incomplete',
  };
}

// One durable row per collected source per run (store.recordSourceScanStats):
// the funnel from what a source found to what it cost to score and what fit.
export function sourceScanStatRows(details, secondsBySource = {}) {
  const processed = new Map();
  for (const scope of details.processing?.scopes || []) {
    const row = processed.get(scope.source) || { scored: 0, suitable: 0, failed: 0 };
    row.scored += Number(scope.processed || 0);
    row.suitable += Number(scope.suitable || 0);
    row.failed += Number(scope.failed || 0);
    processed.set(scope.source, row);
  }
  const rows = [];
  const push = (source, fields) => rows.push({
    source, seconds: secondsBySource[source], ...fields,
    ...(processed.get(source) || { scored: 0, suitable: 0, failed: 0 }),
  });
  if (details.ats) {
    push('ats', {
      found: details.ats.found, candidates: details.ats.candidates, errors: details.ats.errors,
      filteredTitle: details.ats.filtered?.title, filteredLocation: details.ats.filtered?.location,
      filteredRecency: details.ats.filtered?.recency,
    });
  }
  if (details.whatsapp) {
    push('whatsapp', { found: details.whatsapp.candidates, candidates: details.whatsapp.candidates, errors: 0 });
  }
  if (details.linkedin) {
    const searches = details.linkedin.searches || [];
    push('linkedin', {
      found: details.linkedin.discovery?.found ?? details.linkedin.candidates,
      candidates: details.linkedin.candidates,
      filteredTitle: searches.reduce((total, search) => total + Number(search.filtered || 0), 0),
      errors: searches.filter((search) => search.status === 'failed').length,
    });
  }
  return rows;
}

// When the history request comes back partial but the live collector has
// been connected to every group since before the window started, the live
// messages already reached the backlog (processed by the backlog run, which
// ignores the window). Partial history is then not missing coverage, and
// reporting the run as incomplete would only be noise.
export function liveCollectorSince(store) {
  const collector = store.getCollectorStatusSummary();
  const allGroups = Number(collector?.groups_expected || 0) > 0
    && Number(collector.groups_found || 0) === Number(collector.groups_expected);
  return collector?.status === 'connected' && allGroups ? Number(collector.started_at) : null;
}

export function summarizeSourceResults(sourceResults, { windowFrom = null, liveSince = null } = {}) {
  const ats = sourceResults.find((result) => result.source === 'ats');
  const linkedin = sourceResults.find((result) => result.source === 'linkedin');
  const whatsapp = sourceResults.find((result) => result.source === 'whatsapp');
  const groups = (whatsapp?.groups || []).map((group) => {
    const messages = Number(group.messages || 0);
    const fallbackCoverage = group.error ? 'failed' : messages > 0 ? 'partial' : 'unknown';
    return {
      name: group.name,
      found: Boolean(group.found),
      messages,
      failedMessages: Number(group.failedMessages || 0),
      candidates: Number(group.candidates || 0),
      coverage: {
        status: group.coverage?.status || fallbackCoverage,
        requestedFrom: group.coverage?.requestedFrom ?? null,
        oldestAt: group.coverage?.oldestAt ?? null,
        newestAt: group.coverage?.newestAt ?? null,
        delivered: Number(group.coverage?.delivered ?? messages),
        collected: Number(group.coverage?.collected ?? messages),
        batches: Number(group.coverage?.batches ?? 0),
        requestedUntil: group.coverage?.requestedUntil ?? null,
        anchorSource: group.coverage?.anchorSource || null,
        tailConfirmed: group.coverage?.tailConfirmed ?? null,
        reason: group.coverage?.reason || null,
        anchorWaitMs: Number(group.coverage?.anchorWaitMs || 0),
      },
      read: group.read ? {
        ...(group.read.status ? { status: group.read.status } : {}),
        marked: Boolean(group.read.marked),
        method: group.read.method || null,
        messages: Number(group.read.messages || 0),
        unreadBefore: group.read.unreadBefore == null ? null : Number(group.read.unreadBefore),
        error: group.read.error ? describeFailure(group.read.error, 'read_failed').reason : null,
      } : null,
      error: group.error ? describeFailure(group.error, 'collection_failed').reason : null,
    };
  });
  const whatsappMessages = groups.reduce((total, group) => total + group.messages, 0);
  const whatsappReceivedMessages = groups.reduce(
    (total, group) => total + group.coverage.delivered,
    0,
  );
  const coveredByLive = liveSince != null && windowFrom != null && liveSince <= windowFrom;
  const whatsappCoverageStatus = groups.length > 0 && (coveredByLive || groups.every(
    (group) => group.coverage.status === 'complete',
  )) ? 'complete' : 'incomplete';
  const whatsappDiagnostics = {
    historyEvents: Number(whatsapp?.diagnostics?.historyEvents || 0),
    historyNotifications: Number(whatsapp?.diagnostics?.historyNotifications || 0),
    upsertEvents: Number(whatsapp?.diagnostics?.upsertEvents || 0),
    deliveredMessages: Number(whatsapp?.diagnostics?.messages || 0),
    processedHistoryMessages: Number(whatsapp?.diagnostics?.processedHistoryMessages || 0),
    accountSyncCounter: Number(whatsapp?.diagnostics?.accountSyncCounter || 0),
    waitOutcome: whatsapp?.diagnostics?.waitOutcome || null,
    waitMs: Number(whatsapp?.diagnostics?.waitMs || 0),
  };

  return {
    ats: ats ? {
      candidates: ats.candidates.length,
      discovery: ats.discovery || null,
      companies: Number(ats.stats?.companies || 0),
      found: Number(ats.stats?.totalFound || 0),
      errors: ats.errors?.length || 0,
      catchUp: ats.catchUp || [],
      filtered: {
        title: Number(ats.stats?.filteredTitle || 0),
        location: Number(ats.stats?.filteredLocation || 0),
        recency: Number(ats.stats?.filteredRecency || 0),
      },
    } : null,
    whatsapp: whatsapp ? {
      candidates: whatsapp.candidates.length,
      messages: whatsappMessages,
      receivedMessages: whatsappReceivedMessages,
      groups,
      ingress: {
        queued: Number(whatsapp.ingress?.queued || 0),
        duplicates: Number(whatsapp.ingress?.duplicates || 0),
        ignored: Number(whatsapp.ingress?.ignored || 0),
        rejected: Number(whatsapp.ingress?.rejected || 0),
      },
      diagnostics: whatsappDiagnostics,
      coverageStatus: whatsappCoverageStatus,
      coveredBy: coveredByLive ? 'live_collector' : null,
      warning: whatsappCoverageStatus !== 'complete'
        ? 'WhatsApp history לא סיפק כיסוי מוכח לכל הקבוצות; אין להסיק ממספר ההודעות שכל החלון נסרק.'
        : null,
    } : null,
    linkedin: summarizeLinkedIn(linkedin),
  };
}

// The run's status judged without LinkedIn. It anchors the shared
// ATS/WhatsApp scan window, which LinkedIn (with its own per-search
// progress) must never hold back.
//
// A failed ATS company does not hold it back either: each company keeps its
// own progress (company_job_sources.last_success_at) and catches up from it
// on the next run — see companyLookbackHours in sources/ats.mjs. Nor does a
// job whose page or scoring failed: it keeps its error code and the retry
// queue (listPendingEvaluation) picks it up on the next run of its source,
// so rescanning the whole window adds nothing. Nor does partial WhatsApp
// coverage: all groups share one collector connection, a missed message
// cannot be recovered by holding the window back, and the gap itself stays
// recorded per group (syncState/gapFrom). Late-delivered messages outside the
// window are still processed by the backlog run, which ignores the window.
// The run itself still reports incomplete, so every failure stays visible.
export function windowStatusFor(summary) {
  return completionStatusFor({
    ...summary,
    ats: summary?.ats ? { ...summary.ats, errors: 0 } : summary?.ats,
    whatsapp: summary?.whatsapp ? { ...summary.whatsapp, coverageStatus: 'complete' } : summary?.whatsapp,
    linkedin: null,
    processing: null,
  });
}

export function completionStatusFor(summary) {
  return (summary?.linkedin && summary.linkedin.coverageStatus !== 'complete') ||
    (summary?.whatsapp && summary.whatsapp.coverageStatus !== 'complete') ||
    Number(summary?.ats?.errors || 0) > 0 ||
    summary?.whatsapp?.groups?.some((group) => group.read && group.read.status !== 'skipped' && !group.read.marked) ||
    summary?.whatsapp?.groups?.some((group) => group.failedMessages > 0) ||
    Number(summary?.processing?.totals?.failed || 0) > 0
    ? 'incomplete'
    : 'success';
}

function recordRunAudit(store, runId, summary) {
  if (summary.ats) {
    store.recordRunEvent(runId, {
      source: 'ats',
      scope: 'source',
      scopeKey: 'ATS',
      stage: 'collection',
      status: summary.ats.errors > 0 ? 'partial' : 'complete',
      count: summary.ats.candidates,
      details: {
        found: summary.ats.found,
        errors: summary.ats.errors,
        filtered: summary.ats.filtered,
        discovery: summary.ats.discovery,
      },
    });
  }
  if (summary.whatsapp) {
    store.recordRunEvent(runId, {
      source: 'whatsapp',
      scope: 'source',
      scopeKey: 'WhatsApp',
      stage: 'history-coverage',
      status: summary.whatsapp.coverageStatus,
      count: summary.whatsapp.messages,
      details: {
        receivedMessages: summary.whatsapp.receivedMessages,
        candidates: summary.whatsapp.candidates,
        diagnostics: summary.whatsapp.diagnostics,
        ingress: summary.whatsapp.ingress,
      },
    });
    for (const group of summary.whatsapp.groups) {
      store.recordRunEvent(runId, {
        source: 'whatsapp',
        scope: 'group',
        scopeKey: group.name,
        stage: 'history-coverage',
        status: group.coverage.status,
        count: group.messages,
        details: {
          found: group.found,
          candidates: group.candidates,
          coverage: group.coverage,
          read: group.read,
          failed: Boolean(group.error),
        },
      });
    }
  }
  if (summary.linkedin) {
    store.recordRunEvent(runId, {
      source: 'linkedin',
      scope: 'source',
      scopeKey: 'LinkedIn',
      stage: 'collection',
      status: summary.linkedin.coverageStatus,
      count: summary.linkedin.candidates,
      details: { requests: summary.linkedin.requests, haltedBy: summary.linkedin.haltedBy,
        discovery: summary.linkedin.discovery, failure: summary.linkedin.failure },
    });
    for (const search of summary.linkedin.searches) {
      store.recordRunEvent(runId, {
        source: 'linkedin',
        scope: 'search',
        scopeKey: search.label.slice(0, 200),
        stage: 'collection',
        status: search.status,
        count: search.found,
        details: search,
      });
    }
  }
  for (const processing of summary.processing?.scopes || []) {
    store.recordRunEvent(runId, {
      source: processing.source,
      scope: processing.source === 'whatsapp' ? 'group' : processing.source === 'linkedin' ? 'search' : 'source',
      scopeKey: processing.name,
      stage: 'link-processing',
      status: processing.failed > 0 ? 'partial' : 'complete',
      count: processing.processed,
      details: {
        links: processing.links,
        suitable: processing.suitable,
        notSuitable: processing.notSuitable,
        failed: processing.failed,
        alreadyProcessed: processing.alreadyProcessed,
        failureReasons: processing.failureReasons,
      },
    });
  }
}

function printSourceSummary(summary) {
  if (summary.ats) {
    console.log(`ATS: ${summary.ats.candidates} מועמדויות מתוך ${summary.ats.found} משרות ב-${summary.ats.companies} חברות; ${summary.ats.errors} שגיאות.`);
    if (summary.ats.catchUp?.length) {
      console.log(`ATS: השלמה לחברות שנכשלו קודם — ${summary.ats.catchUp.map(({ company, hours }) => `${company} (${hours} שעות)`).join(', ')}.`);
    }
    console.log(`  סוננו: ${summary.ats.filtered.title} לפי תפקיד, ${summary.ats.filtered.location} לפי מיקום, ${summary.ats.filtered.recency} לפי זמן.`);
    if (summary.ats.discovery) console.log(`  לאחר מניעת כפילויות: ${summary.ats.discovery.new} חדשות במאגר, ${summary.ats.discovery.known} כבר מוכרות. מציאת מועמדות אינה החלטת התאמה.`);
  }
  if (summary.whatsapp) {
    console.log('WhatsApp:');
    for (const group of summary.whatsapp.groups) {
      const marker = group.error ? '✗' : group.coverage.status === 'complete' ? '✓' : '⚠';
      const suffix = group.error ? ` — ${group.error}` : '';
      const read = group.read?.status === 'skipped' ? ', לא נשלח סימון קריאה (אין הודעות שנאספו ועובדו בחלון)' :
        group.read?.method === 'scan-message-receipts' ? `, אושרה שליחת אישורי קריאה ל-${group.read.messages} הודעות מהסריקה${group.read.status === 'failed' ? ' — הסימון לא הושלם' : ''}` :
          group.read?.marked ? ', דווח סימון קריאה — נפרד מהסריקה' : group.read ? ', לא סומן כנקרא' : '';
      console.log(`  ${marker} ${group.name}: ${group.coverage.delivered} התקבלו, ${group.messages} עובדו, ${group.candidates} קישורים, כיסוי ${group.coverage.status}${read}${suffix}`);
    }
    const diagnostics = summary.whatsapp.diagnostics;
    console.log(`  סנכרון: ${diagnostics.deliveredMessages} הודעות נמסרו מהשירות (${diagnostics.historyNotifications} חבילות history הוכרזו, ${diagnostics.historyEvents} הושלמו, ${diagnostics.upsertEvents} אירועי live; המתנה ${diagnostics.waitOutcome || 'לא ידוע'}).`);
    if (summary.whatsapp.warning) console.warn(`⚠️ ${summary.whatsapp.warning}`);
  }
}

const LINKEDIN_STATUS_LABELS = { complete: 'הושלם', partial: 'חלקי', failed: 'נכשל' };

export const LINKEDIN_REASON_LABELS = {
  blocked: 'LinkedIn דרש התחברות או חסם את הבקשה',
  rate_limited: 'LinkedIn הגביל את קצב הבקשות',
  structure_changed: 'מבנה התשובה של LinkedIn השתנה',
  network_error: 'כשל רשת',
  timeout: 'תם הזמן',
  http_error: 'תשובת HTTP לא צפויה',
  empty_unverified: 'תשובה ריקה שלא ניתן לאמת (ייתכן חסימה שקטה)',
  request_limit: 'הגיע למגבלת הבקשות לריצה',
  time_limit: 'הגיע למגבלת הזמן לריצה',
  capped: 'הגיע למגבלת העמודים; החלון לא כוסה במלואו',
};

function printLinkedInSummary(linkedin) {
  if (!linkedin) return;
  console.log('LinkedIn:');
  if (linkedin.failure) console.log(`  ✗ המקור נכשל: ${linkedin.failure.reason}`);
  for (const search of linkedin.searches) {
    const marker = search.status === 'complete' ? '✓' : search.status === 'partial' ? '⚠' : '✗';
    const from = search.window ? new Date(search.window.from).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }) : '?';
    const reason = search.reason ? ` — ${LINKEDIN_REASON_LABELS[search.reason] || search.reason}` : '';
    console.log(`  ${marker} ${search.label}: ${LINKEDIN_STATUS_LABELS[search.status] || search.status}${reason}; חלון מ-${from}, ${search.pages} עמודים, ${search.found} נמצאו, ${search.new} חדשות, ${search.known} מוכרות, ${search.filtered} סוננו${search.stale ? `, ${search.stale} ישנות מהחלון` : ''}.`);
    if (search.endedBy === 'no_matches_fallback') console.log('    LinkedIn לא מצא התאמות אמיתיות והחזיר משרות כלליות; הן לא נשמרו.');
    if (search.gap) console.log(`    ⚠ פער שלא כוסה (המחשב היה כבוי זמן רב): ${new Date(search.gap.from).toISOString()} – ${new Date(search.gap.to).toISOString()}`);
    if (search.warning === 'clock_skew') console.log('    ⚠ שעון המחשב חזר אחורה; החלון חושב מחדש מנקודת התחלה.');
  }
  if (linkedin.haltedBy) {
    console.warn(`⚠️ LinkedIn נעצר (${LINKEDIN_REASON_LABELS[linkedin.haltedBy] || linkedin.haltedBy}); אין לנסות שוב מיד — ATS ו-WhatsApp אינם מושפעים.`);
  }
}

function printProcessingSummary(processing) {
  console.log('עיבוד קישורים:');
  for (const scope of processing.scopes) {
    console.log(`  ${scope.name}: ${scope.links} קישורים, ${scope.processed} נקראו, ${scope.suitable} מתאימים, ${scope.notSuitable} לא מתאימים, ${scope.failed} נכשלו, ${scope.alreadyProcessed} כבר נבדקו${scope.deferred ? `, ${scope.deferred} ממתינים לסיום הפסקת LinkedIn` : ''}.`);
    if (scope.failed > 0) {
      const reasons = Object.entries(scope.failureReasons)
        .map(([code, count]) => `${code}: ${count}`)
        .join(', ');
      console.log(`    סיבות כשל: ${reasons}`);
    }
  }
}

function reportPaths(reportsDir, generatedAt) {
  const stamp = generatedAt.toISOString().replace(/[:.]/g, '-');
  return {
    dated: path.join(reportsDir, `${stamp}.md`),
    latest: path.join(reportsDir, 'latest.md'),
  };
}

export async function evaluateCandidates({ candidates, config, store, fetcher, scorer, onFailure = () => {}, onStage = () => {} }) {
  const outcomes = new Map();
  const pendingScores = [];
  let processingStage = 'page-fetch';
  let titleFilteredCount = 0;
  let duplicateCount = 0;
  let blockedCompanyCount = 0;
  // A company marked "not interesting" on the decisions page: rejected
  // locally, never fetched (when the source names it) and never scored.
  const rejectBlockedCompany = (candidate, company, page = null) => {
    blockedCompanyCount += 1;
    store.saveEvaluation(candidate.jobKey, {
      company,
      title: candidate.title || 'משרה לא ידועה',
      summary: 'המשרה סוננה מקומית: החברה סומנה כלא מעניינת.',
      score: 1,
      fitLabel: 'לא מתאים',
      decisionReason: `${company} סומנה כ"חברה לא מעניינת" בעמוד ההחלטות.`,
      suitable: false,
      applyUrl: page?.finalUrl || candidate.url,
      activeStatus: page?.status || 'unknown',
      contentHash: page?.contentHash ?? null,
      profileHash: scorer.profileHash,
      criteriaVersion: config.decision.criteriaVersion,
      evaluatedAt: Date.now(),
    });
    outcomes.set(candidate.jobKey, { status: 'filtered' });
  };
  // ATS candidates are already screened by portals.yml's title_filter before
  // they ever become a candidate (scan.mjs runs it against the source's own
  // structured title). A WhatsApp link has no such title until its page is
  // fetched, so nothing has ever screened it — every link anyone shares
  // reaches full Codex scoring, including the obvious non-matches the same
  // negative keyword list already exists to catch. Reusing that one,
  // person-edited list here (negative-only — see buildNegativeTitleFilter)
  // closes that gap without a second list to keep in sync.
  const passesNegativeTitleFilter = config.rootDir
    ? buildNegativeTitleFilter(loadTitleFilterNegative(path.join(config.rootDir, 'portals.yml')))
    : () => true;
  // The positive half: a WhatsApp page whose title area names none of the
  // target roles never reaches Codex (a scored job costs ~2.6k+ tokens).
  // Checked against a wider 600-char prefix than the negative check, and
  // validated on 2026-09-29: none of the suitable WhatsApp jobs on record
  // would have been dropped even at 300 chars. Disable with
  // sources.whatsapp.titlePrefilter: false.
  const positiveTitle = config.rootDir && config.sources?.whatsapp?.titlePrefilter !== false
    ? loadTitleFilterPositive(path.join(config.rootDir, 'portals.yml'))
    : { positive: [] };
  const passesPositiveTitleFilter = positiveTitle.positive.length
    ? buildTitleFilter({ ...positiveTitle, negative: [] })
    : () => true;
  const recordFailure = (candidate, code, reason) => {
    const fallback = /scor/.test(code) ? 'scoring_failed' : /browser/.test(code) ? 'browser_error' : 'page_uncertain';
    // Source-specific codes with their own explanation (linkedin_*) keep it,
    // rather than being re-derived from the free-text reason.
    const diagnostic = hasFailureReason(code) && /^linkedin_/.test(code)
      ? describeFailure(null, code)
      : describeFailure({ code, message: reason }, fallback);
    const outcome = {
      status: 'failed',
      // Scoring failures start out generically labeled ('scoring_failed') by
      // score-job.mjs, since the raw Codex error text isn't safe to persist
      // as-is — describeFailure's own classification (codex_usage_limit,
      // timeout, network_error, ...) is strictly more specific there, so use
      // it. Page-fetch failures already carry a specific liveness code
      // (access_blocked, no_apply_control, ...); describeFailure's generic
      // HTTP-status fallback can only make those coarser, so keep the raw
      // code for everything else.
      code: code === 'scoring_failed' ? diagnostic.code : String(code || 'unknown_failure').slice(0, 64),
      reason: diagnostic.reason,
    };
    outcomes.set(candidate.jobKey, outcome);
    store.markEvaluationFailure(candidate.jobKey, outcome);
    onFailure(candidate, diagnostic, processingStage);
  };

  onStage('page-fetch');
  let fetched = 0;
  for (const candidate of candidates) {
    const existing = store.getJob(candidate.jobKey);
    const evaluationIsCurrent = existing?.evaluated_at && !existing.last_error_code &&
      existing.profile_hash === scorer.profileHash &&
      existing.criteria_version === config.decision.criteriaVersion;
    if (existing?.duplicate_of) {
      outcomes.set(candidate.jobKey, { status: 'duplicate' });
      continue;
    }
    if (evaluationIsCurrent || existing?.archived_at) {
      outcomes.set(candidate.jobKey, { status: 'already-processed' });
      continue;
    }
    const listedCompany = candidate.company || existing?.company || '';
    if (listedCompany && store.isCompanyBlocked?.(listedCompany)) {
      rejectBlockedCompany(candidate, listedCompany);
      continue;
    }

    let page;
    try {
      page = await fetcher.fetch(candidate.url);
    } catch (error) {
      recordFailure(candidate, 'page_fetch_failed', error?.message || 'Job page fetch failed.');
      continue;
    } finally {
      fetched += 1;
      if (fetched % 20 === 0 || fetched === candidates.length) {
        console.log(`פתיחת קישורים: ${fetched}/${candidates.length}; ${pendingScores.length} עמודים פעילים ממתינים לציון.`);
      }
    }
    if (page.code === 'linkedin_cooldown') {
      // Left pending with no error code: the next run after the cooldown
      // reads it, and it never counts as a failed run.
      outcomes.set(candidate.jobKey, { status: 'deferred' });
      continue;
    }
    if (!store.needsEvaluation(candidate.jobKey, {
      contentHash: page.contentHash,
      profileHash: scorer.profileHash,
      criteriaVersion: config.decision.criteriaVersion,
      activeStatus: page.status,
    })) {
      outcomes.set(candidate.jobKey, { status: 'already-processed' });
      continue;
    }

    if (page.status === 'uncertain' && page.code === 'no_apply_control') {
      // Content loaded, no recognized apply control — treat as active and
      // let Codex judge on content merits instead of failing it unseen.
      // Revisit only if this turns out to hurt scoring quality in practice.
      page = { ...page, status: 'active' };
    }

    if (page.status !== 'active') {
      if (page.status === 'uncertain') {
        recordFailure(candidate, page.code || 'page_uncertain', page.reason || 'The job page could not be verified.');
        continue;
      }
      store.saveEvaluation(candidate.jobKey, {
        company: candidate.company || 'חברה לא ידועה',
        title: candidate.title || 'משרה לא ידועה',
        summary: 'הקישור לא אומת כמשרה פעילה.',
        score: 1,
        fitLabel: 'לא מתאים',
        decisionReason: `הקישור סווג כ-${page.status}; לא בוצעה התאמה.`,
        suitable: false,
        applyUrl: page.finalUrl || candidate.url,
        activeStatus: page.status,
        contentHash: page.contentHash,
        profileHash: scorer.profileHash,
        criteriaVersion: config.decision.criteriaVersion,
        evaluatedAt: Date.now(),
      });
      outcomes.set(candidate.jobKey, { status: 'not-suitable' });
      continue;
    }

    // Same company + role as a job already decided or queued → never score it
    // twice. The identity comes from the page (API fields / JSON-LD), falling
    // back to what the source listed. A LinkedIn apply URL pointing at a known
    // job may already have marked it during the fetch.
    const identity = {
      company: page.identity?.company || candidate.company || existing?.company || '',
      title: page.identity?.title || candidate.title || existing?.title || '',
    };
    if (identity.company && store.isCompanyBlocked?.(identity.company)) {
      rejectBlockedCompany(candidate, identity.company, page);
      continue;
    }
    const { duplicateOf } = store.claimJobIdentity?.(candidate.jobKey, {
      ...identity,
      profileHash: scorer.profileHash,
      criteriaVersion: config.decision.criteriaVersion,
    }) ?? {};
    if (duplicateOf) {
      duplicateCount += 1;
      outcomes.set(candidate.jobKey, { status: 'duplicate' });
      continue;
    }

    // Only WhatsApp links get this local check — ATS titles are already
    // filtered before discovery, and re-running a *title* filter against a
    // full page's worth of description text would risk false-positive
    // exclusions this list was never tuned for. Checked against a bounded
    // prefix (where a fetched job page's own title/heading actually lives),
    // not the whole page — matching the ATS filter's intent of screening a
    // title, not a description.
    const fromWhatsApp = String(candidate.source || '').startsWith('WhatsApp:');
    const titleBlock = !fromWhatsApp ? null
      : !passesNegativeTitleFilter(page.content.slice(0, 300)) ? 'negative'
        : !passesPositiveTitleFilter(page.content.slice(0, 600)) ? 'positive' : null;
    if (titleBlock) {
      titleFilteredCount += 1;
      store.saveEvaluation(candidate.jobKey, {
        company: candidate.company || 'חברה לא ידועה',
        title: candidate.title || 'משרה לא ידועה',
        summary: titleBlock === 'negative'
          ? 'המשרה סוננה מקומית על פי מילת מפתח שלילית בכותרת, לפני שליחה לניקוד.'
          : 'המשרה סוננה מקומית: תחילת העמוד אינה מזכירה אף תפקיד יעד, לפני שליחה לניקוד.',
        score: 1,
        fitLabel: 'לא מתאים',
        decisionReason: titleBlock === 'negative'
          ? 'נחסמה על ידי סינון מילות מפתח (title_filter.negative ב-portals.yml).'
          : 'לא נמצאה אף מילת תפקיד מ-title_filter.positive ב-portals.yml בכותרת העמוד.',
        suitable: false,
        applyUrl: page.finalUrl || candidate.url,
        activeStatus: page.status,
        contentHash: page.contentHash,
        profileHash: scorer.profileHash,
        criteriaVersion: config.decision.criteriaVersion,
        evaluatedAt: Date.now(),
      });
      outcomes.set(candidate.jobKey, { status: 'filtered' });
      continue;
    }

    pendingScores.push({ candidate, page });
  }
  if (blockedCompanyCount > 0) console.log(`סוננו ${blockedCompanyCount} משרות מחברות שסימנת כלא מעניינות, לפני שליחה לניקוד.`);
  if (duplicateCount > 0) console.log(`דולגו ${duplicateCount} משרות כפולות (אותה חברה ואותו תפקיד כבר נבדקו), לפני שליחה לניקוד.`);
  if (titleFilteredCount > 0) console.log(`סוננו מקומית ${titleFilteredCount} משרות WhatsApp לפי כותרת (מילות מפתח שליליות או ללא תפקיד יעד), לפני שליחה לניקוד.`);

  const persistResult = (result) => {
    const item = pendingScores.find(({ candidate }) => candidate.jobKey === result.jobKey);
    if (!item) throw new Error(`Scorer returned an unexpected job: ${result.jobKey}`);
    store.recordSourceOutcome?.({ source: sourceKindOf(item.candidate.source), suitable: result.suitable });
    store.saveEvaluation(result.jobKey, {
      ...result,
      scoredByModel: true,
      contentHash: item.page.contentHash,
      profileHash: scorer.profileHash,
      criteriaVersion: config.decision.criteriaVersion,
      evaluatedAt: Date.now(),
    });
    outcomes.set(result.jobKey, { status: result.suitable ? 'suitable' : 'not-suitable' });
  };

  processingStage = 'scoring';
  onStage(processingStage);
  await scorer.scoreBatchSettled(pendingScores, {
    onProgress: ({ completed, total, failed, results, failures }) => {
      for (const failure of failures) {
        const item = pendingScores.find(({ candidate }) => candidate.jobKey === failure.jobKey);
        if (item) recordFailure(item.candidate, failure.code, failure.reason);
      }
      for (const result of results) persistResult(result);
      console.log(`ציון משרות: ${completed}/${total}; ${failed} נכשלו עד כה.`);
    },
  });
  return outcomes;
}

export async function analyzeSuitableResumeGaps({
  config,
  store,
  analyzer,
  candidateContext,
  onStage = () => {},
  limit = 50,
  now = Date.now(),
}) {
  if (!candidateContext.resumeAvailable) {
    console.log('ניתוח שיפורי קורות החיים דולג: חסר profile/03-current-resume.md.');
    return { status: 'skipped', reason: 'resume_unavailable', analyzed: 0, failed: 0 };
  }

  const candidates = store.listResumeGapCandidates({ limit: 500 })
    .filter((job) => job.profileHash === candidateContext.profileHash)
    .map((job) => ({
      ...job,
      resumeGapInputHash: resumeGapInputHash({
        contentHash: job.contentHash,
        profileHash: candidateContext.profileHash,
        resumeHash: candidateContext.resumeHash,
        analysisVersion: analyzer.version,
      }),
    }))
    .filter((job) => job.resumeGapInputHash !== job.storedResumeGapInputHash || job.resumeGapErrorCode)
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 50)));

  if (candidates.length === 0) {
    return { status: 'complete', analyzed: 0, failed: 0 };
  }

  // Resume analysis is not urgent, and every Codex call pays a fixed ~6.5k
  // input tokens before any job text. Wait until a batch is worth it, or
  // until the oldest suitable job has waited long enough.
  const minBatch = Math.max(1, Number(config.resumeGap?.minBatch) || 5);
  const maxWaitMs = Math.max(0, Number(config.resumeGap?.maxWaitHours ?? 12)) * 60 * 60 * 1000;
  const oldestEvaluatedAt = Math.min(...candidates.map((job) => Number(job.evaluatedAt) || now));
  if (candidates.length < minBatch && now - oldestEvaluatedAt < maxWaitMs) {
    console.log(`ניתוח קורות חיים נדחה: ${candidates.length} משרות מתאימות ממתינות (מנתחים מ-${minBatch}, או אחרי ${Math.round(maxWaitMs / 3_600_000)} שעות).`);
    return { status: 'deferred', analyzed: 0, failed: 0, waiting: candidates.length };
  }

  onStage('resume-gap-analysis');
  let analyzed = 0;
  const settled = await analyzer.analyzeBatchSettled(candidates, {
    profile: candidateContext.profile,
    currentResume: candidateContext.currentResume,
    onProgress: ({ completed, total, failed, results, failures }) => {
      for (const result of results) {
        const job = candidates.find((item) => item.jobKey === result.jobKey);
        if (!job) continue;
        store.saveResumeGap(result.jobKey, {
          inputHash: job.resumeGapInputHash,
          analysis: {
            items: result.items,
            employerPriorities: result.employerPriorities,
            screenPass: result.screenPass,
          },
          analyzedAt: Date.now(),
          resumeHash: candidateContext.resumeHash,
        });
        analyzed += 1;
      }
      for (const failure of failures) {
        const job = candidates.find((item) => item.jobKey === failure.jobKey);
        if (!job) continue;
        store.markResumeGapFailure(failure.jobKey, {
          inputHash: job.resumeGapInputHash,
          code: failure.code,
          reason: failure.reason,
          attemptedAt: Date.now(),
        });
      }
      console.log(`ניתוח קורות חיים: ${completed}/${total}; ${failed} נכשלו עד כה.`);
    },
  });

  return {
    status: settled.failures.length ? 'partial' : 'complete',
    analyzed,
    failed: settled.failures.length,
  };
}

const LOCK_POLL_MS = 15_000;

export function linkedinEnabledFor(config, store) {
  return Boolean(config.sources.linkedin?.enabled) && store.isSourceEnabled('linkedin');
}

export async function runJobs(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const config = loadJobsConfig();
  process.chdir(config.rootDir);
  // Scheduled scans (launchd) and a manually triggered dashboard scan are
  // separate OS processes with no shared in-memory state, so the dashboard's
  // own "only one action at a time" bookkeeping can't see a scheduled run.
  // A real overlap is rare but not impossible, and SQLite only tolerates one
  // writer at a time — so skip cleanly rather than risk two scans writing at
  // once. A dry run never touches the real database and is exempt.
  let scanLock = null;
  if (!options.dryRun) {
    // A scheduled run may wait a bounded time for a neighbouring scan instead
    // of skipping; a skip is still safe because windows resume from the last
    // successful coverage.
    const deadline = Date.now() + Number(options.waitForLockMinutes || 0) * 60_000;
    while (!scanLock) {
      try {
        scanLock = acquireSingleInstance(path.join(path.dirname(config.jobsDbPath), '.scan.lock'), {
          name: 'jobOps scan',
          errorCode: 'JOBOPS_SCAN_ALREADY_RUNNING',
        });
      } catch (error) {
        if (error.code !== 'JOBOPS_SCAN_ALREADY_RUNNING') throw error;
        if (Date.now() + LOCK_POLL_MS > deadline) {
          console.log('סריקה אחרת כבר פועלת על אותו מסד נתונים; מדלג על הריצה הזו.');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      }
    }
  }
  try {
    return await runJobsLocked(options, config);
  } finally {
    scanLock?.release();
  }
}

function formatTokens(value) {
  return Number(value || 0).toLocaleString('en-US');
}

export function summarizeRunUsage(totals) {
  const sum = (field) => totals.reduce((total, row) => total + Number(row[field] || 0), 0);
  const scoring = totals.find((row) => row.purpose === 'scoring');
  const input = sum('inputTokens');
  const output = sum('outputTokens');
  return {
    calls: sum('calls'),
    failedCalls: sum('calls') - sum('okCalls'),
    limitedCalls: sum('limited'),
    measuredCalls: sum('measuredCalls'),
    inputTokens: input,
    cachedInputTokens: sum('cachedInputTokens'),
    outputTokens: output,
    reasoningTokens: sum('reasoningTokens'),
    totalTokens: input + output,
    scoredJobs: Number(scoring?.items || 0),
    tokensPerScoredJob: scoring?.items ? Math.round((Number(scoring.inputTokens) + Number(scoring.outputTokens)) / scoring.items) : null,
    byPurpose: totals.map(({ purpose, calls, items, inputTokens, outputTokens, models }) => ({ purpose, calls, items, tokens: Number(inputTokens) + Number(outputTokens), models })),
  };
}

function printUsageSummary(usage) {
  if (!usage || usage.calls === 0) { console.log('Codex: לא בוצעו קריאות בריצה הזו.'); return; }
  console.log(`Codex: ${usage.calls} קריאות, ${formatTokens(usage.totalTokens)} טוקנים ` +
    `(קלט ${formatTokens(usage.inputTokens)}, מתוכם ${formatTokens(usage.cachedInputTokens)} מהמטמון; פלט ${formatTokens(usage.outputTokens)}` +
    `${usage.reasoningTokens ? `, מתוכו חשיבה ${formatTokens(usage.reasoningTokens)}` : ''})` +
    `${usage.tokensPerScoredJob ? `; ${formatTokens(usage.tokensPerScoredJob)} לכל משרה שנוקדה` : ''}.`);
  if (usage.measuredCalls < usage.calls - usage.failedCalls) console.log('  ⚠ חלק מהקריאות לא דיווחו טוקנים (גרסת Codex ישנה?).');
  if (usage.limitedCalls) console.warn('  ⚠ מכסת Codex נגמרה במהלך הריצה; המשרות שלא נוקדו יטופלו אוטומטית כשהמכסה תתחדש.');
}

async function runJobsLocked(options, config) {
  const store = createJobStore(options.dryRun ? ':memory:' : config.jobsDbPath);
  const runStartedAt = Date.now();
  let usageRunId = null;
  setCodexUsageRecorder((entry) => store.recordCodexCall({ ...entry, runId: usageRunId }));
  // No quota means nothing can be scored; collecting now would only move
  // coverage forward for jobs that then wait. Skip the whole run instead:
  // every source resumes from its last success once quota is back.
  if (!options.dryRun) {
    const quota = checkCodexQuota({ store, readRateLimits: () => readCodexRateLimits({ fsModule: fs }) });
    if (!quota.available) {
      store.noteLlmSkip();
      const until = new Date(quota.until).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
      console.log(`מכסת Codex נגמרה (תתחדש בערך ב-${until}); הריצה דולגה ולא נאסף דבר. כל מקור ימשיך מההצלחה האחרונה שלו.`);
      setCodexUsageRecorder(null);
      store.close();
      return;
    }
  }
  // portals.yml bootstraps the registry without overwriting decisions already
  // made in the dashboard (watch, pause, or ignore).
  syncConfiguredCompanyEntries(store, config.rootDir);
  // Same model for LinkedIn: config seeds searches, the dashboard owns edits.
  store.syncLinkedInSearches(config.sources.linkedin?.searches || []);
  const linkedinEnabled = linkedinEnabledFor(config, store);
  // Decided once, before this run sends anything, so its own requests never
  // throttle it; only earlier runs' blocks and activity count.
  const cooldownSettings = config.sources.linkedin?.cooldown || {};
  const linkedinBlockMs = Number(cooldownSettings.afterBlockMinutes ?? 60) * 60_000;
  const linkedinCooldown = store.getLinkedInCooldown({
    afterActivityMs: Number(cooldownSettings.afterActivityMinutes ?? 15) * 60_000,
  });
  const noteLinkedInBlock = (status) => store.noteLinkedInBlock(status, { cooldownMs: linkedinBlockMs });
  const fetcher = createJobPageFetcher({
    store,
    cacheTtlMs: Number(config.scan.pageCacheHours) * 60 * 60 * 1000,
    linkedinLimits: config.sources.linkedin?.limits || {},
    linkedinCooldown: linkedinCooldown.reads,
    onLinkedInRequest: () => store.noteLinkedInActivity(),
    onLinkedInBlock: noteLinkedInBlock,
  });
  let runId = null;
  let runDetails = null;
  let lifecycle = null;
  let fetcherClosed = false;

  try {
    const sources = [];
    const fullScan = !options.whatsappBacklog && !options.retryOnly;
    if (fullScan && !options.whatsappOnly && !options.linkedinOnly && config.sources.ats?.enabled) sources.push('ats');
    if (fullScan && !options.atsOnly && !options.linkedinOnly && config.sources.whatsapp?.enabled) sources.push('whatsapp');
    if (fullScan && !options.atsOnly && !options.whatsappOnly && linkedinEnabled) sources.push('linkedin');
    if (options.linkedinOnly && !linkedinEnabled) console.log('LinkedIn כבוי (config/jobs.yml או לוח הבקרה); אין מה לסרוק.');
    if (options.whatsappBacklog && config.sources.whatsapp?.enabled) sources.push('whatsapp-backlog');
    if (options.retryOnly) sources.push('retry');
    if (sources.length === 0) throw new Error('No job sources are enabled for this run');
    const window = options.whatsappBacklog
      ? { from: options.days == null ? 0 : Date.now() - options.days * 24 * 60 * 60 * 1_000, to: Date.now() }
      : scanWindow({ config, store, requestedDays: options.days, sources });
    if (!options.dryRun) {
      const actionId = /^[1-9]\d{0,8}$/.test(process.env.JOBOPS_ACTION_ID || '') ? Number(process.env.JOBOPS_ACTION_ID) : null;
      runId = store.startRun({ fromTs: window.from, toTs: window.to, sources, ownerPid: process.pid, actionId });
      usageRunId = runId;
      lifecycle = createRunLifecycle(store, runId, { registerProcessHandlers: true });
      store.recordRunEvent(runId, {
        source: 'system',
        scope: 'run',
        scopeKey: String(runId),
        stage: 'run',
        status: 'started',
        details: { sources },
      });
    }

    const sourceResults = [];
    const sourceSeconds = {};
    const coverageContext = { windowFrom: window.from, liveSince: liveCollectorSince(store) };
    let sourceStartedAt = Date.now();
    const saveSource = (result) => {
      sourceSeconds[result.source] = (Date.now() - sourceStartedAt) / 1_000;
      sourceResults.push(result);
      runDetails = summarizeSourceResults(sourceResults, coverageContext);
      if (!runId) return;
      // Persist each source before waiting for the next one, so an interruption
      // during WhatsApp cannot erase an already completed ATS collection.
      store.touchRun(runId, { details: runDetails });
      recordRunAudit(store, runId, summarizeSourceResults([result]));
      for (const error of result.source === 'ats' ? result.errors || [] : []) {
        store.recordRunEvent(runId, { source: result.source, scope: 'company', scopeKey: String(error.company || 'ATS').slice(0, 200),
          stage: 'collection', status: 'failed', details: describeFailure(error.error, 'collection_failed') });
      }
      for (const group of result.groups || []) {
        const record = (stage, failure) => store.recordRunEvent(runId, { source: 'whatsapp', scope: 'group',
          scopeKey: group.name, stage, status: 'warning', details: failure });
        if (group.coverage?.reason && group.coverage.reason !== 'stale-session-no-anchor') record('history-coverage', describeFailure(null, group.coverage.reason));
        else if (group.coverage?.reason === 'stale-session-no-anchor') record('history-coverage', describeFailure(null, 'history_not_delivered'));
        else if (group.error) record('collection', describeFailure(group.error, 'collection_failed'));
        else if (group.coverage?.status !== 'complete') record('history-coverage', describeFailure(null, 'coverage_incomplete'));
        if (group.read && group.read.status !== 'skipped' && !group.read.marked) record('mark-read', describeFailure(group.read.error, 'read_failed'));
      }
    };
    if (sources.includes('ats')) {
      lifecycle?.stage('collection', 'ats');
      sourceStartedAt = Date.now();
      saveSource(await scanAts({
        store,
        lookbackHours: Math.ceil((window.to - window.from) / (60 * 60 * 1000)),
        companyWindow: {
          sharedFrom: window.from,
          now: window.to,
          overlapMs: Number(config.scan.overlapHours) * 60 * 60 * 1000,
          maxLookbackMs: Number(config.scan.maxLookbackDays) * 24 * 60 * 60 * 1000,
        },
      }));
    }
    if (sources.includes('whatsapp')) {
      lifecycle?.stage('collection', 'whatsapp');
      sourceStartedAt = Date.now();
      saveSource(await scanWhatsApp({
        config,
        store,
        sinceMs: window.from,
        untilMs: window.to,
        onStage: (stage) => lifecycle?.stage(stage, 'whatsapp'),
        onDiagnostic: (event) => { if (runId) store.recordRunEvent(runId, { ...event, source: 'whatsapp' }); },
      }));
    }
    if (sources.includes('linkedin')) {
      lifecycle?.stage('collection', 'linkedin');
      sourceStartedAt = Date.now();
      const passesTitle = buildNegativeTitleFilter(loadTitleFilterNegative(path.join(config.rootDir, 'portals.yml')));
      if (linkedinCooldown.scans) {
        console.log(`LinkedIn בהפסקה אחרי ${linkedinCooldown.scans.reason} עד ${new Date(linkedinCooldown.scans.until).toLocaleTimeString('he-IL')}; החיפוש נדחה לריצה הבאה.`);
      }
      try {
        const result = await scanLinkedIn({
          config,
          store,
          mode: options.linkedinHours != null ? 'manual' : 'auto',
          manualHours: options.linkedinHours,
          passesTitle,
          cooldown: linkedinCooldown.scans,
        });
        if (result.requests > 0) store.noteLinkedInActivity();
        if (['rate_limited', 'blocked'].includes(result.haltedBy)) noteLinkedInBlock(result.haltedBy);
        saveSource(result);
      } catch (error) {
        // LinkedIn is an optional, unofficial source: its failure is reported
        // and never aborts ATS/WhatsApp collection or processing.
        saveSource({ source: 'linkedin', candidates: [], searches: [], errors: [], failure: describeFailure(error, 'collection_failed') });
      }
    }
    if (sources.includes('whatsapp-backlog')) {
      lifecycle?.stage('collection', 'whatsapp-backlog');
      saveSource(scanWhatsAppBacklog({
        config,
        store,
        sinceMs: window.from,
        untilMs: window.to,
        // A group may accumulate a few hundred messages while the Collector is
        // offline. Keep the action bounded while allowing the common backlog
        // to drain in one run.
        limitPerGroup: 500,
        onStage: (stage) => lifecycle?.stage(stage, 'whatsapp-backlog'),
        onDiagnostic: (event) => { if (runId) store.recordRunEvent(runId, { ...event, source: 'whatsapp' }); },
      }));
    }

    runDetails = summarizeSourceResults(sourceResults, coverageContext);
    if (options.retryOnly) console.log('ניסיון חוזר: מעבד רק קישורים שנכשלו או טרם קיבלו החלטה; המקורות לא נסרקים מחדש.');
    printSourceSummary(runDetails);
    printLinkedInSummary(runDetails.linkedin);
    const candidateSightings = sourceResults.flatMap((result) => result.candidates);
    const retryCandidates = filterPendingCandidatesForSources(
      store.listPendingEvaluation({ excludeErrorCodes: [...NON_RETRYABLE_FAILURE_CODES] }),
      sources,
      { linkedinEnabled },
    );
    const currentJobKeys = new Set(candidateSightings.map((candidate) => candidate.jobKey));
    const processingCandidates = [
      ...candidateSightings,
      ...retryCandidates.filter((candidate) => !currentJobKeys.has(candidate.jobKey)),
    ];
    const candidates = uniqueCandidates([...candidateSightings, ...retryCandidates]);
    const candidateContext = readCandidateContext(config);
    lifecycle?.stage('scorer-setup');
    const scorer = createJobScorer(config, { candidateContext });
    let failureSamples = 0;
    const outcomes = await evaluateCandidates({ candidates, config, store, fetcher, scorer,
      onStage: (stage) => lifecycle?.stage(stage),
      onFailure: (candidate, failure, stage) => {
        if (!runId || failureSamples >= 200) return;
        failureSamples += 1;
        // A shared link can appear in several groups; retain each affected scope.
        const sightings = processingCandidates.filter((item) => item.jobKey === candidate.jobKey);
        const scopes = new Map(sightings.map((item) => { const scope = processingScope(item); return [`${scope.source}:${scope.name}`, scope]; }));
        for (const scope of scopes.values()) store.recordRunEvent(runId, {
          source: scope.source, scope: 'job', scopeKey: scope.name, stage,
          status: 'failed', details: { ...failure, jobKey: candidate.jobKey, host: safeTargetUrl(candidate.url) },
        });
      },
    });
    runDetails.processing = summarizeProcessingResults(processingCandidates, outcomes);
    printProcessingSummary(runDetails.processing);
    const resumeGapAnalyzer = createResumeGapAnalyzer({ config });
    runDetails.resumeGap = await analyzeSuitableResumeGaps({
      config, store, analyzer: resumeGapAnalyzer, candidateContext,
      onStage: (stage) => lifecycle?.stage(stage),
    });
    if (runDetails.resumeGap.failed > 0) {
      console.warn('ניתוח שיפורי קורות החיים נכשל חלקית; המשרות עצמן נשמרו ומוצגות כרגיל.');
    }
    // Personal-area cleanup only; a failure here never fails the scan.
    try {
      runDetails.gapCoverage = await refreshGapCoverage({
        store, checker: createGapCoverageChecker({ config }), candidateContext,
      });
      if (runDetails.gapCoverage.checked) {
        console.log(`בדיקת כיסוי פערים: ${runDetails.gapCoverage.covered} מתוך ${runDetails.gapCoverage.checked} נושאים כבר מכוסים בקורות החיים.`);
      }
    } catch (error) {
      runDetails.gapCoverage = { status: 'failed', reason: String(error?.message || error).slice(0, 300) };
      console.warn(`בדיקת כיסוי פערים נכשלה ותנוסה שוב בסריקה הבאה: ${runDetails.gapCoverage.reason}`);
    }
    runDetails.llmUsage = summarizeRunUsage(store.summarizeCodexUsage({ sinceMs: runStartedAt }).totals);
    printUsageSummary(runDetails.llmUsage);
    if (runId) {
      store.recordSourceScanStats(sourceScanStatRows(runDetails, sourceSeconds), { runId });
      runDetails.failureSampleLimit = 200;
      store.touchRun(runId, { details: runDetails });
      recordRunAudit(store, runId, { processing: runDetails.processing });
    }

    lifecycle?.stage('report');
    const unpresentedJobs = store.listUnpresentedSuitable();
    const matchingJobs = deduplicateJobs(unpresentedJobs);
    const generatedAt = new Date(window.to);
    const report = renderMinimalReport({ generatedAt, window, jobs: matchingJobs });

    if (options.dryRun) {
      console.log(`\n${report}`);
    } else {
      fs.mkdirSync(config.reportsDir, { recursive: true });
      const paths = reportPaths(config.reportsDir, generatedAt);
      fs.writeFileSync(paths.dated, report, 'utf8');
      fs.writeFileSync(paths.latest, report, 'utf8');
      appendMatchingJobs(config.pipelinePath, matchingJobs);
      const notified = queueJobNotifications({ store, jobs: matchingJobs, config });
      if (notified) console.log(`${notified} התראות WhatsApp על משרות חזקות נוספו לתור; ה-Collector ישלח אותן.`);
      // Mark equivalent source records together so a duplicate cannot surface tomorrow.
      store.markPresented(unpresentedJobs.map((job) => job.jobKey));
      console.log(`הדוח נשמר: ${path.relative(config.rootDir, paths.dated)}`);
    }

    if (options.open && matchingJobs.length > 0) {
      lifecycle?.stage('open-browser');
      const openResult = await openJobUrls({ jobs: matchingJobs, application: config.browser?.application });
      if (!options.dryRun) store.markOpened(unpresentedJobs.map((job) => job.jobKey));
      console.log(`נפתחו ${openResult.opened} משרות ב-${config.browser?.application || 'Google Chrome'}.`);
    }

    lifecycle?.stage('cleanup');
    await fetcher.close();
    fetcherClosed = true;
    const completionStatus = completionStatusFor(runDetails);
    lifecycle?.finish(completionStatus, { details: runDetails, windowStatus: windowStatusFor(runDetails) });
    if (completionStatus === 'incomplete') {
      console.warn('⚠️ הריצה הסתיימה עם כיסוי חלקי; יש לעיין במשפך הקבוצות לפני הסקת מסקנות.');
    }
    console.log(`נסרקו ${candidates.length} מועמדות; נמצאו ${matchingJobs.length} משרות חדשות מתאימות.`);
  } catch (error) {
    lifecycle?.finish('failed', { failure: describeFailure(error), details: runDetails });
    throw error;
  } finally {
    lifecycle?.dispose();
    try { if (!fetcherClosed) await fetcher.close(); }
    finally {
      try { store.pruneDiagnostics(); }
      catch { console.error('JobOps diagnostic retention unavailable; existing records were preserved.'); }
      setCodexUsageRecorder(null);
      store.close();
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runJobs()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`סריקת המשרות נכשלה: ${error.message}`);
      process.exit(1);
    });
}
