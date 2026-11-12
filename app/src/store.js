/*
 * Keepsake desktop app - local data, kept in one JSON file in the app's data folder:
 *   Windows: %APPDATA%\Keepsake\keepsake-data.json
 *
 * Holds the videos found per community, tick-box choices, what has been downloaded,
 * the download queue and the options. The Locals sign-in session is NOT here: Electron
 * keeps it in its own "Partitions/locals" folder, like a browser profile.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_OPTIONS = {
  folder: '',
  quality: '',
  naming: 'date',
  nameStyle: 'plain',
  oldestFirst: false,
  fragments: 4,
  parallel: 1,
  useCookies: true,
  toolsFolder: '',
  lastCommunity: ''
};

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'keepsake-data.json');
    this.timer = null;
    this.data = { version: 1, options: {}, communities: {}, excluded: {}, downloaded: {}, fresh: {}, scanned: {}, queue: [] };
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved && typeof saved === 'object') Object.assign(this.data, saved);
    } catch (e) {
      /* first run, or unreadable: start fresh */
    }
    this.data.options = Object.assign({}, DEFAULT_OPTIONS, this.data.options);
    for (const k of ['communities', 'excluded', 'downloaded', 'fresh', 'scanned']) this.data[k] = this.data[k] || {};
    this.data.queue = this.data.queue || [];
  }

  get options() {
    return this.data.options;
  }

  setOption(key, value) {
    if (!(key in DEFAULT_OPTIONS)) return;
    const def = DEFAULT_OPTIONS[key];
    if (typeof def === 'number') value = Number(value) || def;
    else if (typeof def === 'boolean') value = Boolean(value);
    else value = String(value == null ? '' : value);
    if (key === 'fragments') value = Math.min(16, Math.max(1, value));
    if (key === 'parallel') value = Math.min(3, Math.max(1, value));
    this.data.options[key] = value;
    this.save();
  }

  community(slug) {
    return this.data.communities[slug] || null;
  }

  setCommunity(slug, state) {
    this.data.communities[slug] = state;
    this.save();
  }

  list(kind, slug) {
    return new Set(this.data[kind][slug] || []);
  }

  setList(kind, slug, set) {
    this.data[kind][slug] = Array.from(set);
    this.save();
  }

  removeCommunity(slug) {
    delete this.data.communities[slug];
    delete this.data.excluded[slug];
    delete this.data.downloaded[slug];
    delete this.data.fresh[slug];
    delete this.data.scanned[slug];
    this.data.queue = this.data.queue.filter((q) => q.slug !== slug);
    this.save();
  }

  save(now) {
    if (now) return this.flush();
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 700);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    // Write to a temporary file first, so a crash can never leave a half-written file.
    const tmp = this.file + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('Could not save data:', e);
    }
  }
}

module.exports = { Store, DEFAULT_OPTIONS };
