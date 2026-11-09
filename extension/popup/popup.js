/* Keepsake – Downloader for Locals (unofficial) - popup */
(() => {
  'use strict';

  const api = globalThis.browser || globalThis.chrome;
  const LVS = globalThis.LVS;
  const VERSION = api.runtime.getManifest().version;
  const isFirefox = navigator.userAgent.includes('Firefox');
  const $ = (id) => document.getElementById(id);

  let communities = {}; // slug -> state
  let current = null; // slug
  let activeTabId = null;
  let slugOfTab = null; // community of the open tab, if it is a Locals page
  let tabUrl = '';
  let excluded = new Set(); // unticked video IDs for the current community (new videos start ticked)
  let lastClickedIndex = null; // for Shift-click ranges
  let shownIds = []; // IDs currently visible in the list (after search)

  const OPTION_IDS = ['folder', 'quality', 'order', 'naming', 'nameStyle', 'cookies', 'fragments'];
  let exported = new Set(); // IDs included in a script downloaded before

  function msg(text) {
    $('msg').textContent = text || '';
  }

  function showScroll(info) {
    const el = $('scrollmsg');
    const running = info && info.status === 'running' && Date.now() - info.at < 15000;
    $('findall').style.display = running ? 'none' : '';
    $('stopscroll').style.display = running ? '' : 'none';
    if (!info) {
      el.textContent = '';
    } else if (running) {
      el.textContent = `Scrolling the page… ${info.count} videos so far. You can close this popup.`;
    } else if (info.status === 'done') {
      el.textContent = /mode=content|\/content/.test(tabUrl)
        ? `Reached the end of the page: ${info.count} videos. Tip: open the Feed and click Find all videos there too, to catch videos posted outside the Content page.`
        : `Reached the end of the page: ${info.count} videos.`;
    } else if (info.status === 'stopped') {
      el.textContent = `Stopped at ${info.count} videos.`;
    }
  }

  function stateNow() {
    return current ? communities[current] : null;
  }

  function selectedSet() {
    const s = stateNow();
    if (!s) return new Set();
    return new Set(s.order.filter((id) => !excluded.has(id)));
  }

  function getOpts() {
    return {
      folder: $('folder').value,
      quality: $('quality').value,
      oldestFirst: $('order').value === 'oldest',
      naming: $('naming').value,
      nameStyle: $('nameStyle').value,
      cookies: $('cookies').value,
      fragments: $('fragments').value,
      askFolder: $('askFolder').checked,
      selected: selectedSet()
    };
  }

  async function loadOptions() {
    const r = await api.storage.local.get('options');
    const o = (r && r.options) || {};
    $('folder').value = o.folder || '';
    $('quality').value = o.quality || '';
    $('order').value = o.order || 'newest';
    $('naming').value = o.naming || 'date';
    $('nameStyle').value = o.nameStyle || 'plain';
    $('cookies').value = o.cookies || (isFirefox ? 'firefox' : 'none');
    $('fragments').value = o.fragments || 4;
    $('askFolder').checked = o.askFolder !== false;
  }

  function saveOptions() {
    const o = {};
    for (const id of OPTION_IDS) o[id] = $(id).value;
    o.askFolder = $('askFolder').checked;
    api.storage.local.set({ options: o });
  }

  async function loadExcluded() {
    excluded = new Set();
    exported = new Set();
    if (!current) return;
    const key = 'excluded:' + current;
    const ekey = 'exported:' + current;
    const r = await api.storage.local.get([key, ekey]);
    if (r && Array.isArray(r[key])) excluded = new Set(r[key]);
    if (r && Array.isArray(r[ekey])) exported = new Set(r[ekey]);
  }

  function markExported(ids) {
    for (const id of ids) exported.add(id);
    api.storage.local.set({ ['exported:' + current]: Array.from(exported) });
  }

  function saveExcluded() {
    if (!current) return;
    api.storage.local.set({ ['excluded:' + current]: Array.from(excluded) });
  }

  async function loadCommunities() {
    const all = await api.storage.local.get(null);
    communities = {};
    for (const [k, v] of Object.entries(all || {})) {
      if (k.startsWith('community:') && v && v.slug) communities[v.slug] = v;
    }
  }

  function renderHeader() {
    const sel = $('community');
    const slugs = Object.keys(communities);
    if (current && !slugs.includes(current)) slugs.push(current); // open tab with nothing found yet
    slugs.sort();
    sel.innerHTML = '';
    if (!slugs.length) {
      const opt = document.createElement('option');
      opt.textContent = 'No community yet';
      sel.appendChild(opt);
      sel.disabled = true;
    } else {
      sel.disabled = false;
      for (const s of slugs) {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s;
        sel.appendChild(opt);
      }
      sel.value = current;
    }
  }

  function renderStatus() {
    const state = stateNow();
    const count = state ? state.order.length : 0;
    const titled = state ? state.order.filter((id) => (state.videos[id] || {}).title).length : 0;
    $('count').textContent = count;
    $('titled').textContent = count ? `(${titled} with titles)` : '';

    const tokenEl = $('tokenText');
    tokenEl.className = '';
    if (state && state.token) {
      const exp = LVS.decodeTokenExpiry(state.token);
      if (exp && exp.getTime() < Date.now()) {
        tokenEl.textContent = `expired on ${exp.toLocaleDateString()} - play any video to refresh it`;
        tokenEl.className = 'warn';
      } else {
        tokenEl.textContent = exp ? `captured (valid until ${exp.toLocaleDateString()})` : 'captured';
        tokenEl.className = 'ok';
      }
    } else {
      tokenEl.textContent = 'not captured yet - play any video for a few seconds';
      tokenEl.className = 'warn';
    }

    const nSel = selectedSet().size;
    $('selcount').textContent = count ? `${nSel} of ${count} selected` : '';
    const ready = Boolean(state && count && state.token && nSel);
    for (const id of ['bat', 'sh', 'copy']) $(id).disabled = !ready;
    for (const id of ['renbat', 'rensh']) $(id).disabled = !(state && count);
    const label = nSel === count ? `all ${count}` : `${nSel}`;
    $('bat').textContent = `Download Windows script (.bat) - ${label} videos`;
    $('sh').textContent = `Download Mac/Linux script (.sh) - ${label} videos`;
    const nNew = state ? state.order.filter((id) => !exported.has(id)).length : 0;
    $('selnew').textContent = exported.size ? `New (${nNew})` : 'New';
    $('selnew').disabled = !exported.size;
    $('findall').disabled = activeTabId === null || slugOfTab !== current;
    $('debug').disabled = !state;
    $('clear').disabled = !state;
    $('help').style.display = state && count && state.token ? 'none' : '';
    $('pick').style.display = count ? '' : 'none';
  }

  function renderList() {
    const state = stateNow();
    const list = $('list');
    const scroll = list.scrollTop;
    list.innerHTML = '';
    shownIds = [];
    if (!state) return;
    const q = $('filter').value.trim().toLowerCase();
    const entries = LVS.buildEntries(state, { oldestFirst: $('order').value === 'oldest' });
    const frag = document.createDocumentFragment();
    for (const e of entries) {
      const title = (state.videos[e.id] || {}).title || '';
      if (q && !title.toLowerCase().includes(q) && !e.id.includes(q)) continue;
      const index = shownIds.length;
      shownIds.push(e.id);
      const li = document.createElement('li');
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !excluded.has(e.id);
      cb.dataset.id = e.id;
      cb.dataset.index = String(index);
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = e.num;
      const t = document.createElement('span');
      t.textContent = title || `(no title) ${e.id}`;
      if (!title) t.className = 'notitle';
      label.append(cb, num);
      if (e.date) {
        const d = document.createElement('span');
        d.className = 'date';
        d.textContent = e.date;
        label.append(d);
      }
      label.append(t);
      if (e.src === 'feed') {
        const f = document.createElement('span');
        f.className = 'feed';
        f.title = 'Found on the Feed, not on the Content page';
        f.textContent = 'FEED';
        label.append(f);
      }
      if (exported.size && !exported.has(e.id)) {
        const n = document.createElement('span');
        n.className = 'isnew';
        n.textContent = 'NEW';
        label.append(n);
      }
      li.appendChild(label);
      frag.appendChild(li);
    }
    list.appendChild(frag);
    list.scrollTop = scroll;
  }

  function renderAll() {
    renderHeader();
    renderStatus();
    renderList();
  }

  function setTicked(ids, ticked) {
    for (const id of ids) {
      if (ticked) excluded.delete(id);
      else excluded.add(id);
    }
    saveExcluded();
  }

  // Saves straight to the Downloads folder. No "Save as" window: in Firefox that window
  // closes the popup, which cancels the download ("Failed").
  async function download(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    let downloadId = null;
    const fallback = async (why) => {
      try {
        await navigator.clipboard.writeText(content);
        msg(`Couldn't save the file (${why}). The script has been copied instead: paste it into Notepad and save it as ${filename}.`);
      } catch (e) {
        msg(`Couldn't save the file (${why}).`);
      }
    };
    const onChanged = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete') {
        msg(`Saved ${filename} to your Downloads folder.`);
        cleanup();
      } else if (delta.state.current === 'interrupted') {
        fallback((delta.error && delta.error.current) || 'interrupted');
        cleanup();
      }
    };
    const cleanup = () => {
      api.downloads.onChanged.removeListener(onChanged);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    api.downloads.onChanged.addListener(onChanged);
    try {
      downloadId = await api.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
      msg(`Saving ${filename}…`);
    } catch (e) {
      cleanup();
      fallback(e && e.message ? e.message : String(e));
    }
  }

  function wire() {
    $('community').addEventListener('change', async (e) => {
      current = e.target.value;
      lastClickedIndex = null;
      await loadExcluded();
      renderAll();
      const r = await api.storage.local.get('scroll:' + current);
      showScroll(r && r['scroll:' + current]);
    });
    for (const id of OPTION_IDS) {
      $(id).addEventListener('change', () => {
        saveOptions();
        if (id === 'order' || id === 'naming' || id === 'nameStyle') renderList();
      });
    }
    $('askFolder').addEventListener('change', saveOptions);
    $('filter').addEventListener('input', () => {
      lastClickedIndex = null;
      renderList();
    });

    // Tick boxes (one listener for the whole list; Shift-click ticks a range)
    $('list').addEventListener('click', (ev) => {
      const cb = ev.target;
      if (!(cb instanceof HTMLInputElement) || cb.type !== 'checkbox') return;
      const index = Number(cb.dataset.index);
      if (ev.shiftKey && lastClickedIndex !== null) {
        const [a, b] = [Math.min(lastClickedIndex, index), Math.max(lastClickedIndex, index)];
        const ids = shownIds.slice(a, b + 1);
        setTicked(ids, cb.checked);
        for (const box of $('list').querySelectorAll('input[type="checkbox"]')) {
          const i = Number(box.dataset.index);
          if (i >= a && i <= b) box.checked = cb.checked;
        }
      } else {
        setTicked([cb.dataset.id], cb.checked);
      }
      lastClickedIndex = index;
      renderStatus();
    });
    $('selall').addEventListener('click', () => {
      excluded.clear();
      saveExcluded();
      renderStatus();
      renderList();
    });
    $('selnone').addEventListener('click', () => {
      const s = stateNow();
      if (!s) return;
      setTicked(s.order, false);
      renderStatus();
      renderList();
    });
    $('selshown').addEventListener('click', () => {
      // Tick only what the search shows, untick everything else
      const s = stateNow();
      if (!s) return;
      const shown = new Set(shownIds);
      excluded = new Set(s.order.filter((id) => !shown.has(id)));
      saveExcluded();
      renderStatus();
      renderList();
    });

    $('selnew').addEventListener('click', () => {
      const s = stateNow();
      if (!s) return;
      excluded = new Set(s.order.filter((id) => exported.has(id)));
      saveExcluded();
      renderStatus();
      renderList();
    });
    $('findall').addEventListener('click', () => {
      api.tabs.sendMessage(activeTabId, { type: 'lvs-autoscroll' }).catch(() => {
        $('scrollmsg').textContent = 'Could not reach the page. Reload the Locals tab (F5) and try again.';
      });
      showScroll({ status: 'running', count: (stateNow() || { order: [] }).order.length, at: Date.now() });
    });
    $('stopscroll').addEventListener('click', () => {
      api.tabs.sendMessage(activeTabId, { type: 'lvs-stopscroll' }).catch(() => {});
    });

    $('bat').addEventListener('click', () => {
      const s = stateNow();
      const o = getOpts();
      download(LVS.makeBat(s, o), `keepsake-${s.slug}-download.bat`, 'text/plain');
      markExported(o.selected);
    });
    $('sh').addEventListener('click', () => {
      const s = stateNow();
      const o = getOpts();
      download(LVS.makeSh(s, o), `keepsake-${s.slug}-download.sh`, 'text/x-shellscript');
      markExported(o.selected);
    });
    $('renbat').addEventListener('click', () => {
      const s = stateNow();
      download(LVS.makeRenameBat(s, getOpts()), `keepsake-${s.slug}-rename.bat`, 'text/plain');
    });
    $('rensh').addEventListener('click', () => {
      const s = stateNow();
      download(LVS.makeRenameSh(s, getOpts()), `keepsake-${s.slug}-rename.sh`, 'text/x-shellscript');
    });
    $('copy').addEventListener('click', async () => {
      const s = stateNow();
      try {
        await navigator.clipboard.writeText(LVS.makeUrlList(s, getOpts()));
        msg('Video links copied. They contain your token - keep them private.');
      } catch (e) {
        msg('Could not copy to the clipboard.');
      }
    });
    $('debug').addEventListener('click', () => {
      const s = stateNow();
      download(LVS.makeDebug(s, VERSION), `keepsake-${s.slug}-debug.json`, 'application/json');
    });
    $('clear').addEventListener('click', async () => {
      if (!current) return;
      await api.storage.local.remove(['community:' + current, 'excluded:' + current, 'exported:' + current, 'scroll:' + current]);
      exported.clear();
      delete communities[current];
      excluded.clear();
      msg('Cleared.');
      renderAll();
    });

    api.storage.onChanged.addListener(async (changes, area) => {
      if (area !== 'local') return;
      const sc = changes['scroll:' + current];
      if (sc && sc.newValue) showScroll(sc.newValue);
      if (Object.keys(changes).some((k) => k.startsWith('community:'))) {
        await loadCommunities();
        renderHeader();
        renderStatus();
        renderList();
      }
    });
  }

  async function init() {
    await loadOptions();
    wire();
    try {
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url) {
        const u = new URL(tab.url);
        if (/(^|\.)locals\.com$/.test(u.hostname)) {
          current = u.hostname.split('.')[0];
          slugOfTab = current;
          activeTabId = tab.id;
          tabUrl = tab.url;
        }
      }
    } catch (e) {
      /* ignore */
    }
    await loadCommunities();
    if (!current) current = Object.keys(communities).sort()[0] || null;
    await loadExcluded();
    renderAll();
    if (current) {
      const r = await api.storage.local.get('scroll:' + current);
      showScroll(r && r['scroll:' + current]);
    }
    if (activeTabId !== null && !/mode=content|\/content/.test(tabUrl)) {
      $('scrollmsg').textContent = 'Tip: Find all videos works best on the Content page; run it on the Feed too to catch videos in ordinary posts.';
    }
    if (activeTabId !== null) {
      // Ask the page to re-read its current contents, in case data arrived before the hook saw it.
      api.tabs.sendMessage(activeTabId, { type: 'lvs-rescan' }).catch(() => {});
    }
  }

  init();
})();
