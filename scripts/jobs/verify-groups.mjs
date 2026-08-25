#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { connectWhatsApp, disconnectWhatsApp } from './sources/whatsapp-client.mjs';
import { verifyConfiguredGroups } from './sources/whatsapp.mjs';
import { loadJobsConfig } from './config.mjs';

async function main() {
  const config = loadJobsConfig();
  const whatsapp = config.sources.whatsapp;
  if (!whatsapp?.enabled) throw new Error('WhatsApp is disabled in config/jobs.yml');

  // Signal session state is mutable even during a read-only membership check.
  // Work on a disposable copy so verification never modifies the real session.
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jobops-wa-verify-'));
  const tempAuthPath = path.join(tempRoot, 'auth');
  fs.cpSync(whatsapp.authAbsPath, tempAuthPath, { recursive: true });
  const sock = await connectWhatsApp(tempAuthPath);
  try {
    const groups = await verifyConfiguredGroups(config, sock);
    for (const group of groups) {
      const status = group.found ? '✓' : '✗';
      const liveName = group.liveName && group.liveName !== group.name ? ` (ב-WhatsApp: ${group.liveName})` : '';
      console.log(`${status} ${group.name}${liveName}`);
    }
    const missing = groups.filter((group) => !group.found);
    if (missing.length) throw new Error(`${missing.length} מתוך ${groups.length} קבוצות לא נמצאו`);
    console.log(`כל ${groups.length} הקבוצות המוגדרות נמצאו.`);
  } finally {
    await disconnectWhatsApp(sock);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`בדיקת הקבוצות נכשלה: ${error.message}`);
    process.exit(1);
  });
