// TJ Record service worker: starts/stops recordings and instant replay, takes screenshots, injects
// the page logger while capturing, and hands finished drafts to the TJ Record Upload page.
import { DEFAULT_APP_URL, LEGACY_APP_URLS, MAX_RECORDING_MS, REPLAY_LENGTHS_MS, REPLAY_WINDOW_MS, appRoot, getAppUrl, normalizeAppUrl, pageUrl } from './lib/config.js';
import { deleteDraft, getDraft, listDrafts, putDraft } from './lib/db.js';

const CHUNK_BYTES = 4 * 1024 * 1024;
const LOGGER_SCRIPTS = [
  { id: 'tjr-logger', js: ['logger.js'], matches: ['<all_urls>'], runAt: 'document_start', world: 'MAIN', allFrames: false, persistAcrossSessions: false },
  { id: 'tjr-relay', js: ['relay.js'], matches: ['<all_urls>'], runAt: 'document_start', world: 'ISOLATED', allFrames: false, persistAcrossSessions: false },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const recordable = (url) => /^(https?|file):/.test(url || '');

/* ---------- capture state (survives service worker restarts) ----------
 * rec.mode is 'record' (a recording up to 3 min) or 'replay' (instant replay keeps the last minutes).
 * A recording's rec.source is 'tab' (recorded in the offscreen page) or 'screen' (recorded in the
 * screen.html tab, rec.recorderTabId; rec.pending until a screen or window is picked). Logs always
 * come from rec.tabId. Only one capture runs at a time. */
const getRec = async () => (await chrome.storage.session.get('rec')).rec || null;
const setRec = (rec) => (rec ? chrome.storage.session.set({ rec }) : chrome.storage.session.remove('rec'));
const busyError = (rec) => new Error(rec.mode === 'replay' ? 'Instant replay is on. Turn it off first.' : 'A recording is running. Stop it first.');

async function refreshBadge() {
  const rec = await getRec();
  await chrome.action.setBadgeBackgroundColor({ color: '#3E63DD' });
  await chrome.action.setBadgeText({ text: rec ? (rec.mode === 'replay' ? 'RPL' : 'REC') : '' });
  await chrome.action.setTitle({ title: rec && rec.mode === 'replay' ? 'TJ Record: instant replay is on' : 'TJ Record' });
}

/* ---------- page metadata for the record row ---------- */
async function pageMeta(tab) {
  let os = '';
  let browser = '';
  try {
    const ua = navigator.userAgentData;
    const hi = await ua.getHighEntropyValues(['platformVersion', 'fullVersionList']);
    const v = String(hi.platformVersion || '').split('.');
    if (ua.platform === 'macOS') os = 'macOS ' + v.slice(0, Number(v[1]) ? 2 : 1).join('.');
    else if (ua.platform === 'Windows') os = Number(v[0]) >= 13 ? 'Windows 11' : 'Windows 10';
    else os = ua.platform || '';
    const brands = (hi.fullVersionList || ua.brands || []).filter((b) => !/not.?a.?brand|chromium/i.test(b.brand));
    const b = brands[0] || (hi.fullVersionList || ua.brands || []).find((x) => /chromium/i.test(x.brand));
    if (b) browser = b.brand.replace(/^Google /, '').replace(/^Microsoft /, '') + ' ' + String(b.version).split('.')[0];
  } catch (e) {
    /* userAgentData unavailable */
  }
  const conn = navigator.connection;
  return {
    title: tab.title || '',
    url: tab.url || '',
    os,
    browser,
    windowSize: tab.width && tab.height ? tab.width + ' × ' + tab.height : '',
    network: conn && conn.effectiveType ? conn.effectiveType + (conn.downlink ? ' · ' + conn.downlink + ' Mbps' : '') : '',
    environment: environmentFor(tab.url),
  };
}

function environmentFor(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:' || /^(localhost|127\.|0\.0\.0\.0|\[::1\])|\.(local|test|localhost)$/.test(u.hostname)) return 'local';
    if (/(^|[.-])(staging|stage|stg|dev|qa|uat|preview|test)([.-]|$)/i.test(u.hostname)) return 'staging';
    return 'production';
  } catch (e) {
    return '';
  }
}

/* ---------- offscreen recorder ---------- */
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (!contexts.length) {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'Record the tab with MediaRecorder.' });
  }
  for (let i = 0; i < 20; i += 1) {
    try {
      const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ping' });
      if (r && r.ok) return;
    } catch (e) {
      /* not listening yet */
    }
    await sleep(50);
  }
  throw new Error('The recorder did not start.');
}

async function closeOffscreen() {
  try {
    await chrome.offscreen.closeDocument();
  } catch (e) {
    /* none open */
  }
}

/* ---------- page logger injection ---------- */
async function registerLogger() {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: LOGGER_SCRIPTS.map((s) => s.id) });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  await chrome.scripting.registerContentScripts(LOGGER_SCRIPTS);
}

async function unregisterLogger() {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: LOGGER_SCRIPTS.map((s) => s.id) });
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  } catch (e) {
    /* nothing registered */
  }
}

async function injectNow(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['logger.js'], world: 'MAIN', injectImmediately: true });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['relay.js'], injectImmediately: true });
    return true;
  } catch (e) {
    return false; // e.g. file:// without "Allow access to file URLs": video only
  }
}

/* ---------- the TJ Record app bridge ---------- */
let bridgeQueue = Promise.resolve();
function registerBridge() {
  // Serialized: onInstalled and a settings save can race on the same script id.
  bridgeQueue = bridgeQueue.catch(() => {}).then(async () => {
    const { appUrl } = await chrome.storage.local.get('appUrl');
    if (!appUrl || LEGACY_APP_URLS.includes(appUrl)) await chrome.storage.local.set({ appUrl: DEFAULT_APP_URL });
    const u = new URL(await getAppUrl());
    // Match patterns ignore ports; bridge.js checks the full app URL itself.
    const script = { id: 'tjr-bridge', js: ['bridge.js'], matches: [u.protocol + '//' + u.hostname + '/*'], runAt: 'document_start', allFrames: false };
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ['tjr-bridge'] });
    if (existing.length) await chrome.scripting.updateContentScripts([script]);
    else await chrome.scripting.registerContentScripts([script]);
  });
  return bridgeQueue;
}

async function openUpload(draftId, near) {
  const url = pageUrl(await getAppUrl(), 'upload', { draft: draftId });
  const opts = { url, active: true };
  if (near && near.tabId != null) {
    try {
      const t = await chrome.tabs.get(near.tabId);
      opts.windowId = t.windowId;
      opts.index = t.index + 1;
    } catch (e) {
      /* recorded tab is gone */
    }
  }
  return chrome.tabs.create(opts);
}

// Capture at the tab's own aspect ratio (no letterboxing), sharp on HiDPI, at most 1920×1200.
async function captureSize(tab) {
  let dpr = 1;
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.devicePixelRatio });
    dpr = Number(r && r.result) || 1;
  } catch (e) {
    /* restricted page: assume 1x */
  }
  const w = (tab.width || 1280) * dpr;
  const h = (tab.height || 720) * dpr;
  const scale = Math.min(1, 1920 / w, 1200 / h);
  const even = (n) => Math.max(2, Math.floor((n * scale) / 2) * 2);
  return { width: even(w), height: even(h) };
}

/* ---------- actions ---------- */
async function startRecording(tab, streamId) {
  const cur = await getRec();
  if (cur) throw busyError(cur);
  if (!tab || !recordable(tab.url)) throw new Error('TJ Record can’t record this page. Open a website and try again.');
  const id = streamId || (await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }));
  await ensureOffscreen();
  const meta = await pageMeta(tab);
  const rec = { mode: 'record', source: 'tab', tabId: tab.id, windowId: tab.windowId, draftId: crypto.randomUUID(), startedAt: 0, maxMs: MAX_RECORDING_MS, meta };
  const size = await captureSize(tab);
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId: id, draftId: rec.draftId, tabId: tab.id, meta, maxMs: rec.maxMs, size });
  if (!res || !res.ok) {
    await closeOffscreen();
    throw new Error((res && res.error) || 'The recorder failed to start.');
  }
  rec.startedAt = res.startedAt;
  await setRec(rec);
  await registerLogger();
  rec.logs = await injectNow(tab.id);
  await setRec(rec);
  await refreshBadge();
  return { ok: true, rec };
}

let stopping = null;
function stopRecording(opts) {
  if (!stopping) stopping = doStop(opts || {}).finally(() => { stopping = null; });
  return stopping;
}

async function doStop({ discard = false, openUploadPage = true }) {
  const rec = await getRec();
  if (!rec || rec.mode === 'replay') return { ok: false, error: 'Nothing is being recorded.' };
  const screen = rec.source === 'screen';
  if (screen && rec.pending) {
    // Still in Chrome's screen picker: nothing recorded yet.
    await endScreen(rec);
    return discard ? { ok: true } : { ok: false, error: 'Pick a screen or window first.' };
  }
  try {
    await chrome.tabs.sendMessage(rec.tabId, { type: 'rec:flush' });
  } catch (e) {
    /* tab closed or no relay */
  }
  await sleep(400); // let the last log batch reach the recorder
  let res;
  try {
    res = await chrome.runtime.sendMessage({ target: screen ? 'screen' : 'offscreen', type: discard ? 'cancel' : 'stop' });
  } catch (e) {
    res = { ok: false, error: e.message };
  }
  await unregisterLogger();
  try {
    await chrome.tabs.sendMessage(rec.tabId, { type: 'rec:off' });
  } catch (e) {
    /* tab closed */
  }
  await setRec(null);
  await refreshBadge();
  if (screen) await closeTab(rec.recorderTabId);
  else await closeOffscreen();
  if (!discard && res && res.ok && openUploadPage) await openUpload(res.draftId, rec);
  return res || { ok: false, error: 'The recorder did not answer.' };
}

/* ---------- screen recording ---------- */
async function closeTab(tabId) {
  if (tabId == null) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {
    /* already closed */
  }
}

async function activate(tabId) {
  try {
    const t = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
  } catch (e) {
    /* tab is gone */
  }
}

// Opens screen.html, which shows Chrome's screen/window picker and records; logs come from `tab`.
async function startScreenRecording(tab, { sources } = {}) {
  const cur = await getRec();
  if (cur) throw busyError(cur);
  if (!tab) throw new Error('Open a tab and try again.');
  const meta = await pageMeta(tab);
  const rec = { mode: 'record', source: 'screen', pending: true, tabId: tab.id, windowId: tab.windowId, draftId: crypto.randomUUID(), startedAt: 0, maxMs: MAX_RECORDING_MS, meta };
  await setRec(rec);
  const url = chrome.runtime.getURL('screen.html') + (sources ? '?sources=' + sources.join(',') : '');
  try {
    const t = await chrome.tabs.create({ url, windowId: tab.windowId, index: tab.index + 1, active: true });
    rec.recorderTabId = t.id;
    const now = await getRec(); // the page may already have checked in, or been cancelled
    if (now && now.draftId === rec.draftId) await setRec({ ...now, recorderTabId: t.id });
  } catch (e) {
    await setRec(null);
    throw e;
  }
  return { ok: true, rec };
}

// The picker was cancelled, the recorder tab closed, or recording couldn't start.
async function endScreen(rec, error) {
  if (rec.startedAt) {
    await unregisterLogger();
    try {
      await chrome.tabs.sendMessage(rec.tabId, { type: 'rec:off' });
    } catch (e) {
      /* tab closed */
    }
  }
  await setRec(null);
  await refreshBadge();
  await closeTab(rec.recorderTabId);
  await activate(rec.tabId);
  if (error) await flagError(error);
}

const fromRecorder = async (sender) => {
  const rec = await getRec();
  const ok = !!rec && rec.source === 'screen' && !!sender.tab && String(sender.url || '').startsWith(chrome.runtime.getURL('screen.html'));
  return ok && (rec.recorderTabId == null || rec.recorderTabId === sender.tab.id) ? rec : null;
};

/* ---------- instant replay ---------- */
async function startReplay(tab, streamId) {
  const cur = await getRec();
  if (cur) throw busyError(cur);
  if (!tab || !recordable(tab.url)) throw new Error('TJ Record can’t capture this page. Open a website and try again.');
  const id = streamId || (await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }));
  await ensureOffscreen();
  const size = await captureSize(tab);
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'replayStart', streamId: id, tabId: tab.id, size, windowMs: REPLAY_WINDOW_MS });
  if (!res || !res.ok) {
    await closeOffscreen();
    throw new Error((res && res.error) || 'Instant replay failed to start.');
  }
  const rec = { mode: 'replay', tabId: tab.id, windowId: tab.windowId, startedAt: res.startedAt, windowMs: REPLAY_WINDOW_MS, meta: { title: tab.title || '', url: tab.url || '' } };
  await setRec(rec);
  await registerLogger();
  rec.logs = await injectNow(tab.id);
  await setRec(rec);
  await refreshBadge();
  return { ok: true, rec };
}

// Saves the last lengthMs (or all of it, if less is buffered) as a draft and opens the Upload page.
// Replay keeps running.
async function saveReplay(lengthMs, { openUploadPage = true } = {}) {
  const rec = await getRec();
  if (!rec || rec.mode !== 'replay') return { ok: false, error: 'Instant replay is off.' };
  const ms = Math.min(rec.windowMs, Math.max(1000, Number(lengthMs) || REPLAY_LENGTHS_MS[0]));
  try {
    await chrome.tabs.sendMessage(rec.tabId, { type: 'rec:flush' });
  } catch (e) {
    /* no relay on this page */
  }
  await sleep(400); // let the last log batch reach the recorder
  let meta = rec.meta;
  try {
    meta = await pageMeta(await chrome.tabs.get(rec.tabId));
  } catch (e) {
    /* tab is gone */
  }
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'replaySave', lengthMs: ms, draftId: crypto.randomUUID(), meta });
  if (res && res.ok && openUploadPage) await openUpload(res.draftId, rec);
  return res || { ok: false, error: 'The recorder did not answer.' };
}

let replayStopping = null;
function stopReplay() {
  if (!replayStopping) replayStopping = doStopReplay().finally(() => { replayStopping = null; });
  return replayStopping;
}

async function doStopReplay() {
  const rec = await getRec();
  if (!rec || rec.mode !== 'replay') return { ok: true };
  try {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'replayStop' });
  } catch (e) {
    /* offscreen page already gone */
  }
  await unregisterLogger();
  try {
    await chrome.tabs.sendMessage(rec.tabId, { type: 'rec:off' });
  } catch (e) {
    /* tab closed */
  }
  await setRec(null);
  await refreshBadge();
  await closeOffscreen();
  return { ok: true };
}

// Captures the visible part of the tab, then lets the user drag out the area to keep (crop.js) on a
// frozen copy of it. crop.js sends the cropped image back as 'shot:save'. Pages we can't script
// (e.g. file:// without file access) save the whole view.
async function takeScreenshot(tab, { crop = true } = {}) {
  if (!tab || !recordable(tab.url)) throw new Error('TJ Record can’t capture this page. Open a website and try again.');
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  if (crop) {
    const token = crypto.randomUUID();
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['crop.js'] });
      await chrome.storage.session.set({ shot: { tabId: tab.id, token } });
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (url, t) => globalThis.__tjrCrop(url, t), args: [dataUrl, token] });
      if (r && r.result === true) return { ok: true, cropping: true };
    } catch (e) {
      /* can't script this page */
    }
    await chrome.storage.session.remove('shot');
  }
  return saveScreenshot(tab, dataUrl);
}

async function saveScreenshot(tab, dataUrl) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  const thumb = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  const meta = await pageMeta(tab);
  const id = crypto.randomUUID();
  const bundle = { version: 1, recordedAt: new Date().toISOString(), durationMs: 0, page: { url: meta.url, title: meta.title }, console: [], network: [], actions: [], customLogs: [] };
  await putDraft({ id, type: 'screenshot', capture: 'screenshot', createdAt: Date.now(), meta, durationMs: 0, counts: { errors: 0, failed: 0, console: 0, network: 0, actions: 0 }, bundle, video: null, thumb });
  await openUpload(id, { tabId: tab.id });
  return { ok: true, draftId: id };
}

async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const fromApp = async (sender) => !!sender && String(sender.url || '').startsWith(appRoot(await getAppUrl()) + '/');
const fromExtension = (sender) => !!sender && String(sender.url || '').startsWith(chrome.runtime.getURL(''));

/* ---------- messages ---------- */
const HANDLERS = {
  'rec:query': async (msg, sender) => {
    const rec = await getRec();
    const mine = !!rec && !!sender.tab && sender.tab.id === rec.tabId && !!rec.startedAt;
    return mine ? { recording: true, replay: rec.mode === 'replay', startedAt: rec.startedAt, maxMs: rec.maxMs } : { recording: false };
  },
  'rec:state': async () => ({ ok: true, rec: await getRec() }),
  'rec:start': async (msg) => startRecording(await chrome.tabs.get(msg.tabId), msg.streamId),
  'screen:start': async (msg) => startScreenRecording(await chrome.tabs.get(msg.tabId)),
  // From screen.html.
  'screen:job': async (msg, sender) => {
    const rec = await fromRecorder(sender);
    if (!rec || !rec.pending) return { ok: false, error: 'No screen recording is waiting.' };
    if (rec.recorderTabId == null) await setRec({ ...rec, recorderTabId: sender.tab.id });
    return { ok: true, draftId: rec.draftId, tabId: rec.tabId, meta: rec.meta, maxMs: rec.maxMs };
  },
  'screen:started': async (msg, sender) => {
    const rec = await fromRecorder(sender);
    if (!rec) return { ok: false };
    rec.pending = false;
    rec.startedAt = Number(msg.startedAt) || Date.now();
    rec.recorderTabId = sender.tab.id;
    await setRec(rec);
    await registerLogger();
    rec.logs = await injectNow(rec.tabId);
    await setRec(rec);
    await refreshBadge();
    await activate(rec.tabId); // back to the page; the recorder tab keeps running
    return { ok: true };
  },
  'screen:cancelled': async (msg, sender) => {
    const rec = await fromRecorder(sender);
    if (rec) await endScreen(rec, msg.error ? 'Screen recording failed: ' + msg.error : '');
    return { ok: true };
  },
  'rec:stop': async (msg, sender) => ((await fromRecordedTab(sender)) ? stopRecording() : { ok: false, error: 'forbidden' }),
  'rec:cancel': async (msg, sender) => ((await fromRecordedTab(sender)) ? stopRecording({ discard: true }) : { ok: false, error: 'forbidden' }),
  'replay:start': async (msg) => startReplay(await chrome.tabs.get(msg.tabId), msg.streamId),
  'replay:save': async (msg) => saveReplay(msg.ms),
  'replay:stop': async () => stopReplay(),
  'replay:ended': async (msg) => {
    await stopReplay();
    if (msg.error) await flagError(msg.error);
    return { ok: true };
  },
  shot: async (msg) => takeScreenshot(await chrome.tabs.get(msg.tabId)),
  // From crop.js in the tab that took the screenshot (pages can't message the extension).
  'shot:save': async (msg, sender) => {
    const { shot } = await chrome.storage.session.get('shot');
    if (!sender.tab || !shot || shot.tabId !== sender.tab.id || shot.token !== msg.token) return { ok: false, error: 'This screenshot expired. Take it again.' };
    await chrome.storage.session.remove('shot');
    return saveScreenshot(sender.tab, String(msg.image || ''));
  },
  'shot:cancel': async (msg) => {
    const { shot } = await chrome.storage.session.get('shot');
    if (shot && shot.token === msg.token) await chrome.storage.session.remove('shot');
    return { ok: true };
  },
  'draft:open': async (msg) => {
    await openUpload(msg.id);
    return { ok: true };
  },
  'draft:delete': async (msg, sender) => {
    if (!fromExtension(sender) && !(await fromApp(sender))) return { ok: false, error: 'forbidden' };
    await deleteDraft(String(msg.id));
    return { ok: true };
  },
  'drafts:list': async () => {
    const drafts = await listDrafts();
    return { ok: true, drafts: drafts.map(({ video, thumb, bundle, ...d }) => ({ ...d, size: (video ? video.size : 0) + (thumb ? thumb.size : 0) })) };
  },
  'settings:save': async (msg) => {
    const appUrl = normalizeAppUrl(msg.appUrl || DEFAULT_APP_URL);
    await chrome.storage.local.set({ appUrl });
    await registerBridge();
    return { ok: true, appUrl };
  },
};

// Content scripts run inside web pages, so they may only send these; everything else (start a
// capture, list drafts, change the app URL that drafts are handed to) needs an extension page.
const FROM_PAGES = new Set(['rec:query', 'rec:stop', 'rec:cancel', 'shot:save', 'shot:cancel', 'draft:delete']);

// The floating Stop control only appears in the recorded tab; other tabs can't stop a recording.
const fromRecordedTab = async (sender) => {
  if (fromExtension(sender)) return true;
  const rec = await getRec();
  return !!rec && !!sender.tab && sender.tab.id === rec.tabId;
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return undefined;
  const handler = HANDLERS[msg.type];
  if (!handler) return undefined;
  if (!fromExtension(sender) && !FROM_PAGES.has(msg.type)) {
    sendResponse({ ok: false, error: 'forbidden' });
    return undefined;
  }
  handler(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
  return true;
});

// The Upload page pulls a draft through bridge.js in base64 chunks (runtime messages are JSON only).
/* ---------- captures from scripts/agent-record.mjs ----------
 * An agent records in its own browser, which isn't signed in to TJ Record. The recorder prints the
 * usual Upload page link and, while it runs, serves its captures on 127.0.0.1. When the Upload page
 * here asks for a draft we don't have, we import it from there, so the link can be opened in the
 * browser you're signed in to. Only the TJ Record app can trigger this (see the port handler). */
const AGENT_RECORDER = 'http://127.0.0.1:47900';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function importAgentCapture(id) {
  if (!UUID.test(id)) return null;
  const base = AGENT_RECORDER + '/drafts/' + id + '/';
  const get = async (file, as) => {
    const r = await fetch(base + file, { cache: 'no-store' });
    if (!r.ok) return null;
    return as === 'json' ? r.json() : r.blob();
  };
  let record;
  try {
    record = await get('record.json', 'json');
  } catch (e) {
    return null; // no recorder running
  }
  if (!record || record.id !== id || !['video', 'screenshot'].includes(record.type)) return null;
  const [bundle, video, thumb] = await Promise.all([get('bundle.json', 'json'), get('video.webm'), get('thumb.jpg')]);
  if (!bundle || (record.type === 'video' && !(video && video.size))) return null;
  const draft = {
    id,
    type: record.type,
    capture: String(record.capture || ''),
    replay: !!record.replay,
    agent: true,
    createdAt: Date.now(),
    meta: record.meta || {},
    durationMs: Number(record.durationMs) || 0,
    counts: record.counts || {},
    bundle,
    video: video && video.size ? new Blob([video], { type: 'video/webm' }) : null,
    thumb: thumb && thumb.size ? new Blob([thumb], { type: 'image/jpeg' }) : null,
  };
  await putDraft(draft);
  return draft;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'draft') return;
  port.onMessage.addListener(async ({ id }) => {
    try {
      if (!(await fromApp(port.sender))) return port.postMessage({ error: 'forbidden' });
      const draft = (await getDraft(String(id))) || (await importAgentCapture(String(id)));
      if (!draft) return port.postMessage({ error: 'not_found' });
      const { video, thumb, ...head } = draft;
      head.videoType = video ? 'video/webm' : '';
      head.thumbType = thumb ? 'image/jpeg' : '';
      head.videoSize = video ? video.size : 0;
      port.postMessage({ head });
      for (const [part, blob] of [['thumb', thumb], ['video', video]]) {
        if (!blob) continue;
        for (let off = 0; off < blob.size; off += CHUNK_BYTES) {
          port.postMessage({ chunk: { part, data: await toBase64(blob.slice(off, off + CHUNK_BYTES)) } });
        }
      }
      return port.postMessage({ done: true });
    } catch (e) {
      try {
        port.postMessage({ error: (e && e.message) || String(e) });
      } catch (err) {
        /* port closed */
      }
      return undefined;
    }
  });
});

// A short "!" on the toolbar icon (the popup is closed when the shortcut or the replay fails).
async function flagError(message) {
  await chrome.action.setBadgeBackgroundColor({ color: '#1F2328' });
  await chrome.action.setBadgeText({ text: '!' });
  await chrome.action.setTitle({ title: 'TJ Record: ' + message });
  setTimeout(() => refreshBadge(), 4000);
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-recording') return;
  try {
    const rec = await getRec();
    if (rec && rec.mode === 'record') await stopRecording();
    else await startRecording(tab);
  } catch (e) {
    await flagError(e.message);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const rec = await getRec();
  if (!rec) return;
  if (rec.source === 'screen') {
    // Closing the recorder tab loses the recording; closing the logged tab only ends its logs.
    if (rec.recorderTabId === tabId) await endScreen(rec, rec.pending ? '' : 'The screen recording tab was closed, so the recording was lost.');
    return;
  }
  if (rec.tabId !== tabId) return;
  if (rec.mode === 'replay') stopReplay();
  else stopRecording();
});

// An update or reload ends any capture (its offscreen page and state are gone), but the logger
// scripts it registered could outlive it and keep loading into every page.
chrome.runtime.onInstalled.addListener(async () => {
  await registerBridge();
  if (!(await getRec())) await unregisterLogger();
});
chrome.runtime.onStartup.addListener(async () => {
  await registerBridge();
  await setRec(null); // a browser restart ends any recording
  await unregisterLogger();
});

// For the test harness and scripts/agent-record.mjs, which call these over the DevTools protocol.
globalThis.tjr = { startRecording, startScreenRecording, stopRecording, startReplay, saveReplay, stopReplay, takeScreenshot, getRec, listDrafts, getDraft, deleteDraft, registerBridge };
