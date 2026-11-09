/* Offline tests for the desktop app's own modules. Run: npm test (in app/) */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { Store } = require('../src/store.js');
const { Tools, parseSums } = require('../src/tools.js');
const { Downloader } = require('../src/downloader.js');
const { renameOld } = require('../src/library.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keepsake-unit-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const end = Date.now() + (ms || 10000);
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(50);
  }
  throw new Error('Timed out waiting for ' + (what || 'condition'));
}

(async () => {
  // ---------------------------------------------------------------- store
  const store = new Store(path.join(tmp, 'data'));
  store.setOption('fragments', 99);
  store.setOption('parallel', '2');
  store.setOption('nonsense', 1);
  assert.strictEqual(store.options.fragments, 16);
  assert.strictEqual(store.options.parallel, 2);
  assert.ok(!('nonsense' in store.options));
  store.setList('excluded', 'example', new Set(['v_a']));
  store.flush();
  const again = new Store(path.join(tmp, 'data'));
  assert.deepStrictEqual(Array.from(again.list('excluded', 'example')), ['v_a']);
  console.log('store: OK');

  // ---------------------------------------------------------------- checksums
  const sums = parseSums('abc\n' + 'a'.repeat(64) + '  yt-dlp.exe\n' + 'B'.repeat(64) + ' *ffmpeg.zip\r\n');
  assert.strictEqual(sums['yt-dlp.exe'], 'a'.repeat(64));
  assert.strictEqual(sums['ffmpeg.zip'], 'b'.repeat(64));
  console.log('checksums: OK');

  // ---------------------------------------------------------------- rename old downloads
  const lib = path.join(tmp, 'library');
  fs.mkdirSync(lib);
  const A = 'v_9c750134-5145-4480-80c8-f624514d6d14';
  const B = 'v_194e4ff5-ba81-402d-8b78-c3ae08fb635a';
  fs.writeFileSync(path.join(lib, `001 ${A}.mp4`), 'x');
  fs.writeFileSync(path.join(lib, `002 ${B}.mkv`), 'x');
  fs.writeFileSync(path.join(lib, '2026-01-01 Example video two.mkv'), 'x');
  fs.writeFileSync(path.join(lib, `notes ${A}.txt`), 'x');
  const r = renameOld([{ id: A, name: '2026-11-01 Example video one' }, { id: B, name: '2026-01-01 Example video two' }], lib);
  assert.deepStrictEqual([r.renamed, r.skipped], [1, 1], 'one renamed, one skipped because its new name is taken');
  assert.ok(fs.existsSync(path.join(lib, '2026-11-01 Example video one.mp4')));
  assert.ok(fs.existsSync(path.join(lib, `002 ${B}.mkv`)), 'existing file is never overwritten');
  assert.ok(fs.existsSync(path.join(lib, `notes ${A}.txt`)), 'only video files are renamed');
  console.log('rename: OK');

  // ---------------------------------------------------------------- download queue (with a stand-in yt-dlp)
  if (process.platform === 'win32') {
    console.log('download queue: skipped on Windows (the stand-in yt-dlp is a shell script)');
  } else {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    const log = path.join(tmp, 'calls.log');
    fs.writeFileSync(
      path.join(bin, 'yt-dlp'),
      `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const url = args[args.length - 1];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const out = args[args.indexOf('-P') + 1] + '/' + args[args.indexOf('-o') + 1].replace('%(ext)s', 'mp4');
if (url.includes('fail403')) { console.error('ERROR: [generic] Unable to download webpage: HTTP Error 403: Forbidden'); process.exit(1); }
if (url.includes('flaky')) {
  const mark = out + '.flaky';
  if (!fs.existsSync(mark)) { fs.writeFileSync(mark, ''); console.error('ERROR: connection reset'); process.exit(1); }
}
const steps = url.includes('slow') ? 40 : 3;
let i = 0;
const t = setInterval(() => {
  i++;
  console.log('KS|' + ((100 * i) / steps).toFixed(1) + '%|1.00MiB/s|00:0' + (steps - i) % 10 + '|' + i + '|' + steps);
  if (i >= steps) { clearInterval(t); fs.writeFileSync(out, 'video'); console.log('KSFILE|' + out); process.exit(0); }
}, 50);
`,
      { mode: 0o755 }
    );
    const qstore = new Store(path.join(tmp, 'qdata'));
    qstore.setOption('toolsFolder', bin);
    const tools = new Tools(path.join(tmp, 'tools'), () => qstore.options, null);
    assert.strictEqual(tools.locate('yt-dlp').source, 'custom');
    let changes = 0;
    const done = [];
    const dl = new Downloader({
      store: qstore,
      tools,
      prepare: (item) => ({ url: `https://example.invalid/${item.id}`, referer: 'https://example.beta.locals.com/' }),
      cookies: async () => null,
      onChange: () => changes++,
      onDone: (q) => done.push(q.id),
      retryDelay: 100
    });
    const out = path.join(tmp, 'out');
    const item = (id) => ({ slug: 'example', id, name: `Video ${id}`, folder: out });

    // 1) Normal downloads, one at a time, with the right arguments
    dl.add([item('ok1'), item('ok2')], { quality: '720', fragments: 6 });
    assert.strictEqual(dl.add([item('ok1')], {}), 0, 'already queued');
    await until(() => done.length === 2, 10000, 'two downloads');
    const first = JSON.parse(fs.readFileSync(log, 'utf8').split('\n')[0]);
    for (const [flag, value] of [['--referer', 'https://example.beta.locals.com/'], ['-P', out], ['-o', 'Video ok1.%(ext)s'], ['-N', '6']]) {
      assert.strictEqual(first[first.indexOf(flag) + 1], value, flag);
    }
    assert.ok(first.includes('bv*[height<=720]+ba/b[height<=720]/b'));
    const q1 = dl.find('example:ok1');
    assert.strictEqual(q1.status, 'done');
    assert.strictEqual(q1.file, path.join(out, 'Video ok1.mp4'));
    assert.ok(changes > 0);

    // 2) A failure is retried automatically
    dl.add([item('flaky')], {});
    await until(() => dl.find('example:flaky').status === 'done', 10000, 'flaky retried');
    assert.strictEqual(dl.find('example:flaky').attempts, 2);

    // 3) Pause stops yt-dlp; resume starts it again
    dl.add([item('slow')], {});
    await until(() => dl.find('example:slow').status === 'downloading' && dl.find('example:slow').percent > 5, 5000, 'slow started');
    dl.pause('example:slow');
    await until(() => !dl.running.size, 5000, 'process stopped');
    const pct = dl.find('example:slow').percent;
    await sleep(300);
    assert.strictEqual(dl.find('example:slow').status, 'paused');
    assert.strictEqual(dl.find('example:slow').percent, pct, 'no progress while paused');
    dl.resume('example:slow');
    await until(() => dl.find('example:slow').status === 'done', 10000, 'slow resumed');

    // 4) HTTP 403: the video fails and the rest of the queue waits (token probably expired)
    dl.add([item('fail403'), item('after')], {});
    await until(() => dl.summary().halted, 5000, 'halted');
    assert.strictEqual(dl.find('example:fail403').status, 'failed');
    assert.strictEqual(dl.find('example:after').status, 'paused');
    assert.ok(/403/.test(dl.summary().halted));
    dl.remove('example:fail403');
    dl.resumeAll();
    await until(() => dl.find('example:after').status === 'done', 5000, 'resumed after halt');

    // 5) After a restart, unfinished downloads wait for "Resume"
    qstore.data.queue.push({ key: 'example:x', slug: 'example', id: 'x', status: 'downloading', percent: 40 });
    const dl2 = new Downloader({ store: qstore, tools, prepare: () => ({}), cookies: async () => null, onChange() {}, onDone() {} });
    assert.strictEqual(dl2.find('example:x').status, 'paused');
    console.log('download queue: OK');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('All app tests passed.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
