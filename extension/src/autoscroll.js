/* GENERATED from core/autoscroll.js by scripts/sync-core.js - edit core/autoscroll.js, not this copy. */
/*
 * Keepsake – Downloader for Locals (unofficial) - "Find all videos"
 *
 * Scrolls the Locals page until nothing new loads. Shared by the browser extension
 * (content script) and the desktop app (main process).
 *
 *  - scrollStep(action) runs inside the page. It is self-contained so the app can
 *    send it to the page as text: '(' + scrollStep + ')("end")'.
 *  - autoScroll(io) is the loop. It only talks to the page through io.step(), so it
 *    works the same whether the page is in the same process or not.
 */
(function (root) {
  'use strict';

  /**
   * action: 'find'   choose the element that scrolls (the new layout may scroll an inner panel)
   *         'end'    scroll to the bottom
   *         'nudge'  scroll up a little (some pages only load more after a small scroll up and down)
   *         'height' just measure
   * Returns the scrollable height.
   */
  function scrollStep(action) {
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
    let s = window.__keepsakeScroller;
    if (!s || !s.isConnected || action === 'find') {
      s = findScroller();
      window.__keepsakeScroller = s;
    }
    if (action === 'end') {
      s.scrollTop = s.scrollHeight;
      if (s === document.scrollingElement) window.scrollTo(0, document.documentElement.scrollHeight);
    } else if (action === 'nudge') {
      s.scrollTop = Math.max(0, s.scrollHeight - s.clientHeight - 1200);
    }
    return s.scrollHeight;
  }

  /**
   * io: {
   *   step(action)  -> number | Promise<number>   (runs scrollStep in the page)
   *   count()       -> number of videos found so far
   *   sleep(ms)     -> Promise
   *   isStopped()   -> true when the member pressed Stop
   *   report(status)   'running' | 'done' | 'stopped'
   *   rescan()      ask the page hook to re-read the page
   * }
   * Stops after about 9 seconds with no new videos and no change in height.
   * Resolves to 'done' or 'stopped'.
   */
  async function autoScroll(io, options) {
    const o = Object.assign({ wait: 1500, nudgeWait: 600, maxRounds: 2000 }, options || {});
    io.report('running');
    let idle = 0;
    let lastCount = -1;
    let lastHeight = -1;
    await io.step('find');
    for (let round = 0; round < o.maxRounds && !io.isStopped(); round++) {
      await io.step('end');
      await io.sleep(o.wait);
      const count = io.count();
      const height = await io.step('height');
      if (count === lastCount && height === lastHeight) idle++;
      else idle = 0;
      lastCount = count;
      lastHeight = height;
      if (idle === 3) {
        await io.step('nudge');
        await io.sleep(o.nudgeWait);
        await io.step('find');
      }
      if (idle >= 6) break;
      io.report('running');
    }
    const status = io.isStopped() ? 'stopped' : 'done';
    io.rescan();
    await io.sleep(800);
    io.report(status);
    return status;
  }

  const KeepsakeScroll = { scrollStep, autoScroll };
  if (typeof module !== 'undefined' && module.exports) module.exports = KeepsakeScroll;
  root.KeepsakeScroll = KeepsakeScroll;
})(typeof globalThis !== 'undefined' ? globalThis : this);
