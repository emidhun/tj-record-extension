// Screen recorder tab. A stream id from Chrome's screen picker can only be used by the page that asked
// for it, so this page asks (desktopCapture.chooseDesktopMedia), records with the shared recorder
// module, and stays open while recording. The service worker owns the capture state, stops the
// recording (via the 'screen' message target, handled in offscreen.js) and closes this tab.
import { startSession } from './offscreen.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};
// Tests can add 'tab' (?sources=screen,window,tab): headless Chrome has no screen to pick.
const SOURCES = (new URLSearchParams(location.search).get('sources') || 'screen,window').split(',');

let recording = false;
let ticker = 0;

function show(state, label, hint) {
  document.body.dataset.state = state;
  if (label) $('msg').textContent = label;
  if (hint !== undefined) $('hint').textContent = hint;
  $('stop').hidden = $('discard').hidden = state !== 'recording';
  $('cancel').hidden = state === 'recording' || state === 'done';
}

function stopTicker() {
  clearInterval(ticker);
  recording = false;
  document.title = 'Screen recording · TJ Record';
}

// The service worker is ending the recording: don't ask "Leave site?" when it closes this tab.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.target === 'screen' && (msg.type === 'stop' || msg.type === 'cancel')) {
    stopTicker();
    show('done', msg.type === 'stop' ? 'Saving…' : 'Discarded', '');
  }
});

window.addEventListener('beforeunload', (e) => {
  if (!recording) return;
  e.preventDefault();
  e.returnValue = '';
});

async function main() {
  const job = await send({ type: 'screen:job' });
  if (!job || !job.ok) {
    show('error', 'This screen recording was cancelled.', 'You can close this tab.');
    return;
  }
  $('from').textContent = job.meta.title || job.meta.url || 'this tab';
  show('picking', 'Choose what to record', 'Pick a screen or a window in Chrome’s dialog. Console, network and clicks come from the tab you started on.');

  chrome.desktopCapture.chooseDesktopMedia(SOURCES, async (streamId) => {
    if (!streamId) {
      show('done', 'Cancelled', '');
      await send({ type: 'screen:cancelled' });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: streamId, maxWidth: 1920, maxHeight: 1200, maxFrameRate: 30 } },
      });
      const r = await startSession(stream, { draftId: job.draftId, tabId: job.tabId, meta: job.meta, maxMs: job.maxMs, capture: 'screen' });
      recording = true;
      show('recording', 'Recording your screen', 'Keep this tab open. Stop here, from the TJ Record icon, or with Chrome’s “Stop sharing”.');
      const tick = () => {
        const elapsed = Math.min(Date.now() - r.startedAt, job.maxMs);
        $('time').textContent = clock(elapsed) + ' / ' + clock(job.maxMs);
        $('meter').style.width = (100 * elapsed) / job.maxMs + '%';
        document.title = '● ' + clock(elapsed) + ' Recording screen · TJ Record';
      };
      tick();
      ticker = setInterval(tick, 500);
      await send({ type: 'screen:started', startedAt: r.startedAt });
    } catch (e) {
      show('error', 'Couldn’t start the screen recording.', (e && e.message) || String(e));
      await send({ type: 'screen:cancelled', error: (e && e.message) || String(e) });
    }
  });
}

$('stop').addEventListener('click', () => {
  $('stop').disabled = true;
  $('stop').textContent = 'Saving…';
  send({ type: 'rec:stop' });
});
$('discard').addEventListener('click', () => {
  const b = $('discard');
  if (b.dataset.armed !== '1') {
    b.dataset.armed = '1';
    b.textContent = 'Click again to discard';
    return;
  }
  send({ type: 'rec:cancel' });
});
$('cancel').addEventListener('click', () => send({ type: 'rec:cancel' }));

main();
