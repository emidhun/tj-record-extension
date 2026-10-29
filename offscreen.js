// The recorder. Chrome only allows MediaRecorder in a document, so the service worker keeps this
// hidden offscreen page alive while a tab is being recorded. It also collects the page events
// relayed from the tab and, on stop, saves video + thumbnail + bundle.json as a draft.
import { fixWebmDuration } from './lib/webm-duration.js';
import { putDraft } from './lib/db.js';
import { VIDEO_BITS_PER_SECOND } from './lib/config.js';

const LIMITS = { console: 2000, network: 1500, actions: 1000, customLogs: 500 };
let session = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return undefined;
  if (msg.type === 'tjr:events') {
    if (session && sender.tab && sender.tab.id === session.tabId) ingest(msg.events);
    return undefined;
  }
  if (msg.target !== 'offscreen') return undefined;
  const handler = { start, stop, cancel, ping: async () => ({ ok: true }) }[msg.type];
  if (!handler) return undefined;
  handler(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
  return true;
});

async function start({ streamId, draftId, tabId, meta, maxMs, size }) {
  if (session) throw new Error('A recording is already running.');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        minWidth: size.width,
        maxWidth: size.width,
        minHeight: size.height,
        maxHeight: size.height,
        maxFrameRate: 30,
      },
    },
  });
  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: VIDEO_BITS_PER_SECOND });
  const track = stream.getVideoTracks()[0];
  const s = {
    draftId,
    tabId,
    meta,
    stream,
    track,
    recorder,
    chunks: [],
    startedAt: 0,
    console: [],
    network: [],
    actions: [],
    customLogs: [],
    thumb: null,
    thumbAtError: false,
    timers: [],
  };
  session = s;
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) s.chunks.push(e.data);
  };
  const started = new Promise((resolve, reject) => {
    recorder.onstart = resolve;
    recorder.onerror = (e) => reject(e.error || new Error('The recorder failed to start.'));
  });
  recorder.start(1000);
  await started;
  s.startedAt = Date.now();
  // Closing or navigating away from a captured tab ends the track; save what we have.
  track.addEventListener('ended', () => {
    s.endedAt = Date.now();
    notifyStop('ended');
  });
  s.timers.push(setTimeout(() => notifyStop('limit'), maxMs));
  s.timers.push(setTimeout(() => { s.thumbJob = grabThumb(s, false); }, 1500));
  return { ok: true, startedAt: s.startedAt };
}

function notifyStop(reason) {
  chrome.runtime.sendMessage({ type: 'rec:stop', reason }).catch(() => {});
}

function ingest(events) {
  const s = session;
  if (!s || !s.startedAt || !Array.isArray(events)) return;
  for (const ev of events) {
    if (!ev || typeof ev.at !== 'number' || ev.at < s.startedAt - 100) continue;
    const { k, at, ...rest } = ev;
    const key = k === 'console' ? 'console' : k === 'network' ? 'network' : k === 'action' ? 'actions' : k === 'custom' ? 'customLogs' : null;
    if (!key || s[key].length >= LIMITS[key]) continue;
    s[key].push({ t: Math.max(0, Math.round(at - s.startedAt)), ...rest });
    if (key === 'console' && rest.level === 'error' && !s.thumbAtError) s.thumbJob = grabThumb(s, true);
  }
}

// Thumbnail: the frame at the first error, else a frame shortly after the start.
async function grabThumb(s, atError) {
  if (s.thumbAtError || s.track.readyState !== 'live') return;
  if (atError) s.thumbAtError = true;
  try {
    const frame = await new ImageCapture(s.track).grabFrame();
    const w = Math.min(960, frame.width);
    const h = Math.round((w * frame.height) / frame.width);
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(frame, 0, 0, w, h);
    frame.close();
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    if (atError || !s.thumbAtError) s.thumb = blob;
  } catch (e) {
    if (atError) s.thumbAtError = false;
  }
}

function collapseClicks(list) {
  const out = [];
  let lastT = -1;
  for (const a of list) {
    const prev = out[out.length - 1];
    if (prev && a.type === 'click' && prev.type === 'click' && prev.target === a.target && a.t - lastT < 1500) {
      prev.more = (prev.more || 0) + 1;
      lastT = a.t;
      continue;
    }
    out.push({ ...a });
    lastT = a.t;
  }
  return out;
}

const isFailed = (n) => !!n.error || (!n.opaque && !n.status) || n.status >= 400;

async function stop() {
  const s = session;
  if (!s) throw new Error('Nothing is being recorded.');
  s.timers.forEach(clearTimeout);
  if (s.thumbJob) await s.thumbJob;
  if (!s.thumb) await grabThumb(s, false);
  // When the captured tab closes, MediaRecorder stops on its own (its 'stop' already fired).
  if (s.recorder.state !== 'inactive') {
    const stopped = new Promise((resolve) => s.recorder.addEventListener('stop', resolve, { once: true }));
    s.recorder.stop();
    await Promise.race([stopped, new Promise((r) => setTimeout(r, 5000))]);
  }
  const durationMs = (s.endedAt || Date.now()) - s.startedAt;
  s.stream.getTracks().forEach((t) => t.stop());
  session = null;

  const byT = (a, b) => a.t - b.t;
  const bundle = {
    version: 1,
    recordedAt: new Date(s.startedAt).toISOString(),
    durationMs,
    page: { url: s.meta.url, title: s.meta.title },
    console: s.console.sort(byT),
    network: s.network.sort(byT),
    actions: collapseClicks(s.actions.sort(byT)),
    customLogs: s.customLogs.sort(byT),
  };
  const counts = {
    errors: bundle.console.filter((c) => c.level === 'error').length,
    failed: bundle.network.filter(isFailed).length,
    console: bundle.console.length,
    network: bundle.network.length,
    actions: bundle.actions.length,
  };
  const video = await fixWebmDuration(new Blob(s.chunks, { type: 'video/webm' }), durationMs);
  await putDraft({ id: s.draftId, type: 'video', createdAt: Date.now(), meta: s.meta, durationMs, counts, bundle, video, thumb: s.thumb });
  return { ok: true, draftId: s.draftId, durationMs, size: video.size, counts };
}

async function cancel() {
  const s = session;
  session = null;
  if (!s) return { ok: true };
  s.timers.forEach(clearTimeout);
  try {
    if (s.recorder.state !== 'inactive') s.recorder.stop();
  } catch (e) {
    /* already stopped */
  }
  s.stream.getTracks().forEach((t) => t.stop());
  return { ok: true };
}
