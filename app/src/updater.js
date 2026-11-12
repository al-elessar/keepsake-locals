/*
 * Keepsake desktop app - automatic updates.
 *
 * The repository also holds the browser extension's releases, so the app does not use
 * GitHub's "latest release". Instead, every app release publishes small update files
 * (latest.yml, latest-mac.yml, latest-linux.yml) on a permanent release named
 * "app-updates"; they point to the installer on that version's own release.
 *
 * Windows and Linux (AppImage): the update downloads in the background and is installed
 * when the app restarts. Mac: only a notice with a link, because macOS only allows
 * self-updating for apps signed with a paid Apple certificate.
 */
'use strict';
const { app } = require('electron');

const FEED = 'https://github.com/al-elessar/keepsake-locals/releases/download/app-updates/';
const RELEASES = 'https://github.com/al-elessar/keepsake-locals/releases';
const SIX_HOURS = 6 * 60 * 60 * 1000;

/**
 * send(state) is called with { state: 'available'|'downloading'|'ready'|'none'|'error', ... }
 * Returns { check(manual), install() }.
 */
function setupUpdates(send) {
  const testUrl = process.env.KEEPSAKE_TEST_UPDATE_URL;
  const enabled = app.isPackaged || Boolean(testUrl);
  const off = {
    enabled: false,
    check: async () => ({ state: 'off' }),
    install: () => {}
  };
  if (!enabled) return off;
  if (process.platform === 'linux' && !process.env.APPIMAGE && !testUrl) return off; // only the AppImage can update itself

  let autoUpdater;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (e) {
    return off;
  }
  const canInstall = process.platform !== 'darwin';
  autoUpdater.logger = null;
  autoUpdater.setFeedURL({ provider: 'generic', url: testUrl || FEED });
  if (testUrl) autoUpdater.forceDevUpdateConfig = true;
  autoUpdater.autoDownload = canInstall && !process.env.KEEPSAKE_TEST_NO_UPDATE_DOWNLOAD;
  autoUpdater.autoInstallOnAppQuit = canInstall;

  let last = { state: 'none' };
  const emit = (s) => {
    last = s;
    send(s);
  };
  autoUpdater.on('update-available', (info) =>
    emit({ state: 'available', version: info.version, canInstall, releases: RELEASES })
  );
  autoUpdater.on('update-not-available', () => emit({ state: 'none', version: app.getVersion() }));
  autoUpdater.on('download-progress', (p) =>
    emit({ state: 'downloading', version: last.version, percent: Math.round(p.percent || 0), canInstall })
  );
  autoUpdater.on('update-downloaded', (info) => emit({ state: 'ready', version: info.version, canInstall }));
  autoUpdater.on('error', (err) => emit({ state: 'error', message: String((err && err.message) || err).split('\n')[0].slice(0, 200) }));

  async function check() {
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      emit({ state: 'error', message: String(e.message || e).split('\n')[0].slice(0, 200) });
    }
    return last;
  }

  setTimeout(check, testUrl ? 1500 : 15000);
  setInterval(check, SIX_HOURS).unref();

  return {
    enabled: true,
    check,
    install: () => {
      if (last.state === 'ready') autoUpdater.quitAndInstall(false, true);
    }
  };
}

module.exports = { setupUpdates, FEED, RELEASES };
