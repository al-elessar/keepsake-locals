#!/usr/bin/env node
/*
 * Prepares the update files for the "app-updates" release.
 *
 *   node scripts/update-feed.js <folder with latest*.yml> <version tag, e.g. app-v0.2.0>
 *
 * electron-builder writes latest.yml (Windows), latest-mac.yml and latest-linux.yml with
 * file names relative to where they are published. The installers live on the version's
 * own release, not on "app-updates", so the names are turned into full links to it.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = 'https://github.com/al-elessar/keepsake-locals/releases/download/';

function rewrite(text, tag) {
  const base = REPO + encodeURIComponent(tag) + '/';
  return text.replace(/^(\s*(?:- )?(?:url|path): )(\S+)$/gm, (line, key, name) =>
    /^https?:\/\//.test(name) ? line : key + base + encodeURIComponent(name.replace(/^['"]|['"]$/g, ''))
  );
}

if (require.main === module) {
  const [dir, tag] = process.argv.slice(2);
  if (!dir || !/^app-v\d+\.\d+\.\d+/.test(tag || '')) {
    console.error('Usage: node scripts/update-feed.js <folder> <app-vX.Y.Z>');
    process.exit(2);
  }
  const files = fs.readdirSync(dir).filter((f) => /^latest(-mac|-linux)?\.yml$/.test(f));
  if (!files.length) {
    console.error('No latest*.yml files found in ' + dir);
    process.exit(1);
  }
  for (const f of files) {
    const p = path.join(dir, f);
    fs.writeFileSync(p, rewrite(fs.readFileSync(p, 'utf8'), tag));
    console.log('Rewrote ' + f);
  }
}

module.exports = { rewrite };
