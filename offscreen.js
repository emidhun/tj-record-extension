// The recorder. Chrome only allows MediaRecorder in a document, so the service worker keeps this
// hidden offscreen page alive while a tab is being recorded. It also collects the page events
// relayed from the tab and, on stop, saves video + thumbnail + bundle.json as a draft.
// Instant replay runs here too: it keeps the last few minutes of a tab in memory (see replayStart).
import { fixWebmDuration } from './lib/webm-duration.js';
import { muxWebm } from './lib/webm-mux.js';
import { putDraft } from './lib/db.js';
import { REPLAY_BITS_PER_SECOND, VIDEO_BITS_PER_SECOND } from './lib/config.js';

const LIMITS = { console: 2000, network: 1500, actions: 1000, customLogs: 500 };
const KIND = { console: 'console', network: 'network', action: 'actions', custom: 'customLogs' };
let session = null;
let replay = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return undefined;
  if (msg.type === 'tjr:events') {
    if (session && sender.tab && sender.tab.id === session.tabId) ingest(msg.events);
    if (replay && sender.tab && sender.tab.id === replay.tabId) ingestReplay(msg.events);
    return undefined;
  }
  if (msg.target !== 'offscreen') return undefined;
  const handler = { start, stop, cancel, replayStart, replaySave, replayStop, ping: async () => ({ ok: true }) }[msg.type];
  if (!handler) return undefined;
  handler(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
  return true;
});

function tabStream(streamId, size) {
  return navigator.mediaDevices.getUserMedia({
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
}

async function start({ streamId, draftId, tabId, meta, maxMs, size }) {
  if (session || replay) throw new Error('TJ Record is already capturing a tab.');
  const stream = await tabStream(streamId, size);
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
    const key = KIND[k];
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
    const blob = await jpegOf(frame);
    frame.close();
    if (atError || !s.thumbAtError) s.thumb = blob;
  } catch (e) {
    if (atError) s.thumbAtError = false;
  }
}

// ImageBitmap or VideoFrame → JPEG, at most 960 px wide.
function jpegOf(image) {
  const iw = image.displayWidth || image.width;
  const ih = image.displayHeight || image.height;
  const w = Math.min(960, iw);
  const h = Math.round((w * ih) / iw);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(image, 0, 0, w, h);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
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

function bundleOf(startedAt, durationMs, meta, lists) {
  const byT = (a, b) => a.t - b.t;
  const bundle = {
    version: 1,
    recordedAt: new Date(startedAt).toISOString(),
    durationMs,
    page: { url: meta.url, title: meta.title },
    console: lists.console.sort(byT),
    network: lists.network.sort(byT),
    actions: collapseClicks(lists.actions.sort(byT)),
    customLogs: lists.customLogs.sort(byT),
  };
  const counts = {
    errors: bundle.console.filter((c) => c.level === 'error').length,
    failed: bundle.network.filter(isFailed).length,
    console: bundle.console.length,
    network: bundle.network.length,
    actions: bundle.actions.length,
  };
  return { bundle, counts };
}

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

  const { bundle, counts } = bundleOf(s.startedAt, durationMs, s.meta, s);
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

/* ---------- instant replay ----------
 * MediaRecorder output can't be cut at an arbitrary point, so replay encodes the tab itself with
 * WebCodecs: frames are encoded with a keyframe at least every KEY_EVERY_MS and kept in a rolling
 * buffer of windowMs. Saving muxes the frames from the last keyframe at or before "now − length".
 * Timestamps are wall-clock based, so the page events (`at`) line up with the video. */
const KEY_EVERY_MS = 3000;
const ERROR_SHOT_EVERY_MS = 10000;

async function encoderConfig(width, height) {
  for (const [codec, codecId] of [['vp09.00.41.08', 'V_VP9'], ['vp8', 'V_VP8']]) {
    const config = { codec, width, height, bitrate: REPLAY_BITS_PER_SECOND, framerate: 30, latencyMode: 'realtime' };
    try {
      const r = await VideoEncoder.isConfigSupported(config);
      if (r.supported) return { config, codecId };
    } catch (e) {
      /* try the next codec */
    }
  }
  throw new Error('This browser can’t encode video for instant replay.');
}

async function replayStart({ streamId, tabId, size, windowMs }) {
  if (session || replay) throw new Error('TJ Record is already capturing a tab.');
  if (typeof VideoEncoder === 'undefined' || typeof MediaStreamTrackProcessor === 'undefined') {
    throw new Error('Instant replay needs a newer version of Chrome.');
  }
  const { config, codecId } = await encoderConfig(size.width, size.height);
  const stream = await tabStream(streamId, size);
  const track = stream.getVideoTracks()[0];
  const r = {
    tabId,
    windowMs,
    stream,
    track,
    codecId,
    width: size.width,
    height: size.height,
    base: Date.now(),
    startedAt: Date.now(),
    frames: [], // { wall, key, data }
    lastFrame: null, // newest captured frame: idle keyframes and thumbnails
    lastWall: 0,
    lastKeyWall: 0,
    lastTs: -1,
    shots: [], // { at, blob }: frames at console errors
    lastShotAt: 0,
    console: [],
    network: [],
    actions: [],
    customLogs: [],
  };
  r.encoder = new VideoEncoder({
    output: (chunk) => keepChunk(r, chunk),
    error: (e) => endReplay(r, 'The video encoder failed: ' + ((e && e.message) || e)),
  });
  r.encoder.configure(config);
  r.reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  replay = r;
  pump(r);
  // A still page sends no frames; repeat the last one so there is always a recent keyframe to cut at.
  r.idle = setInterval(() => {
    if (r.lastFrame && Date.now() - r.lastWall >= KEY_EVERY_MS) encodeFrame(r, r.lastFrame);
  }, 500);
  track.addEventListener('ended', () => endReplay(r, ''));
  return { ok: true, startedAt: r.startedAt };
}

async function pump(r) {
  for (;;) {
    let res;
    try {
      res = await r.reader.read();
    } catch (e) {
      return;
    }
    if (res.done) return;
    if (replay !== r) {
      res.value.close();
      return;
    }
    if (r.lastFrame) r.lastFrame.close();
    r.lastFrame = res.value;
    encodeFrame(r, res.value);
  }
}

function encodeFrame(r, frame) {
  if (r.encoder.state !== 'configured') return;
  const wall = Date.now();
  const key = wall - r.lastKeyWall >= KEY_EVERY_MS;
  if (!key && r.encoder.encodeQueueSize > 3) return; // the encoder is behind: drop this frame
  const ts = Math.round((wall - r.base) * 1000);
  if (ts <= r.lastTs) return;
  let copy = null;
  try {
    copy = new VideoFrame(frame, { timestamp: ts });
    r.encoder.encode(copy, { keyFrame: key });
  } catch (e) {
    return; // the frame was closed or the encoder is shutting down
  } finally {
    if (copy) copy.close();
  }
  r.lastTs = ts;
  r.lastWall = wall;
  if (key) r.lastKeyWall = wall;
}

function keepChunk(r, chunk) {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  const key = chunk.type === 'key';
  if (!r.frames.length && !key) return;
  r.frames.push({ wall: r.base + chunk.timestamp / 1000, key, data });
  if (key) trimReplay(r);
}

// Drop everything before the last keyframe that is at least windowMs old.
function trimReplay(r) {
  const cutoff = r.frames[r.frames.length - 1].wall - r.windowMs;
  let k = 0;
  for (let i = 0; i < r.frames.length && r.frames[i].wall <= cutoff; i += 1) if (r.frames[i].key) k = i;
  if (k > 0) r.frames.splice(0, k);
  const from = r.frames[0].wall - 1000;
  for (const key of Object.values(KIND)) {
    const list = r[key];
    let n = 0;
    while (n < list.length && list[n].at < from) n += 1;
    if (n) list.splice(0, n);
  }
  while (r.shots.length && r.shots[0].at < from) r.shots.shift();
}

function ingestReplay(events) {
  const r = replay;
  if (!r || !Array.isArray(events)) return;
  for (const ev of events) {
    if (!ev || typeof ev.at !== 'number' || ev.at < r.startedAt - 100) continue;
    const { k, ...rest } = ev;
    const key = KIND[k];
    if (!key) continue;
    const list = r[key];
    list.push(rest);
    // A noisy page can't grow the buffer without bound: keep the newest entries.
    if (list.length > LIMITS[key] * 2) list.splice(0, list.length - LIMITS[key] * 2);
    if (key === 'console' && rest.level === 'error' && r.lastFrame && rest.at - r.lastShotAt >= ERROR_SHOT_EVERY_MS) {
      r.lastShotAt = rest.at;
      const shot = { at: rest.at, blob: null };
      r.shots.push(shot);
      jpegOf(r.lastFrame).then((blob) => { shot.blob = blob; }, () => {});
    }
  }
}

async function replaySave({ lengthMs, draftId, meta }) {
  const r = replay;
  if (!r) throw new Error('Instant replay is off.');
  if (!r.frames.length) throw new Error('Nothing is buffered yet. Try again in a moment.');
  const now = Date.now();
  const want = now - lengthMs;
  let start = 0;
  for (let i = 0; i < r.frames.length && r.frames[i].wall <= want; i += 1) if (r.frames[i].key) start = i;
  const frames = r.frames.slice(start);
  const t0 = frames[0].wall;
  const last = frames[frames.length - 1].wall;
  const durationMs = Math.max(1, Math.round(Math.min(now, last + KEY_EVERY_MS) - t0));
  const video = muxWebm({
    codecId: r.codecId,
    width: r.width,
    height: r.height,
    durationMs,
    frames: frames.map((f) => ({ ts: Math.round(f.wall - t0), key: f.key, data: f.data })),
  });

  const lists = {};
  for (const key of Object.values(KIND)) {
    const inWindow = r[key].filter((e) => e.at >= t0 - 100 && e.at <= now);
    lists[key] = inWindow.slice(-LIMITS[key]).map(({ at, ...rest }) => ({ t: Math.max(0, Math.round(at - t0)), ...rest }));
  }
  const { bundle, counts } = bundleOf(t0, durationMs, meta, lists);

  const shot = r.shots.find((x) => x.at >= t0 && x.blob);
  let thumb = shot ? shot.blob : null;
  if (!thumb && r.lastFrame) thumb = await jpegOf(r.lastFrame).catch(() => null);

  await putDraft({ id: draftId, type: 'video', replay: true, createdAt: Date.now(), meta, durationMs, counts, bundle, video, thumb });
  return { ok: true, draftId, durationMs, size: video.size, counts };
}

function endReplay(r, error) {
  if (replay !== r) return;
  replayStop();
  chrome.runtime.sendMessage({ type: 'replay:ended', error }).catch(() => {});
}

async function replayStop() {
  const r = replay;
  replay = null;
  if (!r) return { ok: true };
  clearInterval(r.idle);
  try {
    await r.reader.cancel();
  } catch (e) {
    /* already closed */
  }
  try {
    if (r.encoder.state !== 'closed') r.encoder.close();
  } catch (e) {
    /* already closed */
  }
  if (r.lastFrame) r.lastFrame.close();
  r.lastFrame = null;
  r.stream.getTracks().forEach((t) => t.stop());
  return { ok: true };
}
