/* Offline tests for the shared code in core/ (page hook, merging, scrolling, script generator). Run: node test/run-tests.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..', 'core');
const LVS = require(path.join(root, 'generate.js'));
const M = require(path.join(root, 'merge.js'));
const S = require(path.join(root, 'autoscroll.js'));

// A fake token with the same structure as a real one (header.payload.signature).
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = `${b64({ typ: 'JWT', alg: 'EdDSA' })}.${b64({ aud: 'video', exp: 1809764380 })}.c2lnbmF0dXJl`;
const ID1 = 'v_194e4ff5-ba81-402d-8b78-c3ae08fb635a';
const ID2 = 'v_9c750134-5145-4480-80c8-f624514d6d14';
const ID3 = 'v_7636ee7f-46ee-487c-a4a1-499d2bac2080';

// ---------------------------------------------------------------- page hook
function loadHook() {
  const posted = [];
  const listeners = {};
  const timers = [];
  const fetchResponses = [];
  class FakeXHR {
    constructor() { this.ev = {}; this.responseType = ''; }
    addEventListener(t, f) { (this.ev[t] = this.ev[t] || []).push(f); }
    open() { this.opened = true; }
    fire(text, type) { this.responseType = type || ''; this.responseText = text; (this.ev.load || []).forEach((f) => f()); }
  }
  const window = {
    location: { origin: 'https://example.beta.locals.com' },
    postMessage: (m) => posted.push(m),
    addEventListener: (t, f) => ((listeners[t] = listeners[t] || []).push(f)),
    fetch: (input) => {
      const body = fetchResponses.shift() || '';
      return Promise.resolve({
        headers: { get: (h) => (h === 'content-type' ? 'text/plain' : null) },
        clone() { return { text: () => Promise.resolve(body) }; }
      });
    },
    XMLHttpRequest: FakeXHR
  };
  window.window = window;
  const document = { addEventListener: () => {}, documentElement: { outerHTML: '' } };
  const ctx = {
    window, document, location: window.location, XMLHttpRequest: FakeXHR,
    setTimeout: (f) => { timers.push(f); return timers.length; }, JSON, Object, Math, Array, String, Number, Promise
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'page-hook.js'), 'utf8'), ctx);
  const flush = () => { while (timers.length) timers.shift()(); };
  return { window, FakeXHR, posted, flush, fetchResponses };
}

(async () => {
  const h = loadHook();

  // 1) Feed data in a JS-object style (unquoted keys), as server-function responses often are.
  h.fetchResponses.push(
    `[{id:8296676,title:"Example video one",createdAt:"2026-11-01T18:30:00Z",media:{video:"${ID1}",duration:2367}},` +
    `{id:8200001,title:"Questions \\u0026 answers",published_at:1761300000,media:{video:"${ID2}"}}]`
  );
  await h.window.fetch('https://example.beta.locals.com/_server/');
  await new Promise((r) => setImmediate(r));

  // 2) JSON escaped inside a string.
  h.fetchResponses.push(`{"data":"{\\"title\\":\\"Example video three\\",\\"video\\":\\"${ID3}\\"}"}`);
  await h.window.fetch('https://example.beta.locals.com/_server/');
  await new Promise((r) => setImmediate(r));

  // 2b) A title with escaped quotes must survive intact.
  const ID4 = 'v_15daf595-cd39-4583-ab20-3eb9872b62ab';
  h.fetchResponses.push(`[{id:1,title:"Example \\"quoted\\" title",createdAt:"2026-09-12T15:00:00Z",media:{video:"${ID4}"}}]`);
  await h.window.fetch('https://example.beta.locals.com/_server/');
  await new Promise((r) => setImmediate(r));

  // 3) The player's playlist request carries the token.
  const x = new h.FakeXHR();
  x.open('GET', `https://webapi.locals.com/api/v1/posts/content/hls/${ID1}/source.m3u8?vt=${TOKEN}`);
  x.fire('#EXTM3U');

  h.flush();

  const last = h.posted[h.posted.length - 1];

  assert.ok(last, 'hook posted an update');
  const vids = new Map(last.videos.map((v) => [v[0], v[1]]));
  assert.strictEqual(vids.get(ID1), 'Example video one');
  assert.strictEqual(vids.get(ID2), 'Questions & answers');
  assert.strictEqual(vids.get(ID3), 'Example video three');
  assert.strictEqual(vids.get('v_15daf595-cd39-4583-ab20-3eb9872b62ab'), 'Example "quoted" title');
  assert.strictEqual(last.token, TOKEN);
  const dates = new Map(last.videos.map((v) => [v[0], v[2]]));
  assert.ok(/^2026-11-0[12]$/.test(dates.get(ID1)), 'ISO date captured: ' + dates.get(ID1));
  assert.ok(/^2025-10-2[34]$/.test(dates.get(ID2)), 'Unix date captured: ' + dates.get(ID2));
  assert.strictEqual(dates.get(ID3), '', 'no date when none present');
  assert.ok(last.samples.length >= 1 && !last.samples.some((s) => s.snippet.includes(TOKEN)), 'samples are redacted');
  console.log('page hook: OK', [...vids.values()]);


  // ---------------------------------------------------------- merging (core/merge.js)
  assert.strictEqual(M.slugFromHost('example.beta.locals.com'), 'example');
  assert.strictEqual(M.slugFromHost('www.locals.com'), null);
  assert.strictEqual(M.pageKind('/feed?mode=content'), 'content');
  assert.strictEqual(M.pageKind('/feed'), 'feed');
  const ms = M.upgradeState(null, 'example', 'example.locals.com');
  assert.ok(M.mergeFindings(ms, { videos: [[ID1, 'Near title', '', false, false]] }, { kind: 'feed', host: 'example.locals.com' }));
  assert.deepStrictEqual(ms.order, [ID1]);
  assert.strictEqual(ms.videos[ID1].src, 'feed');
  // A title from the same record beats a nearby one; the Content page wins over the Feed; beta host preferred
  M.mergeFindings(ms, { videos: [[ID1, 'Real title', '2026-11-01', true, true], ['not-an-id', 'x']], token: TOKEN }, { kind: 'content', host: 'example.beta.locals.com' });
  assert.deepStrictEqual(ms.videos[ID1], { title: 'Real title', date: '2026-11-01', sure: true, dateSure: true, src: 'content', n: 0 });
  assert.strictEqual(ms.token, TOKEN);
  assert.strictEqual(ms.host, 'example.beta.locals.com');
  assert.strictEqual(M.mergeFindings(ms, { videos: [[ID1, 'Near again', '', false, false]] }, { kind: 'feed' }), false, 'sure title is kept');
  const old = { schema: 1, slug: 's', videos: { [ID1]: { title: 't', sure: true, dateSure: true } }, order: [ID1] };
  assert.strictEqual(M.upgradeState(old).videos[ID1].sure, false, 'older detection can be improved on');
  console.log('merge: OK');

  // ---------------------------------------------------------- scrolling (core/autoscroll.js)
  {
    let height = 1000; let count = 0; const steps = [];
    const reports = [];
    const status = await S.autoScroll({
      step: (a) => { steps.push(a); if (a === 'end' && count < 60) { count += 20; height += 1000; } return height; },
      count: () => count,
      sleep: () => Promise.resolve(),
      isStopped: () => false,
      report: (r) => reports.push(r),
      rescan: () => steps.push('rescan')
    });
    assert.strictEqual(status, 'done');
    assert.strictEqual(count, 60);
    assert.ok(steps.includes('nudge') && steps[steps.length - 1] === 'rescan');
    assert.strictEqual(reports[reports.length - 1], 'done');
    let stop = false; let n = 0;
    const st = await S.autoScroll({ step: () => ++n, count: () => n, sleep: () => Promise.resolve(), isStopped: () => (stop = n > 10), report: () => {}, rescan: () => {} });
    assert.strictEqual(st, 'stopped');
    assert.strictEqual(typeof S.scrollStep, 'function');
    new Function('return (' + S.scrollStep.toString() + ')'); // must survive being sent to a page as text
    console.log('autoscroll: OK');
  }

  // ---------------------------------------------------------- generator
  const state = {
    slug: 'example',
    host: 'example.beta.locals.com',
    token: TOKEN,
    order: [ID1, ID2, ID3],
    videos: {
      [ID1]: { title: 'Example video one', date: '2026-11-01' },
      [ID2]: { title: 'Example "quoted" title 100% & more!' },
      [ID3]: { title: '' }
    }
  };
  assert.strictEqual(LVS.decodeTokenExpiry(TOKEN).toISOString(), '2027-05-08T08:19:40.000Z');

  const bat = LVS.makeBat(state, { folder: 'D:\\Videos\\Locals', quality: '720', cookies: 'firefox', fragments: 4 });
  assert.ok(bat.includes('\r\n'), 'bat uses CRLF');
  assert.ok(bat.includes('-o "001 Example video one.%%(ext)s"'), 'dated video is oldest, so 001');
  assert.ok(bat.includes('-o "003 Example quoted title 100 & more.%%(ext)s"'), 'quotes, % and ! removed from names');
  assert.ok(bat.includes(`-o "002 ${ID3}.%%(ext)s"`), 'falls back to the ID');
  assert.ok(bat.includes('set "OUT=D:\\Videos\\Locals"') && bat.includes('-P "%OUT%"'));
  assert.ok(bat.includes('-f "bv*[height<=720]+ba/b[height<=720]/b"'));
  assert.ok(bat.includes('--cookies-from-browser firefox'));
  assert.ok(bat.includes('--referer "https://example.beta.locals.com/"'));
  assert.ok(bat.includes(`hls/${ID1}/source.m3u8?vt=${TOKEN}`));
  assert.ok(!/echo \[\d+\/\d+\][^\r\n]*[&|<>^]/.test(bat), 'echo lines have no cmd special characters');
  // Failure summary and token-expiry check
  assert.ok(bat.includes('call :result %errorlevel% "') && bat.includes(':result_fail') && bat.includes('>>failed.txt echo %~2'));
  assert.ok(bat.includes('Finished: %OK% done'));
  assert.ok(bat.includes('if %errorlevel% EQU 3 goto :expired'));
  assert.ok(!/^:result[\s\S]*\(/m.test(bat.slice(bat.indexOf('\r\n:result\r\n'), bat.indexOf(':expired'))), 'no ( ) blocks in :result');

  // Ordering by date, with stable numbers in both directions
  const st2 = { slug: 's', host: 'h', token: TOKEN, order: ['v_a', 'v_b', 'v_c'], videos: {
    v_a: { title: 'Example video one', date: '2026-11-08' },
    v_b: { title: 'Example video two', date: '2026-07-04' },
    v_c: { title: 'Example video three', date: '2026-11-08' } } };
  const newest = LVS.buildEntries(st2, {});
  assert.deepStrictEqual(newest.map((e) => e.title), ['Example video one', 'Example video three', 'Example video two']);
  const oldest = LVS.buildEntries(st2, { oldestFirst: true });
  assert.deepStrictEqual(oldest.map((e) => e.title), ['Example video two', 'Example video three', 'Example video one']);
  assert.deepStrictEqual(newest.map((e) => e.num), ['003', '002', '001'], 'oldest is 001 in either order');

  // Selection keeps each video's number from the full list
  const picked = LVS.buildEntries(state, { selected: new Set([ID3]) });
  assert.strictEqual(picked.length, 1);
  assert.strictEqual(picked[0].num, '002');
  const pickedBat = LVS.makeBat(state, { selected: new Set([ID2, ID3]) });
  assert.ok(!pickedBat.includes(ID1) && pickedBat.includes('echo [1/2] 003 '), 'only selected videos, original numbers');

  // Look-alike punctuation
  assert.strictEqual(LVS.sanitizeName('Example "quoted": it\'s 100%?', 'lookalike'), 'Example \u201Cquoted\u201D - it\u2019s 100\uFF05\uFF1F');
  assert.strictEqual(LVS.sanitizeName('Example "quoted": it\'s 100%?'), 'Example quoted its 100');

  // Rename scripts
  const ren = LVS.makeRenameBat(state, { naming: 'date', folder: 'D:\\Old' });
  assert.ok(ren.includes(`for %%F in (*${ID1}*.mp4 `) && ren.includes('call :ren "%%F" "2026-11-01 Example video one%%~xF"'));
  assert.ok(ren.includes('if not exist "%OUT%\\" goto :nofolder'));
  const rensh = LVS.makeRenameSh(state, { naming: 'date' });
  assert.ok(rensh.includes(`*${ID1}*.mp4`) && rensh.includes("t='2026-11-01 Example video one'"));

  // Date-based names
  const dated = LVS.buildEntries(state, { naming: 'date' });
  assert.strictEqual(dated[0].name, '2026-11-01 Example video one');
  assert.ok(dated.some((e) => e.name === `undated ${ID3}`));
  // Automatic set-up
  assert.ok(bat.includes('call :getytdlp') && bat.includes(':getffmpeg') && bat.includes('ffmpeg-master-latest-win64-gpl.zip'));
  assert.ok(bat.indexOf('\r\n:getytdlp\r\n') > bat.indexOf('goto :eof'), 'helpers sit after the main flow');

  const askBat = LVS.makeBat(state, { askFolder: true, folder: "D:\\Bob's Videos" });
  assert.ok(askBat.includes('FolderBrowserDialog'), 'bat opens a folder picker');
  assert.ok(askBat.includes("$d.SelectedPath = 'D:\\Bob''s Videos'"), 'start folder quoted for PowerShell');
  assert.ok(askBat.includes('-P "%OUT%"') && askBat.includes(':nofolder'));
  fs.writeFileSync(path.join(__dirname, 'sample-ask.bat'), askBat);
  const askSh = LVS.makeSh(state, { askFolder: true });
  assert.ok(askSh.includes('choose folder') && askSh.includes('-P "$OUT"'));
  fs.writeFileSync(path.join(__dirname, 'sample-ask.sh'), askSh);

  const sh = LVS.makeSh(state, { folder: "/home/me/Locals", quality: '' });
  assert.ok(sh.startsWith('#!/usr/bin/env bash'));
  assert.ok(sh.includes("-o '001 Example video one.%(ext)s'"));
  assert.ok(!sh.includes('-f "bv'), 'best quality adds no -f format');

  const dbg = JSON.parse(LVS.makeDebug(state, '0.1.0'));
  assert.ok(!JSON.stringify(dbg).includes(TOKEN), 'debug export omits the token');

  fs.writeFileSync(path.join(__dirname, 'sample-output.bat'), bat);
  fs.writeFileSync(path.join(__dirname, 'sample-output.sh'), sh);
  console.log('generator: OK');
  console.log('All tests passed.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
