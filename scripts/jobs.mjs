#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadJobsConfig } from './jobs/config.mjs';
import { syncConfiguredCompanyEntries } from './jobs/company-catalog.mjs';
import { deduplicateJobs } from './jobs/core.mjs';
import { createJobPageFetcher } from './jobs/fetch-page.mjs';
import { openJobUrls } from './jobs/open.mjs';
import { appendMatchingJobs } from './jobs/pipeline.mjs';
import { renderMinimalReport } from './jobs/report.mjs';
import { createJobScorer } from './jobs/score-job.mjs';
import { createJobStore } from './jobs/store.mjs';
import { scanAts } from './jobs/sources/ats.mjs';
import { scanWhatsApp, scanWhatsAppBacklog } from './jobs/sources/whatsapp.mjs';
import { createRunLifecycle, describeFailure, safeTargetUrl } from './jobs/diagnostics.mjs';

export function parseArgs(argv) {
  const daysIndex = argv.indexOf('--days');
  const days = daysIndex >= 0 ? Number(argv[daysIndex + 1]) : null;
  if (daysIndex >= 0 && (!Number.isFinite(days) || days <= 0)) {
    throw new Error('--days requires a positive number');
  }
  if (argv.includes('--ats-only') && argv.includes('--whatsapp-only')) {
    throw new Error('Use either --ats-only or --whatsapp-only, not both');
  }
  if (argv.includes('--retry-only') && (argv.includes('--ats-only') || argv.includes('--whatsapp-only'))) {
    throw new Error('--retry-only cannot be combined with source-only flags');
  }
  if (argv.includes('--whatsapp-backlog') && (argv.includes('--ats-only') || argv.includes('--whatsapp-only') || argv.includes('--retry-only'))) {
    throw new Error('--whatsapp-backlog cannot be combined with source-only or retry flags');
  }
  return {
    days,
    atsOnly: argv.includes('--ats-only'),
    whatsappOnly: argv.includes('--whatsapp-only'),
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
  return { from, to: now };
}

function uniqueCandidates(candidates) {
  return [...new Map(candidates.map((candidate) => [candidate.jobKey, candidate])).values()];
}

export function filterPendingCandidatesForSources(candidates, sources) {
  if (sources.includes('retry') || (sources.includes('ats') && sources.includes('whatsapp'))) {
    return candidates;
  }
  if (sources.includes('ats')) {
    return candidates.filter((candidate) => String(candidate.source || '').startsWith('ATS:'));
  }
  if (sources.includes('whatsapp') || sources.includes('whatsapp-backlog')) {
    return candidates.filter((candidate) => String(candidate.source || '').startsWith('WhatsApp:'));
  }
  return [];
}

function processingScope(candidate) {
  const source = String(candidate.source || '');
  if (source.startsWith('WhatsApp: ')) {
    return { source: 'whatsapp', name: source.slice('WhatsApp: '.length).trim() || 'WhatsApp' };
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
      failureReasons: {},
    };
    row.links += 1;

    const outcome = outcomes.get(candidate.jobKey);
    if (!outcome || outcome.status === 'failed') {
      row.failed += 1;
      const code = outcome?.code || 'unknown_failure';
      row.failureReasons[code] = Number(row.failureReasons[code] || 0) + 1;
    } else if (outcome.status === 'already-processed') {
      row.alreadyProcessed += 1;
    } else {
      row.processed += 1;
      if (outcome.status === 'suitable') row.suitable += 1;
      else row.notSuitable += 1;
    }
    scopes.set(scopeKey, row);
  }

  const rows = [...scopes.values()];
  const totals = rows.reduce((summary, row) => {
    for (const field of ['links', 'processed', 'suitable', 'notSuitable', 'failed', 'alreadyProcessed']) {
      summary[field] += row[field];
    }
    for (const [code, count] of Object.entries(row.failureReasons)) {
      summary.failureReasons[code] = Number(summary.failureReasons[code] || 0) + Number(count);
    }
    return summary;
  }, { links: 0, processed: 0, suitable: 0, notSuitable: 0, failed: 0, alreadyProcessed: 0, failureReasons: {} });

  return { totals, scopes: rows };
}

export function summarizeSourceResults(sourceResults) {
  const ats = sourceResults.find((result) => result.source === 'ats');
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
  const whatsappCoverageStatus = groups.length > 0 && groups.every(
    (group) => group.coverage.status === 'complete',
  ) ? 'complete' : 'incomplete';
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
      warning: whatsappCoverageStatus !== 'complete'
        ? 'WhatsApp history לא סיפק כיסוי מוכח לכל הקבוצות; אין להסיק ממספר ההודעות שכל החלון נסרק.'
        : null,
    } : null,
  };
}

export function completionStatusFor(summary) {
  return (summary?.whatsapp && summary.whatsapp.coverageStatus !== 'complete') ||
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
  for (const processing of summary.processing?.scopes || []) {
    store.recordRunEvent(runId, {
      source: processing.source,
      scope: processing.source === 'whatsapp' ? 'group' : 'source',
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

function printProcessingSummary(processing) {
  console.log('עיבוד קישורים:');
  for (const scope of processing.scopes) {
    console.log(`  ${scope.name}: ${scope.links} קישורים, ${scope.processed} נקראו, ${scope.suitable} מתאימים, ${scope.notSuitable} לא מתאימים, ${scope.failed} נכשלו, ${scope.alreadyProcessed} כבר נבדקו.`);
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
  const recordFailure = (candidate, code, reason) => {
    const fallback = /scor/.test(code) ? 'scoring_failed' : /browser/.test(code) ? 'browser_error' : 'page_uncertain';
    const diagnostic = describeFailure({ code, message: reason }, fallback);
    const outcome = {
      status: 'failed',
      code: String(code || 'unknown_failure').slice(0, 64),
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
    if (evaluationIsCurrent || existing?.archived_at) {
      outcomes.set(candidate.jobKey, { status: 'already-processed' });
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
    if (!store.needsEvaluation(candidate.jobKey, {
      contentHash: page.contentHash,
      profileHash: scorer.profileHash,
      criteriaVersion: config.decision.criteriaVersion,
      activeStatus: page.status,
    })) {
      outcomes.set(candidate.jobKey, { status: 'already-processed' });
      continue;
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

    pendingScores.push({ candidate, page });
  }

  const persistResult = (result) => {
    const item = pendingScores.find(({ candidate }) => candidate.jobKey === result.jobKey);
    if (!item) throw new Error(`Scorer returned an unexpected job: ${result.jobKey}`);
    store.saveEvaluation(result.jobKey, {
      ...result,
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

export async function runJobs(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const config = loadJobsConfig();
  process.chdir(config.rootDir);
  const store = createJobStore(options.dryRun ? ':memory:' : config.jobsDbPath);
  // portals.yml bootstraps the registry without overwriting decisions already
  // made in the dashboard (watch, pause, or ignore).
  syncConfiguredCompanyEntries(store, config.rootDir);
  const fetcher = createJobPageFetcher({
    store,
    cacheTtlMs: Number(config.scan.pageCacheHours) * 60 * 60 * 1000,
  });
  let runId = null;
  let runDetails = null;
  let lifecycle = null;
  let fetcherClosed = false;

  try {
    const sources = [];
    if (!options.whatsappBacklog && !options.retryOnly && !options.whatsappOnly && config.sources.ats?.enabled) sources.push('ats');
    if (!options.whatsappBacklog && !options.retryOnly && !options.atsOnly && config.sources.whatsapp?.enabled) sources.push('whatsapp');
    if (options.whatsappBacklog && config.sources.whatsapp?.enabled) sources.push('whatsapp-backlog');
    if (options.retryOnly) sources.push('retry');
    if (sources.length === 0) throw new Error('No job sources are enabled for this run');
    const window = options.whatsappBacklog
      ? { from: options.days == null ? 0 : Date.now() - options.days * 24 * 60 * 60 * 1_000, to: Date.now() }
      : scanWindow({ config, store, requestedDays: options.days, sources });
    if (!options.dryRun) {
      const actionId = /^[1-9]\d{0,8}$/.test(process.env.JOBOPS_ACTION_ID || '') ? Number(process.env.JOBOPS_ACTION_ID) : null;
      runId = store.startRun({ fromTs: window.from, toTs: window.to, sources, ownerPid: process.pid, actionId });
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
    const saveSource = (result) => {
      sourceResults.push(result);
      runDetails = summarizeSourceResults(sourceResults);
      if (!runId) return;
      // Persist each source before waiting for the next one, so an interruption
      // during WhatsApp cannot erase an already completed ATS collection.
      store.touchRun(runId, { details: runDetails });
      recordRunAudit(store, runId, summarizeSourceResults([result]));
      for (const error of result.errors || []) {
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
      saveSource(await scanAts({
        store,
        lookbackHours: Math.ceil((window.to - window.from) / (60 * 60 * 1000)),
      }));
    }
    if (sources.includes('whatsapp')) {
      lifecycle?.stage('collection', 'whatsapp');
      saveSource(await scanWhatsApp({
        config,
        store,
        sinceMs: window.from,
        untilMs: window.to,
        onStage: (stage) => lifecycle?.stage(stage, 'whatsapp'),
        onDiagnostic: (event) => { if (runId) store.recordRunEvent(runId, { ...event, source: 'whatsapp' }); },
      }));
    }
    if (sources.includes('whatsapp-backlog')) {
      lifecycle?.stage('collection', 'whatsapp-backlog');
      saveSource(scanWhatsAppBacklog({
        config,
        store,
        sinceMs: window.from,
        untilMs: window.to,
        // Keep one dashboard action bounded. Re-run the action to drain a
        // large historical inbox without creating an hours-long score run.
        limitPerGroup: 100,
        onStage: (stage) => lifecycle?.stage(stage, 'whatsapp-backlog'),
        onDiagnostic: (event) => { if (runId) store.recordRunEvent(runId, { ...event, source: 'whatsapp' }); },
      }));
    }

    runDetails = summarizeSourceResults(sourceResults);
    if (options.retryOnly) console.log('ניסיון חוזר: מעבד רק קישורים שנכשלו או טרם קיבלו החלטה; המקורות לא נסרקים מחדש.');
    printSourceSummary(runDetails);
    const candidateSightings = sourceResults.flatMap((result) => result.candidates);
    const retryCandidates = filterPendingCandidatesForSources(store.listPendingEvaluation(), sources);
    const currentJobKeys = new Set(candidateSightings.map((candidate) => candidate.jobKey));
    const processingCandidates = [
      ...candidateSightings,
      ...retryCandidates.filter((candidate) => !currentJobKeys.has(candidate.jobKey)),
    ];
    const candidates = uniqueCandidates([...candidateSightings, ...retryCandidates]);
    lifecycle?.stage('scorer-setup');
    const scorer = createJobScorer(config);
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
    if (runId) {
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
    lifecycle?.finish(completionStatus, { details: runDetails });
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
