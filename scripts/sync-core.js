#!/usr/bin/env node
/*
 * Copies the shared code in core/ to the places that use it.
 *
 *   node scripts/sync-core.js           copy core/ into extension/ and app/
 *   node scripts/sync-core.js --check   fail if the extension's copies are out of date (CI)
 *
 * The extension's copies are committed, because a browser extension can only load files
 * from its own folder (and "Load unpacked" should work straight from a download of the repo).
 * The app's copies (app/src/core/) are made at build time and are not committed.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXTENSION = {
  'page-hook.js': 'extension/src/page-hook.js',
  'merge.js': 'extension/src/merge.js',
  'autoscroll.js': 'extension/src/autoscroll.js',
  'generate.js': 'extension/popup/generate.js'
};
const APP_DIR = 'app/src/core';

const header = (name) => `/* GENERATED from core/${name} by scripts/sync-core.js - edit core/${name}, not this copy. */\n`;
const wanted = (name) => header(name) + fs.readFileSync(path.join(ROOT, 'core', name), 'utf8');

const check = process.argv.includes('--check');
let stale = 0;
for (const [name, rel] of Object.entries(EXTENSION)) {
  const dest = path.join(ROOT, rel);
  const want = wanted(name);
  const have = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
  if (have === want) continue;
  if (check) {
    console.error(`Out of date: ${rel} (run: node scripts/sync-core.js)`);
    stale++;
  } else {
    fs.writeFileSync(dest, want);
    console.log(`Updated ${rel}`);
  }
}
if (!check && fs.existsSync(path.join(ROOT, 'app'))) {
  const dir = path.join(ROOT, APP_DIR);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of Object.keys(EXTENSION)) fs.writeFileSync(path.join(dir, name), wanted(name));
  console.log(`Copied core/ to ${APP_DIR}/`);
}
if (stale) process.exit(1);
if (check) console.log('Extension copies of core/ are up to date.');
