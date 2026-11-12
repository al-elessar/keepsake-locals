/* GENERATED from core/merge.js by scripts/sync-core.js - edit core/merge.js, not this copy. */
/*
 * Keepsake – Downloader for Locals (unofficial) - stored state for one community
 *
 * Shared by the browser extension (content script) and the desktop app (main process).
 * Pure functions: no browser or Node APIs.
 *
 * state = {
 *   schema, slug, host,
 *   videos: { id: { title, date, sure, dateSure, src: 'content'|'feed', n } },
 *   order:  [ids in discovery order],
 *   token, samples: [{ id, snippet }], updated
 * }
 */
(function (root) {
  'use strict';

  const SCHEMA = 2; // bump when title/date detection improves, so old guesses can be replaced
  const ID_RE = /^v_[0-9a-f-]{36}$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  /** The community name is the first part of the host: example.beta.locals.com -> example */
  function slugFromHost(host) {
    const slug = String(host || '').split('.')[0];
    return slug && slug !== 'www' && slug !== 'locals' ? slug : null;
  }

  /** Where a video was seen: the Content page, or elsewhere (the Feed, a single post...). */
  function pageKind(pathAndQuery) {
    return /mode=content|\/content(\/|$|\?)/.test(String(pathAndQuery || '')) ? 'content' : 'feed';
  }

  function newState(slug, host) {
    return {
      schema: SCHEMA,
      slug,
      host,
      videos: {},
      order: [],
      token: null,
      samples: [],
      updated: 0
    };
  }

  /** Accepts saved state (or nothing) and returns state that is safe to merge into. */
  function upgradeState(saved, slug, host) {
    if (!saved) return newState(slug, host);
    if (saved.schema !== SCHEMA) {
      // Keep everything, but let the improved detection overwrite earlier titles and dates.
      for (const v of Object.values(saved.videos || {})) {
        v.sure = false;
        v.dateSure = false;
      }
      saved.schema = SCHEMA;
    }
    saved.videos = saved.videos || {};
    saved.order = saved.order || [];
    saved.samples = saved.samples || [];
    return saved;
  }

  /**
   * Merges one message from the page hook into state.
   * data: { videos: [[id, title, date, sure, dateSure]], token, samples }
   * ctx:  { kind: 'content'|'feed', host }
   * Returns true when something changed.
   */
  function mergeFindings(state, data, ctx) {
    const c = ctx || {};
    const kind = c.kind || 'feed';
    let changed = false;
    if (data && Array.isArray(data.videos)) {
      for (const pair of data.videos) {
        const id = pair && pair[0];
        const title = (pair && typeof pair[1] === 'string' && pair[1]) || '';
        const date = (pair && DATE_RE.test(pair[2] || '') && pair[2]) || '';
        if (typeof id !== 'string' || !ID_RE.test(id)) continue;
        const sure = Boolean(pair[3]);
        const dateSure = Boolean(pair[4]);
        const existing = state.videos[id];
        if (!existing) {
          state.videos[id] = { title, date, sure, dateSure, src: kind, n: state.order.length };
          state.order.push(id);
          changed = true;
          continue;
        }
        if (kind === 'content' && existing.src !== 'content') {
          existing.src = 'content';
          changed = true;
        }
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
    if (data && typeof data.token === 'string' && data.token && data.token !== state.token) {
      state.token = data.token;
      changed = true;
    }
    if (data && Array.isArray(data.samples)) {
      for (const s of data.samples) {
        if (state.samples.length >= 5) break;
        if (s && s.id && !state.samples.some((x) => x.id === s.id)) {
          state.samples.push({ id: String(s.id), snippet: String(s.snippet || '').slice(0, 4000) });
          changed = true;
        }
      }
    }
    if (c.host && state.host !== c.host && c.host.includes('.beta.')) {
      state.host = c.host; // prefer the beta host for the Referer header
      changed = true;
    }
    return changed;
  }

  const KeepsakeMerge = { SCHEMA, slugFromHost, pageKind, newState, upgradeState, mergeFindings };
  if (typeof module !== 'undefined' && module.exports) module.exports = KeepsakeMerge;
  root.KeepsakeMerge = KeepsakeMerge;
})(typeof globalThis !== 'undefined' ? globalThis : this);
