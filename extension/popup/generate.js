/* GENERATED from core/generate.js by scripts/sync-core.js - edit core/generate.js, not this copy. */
/*
 * Keepsake – Downloader for Locals (unofficial) - script generation
 * Pure functions, shared by the popup and the tests.
 */
(function (root) {
  'use strict';

  const HLS_BASE = 'https://webapi.locals.com/api/v1/posts/content/hls/';
  const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
  const FFMPEG_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
  const VIDEO_EXTS = ['mp4', 'mkv', 'webm', 'm4a', 'mov'];

  // ---------------------------------------------------------------- names

  // Windows-forbidden characters replaced with look-alikes that Windows accepts.
  const LOOKALIKE = {
    "'": '’', // ’
    '?': '？', // ？
    '*': '＊', // ＊
    '<': '‹', // ‹
    '>': '›', // ›
    '|': '｜', // ｜
    '/': '⁄', // ⁄
    '\\': '⧵', // ⧵
    '%': '％' // ％ (a real % would clash with yt-dlp and .bat syntax)
  };

  function finishName(s) {
    return s
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120)
      .replace(/[. ]+$/, '');
  }

  /**
   * style 'plain'     : drop characters Windows or the scripts can't handle.
   * style 'lookalike' : keep punctuation, using look-alike characters where needed.
   */
  function sanitizeName(s, style) {
    let t = String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ');
    if (style === 'lookalike') {
      let open = true;
      t = t.replace(/"/g, () => {
        const q = open ? '“' : '”'; // “ ”
        open = !open;
        return q;
      });
      t = t.replace(/\s*:\s*/g, ' - ');
      t = t.replace(/['?*<>|/\\%]/g, (c) => LOOKALIKE[c]);
      return finishName(t);
    }
    return finishName(t.replace(/[<>:"/\\|?*%!'`$^]/g, ''));
  }

  function pad(n, width) {
    return String(n).padStart(width, '0');
  }

  function decodeTokenExpiry(token) {
    try {
      const part = String(token).split('.')[1];
      const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
      const json = typeof atob === 'function'
        ? atob(b64 + '==='.slice((b64.length + 3) % 4))
        : Buffer.from(b64, 'base64').toString('utf8');
      const exp = JSON.parse(json).exp;
      return typeof exp === 'number' ? new Date(exp * 1000) : null;
    } catch (e) {
      return null;
    }
  }

  function formatArgs(quality) {
    const h = Number(quality);
    if (!h) return '';
    return `-f "bv*[height<=${h}]+ba/b[height<=${h}]/b"`;
  }

  // ---------------------------------------------------------------- entries

  /**
   * state: { slug, host, videos: {id: {title, date}}, order: [ids], token }
   * opts:  { oldestFirst, naming: 'date'|'number', nameStyle: 'plain'|'lookalike', selected: Set|null }
   */
  function buildEntries(state, opts) {
    const o = opts || {};
    // Sort by post date (oldest first), keeping the order the site sent them for ties
    // and for videos without a date (those go last). Numbers count from the oldest
    // video, so a video keeps its number when newer videos are added.
    const order = state.order || [];
    const dateOf = (id) => {
      const d = (state.videos[id] || {}).date || '';
      return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
    };
    const pos = new Map(order.map((id, i) => [id, i]));
    const dated = order.filter((id) => dateOf(id));
    const undated = order.filter((id) => !dateOf(id));
    // The site lists newest first, so for equal dates the later-received video is older.
    dated.sort((a, b) => (dateOf(a) < dateOf(b) ? -1 : dateOf(a) > dateOf(b) ? 1 : pos.get(b) - pos.get(a)));
    const ascending = dated.concat(undated.slice().reverse());
    const width = Math.max(3, String(ascending.length).length);
    const ids = o.oldestFirst ? ascending : dated.slice().reverse().concat(undated);
    const byDate = o.naming === 'date';
    const seen = new Set();
    const byId = new Map();
    // Build names oldest-first so duplicate titles get the same suffix whatever the display order.
    ascending.forEach((id, i) => {
      const v = state.videos[id] || {};
      const title = sanitizeName(v.title, o.nameStyle);
      const date = dateOf(id);
      const num = pad(i + 1, width);
      const prefix = byDate ? date || 'undated' : num;
      let name = `${prefix} ${title || id}`;
      if (seen.has(name.toLowerCase())) name = `${name} ${id.slice(2, 10)}`;
      seen.add(name.toLowerCase());
      byId.set(id, {
        id,
        num,
        title,
        date,
        name,
        src: v.src || '',
        url: `${HLS_BASE}${id}/source.m3u8?vt=${state.token || 'TOKEN_MISSING'}`
      });
    });
    const all = ids.map((id) => byId.get(id));
    return o.selected ? all.filter((e) => o.selected.has(e.id)) : all;
  }

  function commonArgs(state, opts) {
    const o = opts || {};
    const args = [];
    args.push(`-N ${Math.min(16, Math.max(1, Number(o.fragments) || 4))}`);
    const f = formatArgs(o.quality);
    if (f) args.push(f);
    if (o.cookies && o.cookies !== 'none') args.push(`--cookies-from-browser ${o.cookies}`);
    args.push(`--referer "https://${state.host || state.slug + '.locals.com'}/"`);
    return args.join(' ');
  }

  // ---------------------------------------------------------------- Windows (.bat)

  // Text that is safe to print with `echo` or pass to `call` (no & | < > ^ " %).
  const batEcho = (s) => String(s).replace(/[&<>|^"%]/g, ' ').replace(/\s+/g, ' ').trim();
  const batArg = (s) => String(s).replace(/"/g, '').replace(/%/g, '%%');

  function psCommand(cmd) {
    return `powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; ${cmd}"`;
  }

  // Sets %OUT% from a folder-picker window (or the typed folder); jumps to :nofolder on cancel.
  function batFolderLines(o, purpose) {
    const folder = String(o.folder || '').replace(/"/g, '').trim();
    const L = [];
    if (o.askFolder) {
      const init = folder.replace(/'/g, "''").replace(/%/g, '%%');
      const ps =
        'Add-Type -AssemblyName System.Windows.Forms; ' +
        '$f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; ' +
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog; ' +
        `$d.Description = '${purpose}'; $d.ShowNewFolderButton = $true; ` +
        (init ? `$d.SelectedPath = '${init}'; ` : '') +
        'if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }';
      L.push(`echo ${purpose} in the window that opens...`);
      L.push('set "OUT="');
      L.push(`for /f "usebackq delims=" %%I in (\`powershell -NoProfile -STA -Command "${ps}"\`) do set "OUT=%%I"`);
      L.push('if not defined OUT goto :nofolder');
    } else if (folder) {
      L.push(`set "OUT=${batArg(folder)}"`);
    } else {
      L.push('set "OUT=%~dp0."');
    }
    return L;
  }

  function batHeader(state, title, total) {
    return [
      '@echo off',
      'setlocal',
      'chcp 65001 >nul',
      'cd /d "%~dp0"',
      `REM ${title} - generated by Keepsake - Downloader for Locals (unofficial) on ${new Date().toISOString()}`,
      `REM Community: ${state.slug} - ${total} videos`
    ];
  }

  function makeBat(state, opts) {
    const o = opts || {};
    const entries = buildEntries(state, o);
    const args = commonArgs(state, o);
    const total = entries.length;
    const exp = decodeTokenExpiry(state.token);
    const L = batHeader(state, 'Download script', total);
    L.push('REM This file contains your personal Locals video token. Do not share it.');
    L.push('REM Run it again at any time: finished videos are skipped and failed ones are retried.');
    L.push('');
    if (exp) {
      // Exit code 3 means "expired"; anything else (including PowerShell missing) carries on.
      L.push(`powershell -NoProfile -Command "if ((Get-Date).ToUniversalTime() -gt [datetime]::Parse('${exp.toISOString()}').ToUniversalTime()) { exit 3 }"`);
      L.push('if %errorlevel% EQU 3 goto :expired');
    }
    L.push('where yt-dlp >nul 2>nul || call :getytdlp');
    L.push('where yt-dlp >nul 2>nul || goto :noytdlp');
    L.push('where ffmpeg >nul 2>nul || call :getffmpeg');
    L.push('where ffmpeg >nul 2>nul || echo WARNING: ffmpeg was not found - downloads may fail to join.');
    L.push('');
    L.push(...batFolderLines(o, 'Choose where to save the videos'));
    L.push('echo Saving to: "%OUT%"');
    L.push('set /a OK=0');
    L.push('set /a FAIL=0');
    L.push('if exist failed.txt del failed.txt');
    L.push('');
    entries.forEach((e, i) => {
      const label = batEcho(`[${i + 1}/${total}] ${e.name}`);
      L.push(`echo ${label}`);
      L.push(`yt-dlp ${args} -P "%OUT%" -o "${batArg(e.name)}.%%(ext)s" "${e.url}"`);
      L.push(`call :result %errorlevel% "${batEcho(e.name)}"`);
    });
    L.push('');
    L.push('echo.');
    L.push('echo ============================================================');
    L.push('echo Finished: %OK% done (or already downloaded), %FAIL% failed.');
    L.push('if %FAIL% GTR 0 echo The failed videos are listed in failed.txt next to this script.');
    L.push('if %FAIL% GTR 0 echo Run this script again to retry them - finished videos are skipped.');
    L.push('if %FAIL% GTR 0 echo If they all failed with HTTP Error 403, your token has probably expired:');
    L.push('if %FAIL% GTR 0 echo play any video on Locals, then download a new script from the extension.');
    L.push('echo ============================================================');
    L.push('pause');
    L.push('goto :eof');
    L.push('');
    // No ( ) blocks here: video titles can contain brackets, which would end a block early.
    L.push(':result');
    L.push('if not "%~1"=="0" goto :result_fail');
    L.push('set /a OK+=1');
    L.push('exit /b 0');
    L.push(':result_fail');
    L.push('set /a FAIL+=1');
    L.push('>>failed.txt echo %~2');
    L.push('exit /b 0');
    L.push('');
    L.push(':expired');
    L.push(`echo Your Locals video token in this script expired on ${exp ? exp.toISOString().slice(0, 10) : 'an earlier date'}.`);
    L.push('echo Open the community on Locals, play any video for a few seconds,');
    L.push('echo then download a new script from the extension.');
    L.push('pause');
    L.push('exit /b 1');
    L.push('');
    L.push(':nofolder');
    L.push('echo No folder was chosen, so nothing was downloaded.');
    L.push('pause');
    L.push('exit /b 1');
    L.push('');
    L.push(':noytdlp');
    L.push('echo yt-dlp was not found. Put yt-dlp.exe in the same folder as this file, or install it.');
    L.push('echo Download: https://github.com/yt-dlp/yt-dlp/releases/latest');
    L.push('pause');
    L.push('exit /b 1');
    L.push('');
    L.push(':getytdlp');
    L.push('echo.');
    L.push('echo yt-dlp, the program that does the downloading, was not found.');
    L.push('choice /c YN /m "Download yt-dlp into this folder now"');
    L.push('if errorlevel 2 exit /b 0');
    L.push('echo Downloading yt-dlp...');
    L.push(psCommand(`Invoke-WebRequest -UseBasicParsing -Uri '${YTDLP_URL}' -OutFile 'yt-dlp.exe'`));
    L.push('if exist yt-dlp.exe (echo yt-dlp downloaded.) else (echo The download failed.)');
    L.push('exit /b 0');
    L.push('');
    L.push(':getffmpeg');
    L.push('echo.');
    L.push('echo ffmpeg, which joins the video pieces together, was not found.');
    L.push('choice /c YN /m "Download ffmpeg into this folder now - about 160 MB"');
    L.push('if errorlevel 2 exit /b 0');
    L.push('echo Downloading ffmpeg. This can take a few minutes...');
    L.push(
      psCommand(
        "$z = Join-Path $env:TEMP 'lvs-ffmpeg.zip'; $d = Join-Path $env:TEMP 'lvs-ffmpeg'; " +
          `Invoke-WebRequest -UseBasicParsing -Uri '${FFMPEG_URL}' -OutFile $z; ` +
          'Expand-Archive -Force $z $d; ' +
          "Get-ChildItem $d -Recurse -Include ffmpeg.exe,ffprobe.exe | Copy-Item -Destination '.'; " +
          'Remove-Item -Recurse -Force $z, $d'
      )
    );
    L.push('if exist ffmpeg.exe (echo ffmpeg downloaded.) else (echo The download failed.)');
    L.push('exit /b 0');
    return L.join('\r\n') + '\r\n';
  }

  // Renames earlier downloads whose file names contain the video ID (e.g. "001 v_9c75....mp4").
  function makeRenameBat(state, opts) {
    const o = opts || {};
    const entries = buildEntries(state, Object.assign({}, o, { selected: null }));
    const L = batHeader(state, 'Rename script', entries.length);
    L.push('REM Renames files named with a video ID (from an older download) to titles.');
    L.push('REM Files that already have the new name are left alone.');
    L.push('');
    L.push(...batFolderLines(o, 'Choose the folder with the downloaded videos'));
    L.push('if not exist "%OUT%\\" goto :nofolder');
    L.push('cd /d "%OUT%"');
    L.push('echo Renaming files in: "%CD%"');
    L.push('set /a N=0');
    entries.forEach((e) => {
      const pats = VIDEO_EXTS.map((x) => `*${e.id}*.${x}`).join(' ');
      L.push(`for %%F in (${pats}) do if not exist "${batArg(e.name)}%%~xF" call :ren "%%F" "${batArg(e.name)}%%~xF"`);
    });
    L.push('echo.');
    L.push('echo Renamed %N% files.');
    L.push('pause');
    L.push('goto :eof');
    L.push('');
    L.push(':ren');
    L.push('ren %1 %2');
    L.push('if exist %2 set /a N+=1');
    L.push('exit /b 0');
    L.push('');
    L.push(':nofolder');
    L.push('echo No folder was chosen, so nothing was renamed.');
    L.push('pause');
    L.push('exit /b 1');
    return L.join('\r\n') + '\r\n';
  }

  // ---------------------------------------------------------------- Mac / Linux (.sh)

  function shQuote(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
  }

  function shFolderLines(o, purpose) {
    const folder = String(o.folder || '').trim();
    const L = [];
    if (o.askFolder) {
      L.push('if command -v osascript >/dev/null 2>&1; then');
      L.push(`  OUT=$(osascript -e 'POSIX path of (choose folder with prompt "${purpose}")') || exit 1`);
      L.push('elif command -v zenity >/dev/null 2>&1; then');
      L.push(`  OUT=$(zenity --file-selection --directory --title="${purpose}") || exit 1`);
      L.push('else');
      L.push(`  read -r -p "${purpose}: " OUT`);
      L.push('fi');
      L.push('[ -n "$OUT" ] || { echo "No folder was chosen."; exit 1; }');
    } else if (folder) {
      L.push(`OUT=${shQuote(folder)}`);
    } else {
      L.push('OUT="$(pwd)"');
    }
    return L;
  }

  function makeSh(state, opts) {
    const o = opts || {};
    const entries = buildEntries(state, o);
    const args = commonArgs(state, o);
    const total = entries.length;
    const exp = decodeTokenExpiry(state.token);
    const L = [];
    L.push('#!/usr/bin/env bash');
    L.push(`# Download script - generated by Keepsake - Downloader for Locals (unofficial) on ${new Date().toISOString()}`);
    L.push(`# Community: ${state.slug} - ${total} videos`);
    L.push('# This file contains your personal Locals video token. Do not share it.');
    L.push('# Run it again at any time: finished videos are skipped and failed ones are retried.');
    L.push('cd "$(dirname "$0")" || exit 1');
    if (exp) {
      L.push(`if [ "$(date +%s)" -gt ${Math.floor(exp.getTime() / 1000)} ]; then`);
      L.push(`  echo "Your Locals video token in this script expired on ${exp.toISOString().slice(0, 10)}."`);
      L.push('  echo "Play any video on Locals, then download a new script from the extension."');
      L.push('  exit 1');
      L.push('fi');
    }
    L.push('command -v yt-dlp >/dev/null 2>&1 || { echo "yt-dlp was not found. Install it with: brew install yt-dlp ffmpeg (Mac) or your package manager (Linux)."; exit 1; }');
    L.push('command -v ffmpeg >/dev/null 2>&1 || echo "WARNING: ffmpeg was not found - downloads may fail to join."');
    L.push('');
    L.push(...shFolderLines(o, 'Choose where to save the videos'));
    L.push('echo "Saving to: $OUT"');
    L.push('OK=0; FAIL=0; rm -f failed.txt');
    L.push('');
    entries.forEach((e, i) => {
      L.push(`echo ${shQuote(`[${i + 1}/${total}] ${e.name}`)}`);
      L.push(
        `if yt-dlp ${args} -P "$OUT" -o ${shQuote(e.name + '.%(ext)s')} ${shQuote(e.url)}; then OK=$((OK+1)); else FAIL=$((FAIL+1)); echo ${shQuote(e.name)} >> failed.txt; fi`
      );
    });
    L.push('');
    L.push('echo "============================================================"');
    L.push('echo "Finished: $OK done (or already downloaded), $FAIL failed."');
    L.push('if [ "$FAIL" -gt 0 ]; then');
    L.push('  echo "The failed videos are listed in failed.txt next to this script."');
    L.push('  echo "Run this script again to retry them - finished videos are skipped."');
    L.push('  echo "If they all failed with HTTP Error 403, your token has probably expired:"');
    L.push('  echo "play any video on Locals, then download a new script from the extension."');
    L.push('fi');
    return L.join('\n') + '\n';
  }

  function makeRenameSh(state, opts) {
    const o = opts || {};
    const entries = buildEntries(state, Object.assign({}, o, { selected: null }));
    const L = [];
    L.push('#!/usr/bin/env bash');
    L.push(`# Rename script - generated by Keepsake - Downloader for Locals (unofficial) on ${new Date().toISOString()}`);
    L.push('# Renames files named with a video ID (from an older download) to titles.');
    L.push('cd "$(dirname "$0")" || exit 1');
    L.push(...shFolderLines(o, 'Choose the folder with the downloaded videos'));
    L.push('cd "$OUT" || exit 1');
    L.push('shopt -s nullglob');
    L.push('N=0');
    entries.forEach((e) => {
      const globs = VIDEO_EXTS.map((x) => `*${e.id}*.${x}`).join(' ');
      L.push(`for f in ${globs}; do t=${shQuote(e.name)}."\${f##*.}"; [ -e "$t" ] || { mv -- "$f" "$t" && N=$((N+1)); }; done`);
    });
    L.push('echo "Renamed $N files."');
    return L.join('\n') + '\n';
  }

  // ---------------------------------------------------------------- other exports

  function makeUrlList(state, opts) {
    return buildEntries(state, opts).map((e) => e.url).join('\n') + '\n';
  }

  function makeDebug(state, version) {
    const order = state.order || [];
    const v = (id) => state.videos[id] || {};
    const exp = state.token ? decodeTokenExpiry(state.token) : null;
    return JSON.stringify(
      {
        tool: 'Keepsake - Downloader for Locals (unofficial)',
        version,
        slug: state.slug,
        host: state.host,
        videoCount: order.length,
        titledCount: order.filter((id) => v(id).title).length,
        datedCount: order.filter((id) => v(id).date).length,
        feedOnlyCount: order.filter((id) => v(id).src === 'feed').length,
        tokenPresent: Boolean(state.token),
        tokenExpires: exp ? exp.toISOString() : null,
        firstVideos: order.slice(0, 20).map((id) => ({ id, title: v(id).title || '', date: v(id).date || '', src: v(id).src || '' })),
        samples: state.samples || []
      },
      null,
      2
    );
  }

  const LVS = {
    sanitizeName,
    decodeTokenExpiry,
    buildEntries,
    makeBat,
    makeSh,
    makeRenameBat,
    makeRenameSh,
    makeUrlList,
    makeDebug
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = LVS;
  root.LVS = LVS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
