// Extension-world half of the page logger. Asks the service worker whether this tab is being
// recorded, forwards logger.js batches to the recorder, and shows the floating stop control
// (recordings only; instant replay runs without one).
(() => {
  if (window.__tjrRelay) return;
  window.__tjrRelay = true;

  let state = '';
  let live = false;
  const control = (cmd) => document.dispatchEvent(new CustomEvent('tjr:control', { detail: cmd }));
  const setState = (s) => {
    state = s;
    control(s);
  };
  const send = (msg) => {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch (e) {
      return Promise.resolve(null); // extension was reloaded; this page is orphaned
    }
  };

  // logger.js may install after this script; it announces itself so it never misses the state.
  document.addEventListener('tjr:logger-ready', () => {
    if (state) control(state);
  });
  document.addEventListener('tjr:events', (e) => {
    if (!live || typeof e.detail !== 'string') return;
    let events;
    try {
      events = JSON.parse(e.detail);
    } catch (err) {
      return;
    }
    send({ type: 'tjr:events', events });
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'rec:flush') control('flush');
    if (msg.type === 'rec:off') {
      control('flush');
      live = false;
      setState('off');
      pill.hide();
    }
  });

  send({ type: 'rec:query' }).then((r) => {
    if (r && r.recording) {
      live = true;
      setState('live');
      if (!r.replay) pill.show(r);
    } else {
      setState('off');
    }
  });

  /* ---------- floating control (top frame only, closed shadow root) ---------- */
  const pill = (() => {
    let host = null;
    let tick = 0;
    const fmt = (ms) => {
      const s = Math.max(0, Math.floor(ms / 1000));
      return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    };
    const CSS = `
      :host{all:initial}
      .p{position:fixed;left:16px;bottom:16px;z-index:2147483647;display:flex;align-items:center;gap:8px;height:36px;padding:0 6px 0 12px;border-radius:999px;
        background:rgba(17,18,20,.92);color:#fff;font:500 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.28);
        -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);user-select:none}
      .dot{width:8px;height:8px;border-radius:50%;background:#7c9bff;box-shadow:0 0 0 0 rgba(124,155,255,.6);animation:pulse 1.6s infinite}
      @keyframes pulse{70%{box-shadow:0 0 0 7px rgba(124,155,255,0)}100%{box-shadow:0 0 0 0 rgba(124,155,255,0)}}
      .t{font-variant-numeric:tabular-nums;min-width:66px;opacity:.92}
      button{all:unset;cursor:pointer;height:26px;padding:0 10px;border-radius:999px;font-weight:600;display:inline-flex;align-items:center}
      .stop{background:#fff;color:#111214}
      .stop:hover{background:#e8e8ea}
      .x{color:rgba(255,255,255,.75);padding:0 8px}
      .x:hover{background:rgba(255,255,255,.12);color:#fff}
      .q{display:none;align-items:center;gap:6px}
      .p.ask .q{display:inline-flex}
      .p.ask .main{display:none}
      .main{display:inline-flex;align-items:center;gap:6px}
      button:focus-visible{outline:2px solid #7c9bff;outline-offset:1px}`;
    const show = (r) => {
      if (host || window.top !== window) return;
      const mount = () => {
        if (host) return;
        host = document.createElement('tjr-record-pill');
        const root = host.attachShadow({ mode: 'closed' });
        root.innerHTML =
          '<style>' + CSS + '</style>' +
          '<div class="p" role="toolbar" aria-label="TJ Record">' +
          '<span class="dot"></span><span class="t" aria-live="off">0:00</span>' +
          '<span class="main"><button class="stop" title="Stop and upload">Stop</button><button class="x" title="Discard recording" aria-label="Discard recording">✕</button></span>' +
          '<span class="q">Discard? <button class="stop yes">Discard</button><button class="x no">Keep</button></span>' +
          '</div>';
        const box = root.querySelector('.p');
        const time = root.querySelector('.t');
        const stop = root.querySelector('.main .stop');
        root.querySelector('.main .x').addEventListener('click', () => box.classList.add('ask'));
        root.querySelector('.no').addEventListener('click', () => box.classList.remove('ask'));
        root.querySelector('.yes').addEventListener('click', () => {
          box.classList.remove('ask');
          time.textContent = 'Discarding…';
          send({ type: 'rec:cancel' });
        });
        stop.addEventListener('click', () => {
          stop.textContent = 'Saving…';
          stop.disabled = true;
          send({ type: 'rec:stop' });
        });
        const update = () => {
          const elapsed = Date.now() - r.startedAt;
          const left = r.maxMs - elapsed;
          time.textContent = left < 30000 ? fmt(left) + ' left' : fmt(elapsed) + ' / ' + fmt(r.maxMs);
        };
        update();
        tick = setInterval(update, 500);
        document.documentElement.appendChild(host);
      };
      if (document.documentElement) mount();
      else document.addEventListener('readystatechange', mount, { once: true });
    };
    const hide = () => {
      clearInterval(tick);
      if (host) host.remove();
      host = null;
    };
    return { show, hide };
  })();
})();
