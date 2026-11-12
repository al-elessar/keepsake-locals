/*
 * Keepsake desktop app - download queue
 *
 * Runs yt-dlp once per video, reads its progress, and supports pause/resume
 * (stop the process; yt-dlp picks up from the pieces it already has), automatic
 * retries, and stopping the whole queue when Locals refuses access (expired token).
 *
 * The queue is saved with the rest of the app's data, without the video token:
 * links are built when each download starts, from the community's current token.
 */
'use strict';
const fs = require('fs');
const { spawn, execFile } = require('child_process');

const MAX_ATTEMPTS = 3;
const PROGRESS = 'download:KS|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress.fragment_index)s|%(progress.fragment_count)s';

function formatArgs(quality) {
  const h = Number(quality);
  return h ? ['-f', `bv*[height<=${h}]+ba/b[height<=${h}]/b`] : [];
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM'); // the whole group: yt-dlp and its ffmpeg
    } catch (e) {
      try {
        child.kill('SIGTERM');
      } catch (e2) {
        /* already gone */
      }
    }
  }
}

class Downloader {
  /**
   * deps: {
   *   store, tools,
   *   prepare(item)  -> { url, referer, token } | throws Error(message)  (builds the link at start time)
   *   cookies()      -> Promise<path|null>   (a cookies.txt from the Locals session, if enabled)
   *   onChange()     called when the queue changes (the UI refreshes)
   *   onDone(item)   called when a video finishes
   * }
   */
  constructor(deps) {
    this.d = deps;
    this.running = new Map(); // key -> child process
    this.halted = '';
    this.timer = null;
    this.lastEmit = 0;
    // After a restart, nothing is running: unfinished downloads wait for "Resume".
    for (const q of this.queue) {
      if (q.status === 'downloading' || q.status === 'queued' || q.status === 'waiting') q.status = 'paused';
      q.speed = '';
      q.eta = '';
    }
  }

  get queue() {
    return this.d.store.data.queue;
  }

  find(key) {
    return this.queue.find((q) => q.key === key);
  }

  changed(force) {
    this.d.store.save();
    const now = Date.now();
    if (force || now - this.lastEmit > 300) {
      this.lastEmit = now;
      this.d.onChange();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.lastEmit = Date.now();
        this.d.onChange();
      }, 300);
    }
  }

  /** items: [{ slug, id, name, folder }] - videos already in the queue are left as they are, unless they failed. */
  add(items, opts) {
    let added = 0;
    for (const it of items) {
      const key = `${it.slug}:${it.id}`;
      const existing = this.find(key);
      if (existing) {
        if (existing.status === 'failed' || existing.status === 'paused') {
          Object.assign(existing, { status: 'queued', error: '', attempts: 0, name: it.name, folder: it.folder });
          added++;
        }
        continue;
      }
      this.queue.push({
        key,
        slug: it.slug,
        id: it.id,
        name: it.name,
        folder: it.folder,
        quality: opts.quality || '',
        fragments: opts.fragments || 4,
        status: 'queued',
        percent: 0,
        speed: '',
        eta: '',
        error: '',
        attempts: 0,
        added: Date.now()
      });
      added++;
    }
    this.halted = '';
    this.changed(true);
    this.pump();
    return added;
  }

  pause(key) {
    const q = this.find(key);
    if (!q || q.status === 'done') return;
    q.status = 'paused';
    q.speed = '';
    q.eta = '';
    killTree(this.running.get(key));
    this.changed(true);
  }

  resume(key) {
    const q = this.find(key);
    if (!q || q.status === 'done' || q.status === 'downloading') return;
    q.status = 'queued';
    q.error = '';
    if (q.attempts >= MAX_ATTEMPTS) q.attempts = 0;
    this.halted = '';
    this.changed(true);
    this.pump();
  }

  remove(key) {
    const q = this.find(key);
    if (!q) return;
    if (this.running.has(key)) {
      q.status = 'removed';
      killTree(this.running.get(key));
    }
    this.d.store.data.queue = this.queue.filter((x) => x.key !== key);
    this.changed(true);
  }

  pauseAll() {
    for (const q of this.queue) if (q.status === 'queued' || q.status === 'waiting' || q.status === 'downloading') this.pause(q.key);
  }

  resumeAll() {
    for (const q of this.queue) if (q.status === 'paused') q.status = 'queued';
    this.halted = '';
    this.changed(true);
    this.pump();
  }

  retryFailed() {
    for (const q of this.queue) {
      if (q.status === 'failed') Object.assign(q, { status: 'queued', error: '', attempts: 0 });
    }
    this.halted = '';
    this.changed(true);
    this.pump();
  }

  clearFinished() {
    this.d.store.data.queue = this.queue.filter((q) => q.status !== 'done');
    this.changed(true);
  }

  stopAll() {
    for (const child of this.running.values()) killTree(child);
  }

  summary() {
    const s = { total: this.queue.length, done: 0, failed: 0, active: 0, waiting: 0, paused: 0 };
    for (const q of this.queue) {
      if (q.status === 'done') s.done++;
      else if (q.status === 'failed') s.failed++;
      else if (q.status === 'downloading') s.active++;
      else if (q.status === 'paused') s.paused++;
      else s.waiting++;
    }
    s.halted = this.halted;
    return s;
  }

  pump() {
    if (this.halted) return;
    const limit = Math.min(3, Math.max(1, Number(this.d.store.options.parallel) || 1));
    const now = Date.now();
    let soonest = Infinity;
    for (const q of this.queue) {
      if (this.running.size >= limit) break;
      if (q.status !== 'queued' && q.status !== 'waiting') continue;
      if (q.notBefore && q.notBefore > now) {
        soonest = Math.min(soonest, q.notBefore);
        continue;
      }
      this.start(q);
    }
    if (soonest < Infinity) {
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.pump(), soonest - now + 50);
    }
  }

  halt(message) {
    this.halted = message;
    for (const q of this.queue) if (q.status === 'queued' || q.status === 'waiting') q.status = 'paused';
    this.changed(true);
  }

  async start(q) {
    const ytdlp = this.d.tools.locate('yt-dlp');
    if (!ytdlp) {
      this.halt('yt-dlp is not installed yet. Open "Tools & settings" and click "Download the tools", then Resume all.');
      return;
    }
    let link;
    try {
      link = this.d.prepare(q);
    } catch (e) {
      this.halt(e.message);
      return;
    }
    q.status = 'downloading';
    q.percent = 0;
    q.speed = '';
    q.eta = '';
    q.notBefore = 0;
    q.attempts++;
    // Reserve the slot before anything asynchronous, so pump() can't start too many.
    this.running.set(q.key, null);
    this.changed(true);

    const ffmpeg = this.d.tools.locate('ffmpeg');
    const cookieFile = await this.d.cookies();
    if (q.status !== 'downloading') {
      this.running.delete(q.key); // paused or removed while preparing
      this.pump();
      return;
    }
    try {
      fs.mkdirSync(q.folder, { recursive: true });
    } catch (e) {
      /* yt-dlp reports a clearer error */
    }
    const args = [
      '--newline',
      '--color', 'never',
      '--progress',
      '--progress-template', PROGRESS,
      '-N', String(q.fragments || 4),
      ...formatArgs(q.quality),
      '--referer', link.referer,
      '--retries', '10',
      '--fragment-retries', '10',
      '-P', q.folder,
      '-o', `${q.name}.%(ext)s`,
      '--print', 'after_move:KSFILE|%(filepath)s'
    ];
    if (ffmpeg) args.push('--ffmpeg-location', ffmpeg.path);
    if (cookieFile) args.push('--cookies', cookieFile);
    args.push(link.url);

    const child = spawn(ytdlp.path, args, {
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' })
    });
    this.running.set(q.key, child);
    let lastError = '';
    let already = false;

    const onLine = (line) => {
      if (line.startsWith('KS|')) {
        const [, pct, speed, eta, fi, fc] = line.split('|');
        let p = parseFloat(pct);
        if (isNaN(p) && Number(fc) > 0) p = (100 * Number(fi)) / Number(fc);
        if (!isNaN(p)) q.percent = Math.min(100, Math.max(q.percent || 0, Math.round(p * 10) / 10));
        q.speed = speed && !/NA|Unknown/i.test(speed) ? speed.trim() : '';
        q.eta = eta && !/NA|Unknown/i.test(eta) ? eta.trim() : '';
        this.changed();
      } else if (line.startsWith('KSFILE|')) {
        q.file = line.slice(7).trim();
      } else if (/has already been downloaded/.test(line)) {
        already = true;
      } else if (/^ERROR:/.test(line)) {
        lastError = line.replace(/^ERROR:\s*/, '').replace(/vt=[A-Za-z0-9_.-]+/g, 'vt=…').slice(0, 300);
      }
    };
    for (const stream of [child.stdout, child.stderr]) {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split(/\r?\n|\r/);
        buf = lines.pop();
        for (const l of lines) onLine(l.trim());
      });
      stream.on('end', () => buf && onLine(buf.trim()));
    }

    const finish = (code) => {
      if (this.running.get(q.key) !== child) return;
      this.running.delete(q.key);
      q.speed = '';
      q.eta = '';
      if (q.status === 'paused' || q.status === 'removed') {
        // stopped on purpose
      } else if (code === 0) {
        q.status = 'done';
        q.percent = 100;
        q.error = '';
        q.already = already;
        q.finished = Date.now();
        this.d.onDone(q);
      } else if (/HTTP Error 40[13]/.test(lastError)) {
        q.status = 'failed';
        q.error = lastError;
        this.halt(
          'Locals refused access (HTTP 403). Your video token has probably expired. In the Locals window, play any video for a few seconds, then click "Retry failed" and "Resume all".'
        );
      } else if (q.attempts < MAX_ATTEMPTS) {
        q.status = 'waiting';
        q.error = `${lastError || `yt-dlp stopped (code ${code})`} - trying again shortly`;
        q.notBefore = Date.now() + (this.d.retryDelay || 15000) * q.attempts;
      } else {
        q.status = 'failed';
        q.error = lastError || `yt-dlp stopped (code ${code})`;
      }
      this.changed(true);
      this.pump();
    };
    child.on('error', (err) => {
      lastError = `Could not start yt-dlp: ${err.message}`;
      finish(-1);
    });
    child.on('close', finish);
  }
}

module.exports = { Downloader, formatArgs, MAX_ATTEMPTS };
