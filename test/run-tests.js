/* Offline tests for the page hook and the script generator. Run: node test/run-tests.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..', 'extension');
const LVS = require(path.join(root, 'popup', 'generate.js'));

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
    location: { origin: 'https://dap2k.beta.locals.com' },
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
  vm.runInContext(fs.readFileSync(path.join(root, 'src', 'page-hook.js'), 'utf8'), ctx);
  const flush = () => { while (timers.length) timers.shift()(); };
  return { window, FakeXHR, posted, flush, fetchResponses };
}

(async () => {
  const h = loadHook();

  // 1) Feed data in a JS-object style (unquoted keys), as server-function responses often are.
  h.fetchResponses.push(
    `[{id:8296676,title:"Patrick and The 3 Hour Fiasco",createdAt:"2026-11-01T18:30:00Z",media:{video:"${ID1}",duration:2367}},` +
    `{id:8200001,title:"Joseph \\u0026 The Wheelchair",published_at:1761300000,media:{video:"${ID2}"}}]`
  );
  await h.window.fetch('https://dap2k.beta.locals.com/_server/');
  await new Promise((r) => setImmediate(r));

  // 2) JSON escaped inside a string.
  h.fetchResponses.push(`{"data":"{\\"title\\":\\"Slippery Slope\\",\\"video\\":\\"${ID3}\\"}"}`);
  await h.window.fetch('https://dap2k.beta.locals.com/_server/');
  await new Promise((r) => setImmediate(r));

  // 2b) A title with escaped quotes must survive intact.
  const ID4 = 'v_15daf595-cd39-4583-ab20-3eb9872b62ab';
  h.fetchResponses.push(`[{id:1,title:"Tony \\"The Barber\\"",createdAt:"2026-09-12T15:00:00Z",media:{video:"${ID4}"}}]`);
  await h.window.fetch('https://dap2k.beta.locals.com/_server/');
  await new Promise((r) => setImmediate(r));

  // 3) The player's playlist request carries the token.
  const x = new h.FakeXHR();
  x.open('GET', `https://webapi.locals.com/api/v1/posts/content/hls/${ID1}/source.m3u8?vt=${TOKEN}`);
  x.fire('#EXTM3U');

  h.flush();

  const last = h.posted[h.posted.length - 1];

  assert.ok(last, 'hook posted an update');
  const vids = new Map(last.videos.map((v) => [v[0], v[1]]));
  assert.strictEqual(vids.get(ID1), 'Patrick and The 3 Hour Fiasco');
  assert.strictEqual(vids.get(ID2), 'Joseph & The Wheelchair');
  assert.strictEqual(vids.get(ID3), 'Slippery Slope');
  assert.strictEqual(vids.get('v_15daf595-cd39-4583-ab20-3eb9872b62ab'), 'Tony "The Barber"');
  assert.strictEqual(last.token, TOKEN);
  const dates = new Map(last.videos.map((v) => [v[0], v[2]]));
  assert.ok(/^2026-11-0[12]$/.test(dates.get(ID1)), 'ISO date captured: ' + dates.get(ID1));
  assert.ok(/^2025-10-2[34]$/.test(dates.get(ID2)), 'Unix date captured: ' + dates.get(ID2));
  assert.strictEqual(dates.get(ID3), '', 'no date when none present');
  assert.ok(last.samples.length >= 1 && !last.samples.some((s) => s.snippet.includes(TOKEN)), 'samples are redacted');
  console.log('page hook: OK', [...vids.values()]);

  // ---------------------------------------------------------- generator
  const state = {
    slug: 'dap2k',
    host: 'dap2k.beta.locals.com',
    token: TOKEN,
    order: [ID1, ID2, ID3],
    videos: {
      [ID1]: { title: 'Patrick and The 3 Hour Fiasco', date: '2026-11-01' },
      [ID2]: { title: 'Tony "The Barber" 100% & co!' },
      [ID3]: { title: '' }
    }
  };
  assert.strictEqual(LVS.decodeTokenExpiry(TOKEN).toISOString(), '2027-05-08T08:19:40.000Z');

  const bat = LVS.makeBat(state, { folder: 'D:\\Media\\Media\\Other\\Dads Against Predators', quality: '720', cookies: 'firefox', fragments: 4 });
  assert.ok(bat.includes('\r\n'), 'bat uses CRLF');
  assert.ok(bat.includes('-o "001 Patrick and The 3 Hour Fiasco.%%(ext)s"'), 'dated video is oldest, so 001');
  assert.ok(bat.includes('-o "003 Tony The Barber 100 & co.%%(ext)s"'), 'quotes, % and ! removed from names');
  assert.ok(bat.includes(`-o "002 ${ID3}.%%(ext)s"`), 'falls back to the ID');
  assert.ok(bat.includes('set "OUT=D:\\Media\\Media\\Other\\Dads Against Predators"') && bat.includes('-P "%OUT%"'));
  assert.ok(bat.includes('-f "bv*[height<=720]+ba/b[height<=720]/b"'));
  assert.ok(bat.includes('--cookies-from-browser firefox'));
  assert.ok(bat.includes('--referer "https://dap2k.beta.locals.com/"'));
  assert.ok(bat.includes(`hls/${ID1}/source.m3u8?vt=${TOKEN}`));
  assert.ok(!/echo \[\d+\/\d+\][^\r\n]*[&|<>^]/.test(bat), 'echo lines have no cmd special characters');
  // Failure summary and token-expiry check
  assert.ok(bat.includes('call :result %errorlevel% "') && bat.includes(':result_fail') && bat.includes('>>failed.txt echo %~2'));
  assert.ok(bat.includes('Finished: %OK% done'));
  assert.ok(bat.includes('if %errorlevel% EQU 3 goto :expired'));
  assert.ok(!/^:result[\s\S]*\(/m.test(bat.slice(bat.indexOf('\r\n:result\r\n'), bat.indexOf(':expired'))), 'no ( ) blocks in :result');

  // Ordering by date, with stable numbers in both directions
  const st2 = { slug: 's', host: 'h', token: TOKEN, order: ['v_a', 'v_b', 'v_c'], videos: {
    v_a: { title: 'Saturday upload', date: '2026-11-08' },
    v_b: { title: 'Felix', date: '2026-07-04' },
    v_c: { title: 'Dwayne', date: '2026-11-08' } } };
  const newest = LVS.buildEntries(st2, {});
  assert.deepStrictEqual(newest.map((e) => e.title), ['Saturday upload', 'Dwayne', 'Felix']);
  const oldest = LVS.buildEntries(st2, { oldestFirst: true });
  assert.deepStrictEqual(oldest.map((e) => e.title), ['Felix', 'Dwayne', 'Saturday upload']);
  assert.deepStrictEqual(newest.map((e) => e.num), ['003', '002', '001'], 'oldest is 001 in either order');

  // Selection keeps each video's number from the full list
  const picked = LVS.buildEntries(state, { selected: new Set([ID3]) });
  assert.strictEqual(picked.length, 1);
  assert.strictEqual(picked[0].num, '002');
  const pickedBat = LVS.makeBat(state, { selected: new Set([ID2, ID3]) });
  assert.ok(!pickedBat.includes(ID1) && pickedBat.includes('echo [1/2] 003 '), 'only selected videos, original numbers');

  // Look-alike punctuation
  assert.strictEqual(LVS.sanitizeName('Tony "The Barber": it\'s 100%?', 'lookalike'), 'Tony \u201CThe Barber\u201D - it\u2019s 100\uFF05\uFF1F');
  assert.strictEqual(LVS.sanitizeName('Tony "The Barber": it\'s 100%?'), 'Tony The Barber its 100');

  // Rename scripts
  const ren = LVS.makeRenameBat(state, { naming: 'date', folder: 'D:\\Old' });
  assert.ok(ren.includes(`for %%F in (*${ID1}*.mp4 `) && ren.includes('call :ren "%%F" "2026-11-01 Patrick and The 3 Hour Fiasco%%~xF"'));
  assert.ok(ren.includes('if not exist "%OUT%\\" goto :nofolder'));
  const rensh = LVS.makeRenameSh(state, { naming: 'date' });
  assert.ok(rensh.includes(`*${ID1}*.mp4`) && rensh.includes("t='2026-11-01 Patrick and The 3 Hour Fiasco'"));

  // Date-based names
  const dated = LVS.buildEntries(state, { naming: 'date' });
  assert.strictEqual(dated[0].name, '2026-11-01 Patrick and The 3 Hour Fiasco');
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
  assert.ok(sh.includes("-o '001 Patrick and The 3 Hour Fiasco.%(ext)s'"));
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
