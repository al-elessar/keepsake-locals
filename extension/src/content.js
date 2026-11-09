/*
 * Keepsake – Downloader for Locals (unofficial) - content script (isolated world)
 *
 * Receives findings from page-hook.js and keeps them in extension storage,
 * grouped by community (the first part of the host name, e.g. "example" for
 * example.locals.com and example.beta.locals.com).
 *
 * The merging and scrolling logic lives in merge.js and autoscroll.js (copied from
 * core/, shared with the desktop app), which load before this file.
 */
(() => {
  'use strict';

  const api = globalThis.browser || globalThis.chrome;
  const M = globalThis.KeepsakeMerge;
  const S = globalThis.KeepsakeScroll;
  const host = location.hostname;
  const slug = M.slugFromHost(host);
  if (!slug) return;

  const KEY = 'community:' + slug;
  let state = null;
  let saveTimer = null;

  const ready = api.storage.local.get(KEY).then((r) => {
    state = M.upgradeState(r && r[KEY], slug, host);
  });

  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      state.updated = Date.now();
      api.storage.local.set({ [KEY]: state }).catch(() => {});
    }, 500);
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__lvs !== 'page') return;
    ready.then(() => {
      const kind = M.pageKind(location.pathname + location.search);
      if (M.mergeFindings(state, ev.data, { kind, host })) save();
    });
  });

  // ---- "Find all videos": scroll the page until nothing new loads -------
  const SCROLL_KEY = 'scroll:' + slug;
  let scrolling = null;

  function reportScroll(status) {
    const count = state ? state.order.length : 0;
    api.storage.local.set({ [SCROLL_KEY]: { status, count, at: Date.now() } }).catch(() => {});
  }

  const rescan = () => window.postMessage({ __lvs: 'ext', type: 'rescan' }, location.origin);

  async function autoScroll() {
    if (scrolling) return;
    await ready;
    scrolling = { stop: false };
    const me = scrolling;
    await S.autoScroll({
      step: S.scrollStep,
      count: () => state.order.length,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      isStopped: () => me.stop,
      report: reportScroll,
      rescan
    });
    scrolling = null;
  }

  api.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'lvs-rescan') {
      rescan();
    } else if (msg.type === 'lvs-autoscroll') {
      autoScroll();
    } else if (msg.type === 'lvs-stopscroll') {
      if (scrolling) scrolling.stop = true;
    }
  });
  window.addEventListener('pagehide', () => {
    if (scrolling) {
      scrolling.stop = true;
      reportScroll('stopped');
    }
  });
})();
