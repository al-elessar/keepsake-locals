/*
 * Keepsake – Downloader for Locals (unofficial) - content script (isolated world)
 *
 * Receives findings from page-hook.js and keeps them in extension storage,
 * grouped by community (the first part of the host name, e.g. "dap2k" for
 * dap2k.locals.com and dap2k.beta.locals.com).
 */
(() => {
  'use strict';

  const api = globalThis.browser || globalThis.chrome;
  const host = location.hostname;
  const slug = host.split('.')[0];
  if (!slug || slug === 'www' || slug === 'locals') return;

  const KEY = 'community:' + slug;
  let state = null;
  let saveTimer = null;

  const SCHEMA = 2; // bump when title/date detection improves, so old guesses can be replaced

  const ready = api.storage.local.get(KEY).then((r) => {
    const saved = r && r[KEY];
    if (saved && saved.schema !== SCHEMA) {
      // Keep everything, but let the improved detection overwrite earlier titles and dates.
      for (const v of Object.values(saved.videos || {})) {
        v.sure = false;
        v.dateSure = false;
      }
      saved.schema = SCHEMA;
    }
    state = saved || {
      schema: SCHEMA,
      slug,
      host,
      videos: {}, // id -> { title, n }
      order: [], // ids in discovery order
      token: null,
      samples: [],
      updated: 0
    };
  });

  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      state.updated = Date.now();
      api.storage.local.set({ [KEY]: state }).catch(() => {});
    }, 500);
  }

  // Where a video was seen: the Content page, or elsewhere (the Feed, a single post...).
  const pageKind = () => (/mode=content|\/content(\/|$|\?)/.test(location.pathname + location.search) ? 'content' : 'feed');

  function merge(data) {
    let changed = false;
    const kind = pageKind();
    if (Array.isArray(data.videos)) {
      for (const pair of data.videos) {
        const id = pair && pair[0];
        const title = (pair && pair[1]) || '';
        const date = (pair && /^\d{4}-\d{2}-\d{2}$/.test(pair[2] || '') && pair[2]) || '';
        if (typeof id !== 'string' || !/^v_[0-9a-f-]{36}$/.test(id)) continue;
        const existing = state.videos[id];
        if (!existing) {
          state.videos[id] = { title, date, sure: Boolean(pair[3]), dateSure: Boolean(pair[4]), src: kind, n: state.order.length };
          state.order.push(id);
          changed = true;
        } else {
          if (kind === 'content' && existing.src !== 'content') {
            existing.src = 'content';
            changed = true;
          }
          const sure = Boolean(pair[3]);
          const dateSure = Boolean(pair[4]);
          if (title && sure && title === existing.title && !existing.sure) {
            existing.sure = true;
            changed = true;
          }
          if (title && title !== existing.title && (!existing.title || (sure && !existing.sure))) {
            existing.title = title;
            existing.sure = sure;
            changed = true;
          }
          if (date && date !== existing.date && (!existing.date || (dateSure && !existing.dateSure))) {
            existing.date = date;
            existing.dateSure = dateSure;
            changed = true;
          }
        }
      }
    }
    if (typeof data.token === 'string' && data.token && data.token !== state.token) {
      state.token = data.token;
      changed = true;
    }
    if (Array.isArray(data.samples)) {
      for (const s of data.samples) {
        if (state.samples.length >= 5) break;
        if (s && s.id && !state.samples.some((x) => x.id === s.id)) {
          state.samples.push({ id: String(s.id), snippet: String(s.snippet || '').slice(0, 4000) });
          changed = true;
        }
      }
    }
    if (state.host !== host && host.includes('.beta.')) {
      state.host = host; // prefer the beta host for the Referer header
      changed = true;
    }
    if (changed) save();
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__lvs !== 'page') return;
    ready.then(() => merge(ev.data));
  });

  // ---- "Find all videos": scroll the page until nothing new loads -------
  const SCROLL_KEY = 'scroll:' + slug;
  let scrolling = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function reportScroll(status) {
    const count = state ? state.order.length : 0;
    api.storage.local.set({ [SCROLL_KEY]: { status, count, at: Date.now() } }).catch(() => {});
  }

  // The new layout may scroll an inner panel rather than the window: use whichever
  // element actually has the most to scroll.
  function findScroller() {
    let best = document.scrollingElement || document.documentElement;
    let bestExtra = best.scrollHeight - best.clientHeight;
    for (const el of document.querySelectorAll('main, section, div')) {
      const extra = el.scrollHeight - el.clientHeight;
      if (extra > bestExtra + 200) {
        const oy = getComputedStyle(el).overflowY;
        if (oy === 'auto' || oy === 'scroll') {
          best = el;
          bestExtra = extra;
        }
      }
    }
    return best;
  }

  async function autoScroll() {
    if (scrolling) return;
    await ready;
    scrolling = { stop: false };
    reportScroll('running');
    let idle = 0;
    let lastCount = -1;
    let lastHeight = -1;
    let scroller = findScroller();
    for (let round = 0; round < 2000 && !scrolling.stop; round++) {
      scroller.scrollTop = scroller.scrollHeight;
      if (scroller === document.scrollingElement) window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(1500);
      const count = state.order.length;
      const height = scroller.scrollHeight;
      if (count === lastCount && height === lastHeight) idle++;
      else idle = 0;
      lastCount = count;
      lastHeight = height;
      if (idle === 3) {
        // Nudge: some pages only load more after a small scroll up and down
        scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight - 1200);
        await sleep(600);
        scroller = findScroller();
      }
      if (idle >= 6) break;
      reportScroll('running');
    }
    const stopped = scrolling.stop;
    scrolling = null;
    window.postMessage({ __lvs: 'ext', type: 'rescan' }, location.origin);
    await sleep(800);
    reportScroll(stopped ? 'stopped' : 'done');
  }

  api.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'lvs-rescan') {
      window.postMessage({ __lvs: 'ext', type: 'rescan' }, location.origin);
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
