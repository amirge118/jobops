#!/usr/bin/env node

// Read-only list of every WhatsApp group this account participates in (subject + jid),
// marking which ones config/jobs.yml already scans. Used to find the jid of a group
// right after joining it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { connectWhatsApp, disconnectWhatsApp } from './sources/whatsapp-client.mjs';
import { isCollectorServiceLoaded, pauseCollectorService, resumeCollectorService } from './collector-service.mjs';
import { loadJobsConfig } from './config.mjs';
import { loadEffectiveConfig } from './effective-config.mjs';
import { createJobStore } from './store.mjs';

const ACTIVE_COLLECTOR_STATUSES = ['starting', 'connecting', 'connected', 'reconnecting', 'pairing_required', 'unconfirmed'];

export function summarizeGroups(participating, configuredGroups = [], { filter = '' } = {}) {
  const configured = new Set(configuredGroups.map((group) => group.jid));
  const needle = filter.trim().toLowerCase();
  return Object.values(participating || {})
    .map((group) => ({
      jid: group.id,
      subject: group.subject || '',
      participants: group.participants?.length ?? null,
      configured: configured.has(group.id),
    }))
    .filter((group) => !needle || group.subject.toLowerCase().includes(needle) || group.jid.includes(needle))
    .sort((a, b) => Number(b.configured) - Number(a.configured) || a.subject.localeCompare(b.subject, 'he'));
}

export function formatGroupLine(group) {
  const size = group.participants === null ? '' : ` · ${group.participants} חברים`;
  return `${group.configured ? '✓' : ' '} ${group.subject || '(ללא שם)'} — ${group.jid}${size}`;
}

function parseArgs(argv) {
  const options = { filter: '', json: false, pauseCollector: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--pause-collector') options.pauseCollector = true;
    else if (arg === '--filter') options.filter = argv[++index] ?? '';
    else throw new Error(`Unknown argument: ${arg}. Use: [--filter TEXT] [--json] [--pause-collector]`);
  }
  return options;
}

async function fetchParticipating(authAbsPath) {
  // Signal session state is mutable even during a read-only call.
  // Work on a disposable copy so listing never modifies the real session.
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-wa-list-'));
  const tempAuthPath = path.join(tempRoot, 'auth');
  fs.cpSync(authAbsPath, tempAuthPath, { recursive: true });
  const sock = await connectWhatsApp(tempAuthPath);
  try {
    return await sock.groupFetchAllParticipating();
  } finally {
    await disconnectWhatsApp(sock);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = await loadEffectiveConfig();
  const whatsapp = config.sources.whatsapp;
  if (!whatsapp?.enabled) throw new Error('WhatsApp is disabled in config/jobs.yml');

  const store = createJobStore(config.jobsDbPath);
  const collector = await store.getCollectorStatus();
  store.close();
  const collectorActive = Boolean(collector && ACTIVE_COLLECTOR_STATUSES.includes(collector.status));
  const serviceLoaded = isCollectorServiceLoaded();

  // A second connection with the same session would disconnect the collector.
  if ((collectorActive || serviceLoaded) && !options.pauseCollector) {
    throw new Error('ה-Collector פעיל ומחזיק את חיבור ה-WhatsApp. הרץ שוב עם --pause-collector כדי לעצור אותו לזמן הקריאה ולהפעיל אותו מחדש בסיום.');
  }
  if (collectorActive && !serviceLoaded) {
    throw new Error(`Collector #${collector.id} רץ מחוץ לשירות (למשל בטרמינל). עצור אותו ידנית והרץ שוב.`);
  }

  let participating;
  if (serviceLoaded) {
    console.error('עוצר את ה-Collector לזמן הקריאה...');
    pauseCollectorService();
    try {
      participating = await fetchParticipating(whatsapp.authAbsPath);
    } finally {
      resumeCollectorService();
      console.error('ה-Collector הופעל מחדש.');
    }
  } else {
    participating = await fetchParticipating(whatsapp.authAbsPath);
  }

  const groups = summarizeGroups(participating, whatsapp.groups, options);
  if (options.json) {
    console.log(JSON.stringify(groups, null, 2));
    return;
  }
  for (const group of groups) console.log(formatGroupLine(group));
  const configuredCount = groups.filter((group) => group.configured).length;
  console.log(`\n${groups.length} קבוצות${options.filter ? ` תואמות "${options.filter}"` : ''}; ✓ = נסרקת (${configuredCount}).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`רשימת הקבוצות נכשלה: ${error.message}`);
      process.exit(1);
    });
}
