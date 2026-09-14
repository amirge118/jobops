#!/usr/bin/env node

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { canonicalizeJobUrl } from './core.mjs';
import { loadJobsConfig } from './config.mjs';
import { createJobStore } from './store.mjs';

const MAX_LINKS = 5_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function manualMessageId(groupJid, canonicalUrl) {
  return `browser-history:${createHash('sha256')
    .update(groupJid).update('\0').update(canonicalUrl).digest('hex').slice(0, 40)}`;
}

export function importWhatsAppLinks({ config, store, groupName, links, importedAt = Date.now() } = {}) {
  const group = (config.sources.whatsapp?.groups || []).find((item) => item.name === groupName);
  if (!group?.jid) throw new Error(`WhatsApp group is not configured: ${groupName}`);
  if (!Array.isArray(links) || links.length > MAX_LINKS) {
    throw new Error('WhatsApp link import must contain an array of at most 5,000 links');
  }
  const timestamp = Number(importedAt);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new Error('WhatsApp link import timestamp must be a positive integer');
  }

  const seen = new Set();
  const result = { group: group.name, input: links.length, accepted: 0, queued: 0, duplicates: 0, rejected: 0 };
  for (const value of links) {
    if (typeof value !== 'string' || value.length > 4_096) {
      result.rejected += 1;
      continue;
    }
    const canonicalUrl = canonicalizeJobUrl(value.trim());
    if (!canonicalUrl) {
      result.rejected += 1;
      continue;
    }
    if (seen.has(canonicalUrl)) {
      result.duplicates += 1;
      continue;
    }
    seen.add(canonicalUrl);
    result.accepted += 1;
    const queued = store.queueWhatsAppMessage({
      messageId: manualMessageId(group.jid, canonicalUrl),
      groupJid: group.jid,
      timestamp,
      text: canonicalUrl,
    });
    result[queued ? 'queued' : 'duplicates'] += 1;
  }
  return result;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!['--group', '--file'].includes(key) || !argv[index + 1]) {
      throw new Error('Use: import-whatsapp-links.mjs --group <configured name> --file <JSON array>');
    }
    options[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  if (!options.group || !options.file) {
    throw new Error('Use: import-whatsapp-links.mjs --group <configured name> --file <JSON array>');
  }
  return options;
}

export function readLinkFile(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
    throw new Error('WhatsApp link import file must be a JSON file no larger than 2MB');
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('WhatsApp link import file must contain a JSON array');
  return parsed;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const config = loadJobsConfig();
  const store = createJobStore(config.jobsDbPath);
  try {
    const result = importWhatsAppLinks({
      config,
      store,
      groupName: options.group,
      links: readLinkFile(options.file),
    });
    console.log(`${result.group}: ${result.queued} queued, ${result.duplicates} duplicates, ${result.rejected} rejected.`);
  } finally {
    store.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { main(); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
