// Screenshot area picker. background.js captures the visible tab first, injects this file and calls
// __tjrCrop(pngDataUrl, token). We show that frozen image over the page; the user drags out the area
// to keep (or presses Enter / "Whole view"), and the cropped PNG goes back as 'shot:save'.
(() => {
  if (globalThis.__tjrCrop) return;

  const CSS = `
    :host{all:initial}
    .ov{position:fixed;inset:0;z-index:2147483647;overflow:hidden;cursor:crosshair;user-select:none;-webkit-user-select:none;touch-action:none;
      font:500 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;color:#fff}
    canvas{position:absolute;left:0;top:0;display:block}
    .dim{position:absolute;inset:0;background:rgba(10,11,13,.45)}
    .sel{position:absolute;display:none;outline:1px solid #fff;box-shadow:0 0 0 100vmax rgba(10,11,13,.45)}
    .ov.has .sel{display:block}
    .ov.has .dim{display:none}
    .size{position:absolute;left:0;top:-24px;padding:4px 6px;border-radius:5px;background:rgba(17,18,20,.88);font-variant-numeric:tabular-nums;white-space:nowrap}
    .sel.low .size{top:6px;left:6px}
    .bar{position:absolute;top:16px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:6px;height:36px;padding:0 6px 0 14px;border-radius:999px;
      background:rgba(17,18,20,.92);box-shadow:0 6px 24px rgba(0,0,0,.28);cursor:default;white-space:nowrap;transition:opacity .12s}
    .ov.drag .bar{opacity:0;pointer-events:none}
    .msg{margin-right:4px}
    button{all:unset;cursor:pointer;height:26px;padding:0 10px;border-radius:999px;font-weight:600;display:inline-flex;align-items:center;gap:6px}
    button:focus-visible{outline:2px solid #7c9bff;outline-offset:1px}
    .all{background:#fff;color:#111214}
    .all:hover{background:#e8e8ea}
    .x{color:rgba(255,255,255,.75)}
    .x:hover{background:rgba(255,255,255,.12);color:#fff}
    kbd{font-size:10px;opacity:.6}
    .ov.busy .bar button{display:none}`;

  let close = null;

  globalThis.__tjrCrop = (dataUrl, token) => {
    if (close) close();
    const send = (msg) => {
      try {
        return chrome.runtime.sendMessage(msg).catch(() => null);
      } catch (e) {
        return Promise.resolve(null); // extension was reloaded
      }
    };

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const host = document.createElement('tjr-crop');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML =
      '<style>' + CSS + '</style>' +
      '<div class="ov" tabindex="-1">' +
      '<canvas></canvas><div class="dim"></div><div class="sel"><span class="size"></span></div>' +
      '<div class="bar" role="toolbar" aria-label="TJ Record screenshot"><span class="msg">Drag to select an area</span>' +
      '<button class="all" title="Keep the whole view (Enter)">Whole view <kbd>↵</kbd></button>' +
      '<button class="x" title="Cancel (Esc)">Cancel <kbd>Esc</kbd></button></div>' +
      '</div>';
    const ov = root.querySelector('.ov');
    const canvas = root.querySelector('canvas');
    const sel = root.querySelector('.sel');
    const size = root.querySelector('.size');
    const bar = root.querySelector('.bar');
    const msg = root.querySelector('.msg');

    // Decode without fetch(): the page's CSP can't block it.
    const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    let bmp = null;
    const ready = createImageBitmap(new Blob([bytes], { type: 'image/png' })).then((b) => {
      bmp = b;
      canvas.width = b.width;
      canvas.height = b.height;
      canvas.style.width = vw + 'px';
      canvas.style.height = vh + 'px';
      canvas.getContext('2d').drawImage(b, 0, 0);
    });

    let start = null;
    let rect = null;
    let done = false;

    const onKey = (e) => {
      e.stopImmediatePropagation();
      e.preventDefault();
      if (done) return;
      if (e.key === 'Escape') cancel();
      else if (e.key === 'Enter') finish(null);
    };
    const block = (e) => e.preventDefault();
    window.addEventListener('keydown', onKey, true);
    ov.addEventListener('wheel', block, { passive: false });
    ov.addEventListener('contextmenu', block);

    const teardown = () => {
      window.removeEventListener('keydown', onKey, true);
      host.remove();
      if (bmp) bmp.close();
      if (close === teardown) close = null;
    };
    close = teardown;

    function cancel() {
      done = true;
      send({ type: 'shot:cancel', token });
      teardown();
    }

    async function finish(r) {
      done = true;
      ov.classList.remove('drag');
      ov.classList.add('busy');
      msg.textContent = 'Saving…';
      await ready;
      let image = dataUrl;
      if (r) {
        const sx = bmp.width / vw;
        const sy = bmp.height / vh;
        const x = Math.max(0, Math.round(r.x * sx));
        const y = Math.max(0, Math.round(r.y * sy));
        const w = Math.max(1, Math.min(bmp.width - x, Math.round(r.w * sx)));
        const h = Math.max(1, Math.min(bmp.height - y, Math.round(r.h * sy)));
        const out = document.createElement('canvas');
        out.width = w;
        out.height = h;
        out.getContext('2d').drawImage(bmp, x, y, w, h, 0, 0, w, h);
        image = out.toDataURL('image/png');
      }
      const res = await send({ type: 'shot:save', token, image });
      if (res && res.ok) {
        teardown();
        return;
      }
      msg.textContent = (res && res.error) || 'Couldn’t save the screenshot.';
      setTimeout(teardown, 3000);
    }

    const point = (e) => ({ x: Math.min(Math.max(e.clientX, 0), ov.clientWidth), y: Math.min(Math.max(e.clientY, 0), ov.clientHeight) });
    const draw = (e) => {
      const p = point(e);
      rect = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
      Object.assign(sel.style, { left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px' });
      sel.classList.toggle('low', rect.y < 30);
      size.textContent = Math.round(rect.w) + ' × ' + Math.round(rect.h);
      ov.classList.toggle('has', rect.w > 0 || rect.h > 0);
    };

    ov.addEventListener('pointerdown', (e) => {
      if (done || e.button !== 0 || e.composedPath().includes(bar)) return;
      start = point(e);
      ov.setPointerCapture(e.pointerId);
      ov.classList.add('drag');
      draw(e);
    });
    ov.addEventListener('pointermove', (e) => {
      if (start && !done) draw(e);
    });
    ov.addEventListener('pointerup', (e) => {
      if (!start || done) return;
      draw(e);
      start = null;
      ov.classList.remove('drag');
      if (rect.w >= 6 && rect.h >= 6) finish(rect);
      else ov.classList.remove('has'); // a click, not a drag
    });
    root.querySelector('.all').addEventListener('click', () => !done && finish(null));
    root.querySelector('.x').addEventListener('click', () => !done && cancel());

    document.documentElement.appendChild(host);
    ov.focus();
    return true;
  };
})();
