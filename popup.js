import { DEFAULT_APP_URL, getAppUrl, pageUrl } from './lib/config.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const recordable = (url) => /^(https?|file):/.test(url || '');
const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};
const mb = (bytes) => (bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB');
const ago = (ts) => {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  return h < 24 ? h + ' h ago' : Math.round(h / 24) + ' d ago';
};
const ICON_TRASH = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';

let tab = null;
let rec = null;
let ticker = 0;

function showError(message) {
  for (const id of ['error', 'error2']) {
    $(id).textContent = message || '';
    $(id).hidden = !message;
  }
}

async function run(button, label, fn) {
  const original = button.innerHTML;
  button.disabled = true;
  if (label) button.textContent = label;
  showError('');
  try {
    await fn();
  } catch (e) {
    showError((e && e.message) || String(e));
  }
  button.innerHTML = original;
  button.disabled = false;
  render();
}

const ok = (r, fallback) => {
  if (!r || !r.ok) throw new Error((r && r.error) || fallback);
  return r;
};

const focusTab = async () => {
  // While Chrome's screen picker is open, "go to" means the picker's tab.
  const id = rec.pending && rec.recorderTabId != null ? rec.recorderTabId : rec.tabId;
  const t = await chrome.tabs.update(id, { active: true });
  await chrome.windows.update(t.windowId, { focused: true });
  window.close();
};

/* ---------- main view ---------- */
function render() {
  const mode = rec ? rec.mode : 'idle';
  const here = !!rec && !!tab && tab.id === rec.tabId;
  const can = !!tab && recordable(tab.url);
  clearInterval(ticker);

  $('recording').hidden = mode !== 'record';
  $('replay').hidden = mode !== 'replay';
  $('menu').hidden = mode === 'record';
  $('blocked').hidden = can || mode === 'record';

  $('record').disabled = !can || mode === 'replay';
  $('recordSub').textContent = mode === 'replay' ? 'Turn off replay to record' : 'With console, network and clicks';
  $('screen').disabled = mode === 'replay';
  $('screenSub').textContent = mode === 'replay' ? 'Turn off replay to record' : can ? 'Entire screen or a window' : 'Entire screen or a window · no logs here';
  $('shot').disabled = !can;

  let update = null;
  if (mode === 'record') {
    const screen = rec.source === 'screen';
    $('recTitle').textContent = (screen ? 'Logs from ' : '') + (rec.meta.title || rec.meta.url);
    $('recNote').hidden = rec.logs !== false;
    $('goto').hidden = here && !rec.pending;
    $('goto').textContent = rec.pending ? 'Go to the screen picker' : screen ? 'Go to the logged tab' : 'Go to the recorded tab';
    $('recLabel').textContent = rec.pending ? 'Choose a screen or window' : screen ? 'Recording screen' : 'Recording tab';
    $('stop').hidden = !!rec.pending;
    $('recMeterBox').hidden = !!rec.pending;
    $('discard').textContent = rec.pending ? 'Cancel' : 'Discard';
    $('discard').dataset.armed = rec.pending ? '1' : '';
    if (rec.pending) {
      $('recTime').textContent = '';
      return renderSettings();
    }
    update = () => {
      const elapsed = Math.min(Date.now() - rec.startedAt, rec.maxMs);
      $('recTime').textContent = clock(elapsed) + ' / ' + clock(rec.maxMs);
      $('recMeter').style.width = (100 * elapsed) / rec.maxMs + '%';
    };
  }
  if (mode === 'replay') {
    $('rpTitle').textContent = (here && tab.title) || rec.meta.title || rec.meta.url;
    $('rpGoto').hidden = here;
    const buttons = [...document.querySelectorAll('#replay [data-ms]')];
    // "N min" is enabled once more than the next-shorter length is buffered; with less than N
    // minutes buffered it saves everything so far.
    update = () => {
      const buffered = Math.min(Date.now() - rec.startedAt, rec.windowMs);
      $('rpTime').textContent = buffered >= rec.windowMs ? 'Last ' + clock(rec.windowMs) + ' kept' : clock(buffered) + ' buffered';
      let prev = 0;
      buttons.forEach((b) => {
        const ms = Number(b.dataset.ms);
        if (b.dataset.busy !== '1') b.disabled = buffered <= prev + 2000;
        b.title = buffered < ms ? 'Saves the ' + clock(buffered) + ' buffered so far' : 'Saves the last ' + ms / 60000 + ' min';
        prev = ms;
      });
    };
  }
  if (update) {
    update();
    ticker = setInterval(update, 500);
  }
  renderSettings();
}

async function renderDrafts() {
  const r = await send({ type: 'drafts:list' });
  const drafts = (r && r.drafts) || [];
  $('drafts').hidden = !drafts.length;
  $('draftCount').textContent = drafts.length ? '· ' + drafts.length : '';
  const list = $('draftList');
  list.textContent = '';
  drafts.forEach((d) => {
    const li = document.createElement('li');
    const text = document.createElement('div');
    text.className = 'text';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = d.meta.title || d.meta.url || 'Recording';
    const meta = document.createElement('div');
    meta.className = 'sub';
    const kind = d.type === 'screenshot' ? 'Screenshot' : ({ screen: 'Screen ', replay: 'Replay ' }[d.capture] || (d.replay ? 'Replay ' : 'Tab ')) + clock(d.durationMs);
    meta.title = mb(d.size);
    if (d.counts && d.counts.errors) {
      const err = document.createElement('span');
      err.className = 'err';
      err.textContent = d.counts.errors + (d.counts.errors === 1 ? ' error' : ' errors');
      meta.append(err, ' · ');
    }
    meta.append(kind + ' · ' + ago(d.createdAt));
    text.append(title, meta);
    const upload = document.createElement('button');
    upload.className = 'btn small';
    upload.textContent = 'Upload';
    upload.addEventListener('click', () => run(upload, '', async () => {
      ok(await send({ type: 'draft:open', id: d.id }), 'Could not open TJ Record.');
      window.close();
    }));
    const del = document.createElement('button');
    del.className = 'ib';
    del.title = 'Delete';
    del.setAttribute('aria-label', 'Delete');
    del.innerHTML = ICON_TRASH;
    del.addEventListener('click', async () => {
      if (del.dataset.armed !== '1') {
        del.dataset.armed = '1';
        del.classList.add('armed');
        del.textContent = 'Delete';
        return;
      }
      await send({ type: 'draft:delete', id: d.id });
      renderDrafts();
    });
    li.append(text, upload, del);
    list.appendChild(li);
  });
}

/* ---------- settings view ---------- */
function renderSettings() {
  const sw = $('replaySwitch');
  const on = !!rec && rec.mode === 'replay';
  const can = !!tab && recordable(tab.url);
  sw.setAttribute('aria-checked', String(on));
  sw.disabled = (!on && !can) || (!!rec && rec.mode === 'record');
  const where = $('replayWhere');
  where.hidden = !on;
  if (on) where.textContent = 'On for “' + (rec.meta.title || rec.meta.url) + '”';
  const note = $('replayNote');
  note.hidden = !sw.disabled;
  note.textContent = rec && rec.mode === 'record' ? 'Stop the recording to use instant replay.' : 'Open a website to use instant replay.';
}

function showView(name) {
  $('main').hidden = name !== 'main';
  $('settings').hidden = name !== 'settings';
  showError('');
  if (name === 'settings') $('replaySwitch').focus();
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  rec = ((await send({ type: 'rec:state' })) || {}).rec || null;
  const commands = await chrome.commands.getAll();
  const toggle = commands.find((c) => c.name === 'toggle-recording');
  $('kbd').textContent = $('kbd2').textContent = (toggle && toggle.shortcut) || '';
  if (!$('kbd2').textContent) $('kbd2').replaceWith(Object.assign(document.createElement('span'), { className: 'muted', textContent: 'Not set' }));
  $('version').textContent = $('version2').textContent = 'v' + chrome.runtime.getManifest().version;
  $('appUrl').value = await getAppUrl();
  render();
  renderDrafts();
}

/* ---------- actions ---------- */
$('record').addEventListener('click', () => run($('record'), '', async () => {
  // Ask for the stream here: the popup click is the user gesture tab capture needs.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  ok(await send({ type: 'rec:start', tabId: tab.id, streamId }), 'Could not start recording.');
  window.close();
}));

$('screen').addEventListener('click', () => run($('screen'), '', async () => {
  // The screen picker opens in a TJ Record tab; Chrome closes this popup when it gets focus.
  ok(await send({ type: 'screen:start', tabId: tab.id }), 'Could not start the screen recording.');
  window.close();
}));

$('shot').addEventListener('click', () => run($('shot'), '', async () => {
  ok(await send({ type: 'shot', tabId: tab.id }), 'Could not take a screenshot.');
  window.close();
}));

document.querySelectorAll('#replay [data-ms]').forEach((b) => {
  b.addEventListener('click', () => {
    b.dataset.busy = '1';
    run(b, 'Saving…', async () => {
      ok(await send({ type: 'replay:save', ms: Number(b.dataset.ms) }), 'Could not save the replay.');
      window.close();
    }).finally(() => { b.dataset.busy = ''; });
  });
});

$('rpGoto').addEventListener('click', focusTab);
$('goto').addEventListener('click', focusTab);

$('stop').addEventListener('click', () => run($('stop'), 'Saving…', async () => {
  ok(await send({ type: 'rec:stop' }), 'Could not stop the recording.');
  window.close();
}));

$('discard').addEventListener('click', () => {
  const b = $('discard');
  if (b.dataset.armed !== '1') {
    b.dataset.armed = '1';
    b.textContent = 'Click again to discard';
    return;
  }
  run(b, 'Discarding…', async () => {
    ok(await send({ type: 'rec:cancel' }), 'Could not discard the recording.');
    window.close();
  });
});

$('open').addEventListener('click', async () => {
  await chrome.tabs.create({ url: pageUrl(await getAppUrl(), 'home') });
  window.close();
});

/* ---------- settings ---------- */
$('gear').addEventListener('click', () => showView('settings'));
$('back').addEventListener('click', () => showView('main'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('settings').hidden) {
    e.preventDefault();
    showView('main');
  }
});

$('replaySwitch').addEventListener('click', () => {
  const sw = $('replaySwitch');
  const on = sw.getAttribute('aria-checked') === 'true';
  sw.setAttribute('aria-checked', String(!on)); // move the knob right away
  run(sw, '', async () => {
    if (on) {
      ok(await send({ type: 'replay:stop' }), 'Could not turn off instant replay.');
      rec = null;
    } else {
      // The switch click is the user gesture tab capture needs.
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      rec = ok(await send({ type: 'replay:start', tabId: tab.id, streamId }), 'Could not turn on instant replay.').rec;
    }
  });
});

$('save').addEventListener('click', () => run($('save'), '', async () => {
  const r = ok(await send({ type: 'settings:save', appUrl: $('appUrl').value }), 'Could not save the URL.');
  $('appUrl').value = r.appUrl;
  $('saved').hidden = false;
  setTimeout(() => { $('saved').hidden = true; }, 1500);
}));

$('reset').addEventListener('click', () => {
  $('appUrl').value = DEFAULT_APP_URL;
});

$('shortcuts').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  window.close();
});

init().catch((e) => showError(e.message));
