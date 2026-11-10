# TJ Record — Chrome extension

Records a browser tab together with its console, network requests and user actions, then files it
as a record in the **TJ Record** ToolJet app.

## Install

From the Chrome Web Store: *link added once the listing is published*. Works in Chrome and other
Chromium browsers (Comet, Edge, Brave, Arc).

Unpacked, for development:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.
3. Pin the TJ Record icon.

You must be signed in to app.tooljet.ai in the same Chrome profile. The extension has no tokens or
AWS keys: the upload runs inside TJ Record as you.

## Use

- **Record tab** (popup, or `Alt+Shift+R`): records up to 3 minutes. A small control in the
  bottom-left corner of the page shows the time and has **Stop** and discard (✕).
- **Record screen**: opens a TJ Record tab with Chrome's picker; choose an entire screen or a
  window. You go back to your page while the recorder tab keeps running (keep it open). Console,
  network and clicks come from the tab you started on. Stop from the popup, the page control, the
  recorder tab or Chrome's **Stop sharing**. On macOS, Chrome needs Screen Recording permission
  (System Settings → Privacy & Security → Screen & System Audio Recording).
- **Screenshot**: freezes the visible part of the tab; drag to select the area to keep, or press
  **Enter** / **Whole view** to keep all of it. **Esc** cancels. The picker is a modal dialog, so it
  also works over pages that have their own dialog open.
- **Instant replay** (popup → ⚙ Settings → **Instant replay**): keeps the last 3 minutes of the tab
  in memory, with its console, network and clicks. When a bug happens, open the popup and pick
  **Save the last 1 / 2 / 3 min**; that part goes to the Upload page and replay keeps running.
  The toolbar icon shows **RPL** while it is on. Closing the tab or switching it off in Settings
  discards the buffer. Recording is unavailable while replay is on (Chrome captures a tab once).
- Each record is saved with its kind (tab recording, screen recording, instant replay or
  screenshot), shown and filterable in TJ Record.
- When you stop, TJ Record opens its **Upload** page with a preview and a short form (title,
  description, assignee, priority, environment, labels). **Save record** uploads and opens the record.
- Recordings that were not uploaded stay in the popup under **Waiting to upload**.

## How it works

```
popup / shortcut ──► background.js (service worker)
                        ├─ tab capture stream id ──► offscreen.html: MediaRecorder → video.webm (VP9)
                        └─ registers logger.js (page world) + relay.js (extension world) on every
                           page load while recording; relay forwards batches to the recorder
stop ──► offscreen saves a draft in IndexedDB { video, thumbnail, bundle.json, page info }
     ──► opens <TJ Record>/upload?draft=<id>

instant replay ──► offscreen: MediaStreamTrackProcessor → WebCodecs VideoEncoder (VP9, keyframe
                   every 3 s) → rolling 3-minute buffer of encoded frames + page events
save last N min ──► frames from the last keyframe before "now − N" muxed to WebM (lib/webm-mux.js,
                   with Duration and Cues), event times rebased to the cut → same draft as above

record screen ──► screen.html tab: desktopCapture.chooseDesktopMedia → getUserMedia('desktop') →
                 the same recorder (offscreen.js, role 'screen'); a picked stream only works in the
                 page that picked it, so this tab records instead of the offscreen page

screenshot ──► captureVisibleTab ──► crop.js shows the frozen image over the page ──► the selected
              area (PNG) back to the service worker ──► draft
TJ Record Upload page (custom component) ──postMessage──► bridge.js (content script on the app)
     ──► draft handed over as Blobs ──► putDraftFile ×3 (S3, base64) + createJamRow (ToolJet DB)
```

`bundle.json` is the format the TJ Record player reads:
`{ version, recordedAt, durationMs, page, console[], network[], actions[], customLogs[] }`, each
entry with `t` = milliseconds from the start of the video.

Pages can add their own entries: `window.TJRecord.log('cart.total', 118.4)`.

## Privacy

Redacted before anything leaves the page:

- `Authorization`, `Cookie`, `Set-Cookie`, API-key and CSRF headers.
- URL parameters and JSON/form keys that look secret (`token`, `password`, `secret`, `api_key`, `sig`, `cvc`, …), including in logged objects.
- Typed values in password, card, one-time-code and similar fields, and anything inside `[data-tjr-mask]`, recorded as `•••`.

**The video is not masked.** Whatever is on screen is in the recording.

## Limits (v0.4)

- 3 minutes per recording or replay. A replay starts at the keyframe before the cut, so "Last 1 min"
  can be up to 3 s longer. Replay encodes at 1 Mbps (a busy 3-minute replay is about 26 MB).
- Instant replay keeps the tab's video and logs in memory and encodes continuously while the page
  changes; turn it off when you don't need it.
- Uploads go through a base64 S3 query that is capped by the ToolJet
  server's request size, so videos over 34 MB can't be saved (the Upload page offers a download).
  Direct-to-S3 upload needs the S3 plugin to sign PUT URLs without a checksum
  (`requestChecksumCalculation: 'WHEN_REQUIRED'` in `plugins/packages/s3/lib/index.ts`).
- Logs come from the top frame only (not iframes), and for a screen recording only from the tab you
  started on. No audio or microphone.
- `file://` pages record video only unless "Allow access to file URLs" is on for the extension.
- Recording pages you don't control is fine; Chrome blocks `chrome://` pages and the Web Store.

## Settings

The popup's gear opens Settings: instant replay on/off, the TJ Record app URL and the recording
shortcut. The default is `https://app.tooljet.ai/applications/record` (`DEFAULT_APP_URL` in
`lib/config.js`). Installs still on the old development-preview URL move to it on update; a URL
entered in Settings is kept.

## Recording from AI agents (Claude Code, Codex, …)

An agent can't press the TJ Record toolbar button, so there are two ways to record what it does.

**The agent uses your own browser** (Claude in Chrome, Comet's assistant): start a recording or
instant replay yourself, let the agent work, then stop or *Save the last N min*. Its clicks, typing
and navigation are logged like yours. For long agent runs, instant replay fits better than the
3-minute recording.

**The agent works in the terminal** (Claude Code, Codex CLI): `scripts/agent-record.mjs` launches a
separate Chrome for Testing with TJ Record loaded and allowlisted (so capture needs no click), opens
your page and records it. The agent drives the page through a browser MCP server attached to that
Chrome, and starts/stops capture with `curl`. Each capture gets an **Upload link** that you open in
your own browser, where you're already signed in to TJ Record, to review and save it.

**Quickest setup:** paste the prompt in [AGENT_SETUP.md](AGENT_SETUP.md) into your agent. It does
the steps below and saves the recording instructions for later sessions.

### Set up (once)

```
npm install
npm run setup                 # downloads Chrome for Testing
```

The recorder's browser never needs to sign in to ToolJet: uploads happen in your own browser (see
[Upload a capture](#upload-a-capture)). Your own browser needs TJ Record v0.4.0 or later.

**Claude Code**: this repo's `.mcp.json` adds a `tj-record-browser` MCP server (Chrome DevTools
MCP, attached to the recorder's Chrome on port 9222). Approve it the first time Claude Code asks.
For use from another project, add it there:

```
claude mcp add tj-record-browser -- npx -y chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:9222 --no-usage-statistics
```

**Codex**: add the same server to `~/.codex/config.toml`:

```toml
[mcp_servers.tj-record-browser]
command = "npx"
args = ["-y", "chrome-devtools-mcp@latest", "--browserUrl", "http://127.0.0.1:9222", "--no-usage-statistics"]
```

Codex's sandbox must allow it to launch Chrome and reach `127.0.0.1` (approve the command, or run
the recorder yourself in another terminal). Playwright MCP works too: `--cdp-endpoint http://127.0.0.1:9222`.

### Record a session

```
npm run agent -- https://your-app.example.com            # starts recording right away
npm run agent -- https://your-app.example.com --replay   # or: instant replay
```

It prints one JSON line when ready, then keeps running (an agent runs it in the background):

```
{"event":"ready","control":"http://127.0.0.1:47900","cdp":"http://127.0.0.1:9222","running":"record",…}
```

Control it with:

| Request | Does |
| --- | --- |
| `curl localhost:47900/status` | What's running, elapsed time, the 3-minute limit |
| `curl -X POST localhost:47900/stop` | Stop the recording and save it |
| `curl -X POST 'localhost:47900/save?ms=60000'` | Instant replay: save the last 60 s (replay keeps running) |
| `curl -X POST 'localhost:47900/start?mode=record'` | Start again (`mode=replay` for instant replay, `&tab=active` for the active tab instead of the one it opened) |
| `curl -X POST localhost:47900/discard` | Throw the current capture away |
| `curl -X POST localhost:47900/quit` | Save a running recording, close the browser and exit |

Each saved capture goes to `recordings/<time>-<kind>/`: `video.webm`, `thumb.jpg`, `bundle.json`
(console, network, actions, the format the TJ Record player reads) and `record.json` (page,
browser, duration, error counts). The `/stop` and `/save` responses include the folder, the counts
and an `uploadLink`. A recording that hits the 3-minute limit, or whose tab is closed, is saved the
same way (the link is in the recorder's `"saved"` output line).

Options: `--no-start`, `--serve`, `--upload`, `--out <dir>`, `--port <n>`, `--cdp-port <n>`,
`--profile <dir>`, `--headless`. `node scripts/agent-record.mjs --help` lists them.

### Upload a capture

Open the capture's `uploadLink` (`https://app.tooljet.ai/applications/record/upload?draft=<id>`) in
your own browser, where you're signed in to TJ Record. The Upload page asks TJ Record for that
draft; TJ Record doesn't have it, so it fetches it from the recorder on `127.0.0.1:47900` and the
page shows the preview and form as usual. Fill it in and **Save record**. After that first open the
capture is also listed in the popup under **Waiting to upload**.

The recorder must be running when you open the link. For captures from an earlier run:

```
npm run agent -- --serve          # serves ./recordings on 127.0.0.1:47900, no browser
```

On macOS an agent can open the link for you with `open "<uploadLink>"` (your default browser) or
`open -a "Google Chrome" "<uploadLink>"`. The recorder only answers requests from this machine
that come from curl, scripts or an extension; web pages you visit get `403`.

`--upload` is the other way: it opens the Upload page in the recorder's browser instead, which then
needs a ToolJet sign-in once (`npm run agent -- https://app.tooljet.ai --no-start`, sign in, quit;
it's kept in `.agent-profile/`).

### Prompt to give the agent

> Record this session with TJ Record. In the `tj-record-extension` repo, run `npm run agent -- <url> --replay` in the background
> and wait for its `"ready"` line. Use the `tj-record-browser` MCP tools to <do the task>; don't click
> TJ Record's own Stop/Discard buttons on the page. When something goes wrong, run
> `curl -X POST 'localhost:47900/save?ms=180000'` and give me the `uploadLink`, folder and error
> counts it returns. Keep the recorder running until I say I've uploaded, then run
> `curl -X POST localhost:47900/quit`.

### From a script

Playwright scripts (or an agent writing one) can import it instead of using an MCP server:

```js
import { launchRecorder } from './scripts/agent-record.mjs';

const rec = await launchRecorder({ url: 'https://your-app.example.com', headless: true });
await rec.start();                         // or rec.start({ mode: 'replay' })
await rec.page.click('text=Checkout');     // rec.page is a normal Playwright page
const saved = await rec.stop();            // { dir, files, counts, durationMs }; replay: rec.save(ms)
await rec.close();
```

### Good to know

- The recorder's Chrome is a separate test browser with its own profile. Its DevTools port gives
  full control of it to anything on this machine, so don't sign in to personal accounts there.
- Captures have the same limits as manual ones: 3 minutes, video not masked, logs from the top frame.
- Upload links only work while a recorder (or `--serve`) runs on port 47900, the port TJ Record
  checks. Captures are on disk either way.

## Release

1. Bump `version` in `manifest.json` (and check `DEFAULT_APP_URL` in `lib/config.js` is the
   released app, not a `?env=development` preview).
2. Run the tests (below).
3. `scripts/package.sh` builds `dist/tj-record-<version>.zip` with only the files the extension
   loads. It refuses to build while the default URL is the development preview (`--allow-dev`
   builds anyway, for internal testing), or if a page or the manifest refers to a file that isn't
   packaged.
4. Upload the zip to the Chrome Web Store (or publish it privately to the organization's Google
   Workspace domain). [store/LISTING.md](store/LISTING.md) has the listing text, permission
   justifications and privacy answers to paste; `PRIVACY.md` is the privacy policy. `<all_urls>`
   host access gets a longer review; it is needed so logs survive navigation in the recorded tab.

Message handling: content scripts (which run inside web pages) can only query the recording, stop
or discard it from the recorded tab, finish a screenshot they were given a token for, and delete a
draft from the TJ Record app. Starting captures, listing drafts and changing settings need an
extension page.

## Test

`test/run.mjs` loads the extension into Chrome for Testing, records a local fixture page (fetch,
XHR, errors, navigation, masked fields, failed and cross-origin resources), stops it four ways
(background call, in-page Stop, closing the tab, discard) and checks the draft a mock Upload page
receives, including that the video has a duration and seeks. It also crops screenshots (drag, Esc,
Enter) and runs instant replay: a 5-second save leaves out earlier activity and rebases event
times, a save with less buffered keeps all of it, recording is blocked while replay is on, and
closing the tab turns replay off. Screen recording runs with the picker allowed to offer tabs
(headless Chrome has no screen) and checks the full flow, including closing the recorder tab.

```
npm install
npm run setup     # once: downloads Chrome for Testing (branded Chrome ignores --load-extension)
npm test          # or: node test/run.mjs --headed, to watch
```

It also checks that a second capture on the same page (no reload) gets its logs back, and that a
content script in another tab can't stop a recording or change the app URL.
