// Local fixtures for the extension test: a page to record (port A), a cross-origin asset host
// (port B) and a mock "TJ Record Upload page" that pulls the draft through bridge.js.
import http from 'node:http';

export const A = 47811;
export const B = 47812;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

const appPage = `<!doctype html><html><head><meta charset="utf-8"><title>Acme test checkout</title>
<style>body{font:16px system-ui;margin:40px;background:#f6f7f9}input,button{font:inherit;margin:6px;padding:8px}</style></head><body>
<h1>Test shop</h1>
<div><input id="coupon" placeholder="Coupon code"><button id="apply">Apply</button></div>
<div><input id="pw" type="password" name="password" placeholder="Password"><input id="card" name="card-number" placeholder="Card number"></div>
<div><button id="pay" data-testid="pay-button">Pay $10</button> <a href="/app/page2" id="next">Next page</a></div>
<img src="/missing.png" width="20" height="20"><img src="http://127.0.0.1:${B}/pixel.png" width="20" height="20">
<script>
console.info('[shop] mounted');
console.warn('priceFormatter.format() is deprecated');
document.getElementById('apply').onclick = async () => {
  const r = await fetch('/api/coupon', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer SECRET123' }, body: JSON.stringify({ code: document.getElementById('coupon').value, password: 'hunter2' }) });
  const j = await r.json();
  console.log('coupon result', j);
  TJRecord.log('cart.total', j.total);
};
document.getElementById('pay').onclick = () => {
  const x = new XMLHttpRequest();
  x.open('POST', '/api/orders?token=abc&x=1');
  x.setRequestHeader('content-type', 'application/json');
  x.onload = () => console.error(new Error('Order failed: ' + x.status));
  x.send(JSON.stringify({ amount: 10 }));
  fetch('/api/fail');
  setTimeout(() => { null.amount; }, 50);
  Promise.reject(new Error('payment rejected'));
  history.pushState({}, '', '/app?step=paid');
};
</script></body></html>`;

const page2 = `<!doctype html><html><head><meta charset="utf-8"><title>Page two</title></head><body style="font:16px system-ui;margin:40px">
<h1>Page two</h1><button id="again">Again</button>
<img src="/missing2.png" width="20" height="20"><img src="http://127.0.0.1:${B}/pixel.png?p2" width="20" height="20"><script src="/nope.js"></script>
<script>console.log('[page2] loaded'); fetch('/api/ok').then(r => r.json()).then(j => console.log('ok', j.ok));
document.getElementById('again').onclick = () => console.log('again clicked');</script></body></html>`;

// Stands in for the ToolJet Upload page: a same-origin srcdoc iframe asks bridge.js for the draft.
const uploadPage = `<!doctype html><html><head><meta charset="utf-8"><title>Mock upload</title></head><body>
<pre id="out">waiting</pre>
<iframe id="f" style="width:640px;height:360px" srcdoc="<video id=v muted style='width:100%'></video><script>
const out = parent.document.getElementById('out');
const id = new URLSearchParams(parent.location.search).get('draft');
const ask = (m, ms) => new Promise((res) => {
  const rid = Math.random().toString(36).slice(2);
  const on = (e) => { if (e.data && e.data.rid === rid) { removeEventListener('message', on); res(e.data); } };
  addEventListener('message', on);
  parent.postMessage(Object.assign({ rid }, m), '*');
  setTimeout(() => res({ timeout: true }), ms || 4000);
});
(async () => {
  const hello = await ask({ tjr: 'hello' });
  if (!hello.ok) { out.textContent = JSON.stringify({ error: 'no bridge', hello }); return; }
  const r = await ask({ tjr: 'draft:get', id }, 30000);
  if (!r.ok) { out.textContent = JSON.stringify({ error: r.error || 'no draft', r }); return; }
  const d = r.draft;
  const s = { hello: hello.version, id: d.id, type: d.type, meta: d.meta, counts: d.counts, durationMs: d.durationMs,
    videoSize: d.video ? d.video.size : 0, videoType: d.video ? d.video.type : '', thumbSize: d.thumb ? d.thumb.size : 0, thumbType: d.thumb ? d.thumb.type : '',
    bundleKeys: Object.keys(d.bundle || {}) };
  if (d.thumb) { const img = new Image(); img.src = URL.createObjectURL(d.thumb); await img.decode(); s.thumbDims = img.naturalWidth + 'x' + img.naturalHeight; }
  if (d.video) {
    const v = document.getElementById('v');
    v.src = URL.createObjectURL(d.video);
    await new Promise((ok) => { v.onloadedmetadata = ok; v.onerror = ok; });
    s.videoDuration = v.duration; s.videoDims = v.videoWidth + 'x' + v.videoHeight;
    const target = Math.min(3, v.duration / 2);
    const seeked = new Promise((ok) => { v.onseeked = () => ok(true); setTimeout(() => ok(false), 5000); });
    v.currentTime = target;
    s.seeked = await seeked; s.seekTarget = target; s.currentTime = v.currentTime;
  }
  const done = await ask({ tjr: 'draft:done', id });
  s.doneAck = done.ok;
  out.textContent = JSON.stringify(s);
})();
</script>"></iframe></body></html>`;

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

export function start() {
  const a = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/app') return res.writeHead(200, { 'content-type': 'text/html' }), res.end(appPage);
    if (u.pathname === '/app/page2') return res.writeHead(200, { 'content-type': 'text/html' }), res.end(page2);
    if (u.pathname.startsWith('/applications/test-app/upload')) return res.writeHead(200, { 'content-type': 'text/html' }), res.end(uploadPage);
    if (u.pathname === '/api/coupon') return json(res, 200, { code: 'SAVE20', total: 8, token: 'tok_should_be_redacted' });
    if (u.pathname === '/api/orders') return json(res, 500, { error: 'discount_line_mismatch', request_id: 'req_1' });
    if (u.pathname === '/api/fail') return res.writeHead(503, { 'content-type': 'text/plain' }), res.end('Service unavailable');
    if (u.pathname === '/api/ok') return json(res, 200, { ok: true });
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  });
  const b = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PNG);
  });
  return Promise.all([new Promise((r) => a.listen(A, '127.0.0.1', r)), new Promise((r) => b.listen(B, '127.0.0.1', r))]).then(() => ({ close: () => { a.close(); b.close(); } }));
}
