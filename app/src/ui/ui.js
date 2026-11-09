/* Keepsake desktop app - user interface (talks to the app through window.keepsake) */
(() => {
  'use strict';

  const K = window.keepsake;
  const LVS = window.LVS; // core/generate.js: the same naming and sorting as the extension
  const $ = (id) => document.getElementById(id);

  let info = null;
  let current = null; // community slug
  let comm = null; // { state, excluded, downloaded, folder }
  let excluded = new Set();
  let downloaded = new Set();
  let queue = [];
  let queueSummary = {};
  let shownIds = [];
  let lastClickedIndex = null;
  let rowPills = new Map(); // video id -> pill element
  let toolsOk = true;
  let scanning = false;

  // ------------------------------------------------------------------ helpers

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function msg(id, text, cls) {
    const e = $(id);
    e.textContent = text || '';
    e.className = cls || 'muted';
  }

  const state = () => (comm ? comm.state : null);
  const selected = () => {
    const s = state();
    return s ? s.order.filter((id) => !excluded.has(id)) : [];
  };

  function debounce(fn, ms) {
    let t = null;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  }

  // ------------------------------------------------------------------ tabs

  function showTab(name) {
    for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === name);
    for (const p of document.querySelectorAll('.tabpage')) p.hidden = p.id !== 'tab-' + name;
    if (name === 'downloads') renderQueue();
    if (name === 'settings') refreshTools();
  }

  // ------------------------------------------------------------------ communities

  function renderCommunities(list) {
    const sel = $('community');
    sel.innerHTML = '';
    if (!list.length) {
      const o = el('option', null, 'No community yet');
      o.value = '';
      sel.appendChild(o);
      sel.disabled = true;
    } else {
      sel.disabled = false;
      for (const c of list) {
        const o = el('option', null, c.count ? `${c.slug}  (${c.count})` : c.slug);
        o.value = c.slug;
        sel.appendChild(o);
      }
      sel.value = current || '';
    }
  }

  async function loadCommunity() {
    if (!current) {
      comm = null;
      excluded = new Set();
      downloaded = new Set();
    } else {
      comm = await K.getCommunity(current);
      excluded = new Set(comm.excluded);
      downloaded = new Set(comm.downloaded);
    }
    lastClickedIndex = null;
    renderAll();
  }

  // ------------------------------------------------------------------ status

  function renderStatus() {
    const s = state();
    const count = s ? s.order.length : 0;
    $('chipVideos').textContent = `${count} video${count === 1 ? '' : 's'}`;
    const chip = $('chipToken');
    const help = $('tokenHelp');
    help.hidden = true;
    chip.className = 'chip';
    if (!current) {
      chip.textContent = 'Token: –';
    } else if (s && s.token) {
      const exp = LVS.decodeTokenExpiry(s.token);
      if (exp && exp.getTime() < Date.now()) {
        chip.textContent = `Token expired ${exp.toLocaleDateString('en-GB')}`;
        chip.className = 'chip warn';
        help.textContent = 'Your video token has expired. In the Locals window, play any video for a few seconds to renew it.';
        help.hidden = false;
      } else {
        chip.textContent = exp ? `Token valid until ${exp.toLocaleDateString('en-GB')}` : 'Token captured';
        chip.className = 'chip ok';
      }
    } else {
      chip.textContent = 'Token: not yet';
      chip.className = 'chip warn';
      if (count) {
        help.textContent = 'One more step: in the Locals window, play any video for a few seconds, so that your access token is picked up.';
        help.hidden = false;
      }
    }

    $('welcome').hidden = Boolean(current && count);
    $('findContent').disabled = !current || scanning;
    $('findFeed').disabled = !current || scanning;
    $('findContent').hidden = scanning;
    $('stopFind').hidden = !scanning;

    const n = selected().length;
    $('selCount').textContent = count ? `${n} of ${count} ticked` : '';
    $('download').textContent = n ? `Download ${n === count ? 'all ' : ''}${n} video${n === 1 ? '' : 's'}` : 'Download';
    $('download').disabled = !n;
    $('folder').value = comm ? comm.folder || '' : '';
    $('selNotDone').disabled = !downloaded.size;
    for (const id of ['renameOld', 'exportBat', 'exportSh', 'exportDebug', 'removeCommunity']) $(id).disabled = !current || !count;
    $('removeCommunity').disabled = !current;
  }

  // ------------------------------------------------------------------ video list

  function queueStatus(id) {
    const q = queue.find((x) => x.key === `${current}:${id}`);
    return q || null;
  }

  function setPill(pill, id) {
    const q = queueStatus(id);
    pill.hidden = false;
    if (q && q.status === 'downloading') {
      pill.className = 'pill active';
      pill.textContent = `DOWNLOADING ${Math.floor(q.percent || 0)}%`;
    } else if (q && (q.status === 'queued' || q.status === 'waiting')) {
      pill.className = 'pill active';
      pill.textContent = 'QUEUED';
    } else if (q && q.status === 'paused') {
      pill.className = 'pill';
      pill.textContent = 'PAUSED';
    } else if (q && q.status === 'failed') {
      pill.className = 'pill failed';
      pill.textContent = 'FAILED';
    } else if (downloaded.has(id)) {
      pill.className = 'pill done';
      pill.textContent = '✓ SAVED';
    } else {
      pill.hidden = true;
    }
  }

  function renderList() {
    const s = state();
    const list = $('list');
    const scroll = list.scrollTop;
    list.innerHTML = '';
    shownIds = [];
    rowPills = new Map();
    $('empty').hidden = Boolean(s && s.order.length);
    if (!s || !s.order.length) return;
    const q = $('filter').value.trim().toLowerCase();
    const entries = LVS.buildEntries(s, { oldestFirst: $('order').value === 'oldest' });
    const frag = document.createDocumentFragment();
    for (const e of entries) {
      const title = (s.videos[e.id] || {}).title || '';
      if (q && !title.toLowerCase().includes(q) && !e.id.includes(q)) continue;
      const index = shownIds.length;
      shownIds.push(e.id);
      const li = el('li');
      const label = el('label');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = !excluded.has(e.id);
      cb.dataset.id = e.id;
      cb.dataset.index = String(index);
      label.append(cb, el('span', 'num', e.num), el('span', 'date', e.date || ''));
      label.append(el('span', title ? 'title' : 'title notitle', title || `(no title) ${e.id}`));
      if (e.src === 'feed') {
        const f = el('span', 'pill', 'FEED');
        f.title = 'Found on the Feed, not on the Content page';
        label.append(f);
      }
      const pill = el('span', 'pill');
      setPill(pill, e.id);
      rowPills.set(e.id, pill);
      label.append(pill);
      li.appendChild(label);
      frag.appendChild(li);
    }
    list.appendChild(frag);
    list.scrollTop = scroll;
  }

  function updatePills() {
    for (const [id, pill] of rowPills) setPill(pill, id);
  }

  function renderAll() {
    renderStatus();
    renderList();
  }

  const saveExcluded = debounce(() => current && K.setExcluded(current, Array.from(excluded)), 300);

  function setTicked(ids, ticked) {
    for (const id of ids) {
      if (ticked) excluded.delete(id);
      else excluded.add(id);
    }
    saveExcluded();
  }

  // ------------------------------------------------------------------ downloads tab

  const STATUS_TEXT = {
    queued: 'Waiting',
    waiting: 'Will try again shortly',
    downloading: 'Downloading',
    paused: 'Paused',
    failed: 'Failed',
    done: 'Saved'
  };

  function queueButton(text, action, key, cls) {
    const b = el('button', 'small' + (cls ? ' ' + cls : ''), text);
    b.addEventListener('click', () => K.queue(action, key).then(applyQueue));
    return b;
  }

  function renderQueue() {
    const ul = $('queue');
    const s = queueSummary;
    $('qEmpty').hidden = queue.length > 0;
    const parts = [];
    if (s.active) parts.push(`${s.active} downloading`);
    if (s.waiting) parts.push(`${s.waiting} waiting`);
    if (s.paused) parts.push(`${s.paused} paused`);
    if (s.done) parts.push(`${s.done} saved`);
    if (s.failed) parts.push(`${s.failed} failed`);
    $('qSummary').textContent = parts.join(' · ');
    $('halted').hidden = !s.halted;
    $('halted').textContent = s.halted || '';
    $('resumeAll').disabled = !s.paused && !s.halted;
    $('pauseAll').disabled = !s.active && !s.waiting;
    $('retryFailed').disabled = !s.failed;
    $('clearFinished').disabled = !s.done;
    $('tabDlCount').textContent = s.active || s.waiting ? String(s.active + s.waiting) : '';
    if ($('tab-downloads').hidden) return;

    // Reuse rows where possible: progress updates arrive several times a second.
    const existing = new Map(Array.from(ul.children).map((li) => [li.dataset.key, li]));
    const frag = document.createDocumentFragment();
    // What needs attention first: downloading, failed, waiting, paused; finished last.
    const rank = { downloading: 0, failed: 1, waiting: 2, queued: 2, paused: 3, done: 4 };
    const ordered = queue.slice().sort((a, b) => (rank[a.status] ?? 5) - (rank[b.status] ?? 5));
    for (const q of ordered) {
      let li = existing.get(q.key);
      const sig = `${q.status}|${q.file || ''}|${q.error || ''}`;
      if (!li || li.dataset.sig !== sig) {
        li = el('li', q.status);
        li.dataset.key = q.key;
        li.dataset.sig = sig;
        const name = el('div', 'qname', q.name);
        name.title = `${q.name}\n${q.folder}`;
        const bar = el('div', 'bar');
        bar.appendChild(el('i'));
        const inf = el('div', 'qinfo');
        const btns = el('div', 'qbtns');
        if (q.status === 'downloading' || q.status === 'queued' || q.status === 'waiting') btns.append(queueButton('Pause', 'pause', q.key));
        if (q.status === 'paused') btns.append(queueButton('Resume', 'resume', q.key));
        if (q.status === 'failed') btns.append(queueButton('Retry', 'resume', q.key));
        if (q.status === 'done' && q.file) {
          const b = el('button', 'small', 'Show file');
          b.addEventListener('click', () => K.showFile(q.file));
          btns.append(b);
        }
        if (q.status !== 'downloading') {
          const rm = queueButton('✕', 'remove', q.key);
          rm.title = 'Remove from the list (files already saved are kept)';
          btns.append(rm);
        }
        li.append(name, btns, bar, inf);
      }
      li.querySelector('.bar > i').style.width = `${q.status === 'done' ? 100 : q.percent || 0}%`;
      const inf = li.querySelector('.qinfo');
      inf.innerHTML = '';
      inf.append(el('span', null, STATUS_TEXT[q.status] || q.status));
      if (q.status === 'downloading') {
        inf.append(el('span', null, `${(q.percent || 0).toFixed(1)}%`));
        if (q.speed) inf.append(el('span', null, q.speed));
        if (q.eta) inf.append(el('span', null, `${q.eta} left`));
      }
      if (q.status === 'done' && q.already) inf.append(el('span', null, 'already in the folder'));
      if (q.error && q.status !== 'done') inf.append(el('span', 'err', q.error));
      frag.appendChild(li);
    }
    ul.innerHTML = '';
    ul.appendChild(frag);
  }

  function applyQueue(payload) {
    if (!payload) return;
    queue = payload.items || [];
    queueSummary = payload.summary || {};
    renderQueue();
    updatePills();
  }

  // ------------------------------------------------------------------ tools

  function describeTool(t, what) {
    if (!t) return { text: `✗ Not installed`, ok: false };
    const where = { app: 'downloaded by Keepsake', custom: `your copy in ${t.path}`, path: `found at ${t.path}` }[t.source];
    return { text: `✓ ${what} ${t.version} (${where})`, ok: true };
  }

  async function refreshTools(status) {
    const st = status || (await K.toolsStatus());
    const y = describeTool(st.ytdlp, 'version');
    const f = describeTool(st.ffmpeg, 'version');
    $('ytdlpStatus').textContent = y.text;
    $('ytdlpStatus').className = y.ok ? 'ok' : 'warn';
    $('ffmpegStatus').textContent = f.text;
    $('ffmpegStatus').className = f.ok ? 'ok' : 'warn';
    if (!st.ffmpeg && !st.canFetchFfmpeg) {
      $('ffmpegStatus').textContent += ' – on a Mac, install it with Homebrew: brew install ffmpeg';
    }
    toolsOk = Boolean(st.ytdlp && st.ffmpeg);
    $('installTools').disabled = toolsOk || st.busy;
    $('updateYtdlp').disabled = !st.canFetchYtdlp || st.busy;
    $('tabToolsWarn').hidden = toolsOk;
    return st;
  }

  async function installTools(force) {
    $('installTools').disabled = true;
    $('updateYtdlp').disabled = true;
    msg('toolsMsg', 'Starting…');
    const r = await K.toolsInstall(force);
    if (r.error) msg('toolsMsg', r.error, 'warn');
    else msg('toolsMsg', force ? 'yt-dlp is up to date.' : 'The tools are ready.', 'ok');
    await refreshTools(r.status);
    return !r.error;
  }

  // ------------------------------------------------------------------ actions

  async function startDownload() {
    if (!current) return;
    let ids = selected();
    if (!ids.length) return;
    if (!toolsOk) {
      showTab('settings');
      const ok = await installTools(false);
      if (!ok) return;
      showTab('videos');
    }
    let r = await K.download(current, ids);
    if (r.needFolder) {
      const folder = await K.chooseFolder(current);
      if (!folder) {
        msg('dlMsg', 'Choose a folder to save the videos in first.', 'warn');
        return;
      }
      comm.folder = folder;
      renderStatus();
      r = await K.download(current, ids);
    }
    if (r.error) {
      msg('dlMsg', r.error, 'warn');
      return;
    }
    const text = r.added
      ? `Added ${r.added} video${r.added === 1 ? '' : 's'} to Downloads.`
      : 'Those videos are already in Downloads.';
    msg('dlMsg', r.warning ? `${text} ${r.warning}` : text, r.warning ? 'warn' : 'ok');
  }

  async function find(page) {
    if (!current) return;
    scanning = true;
    renderStatus();
    msg('findMsg', 'Opening Locals…');
    const r = await K.findAll(current, page);
    scanning = false;
    renderStatus();
    if (r && r.error) msg('findMsg', r.error, 'warn');
  }

  function wire() {
    for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => showTab(b.dataset.tab));

    $('community').addEventListener('change', async (e) => {
      current = e.target.value || null;
      K.setOption('lastCommunity', current || '');
      msg('findMsg', '');
      msg('dlMsg', '');
      await loadCommunity();
    });
    $('addCommunity').addEventListener('click', () => {
      $('addPanel').hidden = false;
      $('addInput').value = '';
      msg('addMsg', '');
      $('addInput').focus();
    });
    $('addCancel').addEventListener('click', () => ($('addPanel').hidden = true));
    const add = async () => {
      const r = await K.addCommunity($('addInput').value);
      if (r.error) {
        msg('addMsg', r.error, 'warn');
        return;
      }
      $('addPanel').hidden = true;
      current = r.slug;
      renderCommunities(r.communities);
      await loadCommunity();
      K.openLocals(current, 'home');
    };
    $('addConfirm').addEventListener('click', add);
    $('addInput').addEventListener('keydown', (e) => e.key === 'Enter' && add());

    $('openLocals').addEventListener('click', () => K.openLocals(current, 'home'));
    $('findContent').addEventListener('click', () => find('content'));
    $('findFeed').addEventListener('click', () => find('feed'));
    $('stopFind').addEventListener('click', () => K.stopFind());

    $('filter').addEventListener('input', () => {
      lastClickedIndex = null;
      renderList();
    });
    $('order').addEventListener('change', () => {
      K.setOption('oldestFirst', $('order').value === 'oldest');
      renderList();
    });
    $('list').addEventListener('click', (ev) => {
      const cb = ev.target;
      if (!(cb instanceof HTMLInputElement) || cb.type !== 'checkbox') return;
      const index = Number(cb.dataset.index);
      if (ev.shiftKey && lastClickedIndex !== null) {
        const [a, b] = [Math.min(lastClickedIndex, index), Math.max(lastClickedIndex, index)];
        setTicked(shownIds.slice(a, b + 1), cb.checked);
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
    const reselect = (fn) => () => {
      const s = state();
      if (!s) return;
      excluded = new Set(s.order.filter(fn));
      saveExcluded();
      renderAll();
    };
    $('selAll').addEventListener('click', reselect(() => false));
    $('selNone').addEventListener('click', reselect(() => true));
    $('selShown').addEventListener('click', () => {
      const shown = new Set(shownIds);
      reselect((id) => !shown.has(id))();
    });
    $('selNotDone').addEventListener('click', reselect((id) => downloaded.has(id)));

    $('chooseFolder').addEventListener('click', async () => {
      if (!current) return;
      const f = await K.chooseFolder(current);
      if (f) {
        comm.folder = f;
        renderStatus();
      }
    });
    for (const id of ['quality', 'naming', 'nameStyle', 'parallel', 'fragments']) {
      $(id).addEventListener('change', () => {
        K.setOption(id, $(id).value);
        if (id === 'naming' || id === 'nameStyle') renderList();
      });
    }
    $('useCookies').addEventListener('change', () => K.setOption('useCookies', $('useCookies').checked));
    $('download').addEventListener('click', startDownload);

    $('resumeAll').addEventListener('click', () => K.queue('resumeAll').then(applyQueue));
    $('pauseAll').addEventListener('click', () => K.queue('pauseAll').then(applyQueue));
    $('retryFailed').addEventListener('click', () => K.queue('retryFailed').then(applyQueue));
    $('clearFinished').addEventListener('click', () => K.queue('clearFinished').then(applyQueue));
    $('openFolder').addEventListener('click', () => comm && comm.folder && K.openPath(comm.folder));

    $('installTools').addEventListener('click', () => installTools(false));
    $('updateYtdlp').addEventListener('click', () => installTools(true));
    $('useOwnTools').addEventListener('click', async () => {
      const st = await K.chooseToolsFolder();
      if (st) refreshTools(st);
    });

    $('renameOld').addEventListener('click', async () => {
      const r = await K.renameOld(current);
      if (!r) return;
      if (r.error) msg('moreMsg', r.error, 'warn');
      else msg('moreMsg', `Renamed ${r.renamed} file${r.renamed === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} skipped: a file with the new name already exists)` : ''}.`, 'ok');
    });
    const saved = (p) => p && msg('moreMsg', `Saved ${p}. It contains your personal video token: don't share it.`, 'ok');
    $('exportBat').addEventListener('click', () => K.exportScript(current, 'bat').then(saved));
    $('exportSh').addEventListener('click', () => K.exportScript(current, 'sh').then(saved));
    $('exportDebug').addEventListener('click', () =>
      K.exportDebug(current).then((p) => p && msg('moreMsg', `Saved ${p} (it does not contain your token).`, 'ok'))
    );
    $('signOut').addEventListener('click', async () => {
      if (!confirm('Sign out of Locals in Keepsake? You will need to sign in again before finding videos.')) return;
      await K.signOut();
      msg('moreMsg', 'Signed out.', 'ok');
    });
    $('removeCommunity').addEventListener('click', async () => {
      if (!current) return;
      if (!confirm(`Forget ${current}? Its video list and download history in Keepsake are removed. Videos already saved stay where they are.`)) return;
      const r = await K.removeCommunity(current);
      current = r.communities.length ? r.communities[0].slug : null;
      renderCommunities(r.communities);
      await loadCommunity();
    });
    $('repoLink').addEventListener('click', (e) => {
      e.preventDefault();
      K.openExternal('https://github.com/al-elessar/keepsake-locals');
    });

    // ---- events from the app
    const reload = debounce(async () => {
      const fresh = await K.init();
      renderCommunities(fresh.communities);
      if (current) {
        const keepScroll = $('list').scrollTop;
        comm = await K.getCommunity(current);
        downloaded = new Set(comm.downloaded);
        renderAll();
        $('list').scrollTop = keepScroll;
      }
    }, 300);
    K.on('community', (p) => {
      if (!current && p.slug) current = p.slug;
      reload();
    });
    K.on('scroll', (p) => {
      if (p.slug !== current) return;
      if (p.status === 'running') {
        scanning = true;
        msg('findMsg', `Scrolling the ${p.page === 'feed' ? 'Feed' : 'Content page'}… ${p.count} videos so far.`);
      } else {
        scanning = false;
        msg(
          'findMsg',
          p.status === 'done'
            ? `Reached the end: ${p.count} videos.${p.page !== 'feed' ? ' Tip: click "Also check the Feed" to catch videos posted outside the Content page.' : ''}`
            : `Stopped at ${p.count} videos.`,
          p.status === 'done' ? 'ok' : 'muted'
        );
      }
      renderStatus();
    });
    K.on('queue', applyQueue);
    K.on('tools', (p) => msg('toolsMsg', p.message || ''));
  }

  async function init() {
    info = await K.init();
    const o = info.options;
    $('version').textContent = info.version;
    $('quality').value = o.quality || '';
    $('naming').value = o.naming || 'date';
    $('nameStyle').value = o.nameStyle || 'plain';
    $('order').value = o.oldestFirst ? 'oldest' : 'newest';
    $('parallel').value = String(o.parallel || 1);
    $('fragments').value = o.fragments || 4;
    $('useCookies').checked = o.useCookies !== false;
    const slugs = info.communities.map((c) => c.slug);
    current = slugs.includes(o.lastCommunity) ? o.lastCommunity : slugs[0] || null;
    renderCommunities(info.communities);
    wire();
    await loadCommunity();
    applyQueue(await K.queue('status'));
    refreshTools();
  }

  init();
})();
