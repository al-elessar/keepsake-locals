/*
 * Keepsake desktop app - files already in the member's video folder.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const VIDEO_EXTS = ['.mp4', '.mkv', '.webm', '.m4a', '.mov'];
const ID_RE = /v_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/**
 * Renames files named with a video ID (from an older download, e.g. "001 v_9c75….mp4")
 * to the names Keepsake would give them now. Files whose new name already exists are left alone.
 * entries: from LVS.buildEntries (id, name)
 */
function renameOld(entries, folder) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  let renamed = 0;
  let skipped = 0;
  for (const file of fs.readdirSync(folder)) {
    const ext = path.extname(file);
    if (!VIDEO_EXTS.includes(ext.toLowerCase())) continue;
    const m = file.match(ID_RE);
    const e = m && byId.get(m[0]);
    if (!e) continue;
    const target = e.name + ext;
    if (target === file) continue;
    if (fs.existsSync(path.join(folder, target))) {
      skipped++;
      continue;
    }
    try {
      fs.renameSync(path.join(folder, file), path.join(folder, target));
      renamed++;
    } catch (err) {
      skipped++;
    }
  }
  return { renamed, skipped, folder };
}

module.exports = { renameOld, VIDEO_EXTS };
