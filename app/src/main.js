/*
 * Keepsake – Downloader for Locals (unofficial) - desktop app, main process
 *
 * Two windows:
 *  - the app window (src/ui/), with the video list, downloads and settings;
 *  - the Locals window: the real Locals website, where the member signs in. The shared
 *    page hook (core/page-hook.js) reads the video list from it, exactly as the
 *    browser extension does. The password is typed into Locals' own page; the app only
 *    keeps the resulting session (cookies) in its data folder, like a browser would.
 */
'use strict';
const { app, BrowserWindow, ipcMain, session, dialog, shell, net } = require('electron');
const fs = require('fs');
const path = require('path');

const LVS = require('./core/generate.js');
const M = require('./core/merge.js');
const S = require('./core/autoscroll.js');
const { Store } = require('./store.js');
const { Tools } = require('./tools.js');
const { Downloader } = require('./downloader.js');
const { renameOld } = require('./library.js');
const { importFromFirefox } = require('./browser-cookies.js');
const { setupUpdates } = require('./updater.js');

// ------------------------------------------------------------------ test hooks
// Only used by the automated tests (a mock Locals server on this computer).
const TEST = {
  dataDir: process.env.KEEPSAKE_TEST_DATA_DIR,
  hostRules: process.env.KEEPSAKE_TEST_HOST_RULES,
  scheme: process.env.KEEPSAKE_TEST_SCHEME,
  hlsBase: process.env.KEEPSAKE_TEST_HLS_BASE
};
if (TEST.dataDir) app.setPath('userData', TEST.dataDir);
if (TEST.hostRules) app.commandLine.appendSwitch('host-resolver-rules', TEST.hostRules);
const SCHEME = TEST.scheme || 'https';
const HLS_BASE = TEST.hlsBase || 'https://webapi.locals.com/api/v1/posts/content/hls/';

const VERSION = app.getVersion();
const PARTITION = 'persist:locals';
const ICON = path.join(__dirname, 'ui', 'icon.png');
const HOOK_SOURCE = fs.readFileSync(path.join(__dirname, 'core', 'page-hook.js'), 'utf8');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });
}
if (process.platform === 'win32') app.setAppUserModelId('com.al-elessar.keepsake');

let store;
let tools;
let downloader;
let mainWin = null;
let localsWin = null;
let localsSession = null;
let scan = null; // { slug, stop }
let cookieFile = null;
let updates = null;
let updateState = { state: 'none' };

const send = (channel, payload) => {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('ev:' + channel, payload);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ communities

function communityUrl(slug, page) {
  if (!slug) return 'https://locals.com/';
  const base = `${SCHEME}://${slug}.beta.locals.com`;
  if (page === 'content') return `${base}/feed?mode=content`;
  if (page === 'feed') return `${base}/feed`;
  return `${base}/`;
}

/** "example", "example.locals.com" or a pasted link -> "example" */
function parseCommunity(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return null;
  try {
    if (/^[a-z]+:\/\//.test(s)) s = new URL(s).hostname;
  } catch (e) {
    return null;
  }
  s = s.replace(/\/.*$/, '');
  const slug = s.includes('.') ? M.slugFromHost(s) : s;
  return slug && /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) ? slug : null;
}

function stateOf(slug) {
  return store.community(slug) || M.newState(slug, `${slug}.beta.locals.com`);
}

const notifyTimers = {};
function notifyCommunity(slug) {
  if (notifyTimers[slug]) return;
  notifyTimers[slug] = setTimeout(() => {
    delete notifyTimers[slug];
    send('community', { slug, count: stateOf(slug).order.length });
  }, 400);
}

function communityList() {
  const slugs = new Set(Object.keys(store.data.communities));
  for (const s of store.data.known || []) slugs.add(s);
  return Array.from(slugs)
    .sort()
    .map((slug) => {
      const st = store.community(slug);
      return { slug, count: st ? st.order.length : 0 };
    });
}

function folderFor(slug) {
  return ((store.data.folders || {})[slug]) || store.options.folder || '';
}

// ------------------------------------------------------------------ the Locals window

function setupLocalsSession() {
  localsSession = session.fromPartition(PARTITION);
  // Look like the ordinary Chrome this is, without the "Electron" and app names.
  localsSession.setUserAgent(
    localsSession.getUserAgent().replace(/\s(?:Electron|Keepsake|keepsake-locals-app)\/\S+/g, '')
  );
  localsSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'fullscreen'));
  // Backup way of capturing the video token: the player's playlist request carries it.
  localsSession.webRequest.onBeforeRequest({ urls: ['*://*.locals.com/*'] }, (details, cb) => {
    try {
      const m = details.url.match(/[?&]vt=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
      if (m && localsWin && !localsWin.isDestroyed()) {
        const host = new URL(localsWin.webContents.getURL()).hostname;
        const slug = M.slugFromHost(host);
        if (slug) mergeInto(slug, host, { token: m[1] }, 'feed');
      }
    } catch (e) {
      /* ignore */
    }
    cb({});
  });
}

function mergeInto(slug, host, data, kind) {
  const state = M.upgradeState(store.community(slug), slug, host);
  if (M.mergeFindings(state, data, { kind, host })) {
    state.updated = Date.now();
    store.setCommunity(slug, state);
    notifyCommunity(slug);
  } else if (!store.community(slug)) {
    store.setCommunity(slug, state);
  }
}

// Google (and Apple) refuse to sign people in inside apps. Rather than show their error
// page, stop there and explain how to reuse the Firefox sign-in instead.
const BLOCKED_SIGN_IN = /^https:\/\/(accounts\.google\.com|appleid\.apple\.com)\//;

function blockedSignIn(url) {
  if (!BLOCKED_SIGN_IN.test(String(url))) return false;
  const who = /apple/.test(url) ? 'Apple' : 'Google';
  send('notice', {
    kind: 'browser-sign-in',
    text: `${who} doesn't allow signing in inside apps. Sign in to Locals in Firefox as usual, then click "Use my Firefox sign-in": Keepsake will reuse that sign-in.`
  });
  if (mainWin && !mainWin.isDestroyed()) mainWin.focus();
  return true;
}

function guardLocalsContents(wc) {
  wc.on('will-navigate', (e, url) => {
    if (!/^https?:\/\//.test(url) || blockedSignIn(url)) e.preventDefault();
  });
  wc.on('will-redirect', (e, url) => {
    if (blockedSignIn(url)) e.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (!/^https?:\/\//.test(url) || blockedSignIn(url)) return { action: 'deny' };
    // Other sign-in pop-ups stay in the app (same session); nothing else gets the Keepsake preload.
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false }
      }
    };
  });
  wc.on('did-create-window', (child) => guardLocalsContents(child.webContents));
}

function ensureLocalsWindow() {
  if (localsWin && !localsWin.isDestroyed()) return localsWin;
  localsWin = new BrowserWindow({
    width: 1150,
    height: 850,
    title: 'Locals – Keepsake',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'preload-locals.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false // keep loading while "Find all videos" runs in the background
    }
  });
  const wc = localsWin.webContents;
  guardLocalsContents(wc);
  const report = () => send('locals', { open: true, url: wc.getURL() });
  wc.on('did-navigate', report);
  wc.on('did-navigate-in-page', report);
  localsWin.on('closed', () => {
    localsWin = null;
    if (scan) scan.stop = true;
    send('locals', { open: false });
  });
  return localsWin;
}

async function openLocals(slug, page) {
  const win = ensureLocalsWindow();
  win.show();
  win.focus();
  try {
    await win.loadURL(communityUrl(slug, page));
  } catch (e) {
    /* redirects (e.g. to the sign-in page) can "abort" the first load: that's fine */
  }
}

/**
 * Scrolls a community's page to collect its videos.
 * quick: only look at the top of the page (the newest posts) - "Check for new videos".
 * Once a full scan has finished, videos that weren't known before are marked "new", and
 * stay marked until they are downloaded. (Before that, everything would look new.)
 */
async function findAll(slug, page, quick) {
  if (scan) return { error: 'Already looking for videos.' };
  scan = { slug, stop: false, quick: Boolean(quick) };
  const before = new Set(stateOf(slug).order);
  const hadFullScan = Boolean(store.data.scanned[slug]);
  const me = scan;
  try {
    await openLocals(slug, page || 'content');
    await sleep(2500); // let the page's own app start
    const win = localsWin;
    const step = (action) =>
      win && !win.isDestroyed()
        ? win.webContents.executeJavaScript(`(${S.scrollStep.toString()})(${JSON.stringify(action)})`).catch(() => 0)
        : Promise.resolve(0);
    const status = await S.autoScroll({
      step,
      count: () => stateOf(slug).order.length,
      sleep,
      isStopped: () => me.stop || !win || win.isDestroyed(),
      report: (st) => send('scroll', { slug, page, quick: Boolean(quick), status: st, count: stateOf(slug).order.length }),
      rescan: () => win && !win.isDestroyed() && win.webContents.send('locals:rescan')
    }, quick ? { maxRounds: 3 } : undefined);
    const fresh = hadFullScan ? stateOf(slug).order.filter((id) => !before.has(id)) : [];
    if (status === 'done' && !quick && !hadFullScan) {
      store.data.scanned[slug] = Date.now();
      store.save();
    }
    if (hadFullScan) {
      const done = store.list('downloaded', slug);
      const marked = new Set(Array.from(store.list('fresh', slug)).filter((id) => !done.has(id)));
      for (const id of fresh) marked.add(id);
      store.setList('fresh', slug, marked);
    }
    return { status, count: stateOf(slug).order.length, fresh: fresh.length, fullScan: Boolean(store.data.scanned[slug]) };
  } finally {
    scan = null;
  }
}

// ------------------------------------------------------------------ downloads

function prepare(item) {
  const state = store.community(item.slug);
  if (!state || !state.token) {
    throw new Error(
      `There is no video token for ${item.slug} yet. In the Locals window, play any video for a few seconds, then click "Resume all".`
    );
  }
  const exp = LVS.decodeTokenExpiry(state.token);
  if (exp && exp.getTime() < Date.now()) {
    throw new Error(
      `Your video token for ${item.slug} expired on ${exp.toLocaleDateString()}. In the Locals window, play any video for a few seconds, then click "Resume all".`
    );
  }
  return {
    url: `${HLS_BASE}${item.id}/source.m3u8?vt=${state.token}`,
    referer: `${SCHEME}://${state.host || item.slug + '.beta.locals.com'}/`
  };
}

/** Writes the Locals session cookies in the format yt-dlp reads (only if the option is on). */
async function cookies() {
  if (!store.options.useCookies) return null;
  const all = await localsSession.cookies.get({});
  const mine = all.filter((c) => /(^|\.)locals\.com$/.test(String(c.domain || '').replace(/^\./, '')));
  if (!mine.length) return null;
  const lines = ['# Netscape HTTP Cookie File', '# Written by Keepsake for yt-dlp. Deleted when downloads finish.'];
  for (const c of mine) {
    const domain = c.hostOnly ? c.domain : c.domain.startsWith('.') ? c.domain : '.' + c.domain;
    lines.push(
      [domain, domain.startsWith('.') ? 'TRUE' : 'FALSE', c.path || '/', c.secure ? 'TRUE' : 'FALSE', Math.floor(c.expirationDate || 0), c.name, c.value].join('\t')
    );
  }
  cookieFile = path.join(app.getPath('userData'), 'yt-dlp-cookies.txt');
  fs.writeFileSync(cookieFile, lines.join('\n') + '\n', { mode: 0o600 });
  return cookieFile;
}

function removeCookieFile() {
  if (cookieFile) fs.rmSync(cookieFile, { force: true });
  cookieFile = null;
}

function sendQueue() {
  const s = downloader.summary();
  if (!s.active && !s.waiting) removeCookieFile();
  send('queue', { items: store.data.queue, summary: s });
}

// ------------------------------------------------------------------ app window

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 820,
    minHeight: 560,
    title: 'Keepsake – Downloader for Locals',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-ui.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWin.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWin.on('close', (e) => {
    const s = downloader.summary();
    if (!s.active || app.isQuitting) return;
    const choice = dialog.showMessageBoxSync(mainWin, {
      type: 'question',
      buttons: ['Quit', 'Keep downloading'],
      defaultId: 1,
      cancelId: 1,
      message: `${s.active} download${s.active > 1 ? 's are' : ' is'} still running.`,
      detail: 'If you quit now, they will carry on from where they stopped next time you click "Resume all".'
    });
    if (choice === 1) e.preventDefault();
  });
  mainWin.on('closed', () => {
    mainWin = null;
    if (localsWin && !localsWin.isDestroyed()) localsWin.close();
  });
  mainWin.loadFile(path.join(__dirname, 'ui', 'index.html'));
}

// ------------------------------------------------------------------ actions from the app window

function handle(name, fn) {
  ipcMain.handle('ui:' + name, async (e, ...args) => {
    if (!mainWin || e.sender !== mainWin.webContents) throw new Error('Not allowed');
    return fn(...args);
  });
}

function registerActions() {
  // From the Locals window's preload
  ipcMain.on('locals:hook-source', (e) => {
    e.returnValue = e.sender.session === localsSession ? HOOK_SOURCE : '';
  });
  ipcMain.on('locals:findings', (e, msg) => {
    if (!localsWin || localsWin.isDestroyed() || e.sender !== localsWin.webContents || !msg) return;
    let u;
    try {
      u = new URL(msg.href);
    } catch (err) {
      return;
    }
    if (!/(^|\.)locals\.com$/.test(u.hostname)) return;
    const slug = M.slugFromHost(u.hostname);
    if (!slug) return;
    mergeInto(slug, u.hostname, msg.data || {}, M.pageKind(u.pathname + u.search));
  });

  handle('init', () => ({
    version: VERSION,
    platform: process.platform,
    options: store.options,
    communities: communityList(),
    localsOpen: Boolean(localsWin && !localsWin.isDestroyed())
  }));

  handle('getCommunity', (slug) => {
    const st = store.community(slug);
    return {
      slug,
      state: st ? Object.assign({}, st, { samples: undefined }) : M.newState(slug, `${slug}.beta.locals.com`),
      excluded: Array.from(store.list('excluded', slug)),
      downloaded: Array.from(store.list('downloaded', slug)),
      fresh: Array.from(store.list('fresh', slug)),
      folder: folderFor(slug),
      scanning: scan && scan.slug === slug ? scan : null
    };
  });

  handle('addCommunity', (input) => {
    const slug = parseCommunity(input);
    if (!slug) return { error: 'That doesn\'t look like a Locals community name or link (for example "example" or https://example.locals.com).' };
    store.data.known = Array.from(new Set([...(store.data.known || []), slug]));
    store.setOption('lastCommunity', slug);
    return { slug, communities: communityList() };
  });

  handle('removeCommunity', (slug) => {
    store.removeCommunity(slug);
    store.data.known = (store.data.known || []).filter((s) => s !== slug);
    if (store.data.folders) delete store.data.folders[slug];
    store.save();
    sendQueue();
    return { communities: communityList() };
  });

  handle('openLocals', (slug, page) => openLocals(slug, page));
  handle('findAll', (slug, page) => findAll(slug, page, false));
  handle('checkNew', (slug) => findAll(slug, 'content', true));
  handle('stopFind', () => {
    if (scan) scan.stop = true;
  });

  handle('setExcluded', (slug, ids) => store.setList('excluded', slug, new Set(ids || [])));
  handle('setOption', (key, value) => {
    store.setOption(key, value);
    if (key === 'parallel') downloader.pump();
    return store.options;
  });

  handle('chooseFolder', async (slug) => {
    const r = await dialog.showOpenDialog(mainWin, {
      title: 'Choose where to save the videos',
      defaultPath: folderFor(slug) || app.getPath('videos'),
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || !r.filePaths[0]) return null;
    store.data.folders = Object.assign({}, store.data.folders, { [slug]: r.filePaths[0] });
    store.save();
    return r.filePaths[0];
  });

  handle('chooseToolsFolder', async () => {
    const r = await dialog.showOpenDialog(mainWin, {
      title: 'Choose the folder that contains yt-dlp (and ffmpeg)',
      properties: ['openDirectory']
    });
    if (r.canceled || !r.filePaths[0]) return null;
    store.setOption('toolsFolder', r.filePaths[0]);
    return tools.status();
  });

  handle('download', (slug, ids) => {
    const state = store.community(slug);
    if (!state) return { error: 'No videos found for this community yet.' };
    const folder = folderFor(slug);
    if (!folder) return { needFolder: true };
    const o = store.options;
    const entries = LVS.buildEntries(state, { naming: o.naming, nameStyle: o.nameStyle, selected: new Set(ids) });
    const added = downloader.add(
      entries.map((e) => ({ slug, id: e.id, name: e.name, folder })),
      { quality: o.quality, fragments: o.fragments }
    );
    return { added, warning: state.token ? '' : 'No video token yet: play any video in the Locals window for a few seconds.' };
  });

  handle('queue', (action, key) => {
    const fn = { pause: 'pause', resume: 'resume', remove: 'remove', pauseAll: 'pauseAll', resumeAll: 'resumeAll', retryFailed: 'retryFailed', clearFinished: 'clearFinished' }[action];
    if (fn) downloader[fn](key);
    return { items: store.data.queue, summary: downloader.summary() };
  });

  handle('toolsStatus', () => tools.status());
  handle('toolsInstall', async (force) => {
    try {
      await tools.install((message) => send('tools', { message }), force);
      return { status: await tools.status() };
    } catch (e) {
      send('tools', { message: '' });
      return { error: e.message, status: await tools.status() };
    }
  });

  handle('openPath', (p) => {
    if (typeof p === 'string' && p && fs.existsSync(p)) return shell.openPath(p);
    return 'Folder not found';
  });
  handle('showFile', (p) => {
    if (typeof p === 'string' && p && fs.existsSync(p)) shell.showItemInFolder(p);
  });
  handle('openExternal', (url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
  });

  handle('renameOld', async (slug) => {
    const state = store.community(slug);
    if (!state) return { error: 'No videos found for this community yet.' };
    const r = await dialog.showOpenDialog(mainWin, {
      title: 'Choose the folder with videos named by ID (e.g. "001 v_9c750134-….mp4")',
      defaultPath: folderFor(slug) || undefined,
      properties: ['openDirectory']
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const o = store.options;
    return renameOld(LVS.buildEntries(state, { naming: o.naming, nameStyle: o.nameStyle }), r.filePaths[0]);
  });

  handle('exportScript', async (slug, kind) => {
    const state = store.community(slug);
    if (!state) return null;
    const o = store.options;
    const selected = new Set(state.order.filter((id) => !store.list('excluded', slug).has(id)));
    const opts = {
      folder: folderFor(slug),
      askFolder: !folderFor(slug),
      quality: o.quality,
      naming: o.naming,
      nameStyle: o.nameStyle,
      oldestFirst: o.oldestFirst,
      fragments: o.fragments,
      cookies: 'none',
      selected
    };
    const make = { bat: LVS.makeBat, sh: LVS.makeSh, renbat: LVS.makeRenameBat, rensh: LVS.makeRenameSh }[kind];
    if (!make) return null;
    const ext = kind.endsWith('bat') ? 'bat' : 'sh';
    const r = await dialog.showSaveDialog(mainWin, {
      title: 'Save script',
      defaultPath: path.join(app.getPath('downloads'), `keepsake-${slug}-${kind.startsWith('ren') ? 'rename' : 'download'}.${ext}`)
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, make(state, opts));
    return r.filePath;
  });

  handle('exportDebug', async (slug) => {
    const state = store.community(slug);
    if (!state) return null;
    const r = await dialog.showSaveDialog(mainWin, {
      title: 'Save debug info',
      defaultPath: path.join(app.getPath('downloads'), `keepsake-${slug}-debug.json`)
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, LVS.makeDebug(state, 'app ' + VERSION));
    return r.filePath;
  });

  handle('importFirefox', async () => {
    const r = await importFromFirefox(localsSession);
    if (!r.error) {
      if (localsWin && !localsWin.isDestroyed()) localsWin.webContents.reload();
      else openLocals(store.options.lastCommunity, 'home');
    }
    return r;
  });

  handle('checkUpdates', async () => (updates ? updates.check(true) : { state: 'off' }));
  handle('updateStatus', () => Object.assign({ enabled: Boolean(updates && updates.enabled), current: VERSION }, updateState));
  handle('installUpdate', () => {
    if (!updates) return;
    // Downloads carry on from where they stopped after the restart ("Resume all").
    app.isQuitting = true;
    updates.install();
  });

  handle('signOut', async () => {
    if (localsWin && !localsWin.isDestroyed()) localsWin.close();
    await localsSession.clearStorageData();
    await localsSession.clearCache();
    removeCookieFile();
    return true;
  });
}

// ------------------------------------------------------------------ start

app.whenReady().then(() => {
  const dataDir = app.getPath('userData');
  store = new Store(dataDir);
  tools = new Tools(path.join(dataDir, 'tools'), () => store.options, (url) => net.fetch(url));
  downloader = new Downloader({
    store,
    tools,
    prepare,
    cookies,
    onChange: sendQueue,
    onDone: (q) => {
      const done = store.list('downloaded', q.slug);
      done.add(q.id);
      store.setList('downloaded', q.slug, done);
      notifyCommunity(q.slug);
    }
  });
  setupLocalsSession();
  registerActions();
  createMainWindow();
  updates = setupUpdates((s) => {
    updateState = s;
    send('update', Object.assign({ current: VERSION }, s));
  });
  if (TEST.dataDir) global.__keepsake = { store, tools, downloader };
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (downloader) downloader.stopAll();
  if (store) store.flush();
  removeCookieFile();
});

app.on('window-all-closed', () => app.quit());
