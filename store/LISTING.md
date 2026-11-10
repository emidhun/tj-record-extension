# Chrome Web Store listing

What to paste into the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole)
for each tab. Package: `npm run package` → `dist/tj-record-<version>.zip`. Images: this folder
(`node scripts/store-shots.mjs` regenerates them).

## Before the first submission

1. Register a developer account (one-time US$5 fee) with the Google account that should own the
   listing. Prefer a shared ToolJet account or a group publisher over a personal one.
2. Turn on 2-step verification for that account (required to publish).
3. Push `PRIVACY.md` to `main`, so the privacy policy URL below opens.

## Package

Upload `dist/tj-record-0.4.0.zip`. Later versions: bump `version` in `manifest.json`, run
`npm test` and `npm run package`, and upload the new zip on the same item.

## Store listing tab

**Name** (from the manifest): TJ Record

**Summary** (from the manifest, 132 characters max):
Record a tab or your screen, save an instant replay or crop a screenshot, with console, network and clicks.

**Description:**

```
TJ Record turns a bug into a complete report in one click. Record the tab, and TJ Record captures
the video together with everything a developer needs to reproduce it:

• Console logs, errors and unhandled rejections
• Network requests with status, timing, headers and bodies
• Clicks, typing, key presses and page navigation
• Page, browser, OS and window details

Recordings stay on your computer until you choose to save them to the TJ Record app on ToolJet,
where your team can watch the video alongside the logs.

WHAT YOU CAN DO
• Record a tab (up to 3 minutes) with its console, network and actions
• Record your entire screen or a window
• Instant replay: keep the last few minutes in memory and save them after something goes wrong
• Crop and save a screenshot
• Start and stop with a keyboard shortcut (Alt+Shift+R by default)
• Record what an AI coding agent does in the browser (see the README for setup)

PRIVACY
Nothing is recorded until you start a capture, and a badge shows while one runs. Authorization
and cookie headers, tokens, passwords and card numbers are removed from the logs before they
leave the page. Nothing is uploaded until you press Save record, and it goes only to your TJ Record
app, signed in as you. No analytics, no tracking.

Uploading needs a TJ Record account on app.tooljet.ai.
```

**Category:** Developer Tools
**Language:** English

**Graphics:**

| Field | File |
| --- | --- |
| Store icon (128×128) | `icons/128.png` |
| Screenshots (1280×800) | `store/screenshot-1.png`, `store/screenshot-2.png`, `store/screenshot-3.png` |
| Small promo tile (440×280) | `store/promo-small.png` |

**Official URL / homepage:** https://github.com/emidhun/tj-record-extension
**Support URL:** https://github.com/emidhun/tj-record-extension/issues

## Privacy tab

**Single purpose:**

```
Record a browser tab or the screen, together with the page's console, network requests and user
actions, so the recording can be filed as a bug report in the TJ Record app.
```

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| `tabCapture` | Records the video of the tab the user chooses to record, and keeps the instant-replay buffer for that tab. |
| `desktopCapture` | Records a screen or window the user picks in Chrome's own screen picker, when they choose "Record screen". |
| `offscreen` | Runs the MediaRecorder that encodes the video. Manifest V3 service workers can't use MediaRecorder, so it runs in an offscreen document. |
| `scripting` | Injects the logger that collects console, network and click events into the tab being recorded (again after it navigates), and the area picker for screenshots. Only into tabs the user is capturing. |
| `storage` | Keeps settings (such as the TJ Record app URL) and the state of the current recording. |
| `unlimitedStorage` | Recordings (video plus logs) are kept locally in IndexedDB until the user uploads them, and can exceed the default quota. |
| Host permission `<all_urls>` | The user can record a bug on any website, so the logger must be injectable into whichever site the recorded tab shows, including every page it navigates to during the recording. It also loads a small bridge on the TJ Record app's own pages, which hands local recordings to its Upload page. Nothing runs on tabs that aren't being captured. |

**Remote code:** No, I am not using remote code. (All scripts are in the package. The only thing
fetched is recording data: from the TJ Record app, and, for agent recordings, from `127.0.0.1`.)

**Data usage**: check these categories (they are collected only during a capture the user starts,
and only uploaded when the user saves it):

- [x] Personally identifiable information: the video and logs can show names, emails and other
  details visible on the recorded page
- [ ] Health information
- [ ] Financial and payment information: card numbers are redacted from logs, and the user decides
  what's on screen
- [ ] Authentication information: authorization headers, cookies, tokens and password fields are redacted
- [x] Personal communications: messages typed or shown in the recorded tab (for example a chat app)
  can appear in the video and the typed-values log
- [ ] Location
- [x] Web history: URLs of the recorded page and its network requests
- [x] User activity: clicks, typed values and key presses in the recorded tab
- [x] Website content: video of the page, console output, network bodies

Then certify all three:

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://github.com/emidhun/tj-record-extension/blob/main/PRIVACY.md

## Distribution tab

- **Payments:** free.
- **Visibility:** pick one.
  - *Public*: anyone can find and install it.
  - *Unlisted*: only people with the link can install it. Good for customers and partners without
    showing it in search.
  - *Private*: only accounts in the ToolJet Google Workspace domain (the developer account must
    belong to that domain). Fastest route for internal use.
- **Regions:** all regions.

## Test instructions (for the reviewer)

Leave the username and password empty and put this in "Additional instructions" (500 characters max):

```
No login is needed to test. Open any site (e.g. https://todomvc.com/examples/react/dist/), click the TJ Record icon, choose "Record tab", use the page, then click "Stop and upload". The recording is saved locally and listed in the popup under "Waiting to upload". "Screenshot" and "Record screen" work the same way. The final upload goes to the user's own TJ Record workspace on app.tooljet.ai (an internal ToolJet account), so it is not needed to review the extension.
```

The dashboard only enables **Save changes** after real typing or pasting; text set by a script isn't saved.

## Review notes

- `<all_urls>` host access and `desktopCapture` usually mean an in-depth review: expect several
  days, sometimes a couple of weeks for the first version. Updates are usually faster.
- The store assigns a new extension ID. Nothing in TJ Record depends on the ID: the TJ Record app
  finds the extension through its bridge script, and the agent recorder loads its own copy from this repo.
- After it's approved, put the store link in the README's Install section and in `AGENT_SETUP.md`.
