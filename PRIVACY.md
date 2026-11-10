# TJ Record extension — privacy

TJ Record captures a browser tab or screen to file bug reports in the TJ Record ToolJet app. This
page describes what the extension collects, where it goes, and what it never does.

## What is collected, and when

Nothing is collected until you start a capture (Record tab, Record screen, Screenshot or Instant
replay). While a capture runs, the extension collects, for the tab you started on:

- **Video** of the tab, or of the screen or window you picked in Chrome's picker. No audio.
- **Console output**: log, info, warn and error messages, uncaught errors and unhandled rejections.
- **Network requests** made by the page: method, URL, status, timing, headers and up to 64 KB of
  request and response bodies.
- **User actions**: clicks, typed values, key presses and page navigations.
- **Page details**: title, URL, OS, browser version, window size and connection type.

Instant replay keeps only the last 3 minutes, in memory, and discards the rest continuously.

## Redaction

Before anything leaves the page, the extension removes:

- `Authorization`, `Cookie`, `Set-Cookie`, API-key and CSRF headers;
- URL parameters and JSON/form fields whose names look secret (`token`, `password`, `secret`,
  `api_key`, `signature`, `cvc`, …);
- typed values in password, card-number, one-time-code and similar fields, and anything inside an
  element marked `data-tjr-mask`.

**The video is not redacted.** Anything visible on screen is in the recording.

## Where it goes

A finished capture is stored locally in the extension (IndexedDB) as a draft. It leaves your
computer only when you press **Save record** on the TJ Record Upload page, which uploads it to
your organization's TJ Record app on ToolJet, signed in as you. The extension holds no credentials
of its own.

Drafts you don't upload stay on your computer until you delete them from the popup.

**Recordings made by an AI agent.** If you open an Upload link created by the TJ Record agent
recorder (a tool you run yourself, see the README), the extension fetches that recording from the
recorder on your own computer (`127.0.0.1:47900`) and stores it as a draft like any other. It
fetches nothing from any other address.

## What the extension never does

- It never records without a capture you started, and the toolbar badge (REC / RPL) shows while
  one is running.
- It never sends data anywhere except your TJ Record app; there is no telemetry or analytics.
- It never sells or shares data, and does not use it for advertising or creditworthiness.

## Permissions

| Permission | Why |
| --- | --- |
| `tabCapture` | Record the current tab and keep the instant-replay buffer. |
| `desktopCapture` | Record a screen or window you pick in Chrome's picker. |
| `offscreen` | Run the video recorder (Chrome only allows it in a document). |
| `scripting`, host access to all sites | Load the console/network/click logger into the tab being recorded, including after it navigates, and show the screenshot area picker. Not used on any tab you aren't capturing, except a small bridge on the TJ Record app's own pages that hands drafts to its Upload page. |
| `storage`, `unlimitedStorage` | Keep settings, and keep recordings locally until they are uploaded. |

Questions: contact the TJ Record maintainers at ToolJet.
