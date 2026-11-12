/*
 * Keepsake – Downloader for Locals (unofficial) - page hook
 *
 * Runs in the page's own JavaScript context ("MAIN" world) at document_start,
 * before the Locals app loads. It watches the data the site already downloads
 * for the logged-in member and picks out:
 *   - video IDs   (v_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
 *   - post titles (best-effort, from text near each video ID)
 *   - the member's video token (the vt=... value on HLS playlist requests)
 *
 * It sends nothing over the network. Findings are passed to the extension's
 * content script with window.postMessage and stored locally in the browser.
 */
(() => {
  'use strict';

  if (window.__localsVideoSaverHooked) return;
  try {
    Object.defineProperty(window, '__localsVideoSaverHooked', { value: true });
  } catch (e) {
    /* ignore */
  }

  const VID_RE = /v_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  const VT_RE = /[?&]vt=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/;
  const TITLE_RE = /(?:"title"|\btitle)\s*:\s*"((?:[^"\\]|\\.){1,300})"/g;
  const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
  // Post dates: ISO strings or Unix timestamps under date-like keys (best-effort)
  const DATE_RE = /["']?\b(?:published|created|posted|post_?date|publish_?date|scheduled|date|timestamp|time)(?:_?at|_?on|_?date|_?time)?["']?\s*:\s*["']?(\d{4}-\d{2}-\d{2}(?:[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)?|\d{13}|\d{10})(?!\d)/gi;
  const TITLE_WINDOW = 2500; // characters either side of a video ID to search for its title or date
  const MAX_TEXT = 20 * 1024 * 1024;
  const MAX_SAMPLES = 5;

  // id -> { title, date, sure, dateSure } in discovery order. "sure" = found inside the
  // same post record as the video ID, rather than merely close to it.
  const found = new Map();
  const samples = [];
  let token = null;
  let timer = null;


  function redact(s) {
    return s.replace(/vt=[A-Za-z0-9_.-]+/g, 'vt=REDACTED').replace(JWT_RE, 'REDACTED_TOKEN');
  }

  function decodeJsString(s) {
    try {
      return JSON.parse('"' + s + '"');
    } catch (e) {
      return s;
    }
  }

  // Unescape one level of JSON-in-a-string so that \"title\":\"x\" is also matched.
  function normalise(text) {
    let t = text;
    if (t.includes('\\"')) t = t.replace(/\\"/g, '"');
    if (t.includes('\\/')) t = t.replace(/\\\//g, '/');
    return t;
  }

  function toIsoDate(raw) {
    let d;
    if (/^\d{13}$/.test(raw)) d = new Date(Number(raw));
    else if (/^\d{10}$/.test(raw)) d = new Date(Number(raw) * 1000);
    else d = new Date(raw.length === 10 ? raw + 'T12:00:00Z' : raw);
    if (isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    if (y < 2019 || y > new Date().getFullYear() + 1) return '';
    // Local date, matching what the site shows the member
    const pad = (n) => String(n).padStart(2, '0');
    return `${y}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // Walks text[from..to) counting {} and [] outside strings; returns the lowest
  // depth reached and the final depth (relative to the start).
  function depthPath(text, from, to) {
    let d = 0;
    let min = 0;
    let inStr = false;
    for (let i = from; i < to; i++) {
      const c = text.charCodeAt(i);
      if (inStr) {
        if (c === 92) i++; // backslash escape
        else if (c === 34) inStr = false;
        continue;
      }
      if (c === 34) inStr = true;
      else if (c === 123 || c === 91) d++;
      else if (c === 125 || c === 93) {
        d--;
        if (d < min) min = d;
      }
    }
    return { min, end: d };
  }

  // Does a value found at [vStart, vEnd) belong to the same record as the ID at [idStart, idEnd)?
  // Before the ID: its record must stay open until the ID. After the ID: it must sit in a
  // record that encloses the ID (not in a later sibling record).
  function sameRecord(text, vStart, vEnd, idStart, idEnd) {
    if (vEnd <= idStart) return depthPath(text, vEnd, idStart).min >= 0;
    let from = idEnd;
    if (text[idStart - 1] === '"' && text[idEnd] === '"') from++; // step out of the ID's own string
    const p = depthPath(text, from, vStart);
    return p.end === p.min;
  }

  // Finds the best value near a video ID: the closest one in the same record if there is
  // one, otherwise simply the closest.
  function nearestValue(text, idx, idLen, re, convert) {
    const start = Math.max(0, idx - TITLE_WINDOW);
    const slice = text.slice(start, idx + idLen + TITLE_WINDOW);
    re.lastIndex = 0;
    let best = '';
    let bestDist = Infinity;
    let bestSame = false;
    let m;
    while ((m = re.exec(slice))) {
      const value = convert(m[1]);
      if (!value) continue;
      const vStart = start + m.index;
      let vEnd = vStart + m[0].length;
      if (text[vEnd] === '"' || text[vEnd] === "'") vEnd++;
      const dist = vEnd <= idx ? idx - vEnd : vStart - (idx + idLen);
      const same = sameRecord(text, vStart, vEnd, idx, idx + idLen);
      if ((same && !bestSame) || (same === bestSame && dist < bestDist)) {
        best = value;
        bestDist = dist;
        bestSame = same;
      }
    }
    return { value: best, sure: bestSame };
  }

  const nearestTitle = (text, idx, len) => nearestValue(text, idx, len, TITLE_RE, (v) => decodeJsString(v).trim());
  const nearestDate = (text, idx, len) => nearestValue(text, idx, len, DATE_RE, toIsoDate);

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        window.postMessage(
          {
            __lvs: 'page',
            type: 'update',
            videos: Array.from(found.entries()).map(([id, v]) => [id, v.title, v.date, v.sure, v.dateSure]),
            token,
            samples: samples.slice()
          },
          location.origin
        );
      } catch (e) {
        /* ignore */
      }
    }, 400);
  }

  function setToken(t) {
    if (t && t !== token) {
      token = t;
      schedule();
    }
  }

  function scanUrl(url) {
    if (!url || typeof url !== 'string') return;
    const vt = url.match(VT_RE);
    if (vt) setToken(vt[1]);
    VID_RE.lastIndex = 0;
    let m;
    while ((m = VID_RE.exec(url))) {
      if (!found.has(m[0])) {
        found.set(m[0], { title: '', date: '', sure: false, dateSure: false });
        schedule();
      }
    }
  }

  function scanText(text) {
    if (!text || typeof text !== 'string' || text.length > MAX_TEXT) return;
    const vt = text.match(VT_RE);
    if (vt) setToken(vt[1]);
    if (!text.includes('v_')) return;
    // Raw text first: this keeps escaped quotes inside titles (Example \"quoted\" title) intact.
    let changed = scanPass(text);
    // JSON stored inside a string (\"title\":\"x\") is only readable once unescaped.
    if (text.includes('\\"')) changed = scanPass(normalise(text)) || changed;
    if (changed) schedule();
  }

  function scanPass(t) {
    VID_RE.lastIndex = 0;
    let m;
    let changed = false;
    while ((m = VID_RE.exec(t))) {
      const id = m[0];
      const known = found.get(id) || { title: '', date: '', sure: false, dateSure: false };
      const isNew = !found.has(id);
      if (!isNew && known.sure && known.dateSure) continue; // nothing more to learn
      const next = Object.assign({}, known);
      if (!known.sure) {
        // A title found inside the same post record beats one that was merely nearby.
        const r = nearestTitle(t, m.index, id.length);
        if (r.value && (r.sure || !known.title)) {
          next.title = r.value;
          next.sure = r.sure;
        }
      }
      if (!known.dateSure) {
        const r = nearestDate(t, m.index, id.length);
        if (r.value && (r.sure || !known.date)) {
          next.date = r.value;
          next.dateSure = r.sure;
        }
      }
      if (isNew || next.title !== known.title || next.date !== known.date || next.sure !== known.sure) {
        found.set(id, next);
        changed = true;
      }
      if (samples.length < MAX_SAMPLES && !samples.some((x) => x.id === id)) {
        samples.push({
          id,
          snippet: redact(t.slice(Math.max(0, m.index - 1500), m.index + 1500))
        });
      }
    }
    return changed;
  }

  function scanDocument() {
    try {
      scanText(document.documentElement ? document.documentElement.outerHTML : '');
    } catch (e) {
      /* ignore */
    }
  }

  function shouldScanResponse(res) {
    try {
      const ct = (res.headers && res.headers.get('content-type')) || '';
      if (/event-stream|video\/|audio\/|image\/|font\/|octet-stream|mp2t|mp4/i.test(ct)) return false;
      const len = Number((res.headers && res.headers.get('content-length')) || 0);
      if (len && len > MAX_TEXT) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  // --- fetch() hook -------------------------------------------------------
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    const hookedFetch = function (...args) {
      try {
        const input = args[0];
        scanUrl(typeof input === 'string' ? input : (input && input.url) || String(input));
      } catch (e) {
        /* ignore */
      }
      const p = origFetch.apply(this, args);
      p.then(
        (res) => {
          try {
            if (shouldScanResponse(res)) {
              res.clone().text().then(scanText, () => {});
            }
          } catch (e) {
            /* ignore */
          }
        },
        () => {}
      );
      return p;
    };
    try {
      Object.defineProperty(hookedFetch, 'name', { value: 'fetch' });
    } catch (e) {
      /* ignore */
    }
    window.fetch = hookedFetch;
  }

  // --- XMLHttpRequest hook ------------------------------------------------
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype && XHR.prototype.open) {
    const origOpen = XHR.prototype.open;
    XHR.prototype.open = function (method, url, ...rest) {
      try {
        scanUrl(String(url));
      } catch (e) {
        /* ignore */
      }
      try {
        this.addEventListener('load', () => {
          try {
            const rt = this.responseType;
            if (rt === '' || rt === 'text') scanText(this.responseText);
            else if (rt === 'json' && this.response) scanText(JSON.stringify(this.response));
          } catch (e) {
            /* ignore */
          }
        });
      } catch (e) {
        /* ignore */
      }
      return origOpen.call(this, method, url, ...rest);
    };
  }

  // --- initial page data and requests from the extension -----------------
  document.addEventListener('DOMContentLoaded', scanDocument);
  window.addEventListener('load', scanDocument);

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__lvs !== 'ext') return;
    if (ev.data.type === 'rescan') {
      scanDocument();
      schedule();
    }
  });
})();
