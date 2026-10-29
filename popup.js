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

let tab = null;
let rec = null;

function showError(message) {
  $('error').textContent = message || '';
  $('error').hidden = !message;
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
    button.innerHTML = original;
    button.disabled = false;
  }
}

const ok = (r, fallback) => {
  if (!r || !r.ok) throw new Error((r && r.error) || fallback);
  return r;
};

function render() {
  $('idle').hidden = !!rec;
  $('recording').hidden = !rec;
  if (rec) {
    $('recTitle').textContent = rec.meta.title || rec.meta.url;
    const update = () => {
      const elapsed = Date.now() - rec.startedAt;
      $('recTime').textContent = 'Recording · ' + clock(elapsed) + ' of ' + clock(rec.maxMs) + (rec.logs === false ? ' · video only' : '');
    };
    update();
    setInterval(update, 500);
    $('goto').hidden = !!tab && tab.id === rec.tabId;
    return;
  }
  const can = !!tab && recordable(tab.url);
  $('record').disabled = !can;
  $('shot').disabled = !can;
  $('blocked').hidden = can;
}

async function renderDrafts() {
  const r = await send({ type: 'drafts:list' });
  const drafts = (r && r.drafts) || [];
  $('drafts').hidden = !drafts.length;
  const list = $('draftList');
  list.textContent = '';
  drafts.forEach((d) => {
    const li = document.createElement('li');
    const text = document.createElement('div');
    text.className = 'grow';
    const title = document.createElement('div');
    title.className = 'ttl';
    title.textContent = d.meta.title || d.meta.url || 'Recording';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const bits = [d.type === 'screenshot' ? 'Screenshot' : clock(d.durationMs), mb(d.size), ago(d.createdAt)];
    meta.textContent = bits.join(' · ');
    if (d.counts && d.counts.errors) {
      const err = document.createElement('span');
      err.className = 'err';
      err.textContent = ' · ' + d.counts.errors + (d.counts.errors === 1 ? ' error' : ' errors');
      meta.appendChild(err);
    }
    text.append(title, meta);
    const upload = document.createElement('button');
    upload.className = 'btn small';
    upload.textContent = 'Upload';
    upload.addEventListener('click', () => run(upload, '', async () => {
      ok(await send({ type: 'draft:open', id: d.id }), 'Could not open TJ Record.');
      window.close();
    }));
    const del = document.createElement('button');
    del.className = 'link';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (del.dataset.armed !== '1') {
        del.dataset.armed = '1';
        del.textContent = 'Confirm';
        return;
      }
      await send({ type: 'draft:delete', id: d.id });
      renderDrafts();
    });
    li.append(text, upload, del);
    list.appendChild(li);
  });
}

async function loadSettings() {
  $('appUrl').value = await getAppUrl();
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  rec = ((await send({ type: 'rec:state' })) || {}).rec || null;
  const commands = await chrome.commands.getAll();
  const toggle = commands.find((c) => c.name === 'toggle-recording');
  $('kbd').textContent = (toggle && toggle.shortcut) || '';
  $('version').textContent = 'v' + chrome.runtime.getManifest().version;
  render();
  renderDrafts();
  loadSettings();
}

$('record').addEventListener('click', () => run($('record'), 'Starting…', async () => {
  // Ask for the stream here: the popup click is the user gesture tab capture needs.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  ok(await send({ type: 'rec:start', tabId: tab.id, streamId }), 'Could not start recording.');
  window.close();
}));

$('shot').addEventListener('click', () => run($('shot'), 'Capturing…', async () => {
  ok(await send({ type: 'shot', tabId: tab.id }), 'Could not take a screenshot.');
  window.close();
}));

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

$('goto').addEventListener('click', async () => {
  await chrome.tabs.update(rec.tabId, { active: true });
  await chrome.windows.update(rec.windowId, { focused: true });
  window.close();
});

$('gear').addEventListener('click', () => {
  const open = $('settings').hidden;
  $('settings').hidden = !open;
  $('gear').setAttribute('aria-expanded', String(open));
  if (open) $('appUrl').focus();
});

$('save').addEventListener('click', () => run($('save'), '', async () => {
  const r = ok(await send({ type: 'settings:save', appUrl: $('appUrl').value }), 'Could not save the URL.');
  $('appUrl').value = r.appUrl;
  $('save').disabled = false;
  $('saved').hidden = false;
  setTimeout(() => { $('saved').hidden = true; }, 1500);
}));

$('reset').addEventListener('click', () => {
  $('appUrl').value = DEFAULT_APP_URL;
});

$('open').addEventListener('click', async () => {
  await chrome.tabs.create({ url: pageUrl(await getAppUrl(), 'home') });
  window.close();
});

init().catch((e) => showError(e.message));
