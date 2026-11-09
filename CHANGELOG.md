# Changelog

## Desktop app 0.1.0 (beta, Windows) – unreleased
- New standalone app in `app/`: sign in on Locals' own page inside the app, **Find all videos**, tick and **Download**, with no script step.
- Download queue with progress, pause/resume, automatic retries, and a clear stop when the token has expired (HTTP 403).
- yt-dlp and ffmpeg fetched on first use from their official releases and checked against their published checksums.
- **Rename old downloads** built in.

## Extension (next version)
- Internal: detection, merging, scrolling and naming code moved to `core/`, shared with the desktop app. No change in behaviour.

## 0.5.0 – 2026-11-09
- Renamed to **Keepsake – Downloader for Locals**, with a new add-on ID.
- Publishing materials: README, Firefox listing text, issue templates and automated checks.

## 0.4.0
- The download script ends with a summary ("352 done, 5 failed") and writes `failed.txt`. Running it again retries the failures.
- The script stops with a clear message if the token in it has expired.
- Rename script for earlier downloads named by video ID.
- Videos found only on the Feed are tagged **FEED**, with a tip to run **Find all videos** there too.
- Optional look-alike punctuation in file names (`Example “quoted” title`).

## 0.3.x
- **Find all videos:** automatic scrolling to the end of the page.
- Post dates captured, giving date-based file names (`2026-11-01 Title`).
- The list is sorted by date, and numbers count from the oldest video, so they stay the same.
- **New:** selects only videos not included in an earlier script.
- The Windows script offers to download yt-dlp and ffmpeg.
- Titles containing quotation marks are kept intact. Titles and dates are matched within the same post record.

## 0.2.x
- Tick boxes, title search and Shift-click ranges.
- Folder picker when the script runs.
- Scripts save straight to the Downloads folder (fixes "Failed" downloads in Firefox).
- New icon.

## 0.1.0
- First prototype: collects video IDs, titles and the member's token, and builds a yt-dlp script.
