/*
 * Keepsake desktop app - yt-dlp and ffmpeg
 *
 * Neither is bundled with the app (ffmpeg's licence is GPL; yt-dlp updates often).
 * On first use the app downloads the official builds from GitHub into its own data
 * folder and checks each file against the SHA-256 checksums its project publishes.
 * Copies the member already has (a chosen folder, or on PATH) are used if present.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const YTDLP_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
const FFMPEG_BASE = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/';

const PLATFORM = {
  win32: {
    exe: '.exe',
    ytdlp: 'yt-dlp.exe',
    ffmpeg: 'ffmpeg-master-latest-win64-gpl.zip'
  },
  linux: {
    exe: '',
    ytdlp: 'yt-dlp_linux',
    ffmpeg: 'ffmpeg-master-latest-linux64-gpl.tar.xz'
  },
  darwin: {
    exe: '',
    ytdlp: 'yt-dlp_macos',
    ffmpeg: null // no official static build here yet: use Homebrew (brew install ffmpeg)
  }
}[process.platform] || { exe: '', ytdlp: null, ffmpeg: null };

function run(file, args, timeout) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeout || 20000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout || ''));
    });
  });
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}

function onPath(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir && isFile(path.join(dir, name + PLATFORM.exe))) return path.join(dir, name + PLATFORM.exe);
  }
  return null;
}

function parseSums(text) {
  const sums = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m) sums[m[2].trim()] = m[1].toLowerCase();
  }
  return sums;
}

class Tools {
  /**
   * dir:      the app's own tools folder
   * getOpts:  () => options (toolsFolder)
   * fetchFn:  fetch implementation (Electron's net.fetch: uses the system proxy and certificates)
   */
  constructor(dir, getOpts, fetchFn) {
    this.dir = dir;
    this.getOpts = getOpts;
    this.fetch = fetchFn;
    this.busy = false;
  }

  locate(name) {
    const file = name + PLATFORM.exe;
    const custom = String(this.getOpts().toolsFolder || '').trim();
    if (custom && isFile(path.join(custom, file))) return { path: path.join(custom, file), source: 'custom' };
    if (isFile(path.join(this.dir, file))) return { path: path.join(this.dir, file), source: 'app' };
    const p = onPath(name);
    return p ? { path: p, source: 'path' } : null;
  }

  async status() {
    const out = { canFetchYtdlp: Boolean(PLATFORM.ytdlp), canFetchFfmpeg: Boolean(PLATFORM.ffmpeg), busy: this.busy };
    const y = this.locate('yt-dlp');
    out.ytdlp = y ? Object.assign({ version: ((await run(y.path, ['--version'])) || '').trim() || '?' }, y) : null;
    const f = this.locate('ffmpeg');
    if (f) {
      const v = (await run(f.path, ['-version'])) || '';
      const m = v.match(/ffmpeg version (\S+)/);
      out.ffmpeg = Object.assign({ version: m ? m[1].slice(0, 30) : '?' }, f);
    } else {
      out.ffmpeg = null;
    }
    return out;
  }

  async download(url, dest, onProgress, expectedSha) {
    const res = await this.fetch(url);
    if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}) for ${url}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const hash = crypto.createHash('sha256');
    let got = 0;
    let last = 0;
    const body = Readable.fromWeb(res.body);
    body.on('data', (chunk) => {
      hash.update(chunk);
      got += chunk.length;
      if (onProgress && Date.now() - last > 250) {
        last = Date.now();
        onProgress(got, total);
      }
    });
    await pipeline(body, fs.createWriteStream(dest));
    const sha = hash.digest('hex');
    if (expectedSha && sha !== expectedSha) {
      fs.rmSync(dest, { force: true });
      throw new Error(`Checksum mismatch for ${path.basename(url)}: the download was damaged or tampered with, so it was deleted.`);
    }
    return sha;
  }

  async sums(base, file) {
    const res = await this.fetch(base + file);
    if (!res.ok) throw new Error(`Could not get the checksums (HTTP ${res.status}).`);
    return parseSums(await res.text());
  }

  /**
   * Downloads whatever is missing into the app's tools folder. With force ("Update"),
   * also fetches the newest yt-dlp (Locals or YouTube changes sometimes need one).
   * progress(text) is called with human-readable updates.
   */
  async install(progress, force) {
    if (this.busy) throw new Error('Already downloading the tools.');
    this.busy = true;
    const say = progress || (() => {});
    const mb = (n) => (n / 1048576).toFixed(1);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const y = this.locate('yt-dlp');
      if (PLATFORM.ytdlp && (force || !y)) {
        say('Checking yt-dlp…');
        const sums = await this.sums(YTDLP_BASE, 'SHA2-256SUMS');
        const sha = sums[PLATFORM.ytdlp];
        if (!sha) throw new Error('yt-dlp checksum not found.');
        const tmp = path.join(this.dir, 'yt-dlp.download');
        await this.download(YTDLP_BASE + PLATFORM.ytdlp, tmp, (g, t) => say(`Downloading yt-dlp… ${mb(g)}${t ? ' of ' + mb(t) : ''} MB`), sha);
        const dest = path.join(this.dir, 'yt-dlp' + PLATFORM.exe);
        fs.renameSync(tmp, dest);
        if (PLATFORM.exe === '') fs.chmodSync(dest, 0o755);
      }
      const f = this.locate('ffmpeg');
      if (PLATFORM.ffmpeg && !f) {
        say('Checking ffmpeg…');
        const sums = await this.sums(FFMPEG_BASE, 'checksums.sha256');
        const sha = sums[PLATFORM.ffmpeg];
        if (!sha) throw new Error('ffmpeg checksum not found.');
        const archive = path.join(os.tmpdir(), `keepsake-${process.pid}-${PLATFORM.ffmpeg}`);
        const work = archive + '-x';
        try {
          await this.download(FFMPEG_BASE + PLATFORM.ffmpeg, archive, (g, t) => say(`Downloading ffmpeg… ${mb(g)}${t ? ' of ' + mb(t) : ''} MB`), sha);
          say('Unpacking ffmpeg…');
          fs.mkdirSync(work, { recursive: true });
          if (archive.endsWith('.zip')) {
            await require('extract-zip')(archive, { dir: work });
          } else {
            await new Promise((resolve, reject) =>
              execFile('tar', ['-xJf', archive, '-C', work], (err) => (err ? reject(err) : resolve()))
            );
          }
          for (const name of ['ffmpeg', 'ffprobe']) {
            const found = findFile(work, name + PLATFORM.exe);
            if (!found) throw new Error(`${name} was not in the download.`);
            const dest = path.join(this.dir, name + PLATFORM.exe);
            fs.copyFileSync(found, dest);
            if (PLATFORM.exe === '') fs.chmodSync(dest, 0o755);
          }
        } finally {
          fs.rmSync(archive, { force: true });
          fs.rmSync(work, { recursive: true, force: true });
        }
      }
      say('');
    } finally {
      this.busy = false;
    }
  }
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const r = findFile(p, name);
      if (r) return r;
    } else if (entry.name === name) {
      return p;
    }
  }
  return null;
}

module.exports = { Tools, parseSums, PLATFORM };
