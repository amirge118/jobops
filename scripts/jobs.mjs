#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadJobsConfig } from './jobs/config.mjs';
import { deduplicateJobs } from './jobs/core.mjs';
import { createJobPageFetcher } from './jobs/fetch-page.mjs';
import { openJobUrls } from './jobs/open.mjs';
import { appendMatchingJobs } from './jobs/pipeline.mjs';
import { renderMinimalReport } from './jobs/report.mjs';
import { createJobScorer } from './jobs/score-job.mjs';
import { createJobStore } from './jobs/store.mjs';
import { scanAts } from './jobs/sources/ats.mjs';
import { scanWhatsApp } from './jobs/sources/whatsapp.mjs';

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
  return {
    days,
    atsOnly: argv.includes('--ats-only'),
    whatsappOnly: argv.includes('--whatsapp-only'),
    open: argv.includes('--open'),
    dryRun: argv.includes('--dry-run'),
    retryOnly: argv.includes('--retry-only'),
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
  if (sources.includes('whatsapp')) {
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
      candidates: Number(group.candidates || 0),
      coverage: {
        status: group.coverage?.status || fallbackCoverage,
        requestedFrom: group.coverage?.requestedFrom ?? null,
        oldestAt: group.coverage?.oldestAt ?? null,
        newestAt: group.coverage?.newestAt ?? null,
        delivered: Number(group.coverage?.delivered ?? messages),
        collected: Number(group.coverage?.collected ?? messages),
        batches: Number(group.coverage?.batches ?? 0),
      },
      read: group.read ? {
        marked: Boolean(group.read.marked),
        method: group.read.method || null,
        messages: Number(group.read.messages || 0),
        unreadBefore: group.read.unreadBefore == null ? null : Number(group.read.unreadBefore),
        error: group.read.error || null,
      } : null,
      error: group.error || null,
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
  }
  if (summary.whatsapp) {
    console.log('WhatsApp:');
    for (const group of summary.whatsapp.groups) {
      const marker = group.error ? '✗' : '✓';
      const suffix = group.error ? ` — ${group.error}` : '';
      const read = group.read?.marked ? ', סומן כנקרא' : group.read ? ', לא סומן כנקרא' : '';
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

export async function evaluateCandidates({ candidates, config, store, fetcher, scorer }) {
  const outcomes = new Map();
  const pendingScores = [];
  const recordFailure = (candidate, code, reason) => {
    const outcome = {
      status: 'failed',
      code: String(code || 'unknown_failure').slice(0, 64),
      reason: String(reason || 'Unknown failure').slice(0, 500),
    };
    outcomes.set(candidate.jobKey, outcome);
    store.markEvaluationFailure(candidate.jobKey, outcome);
  };

  let fetched = 0;
  for (const candidate of candidates) {
    const existing = store.getJob(candidate.jobKey);
    const evaluationIsCurrent = existing?.evaluated_at &&
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
  const fetcher = createJobPageFetcher({
    store,
    cacheTtlMs: Number(config.scan.pageCacheHours) * 60 * 60 * 1000,
  });
  let runId = null;
  let runDetails = null;

  try {
    const sources = [];
    if (!options.retryOnly && !options.whatsappOnly && config.sources.ats?.enabled) sources.push('ats');
    if (!options.retryOnly && !options.atsOnly && config.sources.whatsapp?.enabled) sources.push('whatsapp');
    if (options.retryOnly) sources.push('retry');
    if (sources.length === 0) throw new Error('No job sources are enabled for this run');
    const window = scanWindow({ config, store, requestedDays: options.days, sources });
    if (!options.dryRun) {
      runId = store.startRun({ fromTs: window.from, toTs: window.to, sources });
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
    if (sources.includes('ats')) {
      sourceResults.push(await scanAts({
        store,
        lookbackHours: Math.ceil((window.to - window.from) / (60 * 60 * 1000)),
      }));
    }
    if (sources.includes('whatsapp')) {
      sourceResults.push(await scanWhatsApp({
        config,
        store,
        sinceMs: window.from,
        untilMs: window.to,
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
    const scorer = createJobScorer(config);
    const outcomes = await evaluateCandidates({ candidates, config, store, fetcher, scorer });
    runDetails.processing = summarizeProcessingResults(processingCandidates, outcomes);
    printProcessingSummary(runDetails.processing);
    if (runId) recordRunAudit(store, runId, runDetails);

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
      const openResult = await openJobUrls({ jobs: matchingJobs, application: config.browser?.application });
      if (!options.dryRun) store.markOpened(unpresentedJobs.map((job) => job.jobKey));
      console.log(`נפתחו ${openResult.opened} משרות ב-${config.browser?.application || 'Google Chrome'}.`);
    }

    const completionStatus = completionStatusFor(runDetails);
    if (runId) {
      store.recordRunEvent(runId, {
        source: 'system',
        scope: 'run',
        scopeKey: String(runId),
        stage: 'run',
        status: completionStatus,
      });
      store.finishRun(runId, { status: completionStatus, details: runDetails });
    }
    if (completionStatus === 'incomplete') {
      console.warn('⚠️ הריצה הסתיימה עם כיסוי חלקי; יש לעיין במשפך הקבוצות לפני הסקת מסקנות.');
    }
    console.log(`נסרקו ${candidates.length} מועמדות; נמצאו ${matchingJobs.length} משרות חדשות מתאימות.`);
  } catch (error) {
    if (runId) {
      store.recordRunEvent(runId, {
        source: 'system',
        scope: 'run',
        scopeKey: String(runId),
        stage: 'run',
        status: 'failed',
        details: { errorType: error.name || 'Error' },
      });
      store.finishRun(runId, { status: 'failed', error: error.message, details: runDetails });
    }
    throw error;
  } finally {
    await fetcher.close();
    store.close();
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
