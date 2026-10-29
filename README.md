# TJ Record — Chrome extension

Records a browser tab together with its console, network requests and user actions, then files it
as a jam in the **TJ Record** ToolJet app.

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.
3. Pin the TJ Record icon.

You must be signed in to app.tooljet.ai in the same Chrome profile. The extension has no tokens or
AWS keys: the upload runs inside TJ Record as you.

## Use

- **Record this tab** (popup, or `Alt+Shift+R`): records up to 3 minutes. A small control in the
  bottom-left corner of the page shows the time and has **Stop** and discard (✕).
- **Screenshot**: captures the visible part of the tab.
- When you stop, TJ Record opens its **Upload** page with a preview and a short form (title,
  description, assignee, priority, environment, labels). **Save jam** uploads and opens the jam.
- Recordings that were not uploaded stay in the popup under **Waiting to upload**.

## How it works

```
popup / shortcut ──► background.js (service worker)
                        ├─ tab capture stream id ──► offscreen.html: MediaRecorder → video.webm (VP9)
                        └─ registers logger.js (page world) + relay.js (extension world) on every
                           page load while recording; relay forwards batches to the recorder
stop ──► offscreen saves a draft in IndexedDB { video, thumbnail, bundle.json, page info }
     ──► opens <TJ Record>/upload?draft=<id>
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

## Limits (v0.1)

- 3 minutes per recording. Uploads go through a base64 S3 query that is capped by the ToolJet
  server's request size, so videos over 34 MB can't be saved (the Upload page offers a download).
  Direct-to-S3 upload needs the S3 plugin to sign PUT URLs without a checksum
  (`requestChecksumCalculation: 'WHEN_REQUIRED'` in `plugins/packages/s3/lib/index.ts`).
- Logs come from the top frame only (not iframes). No tab audio or microphone.
- `file://` pages record video only unless "Allow access to file URLs" is on for the extension.
- Recording pages you don't control is fine; Chrome blocks `chrome://` pages and the Web Store.

## Settings

The popup's gear sets the TJ Record app URL. The default is the development preview
(`?env=development&version=v1`) because the app is not released yet; after release, remove the
query string (or change `DEFAULT_APP_URL` in `lib/config.js`).

## Test

`test/run.mjs` loads the extension into Chrome for Testing, records a local fixture page (fetch,
XHR, errors, navigation, masked fields, failed and cross-origin resources), stops it four ways
(background call, in-page Stop, closing the tab, discard) and checks the draft a mock Upload page
receives, including that the video has a duration and seeks.

```
PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
CHROME="/path/to/Google Chrome for Testing" \
node test/run.mjs            # add --headed to watch
```
