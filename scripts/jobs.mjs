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
  return {
    days,
    atsOnly: argv.includes('--ats-only'),
    whatsappOnly: argv.includes('--whatsapp-only'),
    open: argv.includes('--open'),
    dryRun: argv.includes('--dry-run'),
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

export function summarizeSourceResults(sourceResults) {
  const ats = sourceResults.find((result) => result.source === 'ats');
  const whatsapp = sourceResults.find((result) => result.source === 'whatsapp');
  const groups = (whatsapp?.groups || []).map((group) => ({
    name: group.name,
    found: Boolean(group.found),
    messages: Number(group.messages || 0),
    candidates: Number(group.candidates || 0),
    error: group.error || null,
  }));
  const whatsappMessages = groups.reduce((total, group) => total + group.messages, 0);
  const whatsappDiagnostics = {
    historyEvents: Number(whatsapp?.diagnostics?.historyEvents || 0),
    upsertEvents: Number(whatsapp?.diagnostics?.upsertEvents || 0),
    deliveredMessages: Number(whatsapp?.diagnostics?.messages || 0),
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
      groups,
      ingress: {
        queued: Number(whatsapp.ingress?.queued || 0),
        duplicates: Number(whatsapp.ingress?.duplicates || 0),
        ignored: Number(whatsapp.ingress?.ignored || 0),
        rejected: Number(whatsapp.ingress?.rejected || 0),
      },
      diagnostics: whatsappDiagnostics,
      warning: groups.length > 0 && whatsappMessages === 0
        ? 'WhatsApp history לא הוחזרה באף קבוצה; החיבור תקין אך כיסוי הודעות עבר אינו מובטח.'
        : null,
    } : null,
  };
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
      console.log(`  ${marker} ${group.name}: ${group.messages} הודעות, ${group.candidates} קישורים${suffix}`);
    }
    const diagnostics = summary.whatsapp.diagnostics;
    console.log(`  סנכרון: ${diagnostics.deliveredMessages} הודעות נמסרו מהשירות (${diagnostics.historyEvents} אירועי history, ${diagnostics.upsertEvents} אירועי live).`);
    if (summary.whatsapp.warning) console.warn(`⚠️ ${summary.whatsapp.warning}`);
  }
}

function reportPaths(reportsDir, generatedAt) {
  const stamp = generatedAt.toISOString().replace(/[:.]/g, '-');
  return {
    dated: path.join(reportsDir, `${stamp}.md`),
    latest: path.join(reportsDir, 'latest.md'),
  };
}

async function evaluateCandidates({ candidates, config, store, fetcher, scorer }) {
  const pendingScores = [];
  for (const candidate of candidates) {
    const page = await fetcher.fetch(candidate.url);
    if (!store.needsEvaluation(candidate.jobKey, {
      contentHash: page.contentHash,
      profileHash: scorer.profileHash,
      criteriaVersion: config.decision.criteriaVersion,
      activeStatus: page.status,
    })) continue;

    if (page.status !== 'active') {
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
      continue;
    }

    pendingScores.push({ candidate, page });
  }

  const results = await scorer.scoreBatch(pendingScores);
  for (const result of results) {
    const item = pendingScores.find(({ candidate }) => candidate.jobKey === result.jobKey);
    if (!item) throw new Error(`Scorer returned an unexpected job: ${result.jobKey}`);
    store.saveEvaluation(result.jobKey, {
      ...result,
      contentHash: item.page.contentHash,
      profileHash: scorer.profileHash,
      criteriaVersion: config.decision.criteriaVersion,
      evaluatedAt: Date.now(),
    });
  }
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
    if (!options.whatsappOnly && config.sources.ats?.enabled) sources.push('ats');
    if (!options.atsOnly && config.sources.whatsapp?.enabled) sources.push('whatsapp');
    if (sources.length === 0) throw new Error('No job sources are enabled for this run');
    const window = scanWindow({ config, store, requestedDays: options.days, sources });
    if (!options.dryRun) runId = store.startRun({ fromTs: window.from, toTs: window.to, sources });

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
    printSourceSummary(runDetails);
    const candidates = uniqueCandidates(sourceResults.flatMap((result) => result.candidates));
    const scorer = createJobScorer(config);
    await evaluateCandidates({ candidates, config, store, fetcher, scorer });

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

    if (runId) store.finishRun(runId, { status: 'success', details: runDetails });
    console.log(`נסרקו ${candidates.length} מועמדות; נמצאו ${matchingJobs.length} משרות חדשות מתאימות.`);
  } catch (error) {
    if (runId) store.finishRun(runId, { status: 'failed', error: error.message, details: runDetails });
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
