# Keepsake desktop app (beta)

A standalone app for **Windows, Mac and Linux** that does everything the browser extension does, **and runs the downloads itself**: no script to save and run.

<p align="center"><img src="../docs/screenshots/app-videos.png" width="720" alt="The Keepsake app: a list of videos with dates and tick boxes, and a Download button"></p>

> **Unofficial.** Not affiliated with, endorsed by or supported by Locals or Rumble.
> For personal offline viewing of videos your own account can already watch. Please don't share what you download.

## Your password and your sign-in

- You sign in on **Locals' own sign-in page**, shown in the app's *Locals window*, exactly as in a browser. **Keepsake never sees, reads or stores your password.**
- **Signed up with Google (or Apple)?** Google and Apple don't allow signing in inside apps, and show *"Couldn't sign you in"*. Instead, sign in to Locals in **Firefox** as usual, then click **Use my Firefox sign-in** in Keepsake. Keepsake copies only the Locals sign-in (the locals.com cookies) from your Firefox profile, the same thing yt-dlp's "browser cookies" option does. It never sees your password or your Google account.
- After you sign in, the **session** (the cookies Locals sets) is kept only on your computer, in the app's data folder, just as a browser keeps it. **Sign out of Locals** in *Tools & settings* deletes it.
- Your personal **video token** (picked up when you play a video) is kept in the same place. It is sent only to Locals, when downloading.
- The app contacts only Locals (as your browser would) and GitHub (once, to fetch yt-dlp and ffmpeg). There is no server, analytics or tracking.

## Install

Download the file for your computer from the latest **Keepsake desktop app** release on the [releases page](../../../releases).

The app isn't signed with a paid code-signing certificate, so each system warns you the first time. This is expected for small open-source apps.

**Windows 10/11:** `Keepsake-Setup-<version>.exe`
1. Run it. If Windows shows **"Windows protected your PC"**, click **More info → Run anyway**.
2. Choose where to install it (or keep the default) and finish.

**Mac:** `Keepsake-<version>-mac-arm64.dmg` for Apple silicon (M1 and later), `…-mac-x64.dmg` for older Intel Macs.
1. Open the `.dmg` and drag **Keepsake** into **Applications**.
2. The first time, macOS says it can't check the app for malicious software. Click **Done**, then open **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to Keepsake.
3. Install ffmpeg with [Homebrew](https://brew.sh): `brew install ffmpeg` (Keepsake fetches yt-dlp itself).

**Linux:** `Keepsake-<version>-linux-x86_64.AppImage`
1. Make it executable (`chmod +x Keepsake-*.AppImage`, or *Properties → Allow executing*) and run it.

### Updates

The app checks for a new version when it starts and every few hours.
- **Windows and Linux:** the update downloads in the background. Click **Restart now** when it's ready, or it installs the next time you close Keepsake.
- **Mac:** you'll see a notice with a **Download** link. Install it the same way as the first time. (macOS only lets apps signed with a paid Apple certificate update themselves.)

Unfinished downloads carry on after an update: click **Resume all**.

## How to use

1. **＋ Add** your community: type its name (e.g. `example`) or paste its link.
2. The **Locals window** opens. **Sign in** there if you aren't already. If you sign in to Locals with Google, sign in in Firefox instead and click **Use my Firefox sign-in** (see above).
3. Back in Keepsake, click **Find all videos**. The Locals window scrolls through the Content page by itself. Click **Also check the Feed** to catch videos posted in ordinary posts.
4. In the Locals window, **play any video for a few seconds**, so that your access token is picked up. The top bar then shows *Token valid until …*.
5. Tick the videos you want, **Choose…** a folder, and click **Download**.
6. Follow progress on the **Downloads** tab. You can pause, resume and retry, and close the app at any time: unfinished downloads carry on from where they stopped when you click **Resume all**.
7. Later, click **Check for new videos**. It looks at the newest posts only, so it takes a few seconds. New videos are marked **NEW** until you download them, and the **New** button ticks just those.

The first time you download, Keepsake fetches **yt-dlp** and **ffmpeg** from their official GitHub pages and checks them against their published checksums. Already have them? Use **Tools & settings → Use my own copies…**.

### Other tools (Tools & settings)

- **Rename old downloads…**: renames videos named by ID (e.g. `001 v_9c750134-….mp4`) to their titles.
- **Save Windows script / Mac/Linux script**: the same scripts as the extension, if you prefer to run downloads elsewhere.
- **Update yt-dlp**: fetches the newest yt-dlp (worth doing if downloads suddenly start failing).

### If something goes wrong

- **"Locals refused access (HTTP 403)"**: your token has probably expired. Play any video in the Locals window, then click **Retry failed** and **Resume all**.
- **"Couldn't sign you in" (Google):** use **Use my Firefox sign-in**, as described above.
- **No videos found:** make sure you are signed in, in the Locals window, and that you can see the videos there.
- **Save debug info** creates a file *without* your token, which you can attach to a bug report.

## Where things are kept

Everything is in one data folder: `%APPDATA%\Keepsake` on Windows, `~/Library/Application Support/Keepsake` on Mac, `~/.config/Keepsake` on Linux.

| What | Where, inside that folder |
|---|---|
| Video lists, choices, download queue, token | `keepsake-data.json` |
| Locals sign-in session | `Partitions/locals/` |
| yt-dlp and ffmpeg | `tools/` |

Uninstalling leaves these in place. Delete the data folder to remove them.

## Development

The app is built with [Electron](https://www.electronjs.org/). It uses the same detection and naming code as the extension, from [`core/`](../core).

```
cd app
npm install
npm start                       # run the app
npm test                        # unit tests (queue, tools, storage, renaming)
xvfb-run -a npm run test:e2e    # end-to-end test against the mock Locals site (Linux; needs python3 and ffmpeg)
npm run dist                    # Windows installer (on Windows, or on Linux with Wine)
npm run dist:mac                # Mac .dmg and .zip (on a Mac)
npm run dist:linux              # Linux AppImage
```

GitHub Actions runs the tests and builds all three on every change (see `.github/workflows/app.yml`).

**Releasing a new app version:** set the version in `app/package.json`, update `app/RELEASE-NOTES.md` and `CHANGELOG.md`, and merge to `main`. Then on GitHub: **Actions → Desktop app → Run workflow**, keep the branch on `main`, tick **Publish a release**, and click **Run workflow**. It tests, builds, and publishes the installers as release `app-v<version>`, and updates the **app-updates** release, which installed apps check for updates. Don't delete that release. (Pushing a tag `app-v<version>` does the same.)
