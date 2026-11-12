/*
 * Keepsake desktop app - reuse the Locals sign-in from Firefox.
 *
 * Google (and some other sign-in providers) refuse to sign people in inside apps.
 * So the member signs in to Locals in Firefox as usual, and Keepsake copies only the
 * locals.com cookies from their Firefox profile into its own Locals session, the same
 * thing yt-dlp's --cookies-from-browser firefox does. Nothing else is read, and the
 * password never passes through Keepsake.
 *
 * Firefox keeps cookies unencrypted in <profile>/cookies.sqlite. It locks that file
 * while running, so a copy is read (with its -wal journal, which holds recent changes).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Where Firefox keeps its profiles on this computer. */
function firefoxRoots() {
  if (process.env.KEEPSAKE_TEST_FIREFOX_DIR) return [process.env.KEEPSAKE_TEST_FIREFOX_DIR];
  const home = os.homedir();
  if (process.platform === 'win32') {
    return [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Mozilla', 'Firefox')];
  }
  if (process.platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'Firefox')];
  return [
    path.join(home, '.mozilla', 'firefox'),
    path.join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
    path.join(home, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox')
  ];
}

/** Profiles that have a cookie database, most recently used first. */
function findProfiles(roots) {
  const dirs = new Set();
  for (const root of roots || firefoxRoots()) {
    // Profiles listed in profiles.ini...
    try {
      const ini = fs.readFileSync(path.join(root, 'profiles.ini'), 'utf8');
      let rel = true;
      let p = null;
      const flush = () => p && dirs.add(rel ? path.join(root, p) : p);
      for (const line of ini.split(/\r?\n/)) {
        if (/^\[/.test(line)) {
          flush();
          p = null;
          rel = true;
        } else if (/^Path=/i.test(line)) {
          p = line.slice(5).trim();
        } else if (/^IsRelative=0/i.test(line)) {
          rel = false;
        }
      }
      flush();
    } catch (e) {
      /* no profiles.ini */
    }
    // ...and any others in the usual folders.
    for (const sub of ['Profiles', '.']) {
      try {
        for (const d of fs.readdirSync(path.join(root, sub))) dirs.add(path.join(root, sub, d));
      } catch (e) {
        /* folder missing */
      }
    }
  }
  const out = [];
  for (const dir of dirs) {
    const db = path.join(dir, 'cookies.sqlite');
    try {
      const st = fs.statSync(db);
      let mtime = st.mtimeMs;
      try {
        mtime = Math.max(mtime, fs.statSync(db + '-wal').mtimeMs);
      } catch (e) {
        /* no journal */
      }
      out.push({ dir, name: path.basename(dir), db, mtime });
    } catch (e) {
      /* not a profile */
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** Reads the locals.com cookies from one profile. */
function readLocalsCookies(profile) {
  const { DatabaseSync } = require('node:sqlite');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keepsake-ff-'));
  try {
    const copy = path.join(tmp, 'cookies.sqlite');
    fs.copyFileSync(profile.db, copy);
    if (fs.existsSync(profile.db + '-wal')) fs.copyFileSync(profile.db + '-wal', copy + '-wal');
    const db = new DatabaseSync(copy);
    try {
      const rows = db
        .prepare(
          "SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, originAttributes FROM moz_cookies WHERE host = 'locals.com' OR host = '.locals.com' OR host LIKE '%.locals.com'"
        )
        .all();
      const now = Date.now() / 1000;
      return rows
        .filter((r) => !r.originAttributes) // the normal tab, not containers or third-party partitions
        .map((r) => {
          let expiry = Number(r.expiry) || 0;
          if (expiry > 1e11) expiry = expiry / 1000; // newer Firefox versions store milliseconds
          return {
            host: String(r.host),
            name: String(r.name),
            value: String(r.value),
            path: String(r.path || '/'),
            expiry,
            secure: Boolean(r.isSecure),
            httpOnly: Boolean(r.isHttpOnly),
            sameSite: Number(r.sameSite)
          };
        })
        .filter((c) => !c.expiry || c.expiry > now);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const SAME_SITE = { 0: 'no_restriction', 1: 'lax', 2: 'strict' };

/**
 * Copies the Locals sign-in from the most recently used Firefox profile that has one
 * into an Electron session. Returns { count, profile } or { error }.
 */
async function importFromFirefox(electronSession, roots) {
  const profiles = findProfiles(roots);
  if (!profiles.length) {
    return { error: 'Firefox was not found on this computer (no Firefox profile with cookies).' };
  }
  for (const profile of profiles) {
    let cookies;
    try {
      cookies = readLocalsCookies(profile);
    } catch (e) {
      continue; // unreadable profile: try the next one
    }
    if (!cookies.length) continue;
    let count = 0;
    for (const c of cookies) {
      const hostOnly = !c.host.startsWith('.');
      const bare = c.host.replace(/^\./, '');
      const details = {
        url: `${c.secure ? 'https' : 'http'}://${bare}${c.path}`,
        name: c.name,
        value: c.value,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: SAME_SITE[c.sameSite] || 'unspecified'
      };
      if (!hostOnly) details.domain = c.host;
      if (c.expiry) details.expirationDate = c.expiry;
      try {
        await electronSession.cookies.set(details);
        count++;
      } catch (e) {
        /* skip a cookie Chromium won't accept */
      }
    }
    if (count) {
      await electronSession.cookies.flushStore();
      return { count, profile: profile.name };
    }
  }
  return {
    error:
      'No Locals sign-in was found in Firefox. Sign in to Locals in Firefox first (and leave "Remember me" on), then try again.'
  };
}

module.exports = { findProfiles, readLocalsCookies, importFromFirefox, firefoxRoots };
