# Firefox Add-ons (AMO) submission text

Copy these into the addons.mozilla.org submission form.

## Distribution
**Recommended first: "On your own" (unlisted, self-distributed).** Mozilla signs the add-on and you attach `keepsake.xpi` to GitHub releases. You can apply for a public listing later.

## Name
Keepsake – Downloader for Locals

## Summary (max 250 characters)
Unofficial tool: save videos from Locals communities you belong to, for offline viewing. Lists every video with title and date and builds a yt-dlp download script. No tracking and no network requests of its own.

## Categories / tags
- Category: Download Management
- Tags: download, video, offline, yt-dlp

## Description
Keepsake helps members of Locals communities keep offline copies of videos they already have access to.

• **Find all videos:** scrolls a community's Content page and collects every video with its title and date.
• **Choose what you want:** tick boxes, search, and "New" for videos added since last time.
• **Builds a script:** a ready-to-run download script for yt-dlp (Windows .bat, or .sh for Mac/Linux), with tidy file names such as "2026-11-01 Title.mp4".
• **Private:** Keepsake makes no network requests of its own. Everything stays in your browser.

Unofficial: not affiliated with, endorsed by or supported by Locals or Rumble. For personal offline viewing only. Please don't share what you download.

Source code: https://github.com/al-elessar/keepsake-locals

## Support
- Support site: https://github.com/al-elessar/keepsake-locals/issues
- Support email: (optional – a project address, not a personal one)

## Licence
MIT

## Privacy policy
Not required: the add-on doesn't collect or transmit user data. The manifest declares `data_collection_permissions: none`. If the form asks anyway, use this:

> Keepsake does not collect, transmit or sell any data. It makes no network requests of its own. Video titles, dates, IDs and the member's video token are read from pages the user has open on locals.com and stored only in the browser's local extension storage, where the user can delete them at any time ("Clear this community's data"). Generated download scripts are saved only to the user's own computer.

## Notes for reviewers
- **What it does:** on `*.locals.com` pages only, `src/page-hook.js` runs in the page context at `document_start`. It wraps `fetch`/`XMLHttpRequest` to *read* responses the page already receives. From those it extracts video IDs (`v_<uuid>`), post titles and dates, and the member's own video token (the `vt=` query value on HLS playlist requests). It doesn't modify any request or response.
- **Data flow:** findings go to `src/content.js` by `window.postMessage`, and are stored with `storage.local`. The popup (`popup/`) builds a text script (`popup/generate.js`) and saves it with `downloads.download` from a Blob URL. **The add-on makes no network requests of its own.**
- **No remote code**, no obfuscation, no third-party libraries.
- **Testing without a Locals account:** the repository includes a mock Locals page and an end-to-end test (`test/e2e/`). Run `python3 test/e2e/mock_locals_server.py` and map `example.beta.locals.com` to `127.0.0.1:8765` (or see `run_e2e.py`).
- **Permissions:** `storage` (findings and options), `downloads` (saving the generated script), `activeTab` (knowing which community the popup is for), host access to `*.locals.com` only.

## Release checklist
1. Update `version` in `extension/manifest.json` and add an entry to `CHANGELOG.md`.
2. Run `node test/run-tests.js` and `npx web-ext lint --source-dir extension`.
3. Build: `npx web-ext build --source-dir extension --overwrite-dest` (creates `web-ext-artifacts/keepsake_downloader_for_locals-<version>.zip`).
4. Firefox: upload the zip on addons.mozilla.org ("On your own"), download the signed `.xpi`, and rename it to `keepsake.xpi`.
5. Chrome: attach the same zip as `keepsake-chrome.zip`.
6. Create a GitHub release `v<version>` with both files and the changelog entry.
7. Add the new version to `updates.json` (pointing at `releases/download/v<version>/keepsake.xpi`) so installed Firefox copies update automatically.
