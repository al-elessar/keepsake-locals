# How Keepsake works

This document describes what we know about how Locals delivers videos, as observed in November 2026 on the new ("beta") layout. Locals can change any of this without notice.

## Video delivery

- Each video is an **HLS stream**: an unencrypted `.m3u8` playlist made up of many small segments. The player (video.js) loads it into a `<video>` element through Media Source Extensions, which is why the element's source shows as `blob:`.
- Playlist address:

  ```
  https://webapi.locals.com/api/v1/posts/content/hls/v_<UUID>/source.m3u8?vt=<TOKEN>
  ```

  `source.m3u8` is the main playlist, which lists every quality. Variants such as `720.m3u8` sit next to it.
- `v_<UUID>` is the video ID, for example `v_194e4ff5-ba81-402d-8b78-c3ae08fb635a`.
- `vt` is a signed token (a JWT, audience `video`). It identifies the **member, not the video**: one token works for every video that member can access. In the sample we looked at, it was valid for about six months.
- yt-dlp's generic HLS downloader handles these playlists directly. The extension adds `--referer https://<community>.beta.locals.com/`.

## Finding the video IDs

- The new layout is a single-page app. Thumbnails in the content grid are not ordinary links, and the stream addresses are only requested when a video plays.
- The **video IDs** are present in the data the app downloads for the feed and content pages (requests to `/_server/` on the community's host). These responses are not plain JSON, so the extension uses pattern matching rather than parsing.
- `src/page-hook.js` runs in the page's context before the app starts. It wraps `fetch` and `XMLHttpRequest` so that it can:
  - collect every `v_<UUID>` found in response bodies and request URLs;
  - look for a `title: "..."` and a date (ISO string or Unix time under keys such as `createdAt` or `published_at`) within about 2,500 characters of each ID. Values inside the **same record** as the ID (worked out by counting `{}`/`[]` outside strings) win over values that are merely nearby, and a confident match later replaces an earlier guess;
  - capture `vt=` from the player's playlist request.
- It passes what it finds to `src/content.js`, which stores it in `storage.local` under `community:<slug>`. The slug is the first part of the host name, so the classic and beta layouts of one community share a single entry.

## Generating the script

`popup/generate.js` builds a script with one yt-dlp command per video:

```
yt-dlp -N 4 [-f ...] [--cookies-from-browser firefox] --referer "https://<host>/" -P "<folder>" -o "001 <Title>.%(ext)s" "<playlist URL>"
```

File names are cleaned so they are safe on Windows, and so that `%`, `!`, `&` and quotes cannot break `cmd`. If two videos have the same title, part of the video ID is added to keep the names apart.

## Windows script notes

- Each download is followed by `call :result %errorlevel% "name"`, which counts successes and failures and appends failures to `failed.txt`. There are no `( … )` blocks around titles, because brackets in a title would end a block early.
- The token's expiry date is written into the script. A PowerShell check stops with a clear message only on an explicit "expired" result (exit code 3), so a missing PowerShell never blocks downloads.
- The rename script uses unquoted wildcards (`*v_<id>*.mp4`), checks the folder exists before `cd /d`, and counts a rename only if the new file exists.
- File names can contain non-English characters. The script switches the console to UTF-8 (`chcp 65001`), which Windows 10 and 11 support.

## Known gaps

- Titles are confirmed on one live community. Dates have only been tested against mock data, so check them on the live site. Use **Export debug info**, which removes the token, and open an issue with the file if they're wrong.
- **Find all videos** scrolls whichever element on the page has the most to scroll (the window or an inner panel). It stops after about 9 seconds with no new videos and no growth in page height.
- Whether `webapi.locals.com` also requires cookies, as well as `vt`, is unknown. The cookie option exists in case it does.
- Livestream replays, audio posts and posts with several videos have not been tested.
