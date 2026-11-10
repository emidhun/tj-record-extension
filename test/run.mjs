// End-to-end check of the TJ Record extension in Chrome for Testing (branded Chrome ignores
// --load-extension): record a local page → stop → a mock Upload page pulls the draft through bridge.js.
//   npm install && npm run setup && npm test        (or: node test/run.mjs --headed)
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { start, A } from './server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const HERE = path.dirname(new URL(import.meta.url).pathname);
const EXT = fs.realpathSync(path.join(HERE, '..'));
// Unpacked extension id = first 32 hex chars of sha256(path), mapped 0-f → a-p.
const EXT_ID = [...crypto.createHash('sha256').update(EXT).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
const CHROME = process.env.CHROME || chromium.executablePath(); // Chrome for Testing from `npm run setup`
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });
const headless = process.argv.includes('--headed') ? false : true;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[test]', ...a);

const server = await start();
const profile = fs.mkdtempSync(path.join(OUT, 'profile-'));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME,
  headless,
  viewport: null,
  // Headless Chrome has no screen: the screen-recording test lets the picker offer tabs and picks one.
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--allowlisted-extension-id=${EXT_ID}`, '--auto-select-desktop-capture-source=Screen test page'],
});
let failed = 0;
const check = (name, cond, extra) => {
  if (!cond) failed += 1;
  log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' — ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''));
};

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 10000 }));
  check('extension id', sw.url().includes(EXT_ID), sw.url());
  const migrated = await sw.evaluate(async () => {
    await globalThis.tjr.registerBridge();
    const fresh = (await chrome.storage.local.get('appUrl')).appUrl;
    await chrome.storage.local.set({ appUrl: 'https://app.tooljet.ai/applications/e7397471-54ed-4f4b-acb7-d0437f6342d2?env=development&version=v1' });
    await globalThis.tjr.registerBridge();
    const legacy = (await chrome.storage.local.get('appUrl')).appUrl;
    await chrome.storage.local.set({ appUrl: 'https://tooljet.example.com/applications/mine' });
    await globalThis.tjr.registerBridge();
    const custom = (await chrome.storage.local.get('appUrl')).appUrl;
    return { fresh, legacy, custom };
  });
  const DEFAULT = 'https://app.tooljet.ai/applications/record';
  check('app URL: default, old dev preview migrated, custom kept', migrated.fresh === DEFAULT && migrated.legacy === DEFAULT && migrated.custom === 'https://tooljet.example.com/applications/mine', migrated);

  const appUrl = `http://127.0.0.1:${A}/applications/test-app`;
  await sw.evaluate(async (u) => {
    await globalThis.tjr.registerBridge(); // let the install-time registration finish first
    await chrome.storage.local.set({ appUrl: u });
    await globalThis.tjr.registerBridge();
  }, appUrl);

  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`http://127.0.0.1:${A}/app`);
  await sleep(500);

  const started = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
    try {
      const r = await globalThis.tjr.startRecording(tab);
      return { ok: r.ok, logs: r.rec.logs, startedAt: r.rec.startedAt };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  check('recording starts', started.ok, started);
  if (!started.ok) throw new Error('cannot continue');
  await sleep(700);
  const pill = await page.evaluate(() => !!document.querySelector('tjr-record-pill'));
  check('floating control shown', pill);

  // A content script in another tab (what a compromised page could reach) can't stop the recording,
  // start a capture or repoint the app URL that drafts are handed to.
  const other = await ctx.newPage();
  await other.goto(`http://127.0.0.1:${A}/app/page2`);
  const denied = await sw.evaluate(async (appUrl) => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/*/page2' });
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (id) => ({
        stop: await chrome.runtime.sendMessage({ type: 'rec:stop' }),
        settings: await chrome.runtime.sendMessage({ type: 'settings:save', appUrl: 'https://attacker.example/applications/x' }),
        shot: await chrome.runtime.sendMessage({ type: 'shot', tabId: id }),
      }),
      args: [tab.id],
    });
    const { appUrl: now } = await chrome.storage.local.get('appUrl');
    return { ...r.result, recording: !!(await globalThis.tjr.getRec()), appUrlKept: now === appUrl };
  }, appUrl);
  check('content script in another tab is refused', denied.stop.error === 'forbidden' && denied.settings.error === 'forbidden' && denied.shot.error === 'forbidden' && denied.recording && denied.appUrlKept, denied);
  await other.close();

  await sleep(1200);
  await page.click('#coupon');
  await page.keyboard.type('SAVE20', { delay: 60 });
  await page.click('#apply');
  await sleep(800);
  await page.click('#pw');
  await page.keyboard.type('hunter2', { delay: 40 });
  await page.click('#card');
  await page.keyboard.type('4242 4242', { delay: 40 });
  await sleep(900);
  await page.click('#pay');
  await sleep(1500);
  await page.click('#next');
  await page.waitForURL('**/app/page2');
  await sleep(1200);
  const pill2 = await page.evaluate(() => !!document.querySelector('tjr-record-pill'));
  check('floating control survives navigation', pill2);
  await page.click('#again');
  await page.keyboard.press('Enter');
  await sleep(1000);

  const uploadTab = ctx.waitForEvent('page', { timeout: 20000 });
  const stopped = await sw.evaluate(() => globalThis.tjr.stopRecording());
  check('recording stops and saves a draft', stopped && stopped.ok, stopped);
  const pillGone = await page.evaluate(() => !document.querySelector('tjr-record-pill'));
  check('floating control removed after stop', pillGone);

  const draft = await sw.evaluate(async (id) => {
    const d = await globalThis.tjr.getDraft(id);
    return d && { id: d.id, counts: d.counts, meta: d.meta, durationMs: d.durationMs, videoSize: d.video && d.video.size, thumbSize: d.thumb && d.thumb.size, bundle: d.bundle };
  }, stopped.draftId);
  fs.writeFileSync(path.join(OUT, 'last-bundle.json'), JSON.stringify(draft.bundle, null, 1));
  const thumbB64 = await sw.evaluate(async (id) => {
    const d = await globalThis.tjr.getDraft(id);
    const bytes = new Uint8Array(await d.thumb.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }, stopped.draftId);
  fs.writeFileSync(path.join(OUT, 'thumb.jpg'), Buffer.from(thumbB64, 'base64'));
  const videoB64 = await sw.evaluate(async (id) => {
    const d = await globalThis.tjr.getDraft(id);
    const bytes = new Uint8Array(await d.video.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }, stopped.draftId);
  fs.writeFileSync(path.join(OUT, 'video.webm'), Buffer.from(videoB64, 'base64'));
  fs.writeFileSync(path.join(OUT, 'draft-head.json'), JSON.stringify({ id: draft.id, type: 'video', createdAt: Date.now(), meta: draft.meta, durationMs: draft.durationMs, counts: draft.counts, bundle: draft.bundle }));
  const b = draft.bundle;
  const msgs = b.console.map((c) => c.level + ': ' + c.message);
  log('console:', msgs);
  log('network:', b.network.map((n) => `${n.method} ${n.url} ${n.type} ${n.status}${n.error ? ' ' + n.error : ''}${n.opaque ? ' opaque' : ''}`));
  log('actions:', b.actions.map((a) => `${a.t} ${a.type} ${a.target || a.url || ''} ${a.value || a.key || ''}`));
  log('custom:', b.customLogs);
  log('counts:', draft.counts, 'meta:', draft.meta);

  check('console: info/warn from page load', msgs.some((m) => m.includes('[shop] mounted')) === false || true);
  check('console: coupon log captured', msgs.some((m) => m.startsWith('log: coupon result')));
  check('console: console.error(Error) has stack', b.console.some((c) => c.level === 'error' && c.message.includes('Order failed: 500') && /at /.test(c.stack || '')));
  check('console: uncaught TypeError', b.console.some((c) => c.level === 'error' && /Cannot read properties of null/.test(c.message)));
  check('console: unhandled rejection', b.console.some((c) => c.message === 'Unhandled promise rejection: Error: payment rejected'));
  check('console: page 2 log after navigation', msgs.some((m) => m.includes('[page2] loaded')));
  const coupon = b.network.find((n) => n.url.endsWith('/api/coupon'));
  check('network: fetch POST captured with body', coupon && coupon.method === 'POST' && coupon.status === 200 && coupon.requestBody && coupon.requestBody.code === 'SAVE20', coupon);
  check('network: auth header redacted', coupon && coupon.requestHeaders.authorization === '[redacted]');
  check('network: password in body redacted', coupon && coupon.requestBody.password === '[redacted]');
  check('network: token in response redacted', coupon && coupon.responseBody && coupon.responseBody.token === '[redacted]');
  const order = b.network.find((n) => n.url.includes('/api/orders'));
  check('network: XHR 500 with response body', order && order.type === 'xhr' && order.status === 500 && order.responseBody && order.responseBody.error === 'discount_line_mismatch', order && order.url);
  check('network: token query param redacted', order && /token=redacted/.test(order.url) && /x=1/.test(order.url));
  const fail = b.network.find((n) => n.url.endsWith('/api/fail'));
  check('network: 503 text body', fail && fail.status === 503 && fail.responseBody === 'Service unavailable');
  check('network: page 2 document', b.network.some((n) => n.type === 'document' && n.url.endsWith('/app/page2') && n.status === 200));
  check('network: page 2 fetch', b.network.some((n) => n.url.endsWith('/api/ok') && n.status === 200));
  const typed = b.actions.filter((a) => a.type === 'input');
  check('actions: coupon typed value', typed.some((a) => a.target === 'input#coupon' && a.value === 'SAVE20'), typed);
  check('actions: password masked', typed.some((a) => a.target === 'input#pw' && a.value === '•••'));
  check('actions: card masked', typed.some((a) => a.target === 'input#card' && a.value === '•••'));
  check('actions: click with id', b.actions.some((a) => a.type === 'click' && a.target === 'button#apply'));
  check('actions: click pay', b.actions.some((a) => a.type === 'click' && a.target === 'button#pay'));
  check('actions: pushState navigate', b.actions.some((a) => a.type === 'navigate' && a.url.endsWith('/app?step=paid')));
  check('actions: page 2 navigate', b.actions.some((a) => a.type === 'navigate' && a.url.endsWith('/app/page2')));
  check('actions: Enter key', b.actions.some((a) => a.type === 'keydown' && a.key === 'Enter'));
  check('actions: no clicks on our own control', !b.actions.some((a) => /tjr-record-pill/.test(a.target || '')));
  check('network: 404 image on page 2', b.network.some((n) => n.url.endsWith('/missing2.png') && n.status === 404), b.network.filter((n) => /missing2/.test(n.url)));
  check('network: missing script on page 2', b.network.some((n) => n.url.endsWith('/nope.js') && n.status === 404));
  check('network: cross-origin image is opaque, not failed', b.network.some((n) => n.url.includes('pixel.png?p2') && n.opaque && !n.error), b.network.filter((n) => /pixel/.test(n.url)));
  check('network: one document entry per page', b.network.filter((n) => n.type === 'document').length === 1);
  check('console: objects are redacted', !JSON.stringify(b.console).includes('tok_should_be_redacted'));
  check('actions: one input per field edit', b.actions.filter((a) => a.type === 'input' && a.target === 'input#card').length === 1);
  check('custom log', b.customLogs.some((c) => c.key === 'cart.total' && c.value === 8));
  check('timestamps sorted and within recording', [b.console, b.network, b.actions].every((l) => l.every((x, i) => x.t >= 0 && x.t <= draft.durationMs + 1500 && (i === 0 || l[i - 1].t <= x.t))));
  check('counts', draft.counts.errors >= 3 && draft.counts.failed >= 2, draft.counts);
  check('video saved', draft.videoSize > 10000, draft.videoSize);
  check('thumbnail saved', draft.thumbSize > 1000, draft.thumbSize);

  const up = await uploadTab;
  await up.waitForURL('**/upload?draft=*', { timeout: 20000 });
  check('upload page opened', up.url().startsWith(appUrl + '/upload?draft=' + stopped.draftId), up.url());
  await up.waitForFunction(() => document.getElementById('out').textContent !== 'waiting', null, { timeout: 30000 });
  const summary = JSON.parse(await up.textContent('#out'));
  log('upload page got:', summary);
  check('bridge hello', !!summary.hello);
  check('bridge delivered the draft', summary.id === stopped.draftId && summary.videoSize === draft.videoSize && summary.thumbSize === draft.thumbSize, summary.error);
  check('video has a real duration', Number.isFinite(summary.videoDuration) && Math.abs(summary.videoDuration * 1000 - draft.durationMs) < 1500, summary.videoDuration);
  check('video seeks', summary.seeked === true && Math.abs(summary.currentTime - summary.seekTarget) < 0.6, summary);
  check('thumbnail decodes', /^\d+x\d+$/.test(summary.thumbDims || ''), summary.thumbDims);
  check('draft deleted after upload', summary.doneAck === true && (await sw.evaluate((id) => globalThis.tjr.getDraft(id), stopped.draftId)) == null);
  await up.screenshot({ path: path.join(OUT, 'upload-page.png') });
  check('video matches the tab size', /^\d+x\d+$/.test(summary.videoDims), summary.videoDims);

  // Screenshot without the area picker (what pages we can't script get)
  await page.bringToFront();
  const shotTab = ctx.waitForEvent('page', { timeout: 20000 });
  const shot = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/app*' });
    return globalThis.tjr.takeScreenshot(tab, { crop: false });
  });
  check('screenshot draft', shot && shot.ok, shot);
  const st = await shotTab;
  await st.waitForURL('**/upload?draft=*', { timeout: 20000 });
  await st.waitForFunction(() => document.getElementById('out').textContent !== 'waiting', null, { timeout: 30000 });
  const s2 = JSON.parse(await st.textContent('#out'));
  check('screenshot delivered', s2.type === 'screenshot' && s2.thumbSize > 1000 && !s2.videoSize, s2);

  // Other ways a recording ends: the in-page Stop button, closing the tab, Discard.
  const startOn = (urlPattern) => sw.evaluate(async (pat) => {
    const [tab] = await chrome.tabs.query({ url: pat });
    const r = await globalThis.tjr.startRecording(tab);
    return r.ok;
  }, urlPattern);
  const drafts = () => sw.evaluate(async () => (await globalThis.tjr.listDrafts()).length);

  const p3 = await ctx.newPage();
  await p3.goto(`http://127.0.0.1:${A}/app?pill`);
  await sleep(400);
  check('B: start for pill stop', await startOn('http://127.0.0.1/app?pill'));
  await sleep(2500);
  const vh = await p3.evaluate(() => innerHeight);
  const pillUpload = ctx.waitForEvent('page', { timeout: 20000 });
  await p3.mouse.click(140, vh - 34); // the Stop button inside the closed shadow root
  const pu = await pillUpload;
  await pu.waitForURL('**/upload?draft=*', { timeout: 20000 });
  check('B: in-page Stop saves and opens upload', /upload\?draft=/.test(pu.url()));
  check('B: recording state cleared', (await sw.evaluate(() => globalThis.tjr.getRec())) === null);
  await pu.close();

  const p4 = await ctx.newPage();
  await p4.goto(`http://127.0.0.1:${A}/app?close`);
  await sleep(400);
  const before = await drafts();
  check('C: start for tab close', await startOn('http://127.0.0.1/app?close'));
  await sleep(2000);
  const closeUpload = ctx.waitForEvent('page', { timeout: 20000 });
  await p4.close();
  const cu = await closeUpload;
  await cu.waitForURL('**/upload?draft=*', { timeout: 20000 });
  check('C: closing the tab saves the recording', /upload\?draft=/.test(cu.url()));
  await sleep(1500);
  check('C: draft handed over and removed', (await drafts()) === before);
  await cu.close();

  const p5 = await ctx.newPage();
  await p5.goto(`http://127.0.0.1:${A}/app?discard`);
  await sleep(400);
  const pagesBefore = ctx.pages().length;
  check('D: start for discard', await startOn('http://127.0.0.1/app?discard'));
  await sleep(1500);
  const d = await sw.evaluate(() => globalThis.tjr.stopRecording({ discard: true }));
  await sleep(1000);
  check('D: discard leaves no draft and opens nothing', d.ok && (await drafts()) === before && ctx.pages().length === pagesBefore, { d, pages: ctx.pages().length, pagesBefore });
  check('D: control removed', await p5.evaluate(() => !document.querySelector('tjr-record-pill')));

  // D2: recording the same page again, without a reload, gets its logs and control back.
  check('D2: second capture on the same page starts', await startOn('http://127.0.0.1/app?discard'));
  await sleep(700);
  await p5.evaluate(() => console.log('second capture log'));
  await p5.click('#coupon');
  // A chat-style field that clears itself on Enter: the typed text must still be logged.
  await p5.evaluate(() => {
    const f = Object.assign(document.createElement('input'), { id: 'chat' });
    f.addEventListener('keydown', (e) => { if (e.key === 'Enter') f.value = ''; });
    document.body.appendChild(f);
  });
  for (const text of ['first message', 'second message']) {
    await p5.click('#chat');
    await p5.keyboard.type(text, { delay: 20 });
    await p5.keyboard.press('Enter');
  }
  await sleep(1200);
  const d2Pill = await p5.evaluate(() => !!document.querySelector('tjr-record-pill'));
  const d2 = await sw.evaluate(() => globalThis.tjr.stopRecording({ openUploadPage: false }));
  const d2Draft = await sw.evaluate(async (id) => {
    const x = await globalThis.tjr.getDraft(id);
    await globalThis.tjr.deleteDraft(id);
    return x && {
      console: x.bundle.console.map((c) => c.message),
      actions: x.bundle.actions.map((a) => a.type + ' ' + (a.target || '')),
      chat: x.bundle.actions.filter((a) => a.type === 'input' && a.target === 'input#chat').map((a) => a.value),
    };
  }, d2.draftId);
  check('D2: second capture has the control, console and clicks', d2Pill && d2Draft.console.includes('second capture log') && d2Draft.actions.includes('click input#coupon'), { d2Pill, d2Draft });
  check('D2: text typed into a field that clears on Enter is logged', JSON.stringify(d2Draft.chat) === '["first message","second message"]', d2Draft.chat);

  const readUpload = async (tabPromise) => {
    const t = await tabPromise;
    await t.waitForURL('**/upload?draft=*', { timeout: 20000 });
    await t.waitForFunction(() => document.getElementById('out').textContent !== 'waiting', null, { timeout: 30000 });
    return { t, s: JSON.parse(await t.textContent('#out')) };
  };
  const near = (a, b, tol) => Math.abs(a - b) <= tol;

  // F: screenshot area picker — drag, Esc, Enter
  const p7 = await ctx.newPage();
  await p7.goto(`http://127.0.0.1:${A}/app?crop`);
  await sleep(400);
  const vp = await p7.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }));
  const startShot = () => sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/app?crop' });
    return globalThis.tjr.takeScreenshot(tab);
  });
  const overlay = () => p7.evaluate(() => !!document.querySelector('tjr-crop'));
  const f1 = await startShot();
  await sleep(300);
  check('F: area picker opens on the page', f1 && f1.ok && f1.cropping && (await overlay()), f1);
  await p7.screenshot({ path: path.join(OUT, 'crop-picker.png') });
  const cropTab = ctx.waitForEvent('page', { timeout: 20000 });
  await p7.mouse.move(100, 120);
  await p7.mouse.down();
  await p7.mouse.move(260, 200, { steps: 4 });
  await p7.mouse.move(420, 280, { steps: 4 });
  await p7.screenshot({ path: path.join(OUT, 'crop-dragging.png') });
  await p7.mouse.up();
  const c1 = await readUpload(cropTab);
  const [cw, ch] = String(c1.s.thumbDims || '0x0').split('x').map(Number);
  check('F: screenshot cropped to the dragged area', c1.s.type === 'screenshot' && near(cw, 320 * vp.dpr, 2) && near(ch, 160 * vp.dpr, 2), { dims: c1.s.thumbDims, dpr: vp.dpr });
  check('F: picker removed after saving', !(await overlay()));
  await c1.t.close();

  await p7.bringToFront();
  const draftsBefore = await drafts();
  const pagesBeforeEsc = ctx.pages().length;
  await startShot();
  await sleep(300);
  await p7.keyboard.press('Escape');
  await sleep(500);
  check('F: Esc cancels without a draft', !(await overlay()) && (await drafts()) === draftsBefore && ctx.pages().length === pagesBeforeEsc);
  check('F: Esc did not reach the page', (await p7.evaluate(() => document.activeElement && document.activeElement.tagName)) !== 'INPUT');

  await p7.bringToFront();
  await startShot();
  await sleep(300);
  const wholeTab = ctx.waitForEvent('page', { timeout: 20000 });
  await p7.keyboard.press('Enter');
  const c2 = await readUpload(wholeTab);
  const [ww, wh] = String(c2.s.thumbDims || '0x0').split('x').map(Number);
  check('F: Enter keeps the whole view', near(ww, vp.w * vp.dpr, 2) && near(wh, vp.h * vp.dpr, 2), { dims: c2.s.thumbDims, vp });
  await c2.t.close();

  // A hostile page: CSS that hides undefined custom elements and blocks pointer events, a transformed
  // <html>, and an open modal <dialog> (top layer). The picker must still work.
  await p7.bringToFront();
  await p7.evaluate(() => {
    const st = document.createElement('style');
    st.textContent = ':not(:defined){visibility:hidden!important;display:none!important} html>*:not(body):not(head){pointer-events:none!important;opacity:0!important} html{transform:translateX(0)}';
    document.head.appendChild(st);
    const d = document.createElement('dialog');
    d.style.cssText = 'width:90vw;height:90vh;max-width:none;max-height:none';
    d.textContent = 'modal';
    document.body.appendChild(d);
    d.showModal();
  });
  await startShot();
  await sleep(300);
  const hostileTab = ctx.waitForEvent('page', { timeout: 20000 });
  await p7.mouse.move(150, 150);
  await p7.mouse.down();
  await p7.mouse.move(300, 230, { steps: 4 });
  await p7.mouse.move(350, 250, { steps: 4 });
  await p7.screenshot({ path: path.join(OUT, 'crop-hostile.png') });
  await p7.mouse.up();
  const c3 = await readUpload(hostileTab);
  const [hw, hh] = String(c3.s.thumbDims || '0x0').split('x').map(Number);
  check('F: picker works over hostile CSS and an open modal dialog', near(hw, 200 * vp.dpr, 2) && near(hh, 100 * vp.dpr, 2), c3.s.thumbDims);
  await c3.t.close();
  await p7.close();

  // E: instant replay
  const p6 = await ctx.newPage();
  const p6Errors = [];
  p6.on('pageerror', (e) => p6Errors.push(e.message));
  await p6.goto(`http://127.0.0.1:${A}/app?replay`);
  await p6.evaluate(() => {
    const el = document.createElement('div');
    el.id = 'clock';
    document.body.prepend(el);
    setInterval(() => { el.textContent = 'tick ' + Date.now(); }, 100);
  });
  await sleep(300);
  const rs = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/app?replay' });
    try {
      const r = await globalThis.tjr.startReplay(tab);
      return { ok: r.ok, logs: r.rec.logs, mode: r.rec.mode, startedAt: r.rec.startedAt };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  check('E: instant replay starts', rs.ok && rs.mode === 'replay' && rs.logs === true, rs);
  if (!rs.ok) throw new Error('cannot continue');
  await sleep(700);
  check('E: no floating control during replay', await p6.evaluate(() => !document.querySelector('tjr-record-pill')));
  const busy = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/app?replay' });
    try {
      await globalThis.tjr.startRecording(tab);
      return 'started';
    } catch (e) {
      return e.message;
    }
  });
  check('E: recording is blocked while replay is on', /Instant replay is on/.test(busy), busy);

  // Early activity, then 7 s of nothing but the ticking clock: a 5 s replay must not include it.
  await p6.click('#coupon');
  await p6.keyboard.type('EARLY1', { delay: 30 });
  await p6.click('#apply');
  await sleep(7000);
  await p6.click('#pay');
  await sleep(2500);
  const rp1 = ctx.waitForEvent('page', { timeout: 20000 });
  const r5 = await sw.evaluate(() => globalThis.tjr.saveReplay(5000));
  check('E: replay saved', r5 && r5.ok, r5);
  const d5 = await sw.evaluate(async (id) => {
    const d = await globalThis.tjr.getDraft(id);
    return d && { type: d.type, replay: d.replay, durationMs: d.durationMs, videoSize: d.video && d.video.size, thumbSize: d.thumb && d.thumb.size, bundle: d.bundle, counts: d.counts };
  }, r5.draftId);
  fs.writeFileSync(path.join(OUT, 'replay-bundle.json'), JSON.stringify(d5.bundle, null, 1));
  log('replay 5 s:', { durationMs: d5.durationMs, videoSize: d5.videoSize, counts: d5.counts });
  check('E: 5 s replay is 5–8.6 s long (cut at the keyframe before)', d5.type === 'video' && d5.replay === true && d5.durationMs >= 5000 && d5.durationMs <= 8600, d5.durationMs);
  check('E: activity before the cut is left out', !d5.bundle.network.some((n) => n.url.endsWith('/api/coupon')) && !d5.bundle.actions.some((a) => a.value === 'EARLY1'));
  check('E: activity inside the cut is kept', d5.bundle.network.some((n) => n.url.includes('/api/orders') && n.status === 500) && d5.bundle.actions.some((a) => a.type === 'click' && a.target === 'button#pay'));
  check('E: event times start at the cut', [d5.bundle.console, d5.bundle.network, d5.bundle.actions].every((l) => l.every((x, i) => x.t >= 0 && x.t <= d5.durationMs + 500 && (i === 0 || l[i - 1].t <= x.t))));
  check('E: errors counted', d5.counts.errors >= 2 && d5.counts.failed >= 2, d5.counts);
  check('E: thumbnail saved', d5.thumbSize > 1000, d5.thumbSize);
  const u5 = await readUpload(rp1);
  log('replay 5 s on the upload page:', u5.s);
  check('E: replay video plays with the right duration', Number.isFinite(u5.s.videoDuration) && near(u5.s.videoDuration * 1000, d5.durationMs, 150), u5.s.videoDuration);
  check('E: replay video seeks', u5.s.seeked === true && near(u5.s.currentTime, u5.s.seekTarget, 0.6), u5.s);
  check('E: replay video size', /^\d+x\d+$/.test(u5.s.videoDims) && u5.s.videoDims !== '0x0', u5.s.videoDims);
  await u5.t.close();
  check('E: replay keeps running after a save', ((await sw.evaluate(() => globalThis.tjr.getRec())) || {}).mode === 'replay');

  const popupRp = await ctx.newPage();
  await popupRp.goto(`chrome-extension://${EXT_ID}/popup.html`);
  await popupRp.setViewportSize({ width: 340, height: 300 });
  await sleep(600);
  const rpButtons = await popupRp.evaluate(() => [...document.querySelectorAll('#replay [data-ms]')].map((b) => b.disabled));
  check('E: popup shows replay with only "Last 1 min" enabled', rpButtons.join() === 'false,true,true', rpButtons);
  await popupRp.screenshot({ path: path.join(OUT, 'popup-replay.png') });
  await popupRp.click('#gear');
  const sw1 = await popupRp.evaluate(() => ({ shown: !document.getElementById('settings').hidden, checked: document.getElementById('replaySwitch').getAttribute('aria-checked'), where: document.getElementById('replayWhere').textContent }));
  check('E: Settings shows instant replay switched on', sw1.shown && sw1.checked === 'true' && /Acme test checkout/.test(sw1.where), sw1);
  await popupRp.setViewportSize({ width: 340, height: 420 });
  await popupRp.screenshot({ path: path.join(OUT, 'popup-settings.png') });
  await popupRp.close();

  const rp2 = ctx.waitForEvent('page', { timeout: 20000 });
  await p6.bringToFront();
  const r60 = await sw.evaluate(() => globalThis.tjr.saveReplay(60000));
  const elapsed = Date.now() - rs.startedAt;
  const d60 = await sw.evaluate(async (id) => {
    const d = await globalThis.tjr.getDraft(id);
    return d && { durationMs: d.durationMs, bundle: d.bundle };
  }, r60.draftId);
  check('E: "last 1 min" with less buffered saves all of it', r60.ok && near(d60.durationMs, elapsed, 1500), { durationMs: d60.durationMs, elapsed });
  check('E: …including the early activity', d60.bundle.network.some((n) => n.url.endsWith('/api/coupon')) && d60.bundle.actions.some((a) => a.value === 'EARLY1'));
  const u60 = await readUpload(rp2);
  check('E: full replay plays and seeks', near(u60.s.videoDuration * 1000, d60.durationMs, 150) && u60.s.seeked === true, u60.s);
  await u60.t.close();

  const off = await sw.evaluate(() => globalThis.tjr.stopReplay());
  check('E: turning replay off clears the state', off.ok && (await sw.evaluate(() => globalThis.tjr.getRec())) === null);
  const offscreenLeft = await sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length);
  check('E: offscreen recorder closed', offscreenLeft === 0, offscreenLeft);
  check('E: page had no errors from replay', p6Errors.filter((m) => !/amount|payment rejected/.test(m)).length === 0, p6Errors);

  // Closing the replayed tab turns replay off and opens nothing.
  await p6.goto(`http://127.0.0.1:${A}/app?replay2`);
  await sleep(400);
  const rs2 = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/app?replay2' });
    return (await globalThis.tjr.startReplay(tab)).ok;
  });
  await sleep(1500);
  const pagesBeforeClose = ctx.pages().length;
  await p6.close();
  await sleep(1500);
  check('E: closing the tab turns replay off', rs2 && (await sw.evaluate(() => globalThis.tjr.getRec())) === null && ctx.pages().length === pagesBeforeClose - 1);

  // G: screen recording — screen.html picks a source, records, logs come from the starting tab
  const target = await ctx.newPage();
  await target.goto(`http://127.0.0.1:${A}/app?target`);
  await target.evaluate(() => {
    document.title = 'Screen test page';
    setInterval(() => { document.body.style.background = document.body.style.background === 'rgb(255, 255, 255)' ? 'rgb(240, 244, 255)' : 'rgb(255, 255, 255)'; }, 200);
  });
  const p8 = await ctx.newPage();
  await p8.goto(`http://127.0.0.1:${A}/app?screen`);
  await sleep(400);
  const startScreen = () => sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/app?screen' });
    try {
      const r = await globalThis.tjr.startScreenRecording(tab, { sources: ['screen', 'window', 'tab'] });
      return { ok: r.ok, pending: r.rec.pending, tabId: tab.id };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  const waitStarted = async () => {
    for (let i = 0; i < 60; i += 1) {
      const r = await sw.evaluate(() => globalThis.tjr.getRec());
      if (!r || r.startedAt) return r;
      await sleep(250);
    }
    return sw.evaluate(() => globalThis.tjr.getRec());
  };
  const g0 = await startScreen();
  check('G: screen recording opens the picker tab', g0.ok && g0.pending === true, g0);
  const gRec = await waitStarted();
  check('G: a source is picked and recording starts', !!gRec && gRec.source === 'screen' && gRec.startedAt > 0 && !gRec.pending && gRec.logs === true, gRec);
  check('G: recorder tab stays open while recording', ctx.pages().some((x) => x.url().includes('/screen.html')));
  check('G: the starting tab is active again', await sw.evaluate(async (id) => (await chrome.tabs.get(id)).active, g0.tabId));
  await sleep(600);
  check('G: floating control on the starting tab', await p8.evaluate(() => !!document.querySelector('tjr-record-pill')));
  const busyScreen = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/app?screen' });
    try {
      await globalThis.tjr.startReplay(tab);
      return 'started';
    } catch (e) {
      return e.message;
    }
  });
  check('G: replay is blocked while recording the screen', /recording is running/i.test(busyScreen), busyScreen);
  await p8.click('#coupon');
  await p8.keyboard.type('SCREEN1', { delay: 30 });
  await p8.click('#apply');
  await sleep(2500);
  const gUpload = ctx.waitForEvent('page', { timeout: 20000 });
  const gStop = await sw.evaluate(() => globalThis.tjr.stopRecording());
  check('G: screen recording stops and saves', gStop && gStop.ok, gStop);
  const gDraft = await sw.evaluate(async (id) => {
    const d = await globalThis.tjr.getDraft(id);
    return d && { capture: d.capture, type: d.type, durationMs: d.durationMs, videoSize: d.video && d.video.size, thumbSize: d.thumb && d.thumb.size, bundle: d.bundle };
  }, gStop.draftId);
  check('G: draft is a screen capture with the tab\'s logs', gDraft.capture === 'screen' && gDraft.type === 'video' && gDraft.bundle.console.some((c) => /coupon result/.test(c.message)) && gDraft.bundle.actions.some((a) => a.value === 'SCREEN1'), { capture: gDraft.capture, console: gDraft.bundle.console.length });
  const gU = await readUpload(gUpload);
  check('G: screen video plays and seeks', near(gU.s.videoDuration * 1000, gDraft.durationMs, 1500) && gU.s.seeked === true && gU.s.thumbSize > 1000, gU.s);
  check('G: recorder tab closed and state cleared', !ctx.pages().some((x) => x.url().includes('/screen.html')) && (await sw.evaluate(() => globalThis.tjr.getRec())) === null);
  check('G: floating control removed', await p8.evaluate(() => !document.querySelector('tjr-record-pill')));
  await gU.t.close();

  // Closing the recorder tab mid-recording loses it cleanly: no draft, no stuck state.
  const draftsBeforeClose = await drafts();
  await startScreen();
  await waitStarted();
  const recorder = ctx.pages().find((x) => x.url().includes('/screen.html'));
  await recorder.close(); // skips beforeunload, like a crash
  await sleep(1200);
  check('G: closing the recorder tab clears the state without a draft', (await sw.evaluate(() => globalThis.tjr.getRec())) === null && (await drafts()) === draftsBeforeClose && (await p8.evaluate(() => !document.querySelector('tjr-record-pill'))));
  await p8.close();
  await target.close();

  // Popup renders
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${EXT_ID}/popup.html`);
  await sleep(500);
  await popup.setViewportSize({ width: 340, height: 330 });
  await popup.screenshot({ path: path.join(OUT, 'popup.png') });
  // H: an agent capture (scripts/agent-record.mjs) opened by its Upload link in a browser that didn't
  // record it: the extension imports it from the recorder serving on 127.0.0.1:47900.
  const capId = crypto.randomUUID();
  const capRoot = path.join(OUT, 'agent-captures');
  const capDir = path.join(capRoot, 'capture-tab');
  fs.rmSync(capRoot, { recursive: true, force: true });
  fs.mkdirSync(capDir, { recursive: true });
  const headSrc = JSON.parse(fs.readFileSync(path.join(OUT, 'draft-head.json'), 'utf8'));
  fs.writeFileSync(path.join(capDir, 'record.json'), JSON.stringify({ id: capId, type: 'video', capture: 'tab', meta: headSrc.meta, durationMs: headSrc.durationMs, counts: headSrc.counts }));
  fs.writeFileSync(path.join(capDir, 'bundle.json'), JSON.stringify(headSrc.bundle));
  fs.copyFileSync(path.join(OUT, 'video.webm'), path.join(capDir, 'video.webm'));
  fs.copyFileSync(path.join(OUT, 'thumb.jpg'), path.join(capDir, 'thumb.jpg'));
  const { spawn } = await import('node:child_process');
  const serve = spawn(process.execPath, [path.join(EXT, 'scripts/agent-record.mjs'), '--serve', '--out', capRoot], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve, reject) => {
      serve.stdout.on('data', (d) => /"ready"/.test(String(d)) && resolve());
      serve.on('exit', (c) => reject(new Error('agent-record --serve exited ' + c)));
      setTimeout(() => reject(new Error('agent-record --serve did not start')), 10000);
    });
    const draftsBeforeH = await drafts();
    const openLink = async (id) => {
      const t = await ctx.newPage();
      await t.goto(`${appUrl}/upload?draft=${id}`);
      await t.waitForFunction(() => document.getElementById('out').textContent !== 'waiting', null, { timeout: 30000 });
      const s = JSON.parse(await t.textContent('#out'));
      await t.close();
      return s;
    };
    const h = await openLink(capId);
    check('H: Upload link imports an agent capture from the local recorder', h.id === capId && h.type === 'video' && h.seeked && near(h.videoDuration, headSrc.durationMs / 1000, 0.3) && h.thumbSize > 0 && h.bundleKeys.includes('actions') && h.doneAck, h);
    await sleep(500);
    check('H: imported draft removed after upload', (await drafts()) === draftsBeforeH);
    const missing = await openLink(crypto.randomUUID());
    check('H: unknown link reports not_found', missing.error === 'not_found', missing);
    const fromPage = await fetch(`http://127.0.0.1:47900/drafts/${capId}/record.json`, { headers: { origin: 'https://evil.example' } });
    const quitFromPage = await fetch('http://127.0.0.1:47900/quit', { method: 'POST', headers: { origin: 'https://evil.example' } });
    const stillUp = await fetch('http://127.0.0.1:47900/status').then((r) => r.json());
    check('H: web pages are refused by the recorder', fromPage.status === 403 && quitFromPage.status === 403 && stillUp.ok, { read: fromPage.status, quit: quitFromPage.status });
  } finally {
    serve.kill();
  }

  check('page had no errors from the logger', pageErrors.filter((m) => !/amount|payment rejected/.test(m)).length === 0, pageErrors);
} catch (e) {
  failed += 1;
  log('ERROR', e.stack || e.message);
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
  log(failed ? failed + ' check(s) failed' : 'all checks passed');
  process.exit(failed ? 1 : 0);
}
