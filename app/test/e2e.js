/*
 * End-to-end test of the desktop app against the mock Locals server (test/e2e/).
 * Clicks through the real app: add community, Find all videos, token, tools,
 * download with yt-dlp, and the "token expired" (HTTP 403) handling.
 *
 * Run (Linux, needs python3, ffmpeg and a display, e.g. xvfb-run):  npm run test:e2e
 * Set KEEPSAKE_E2E_SCREENSHOTS=dir to save screenshots of the app.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { _electron: electron } = require('playwright-core');

const APP = path.join(__dirname, '..');
const MOCK = path.join(APP, '..', 'test', 'e2e', 'mock_locals_server.py');
const SHOTS = process.env.KEEPSAKE_E2E_SCREENSHOTS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

(async () => {
  execFileSync('node', [path.join(APP, '..', 'scripts', 'sync-core.js')]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keepsake-e2e-'));
  const out = path.join(tmp, 'Videos');
  // A Firefox profile that is signed in to Locals (a session cookie for the mock site)
  const ffRoot = path.join(tmp, 'firefox');
  const prof = path.join(ffRoot, 'Profiles', 'test.default-release');
  fs.mkdirSync(prof, { recursive: true });
  {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(prof, 'cookies.sqlite'));
    db.exec("CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER)");
    db.prepare('INSERT INTO moz_cookies (name, value, host, path, expiry, isSecure, isHttpOnly, sameSite) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('keepsake_test_session', 'from-firefox', '.locals.com', '/', Math.floor(Date.now() / 1000) + 86400, 0, 1, 1);
    db.close();
  }
  const mock = spawn('python3', [MOCK], { stdio: 'inherit' });
  await sleep(2500);
  let app;
  let ok = false;
  try {
    // Test machines (root, or Ubuntu runners that restrict user namespaces) can't use Chromium's sandbox.
    // KEEPSAKE_E2E_EXECUTABLE: test a packaged build (e.g. dist/linux-unpacked/keepsake-locals-app) instead.
    const packaged = process.env.KEEPSAKE_E2E_EXECUTABLE;
    const args = packaged ? ['--no-sandbox'] : ['--no-sandbox', APP];
    if (packaged) console.log('Testing the packaged app: ' + packaged);
    const env = Object.assign({}, process.env, {
        KEEPSAKE_TEST_DATA_DIR: path.join(tmp, 'data'),
        KEEPSAKE_TEST_HOST_RULES: 'MAP example.beta.locals.com 127.0.0.1:8765',
        KEEPSAKE_TEST_SCHEME: 'http',
        KEEPSAKE_TEST_HLS_BASE: 'http://127.0.0.1:8765/api/v1/posts/content/hls/',
        KEEPSAKE_TEST_FIREFOX_DIR: ffRoot,
        KEEPSAKE_TEST_UPDATE_URL: 'http://127.0.0.1:8765/updates/',
        KEEPSAKE_TEST_NO_UPDATE_DOWNLOAD: '1'
    });
    const launch = () => electron.launch({ executablePath: packaged || require('electron'), args, env });
    app = await launch();
    let win = await app.firstWindow();
    await win.setViewportSize({ width: 1180, height: 800 }).catch(() => {});
    await win.waitForSelector('#community');
    const shot = async (name) => SHOTS && win.screenshot({ path: path.join(SHOTS, name) });
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
    await shot('app-start.png');

    // 1) Add the community (a pasted link works) - this opens the Locals window
    await win.click('#addCommunity');
    await win.fill('#addInput', 'https://example.locals.com/feed');
    await win.click('#addConfirm');
    await until(async () => (await win.inputValue('#community')) === 'example', 5000, 'community added');
    console.log('community added: OK');

    // 1b) "Sign in with Google" is stopped with an explanation; the Firefox sign-in is reused instead
    const localsWin = await until(async () => app.windows().find((w) => w.url().includes('example.beta.locals.com')), 10000, 'Locals window');
    await localsWin.waitForSelector('#who');
    if ((await localsWin.textContent('#who')) !== 'not signed in') throw new Error('mock should start signed out');
    await localsWin.evaluate(() => document.getElementById('google').click()); // the navigation is cancelled on purpose
    await until(async () => (await win.isVisible('#notice')) && /Google doesn't allow/.test(await win.textContent('#noticeText')), 10000, 'Google notice');
    if (/accounts\.google\.com/.test(localsWin.url())) throw new Error('Google page should not open');
    console.log('Google sign-in stopped with an explanation: OK');

    // 1a) Links to other sites open in the normal browser, not inside the app
    const windowsBefore = app.windows().length;
    await localsWin.evaluate(() => document.getElementById('ext').click());
    await localsWin.evaluate(() => document.getElementById('extpopup').click());
    const opened = await until(() => app.evaluate(() => global.__keepsake.openedExternally.length === 2 && global.__keepsake.openedExternally), 5000, 'external links');
    if (!/from-a-post/.test(opened[0]) || !/new-tab/.test(opened[1])) throw new Error('external: ' + opened);
    if (!/example\.beta\.locals\.com/.test(localsWin.url()) || app.windows().length !== windowsBefore) throw new Error('external link opened inside the app');
    console.log('links to other sites open in the normal browser: OK');
    await shot('app-google-notice.png');
    await win.click('#noticeFirefox');
    await until(async () => /Done: signed in using Firefox/.test(await win.textContent('#noticeText')), 10000, 'Firefox import');
    await until(async () => (await localsWin.textContent('#who').catch(() => '')) === 'signed in', 10000, 'signed-in page');
    console.log('Firefox sign-in reused, Locals window signed in: OK');

    // 2) Find all videos
    await win.click('#findContent');
    const found = await until(async () => {
      const t = await win.textContent('#findMsg');
      return /Reached the end/.test(t) && t;
    }, 120000, 'Find all videos');
    console.log('find:', found);
    const rows = await win.$$eval('#list li', (lis) => lis.map((li) => li.querySelector('.title').textContent));
    const dated = await win.$$eval('#list .date', (d) => d.filter((x) => /^2026-10-\d\d$/.test(x.textContent)).length);
    if (rows.length !== 100 || !rows.every((t) => /^Example video \d{3}$/.test(t)) || dated !== 100) {
      throw new Error(`expected 100 titled, dated videos, got ${rows.length} (dated ${dated})`);
    }
    console.log('100 videos with titles and dates: OK');

    // 2b) Three videos are published; "Check for new videos" finds and marks them
    await fetch('http://127.0.0.1:8765/__add_new?n=3');
    if (await win.isHidden('#checkNew')) throw new Error('"Check for new videos" should show once videos are known');
    await win.click('#checkNew');
    const checked = await until(async () => {
      const t = await win.textContent('#findMsg');
      return /new video/.test(t) && t;
    }, 60000, 'Check for new videos');
    if (!/^3 new videos/.test(checked)) throw new Error('check: ' + checked);
    const newPills = await win.$$eval('#list .pill.new', (p) => p.length);
    if (newPills !== 3) throw new Error('NEW markers: ' + newPills);
    await win.click('#selNew');
    if (!/Download 3 videos/.test(await win.textContent('#download'))) throw new Error('New selection: ' + (await win.textContent('#download')));
    console.log('check found 3 new videos, marked NEW, "New" ticks them: OK');
    await win.click('#checkNew');
    await until(async () => /No new videos/.test(await win.textContent('#findMsg')), 60000, 'second check');
    if ((await win.$$eval('#list .pill.new', (p) => p.length)) !== 3) throw new Error('NEW should stay until downloaded');
    console.log('second check: no new videos, the 3 stay marked NEW: OK');

    // 3) Token: play a video in the Locals window
    const locals = app.windows().find((w) => w.url().includes('example.beta.locals.com'));
    await locals.evaluate('playOne()');
    await until(async () => /Token valid until/.test(await win.textContent('#chipToken')), 10000, 'token');
    console.log('token captured: OK');
    await shot('app-videos.png');

    // 4) Tools: download yt-dlp from GitHub (ffmpeg is already installed on this machine)
    await win.click('.tab[data-tab="settings"]');
    const installed = await until(async () => {
      const t = await win.textContent('#ytdlpStatus');
      if (/^✓/.test(t)) return t;
      if (!(await win.isDisabled('#installTools'))) await win.click('#installTools');
      const m = await win.textContent('#toolsMsg');
      if (/failed|mismatch|Could not/i.test(m)) throw new Error('tools: ' + m);
      return false;
    }, 240000, 'yt-dlp download');
    console.log('tools:', installed.trim(), '|', (await win.textContent('#ffmpegStatus')).trim());
    await shot('app-settings.png');
    await win.click('#checkUpdates');
    await until(async () => /9\.9\.9/.test(await win.textContent('#updateMsg')), 15000, 'update check');
    console.log('update check sees the newer version: OK');

    // 5) Download nine videos into a chosen folder
    await app.evaluate((_e, folder) => {
      global.__keepsake.store.data.folders = { example: folder };
    }, out);
    await win.click('.tab[data-tab="videos"]');
    await win.selectOption('#community', 'example'); // reload so the folder shows
    await win.fill('#filter', 'Example video 00');
    await win.click('#selShown');
    const label = await win.textContent('#download');
    if (!/Download 9 videos/.test(label)) throw new Error('selection: ' + label);
    await win.click('#download');
    await win.click('.tab[data-tab="downloads"]');
    await until(() => app.evaluate(() => global.__keepsake.downloader.summary().done === 9), 180000, '9 downloads');
    await shot('app-downloads.png');
    const files = fs.readdirSync(out).filter((f) => f.endsWith('.mp4')).sort();
    if (files.length !== 9 || !files.every((f) => /^2026-10-\d\d Example video 00\d\.mp4$/.test(f))) throw new Error('files: ' + files);
    const dur = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(out, files[0])]).toString().trim();
    if (!(Number(dur) > 1.5)) throw new Error('bad video duration ' + dur);
    console.log(`downloaded ${files.length} playable videos (${files[0]}, ${Number(dur).toFixed(1)} s): OK`);
    await win.click('.tab[data-tab="videos"]');
    await until(async () => (await win.$$eval('#list .pill.done', (p) => p.length)) === 9, 5000, '9 "saved" markers');
    console.log('list marks the 9 videos as saved: OK');

    // 6) Locals refuses a video (HTTP 403): the queue stops with a clear message
    await win.fill('#filter', 'Example video 100');
    await win.click('#selShown');
    await win.click('#download');
    await win.click('.tab[data-tab="downloads"]');
    const halted = await until(async () => (await win.isVisible('#halted')) && win.textContent('#halted'), 60000, 'halt on 403');
    if (!/403/.test(halted)) throw new Error('halt message: ' + halted);
    console.log('403 handling: OK');
    await shot('app-halted.png');

    // 7) Close and reopen: the list, choices and download history are all still there
    await app.close();
    app = await launch();
    win = await app.firstWindow();
    await win.waitForSelector('#community');
    await until(async () => (await win.textContent('#chipVideos')) === '103 videos', 10000, 'list after restart');
    await until(async () => (await win.$$eval('#list .pill.done', (p) => p.length)) === 9, 10000, 'saved markers after restart');
    const after = await app.evaluate(() => global.__keepsake.downloader.summary());
    if (after.done !== 9 || after.failed !== 1) throw new Error('queue after restart: ' + JSON.stringify(after));
    if (!/Token valid until/.test(await win.textContent('#chipToken'))) throw new Error('token lost on restart');
    console.log('after a restart: 103 videos, 9 saved, history and token kept: OK');
    ok = true;
  } catch (e) {
    console.error(e);
    if (app) {
      const dir = SHOTS || os.tmpdir();
      for (const [i, w] of app.windows().entries()) await w.screenshot({ path: path.join(dir, `failure-${i}.png`) }).catch(() => {});
      console.error(`Screenshots of each window: ${dir}/failure-*.png`);
    }
  } finally {
    if (app) await app.close().catch(() => {});
    mock.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(ok ? 'APP E2E PASSED' : 'APP E2E FAILED');
  process.exit(ok ? 0 : 1);
})();
