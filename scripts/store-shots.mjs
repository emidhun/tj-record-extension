// Regenerates the Chrome Web Store images in store/: three 1280x800 screenshots of the popup over a
// recorded page, and the 440x280 promo tile. Needs network access (it records todomvc.com).
//   node scripts/store-shots.mjs
import { launchRecorder } from './agent-record.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';
process.chdir(path.join(path.dirname(new URL(import.meta.url).pathname), '..'));
const S = fs.mkdtempSync(path.join(os.tmpdir(), 'tjr-shots-')), OUT = 'store';
const rec = await launchRecorder({ url: 'https://todomvc.com/examples/react/dist/', profile: S + '/prof', out: S + '/rec', upload: true, headless: true, cdpPort: 0 });
const base = `chrome-extension://${rec.extensionId}/popup.html`;
async function popup(name) {
  const p = await rec.context.newPage();
  await p.addInitScript(() => {
    if (!globalThis.chrome?.tabs) return;
    const q = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (o) => (o && o.active && o.currentWindow) ? (await q({ url: 'https://todomvc.com/*' })).slice(0, 1) : q(o);
  });
  await p.setViewportSize({ width: 360, height: 640 });
  await p.goto(base); await p.waitForTimeout(1000);
  const h = await p.evaluate(() => Math.ceil(Math.max(...[...document.body.children].map((e) => e.getBoundingClientRect().bottom))));
  await p.setViewportSize({ width: 360, height: Math.min(h, 640) });
  const cdp = await rec.context.newCDPSession(p);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: Math.min(h, 640), deviceScaleFactor: 2, mobile: false });
  const buf = await p.screenshot({ scale: 'device' });
  fs.writeFileSync(`${S}/${name}.png`, buf); await p.close();
}
await popup('idle');
const page = rec.page;
await rec.start();
await page.fill('.new-todo', 'Ship the release'); await page.press('.new-todo', 'Enter');
await page.fill('.new-todo', 'Write store listing'); await page.press('.new-todo', 'Enter');
await page.evaluate(() => { console.error('Checkout failed: 500'); fetch('/api/missing').catch(() => {}); });
await page.waitForTimeout(1500);
await page.setViewportSize({ width: 1280, height: 800 });
await page.bringToFront(); await page.waitForTimeout(300);
fs.writeFileSync(`${S}/page.png`, await page.screenshot());
await popup('recording');
await rec.stop();
await page.waitForTimeout(1500);
for (const p of rec.context.pages()) if (!p.url().startsWith('https://todomvc')) await p.close().catch(() => {});
await popup('drafts');

const img = (n) => 'data:image/png;base64,' + fs.readFileSync(`${S}/${n}.png`).toString('base64');
const icon = 'data:image/png;base64,' + fs.readFileSync('icons/128.png').toString('base64');
const font = `font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;`;
const shot = (pop, title, sub) => `<body style="margin:0;width:1280px;height:800px;position:relative;overflow:hidden;${font}">
  <img src="${img('page')}" style="position:absolute;inset:0;width:1280px;height:800px;filter:saturate(.9)">
  <div style="position:absolute;inset:0;background:linear-gradient(90deg,rgba(17,20,33,.97) 0,rgba(17,20,33,.94) 44%,rgba(17,20,33,.35) 64%,rgba(17,20,33,.08) 80%)"></div>
  <div style="position:absolute;left:72px;top:0;bottom:0;width:520px;display:flex;flex-direction:column;justify-content:center;color:#fff">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:28px"><img src="${icon}" style="width:40px;height:40px;border-radius:9px;object-view-box:inset(12.5%)"><span style="font-size:22px;font-weight:600">TJ Record</span></div>
    <div style="font-size:44px;line-height:1.15;font-weight:700;letter-spacing:-.5px">${title}</div>
    <div style="font-size:21px;line-height:1.5;margin-top:20px;color:#d4d8e8">${sub}</div>
  </div>
  <img src="${img(pop)}" style="position:absolute;right:72px;top:64px;width:360px;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.35),0 0 0 1px rgba(0,0,0,.08)">
</body>`;
const out = await rec.context.newPage();
await out.setViewportSize({ width: 1280, height: 800 });
const shots = [
  ['recording', 'Record a bug with its logs', 'Tab video plus console errors, network requests and clicks, captured together. Secrets in headers and fields are removed.'],
  ['drafts', 'Upload when you are ready', 'Recordings stay on your computer until you save them to TJ Record, with the errors already counted.'],
  ['idle', 'Tab, screen or screenshot', 'One click or a shortcut to record a tab, record your screen, or crop a screenshot.'],
];
for (const [i, [pop, t, sub]] of shots.entries()) {
  await out.setContent(shot(pop, t, sub)); await out.waitForTimeout(300);
  fs.writeFileSync(`${OUT}/screenshot-${i + 1}.png`, await out.screenshot());
}
await out.setViewportSize({ width: 440, height: 280 });
await out.setContent(`<body style="margin:0;width:440px;height:280px;background:linear-gradient(135deg,#3e63dd,#2a3f9e);display:flex;align-items:center;justify-content:center;gap:18px;color:#fff;${font}">
  <img src="${icon}" style="width:84px;height:84px;border-radius:18px;object-view-box:inset(12.5%);box-shadow:0 10px 30px rgba(0,0,0,.25)">
  <div><div style="font-size:38px;font-weight:700;letter-spacing:-.5px">TJ Record</div><div style="font-size:17px;color:#dfe6ff;margin-top:6px">Bug reports with logs, in one click</div></div>
</body>`);
await out.waitForTimeout(300);
fs.writeFileSync(`${OUT}/promo-small.png`, await out.screenshot());
await rec.close();
fs.rmSync(S, { recursive: true, force: true });
