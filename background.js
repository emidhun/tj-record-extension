// TJ Record service worker: starts/stops recordings, takes screenshots, injects the page logger
// while recording, and hands finished drafts to the TJ Record Upload page.
import { DEFAULT_APP_URL, MAX_RECORDING_MS, appRoot, getAppUrl, normalizeAppUrl, pageUrl } from './lib/config.js';
import { deleteDraft, getDraft, listDrafts, putDraft } from './lib/db.js';

const CHUNK_BYTES = 4 * 1024 * 1024;
const LOGGER_SCRIPTS = [
  { id: 'tjr-logger', js: ['logger.js'], matches: ['<all_urls>'], runAt: 'document_start', world: 'MAIN', allFrames: false, persistAcrossSessions: false },
  { id: 'tjr-relay', js: ['relay.js'], matches: ['<all_urls>'], runAt: 'document_start', world: 'ISOLATED', allFrames: false, persistAcrossSessions: false },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const recordable = (url) => /^(https?|file):/.test(url || '');

/* ---------- recording state (survives service worker restarts) ---------- */
const getRec = async () => (await chrome.storage.session.get('rec')).rec || null;
const setRec = (rec) => (rec ? chrome.storage.session.set({ rec }) : chrome.storage.session.remove('rec'));

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
    if (!appUrl) await chrome.storage.local.set({ appUrl: DEFAULT_APP_URL });
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
  if (await getRec()) throw new Error('A recording is already running.');
  if (!tab || !recordable(tab.url)) throw new Error('TJ Record can’t record this page. Open a website and try again.');
  const id = streamId || (await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }));
  await ensureOffscreen();
  const meta = await pageMeta(tab);
  const rec = { tabId: tab.id, windowId: tab.windowId, draftId: crypto.randomUUID(), startedAt: 0, maxMs: MAX_RECORDING_MS, meta };
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
  await chrome.action.setBadgeBackgroundColor({ color: '#3E63DD' });
  await chrome.action.setBadgeText({ text: 'REC' });
  return { ok: true, rec };
}

let stopping = null;
function stopRecording(opts) {
  if (!stopping) stopping = doStop(opts || {}).finally(() => { stopping = null; });
  return stopping;
}

async function doStop({ discard = false, openUploadPage = true }) {
  const rec = await getRec();
  if (!rec) return { ok: false, error: 'Nothing is being recorded.' };
  try {
    await chrome.tabs.sendMessage(rec.tabId, { type: 'rec:flush' });
  } catch (e) {
    /* tab closed or no relay */
  }
  await sleep(400); // let the last log batch reach the recorder
  let res;
  try {
    res = await chrome.runtime.sendMessage({ target: 'offscreen', type: discard ? 'cancel' : 'stop' });
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
  await chrome.action.setBadgeText({ text: '' });
  await closeOffscreen();
  if (!discard && res && res.ok && openUploadPage) await openUpload(res.draftId, rec);
  return res || { ok: false, error: 'The recorder did not answer.' };
}

async function takeScreenshot(tab) {
  if (!tab || !recordable(tab.url)) throw new Error('TJ Record can’t capture this page. Open a website and try again.');
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  const thumb = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  const meta = await pageMeta(tab);
  const id = crypto.randomUUID();
  const bundle = { version: 1, recordedAt: new Date().toISOString(), durationMs: 0, page: { url: meta.url, title: meta.title }, console: [], network: [], actions: [], customLogs: [] };
  await putDraft({ id, type: 'screenshot', createdAt: Date.now(), meta, durationMs: 0, counts: { errors: 0, failed: 0, console: 0, network: 0, actions: 0 }, bundle, video: null, thumb });
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
    return mine ? { recording: true, startedAt: rec.startedAt, maxMs: rec.maxMs } : { recording: false };
  },
  'rec:state': async () => ({ ok: true, rec: await getRec() }),
  'rec:start': async (msg) => startRecording(await chrome.tabs.get(msg.tabId), msg.streamId),
  'rec:stop': async () => stopRecording(),
  'rec:cancel': async () => stopRecording({ discard: true }),
  shot: async (msg) => takeScreenshot(await chrome.tabs.get(msg.tabId)),
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return undefined;
  const handler = HANDLERS[msg.type];
  if (!handler) return undefined;
  handler(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
  return true;
});

// The Upload page pulls a draft through bridge.js in base64 chunks (runtime messages are JSON only).
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'draft') return;
  port.onMessage.addListener(async ({ id }) => {
    try {
      if (!(await fromApp(port.sender))) return port.postMessage({ error: 'forbidden' });
      const draft = await getDraft(String(id));
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

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-recording') return;
  try {
    if (await getRec()) await stopRecording();
    else await startRecording(tab);
  } catch (e) {
    await chrome.action.setBadgeBackgroundColor({ color: '#1F2328' });
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setTitle({ title: 'TJ Record: ' + e.message });
    setTimeout(() => {
      chrome.action.setBadgeText({ text: '' });
      chrome.action.setTitle({ title: 'TJ Record' });
    }, 4000);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const rec = await getRec();
  if (rec && rec.tabId === tabId) stopRecording();
});

chrome.runtime.onInstalled.addListener(() => registerBridge());
chrome.runtime.onStartup.addListener(async () => {
  await registerBridge();
  await setRec(null); // a browser restart ends any recording
  await unregisterLogger();
});

// For automated checks only (service worker console / test harness).
globalThis.tjr = { startRecording, stopRecording, takeScreenshot, getRec, listDrafts, getDraft, registerBridge };
