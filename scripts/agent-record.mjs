// Agent recorder: lets an AI coding agent (Claude Code, Codex, …) or any script record a browser
// session with TJ Record, without anyone clicking the toolbar button.
//
// It launches Chrome for Testing with this extension loaded (branded Chrome ignores --load-extension)
// and allowlisted, so tab capture needs no user gesture, opens <url>, and then:
//   - serves a small control API on 127.0.0.1 (start / stop / save replay / discard / quit), and
//   - exposes the browser's DevTools port, so a browser MCP server or Playwright can drive the page.
// A stopped recording is written to disk (video.webm, thumb.jpg, bundle.json, record.json) and gets
// an Upload link (…/upload?draft=<id>). Open it in your own browser, where you're signed in to TJ
// Record: its extension imports the capture from this script, which serves its captures on the
// control port (GET /drafts/<id>/<file>) while it runs. --serve does only that, for earlier captures.
// --upload instead opens the Upload page in the recorder's browser (which then needs a sign-in).
//
//   node scripts/agent-record.mjs <url> [--replay] [--no-start] [--upload] [--out dir] [--port n]
//                                       [--cdp-port n] [--profile dir] [--headless]
//   node scripts/agent-record.mjs --serve [--out dir]
//
// Also importable: `const rec = await launchRecorder({ url }); await rec.page.click(…); await rec.stop();`
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { DEFAULT_APP_URL, pageUrl } from '../lib/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = fs.realpathSync(path.join(HERE, '..'));
// Unpacked extension id = first 32 hex chars of sha256(path), mapped 0-f → a-p.
const EXT_ID = [...crypto.createHash('sha256').update(EXT).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const DEFAULT_OUT = path.join(process.cwd(), 'recordings');
// The extension looks for agent captures on this port (AGENT_RECORDER in background.js).
const DEFAULT_PORT = 47900;
export const uploadLink = (draftId, appUrl = DEFAULT_APP_URL) => pageUrl(appUrl, 'upload', { draft: draftId });

export async function launchRecorder({
  url = 'about:blank',
  profile = path.join(EXT, '.agent-profile'),
  out = DEFAULT_OUT,
  upload = false,
  headless = false,
  cdpPort = 9222,
  chrome = process.env.CHROME || chromium.executablePath(),
  onSaved = () => {},
} = {}) {
  fs.mkdirSync(profile, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: chrome,
    headless,
    viewport: null,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      `--allowlisted-extension-id=${EXT_ID}`,
      ...(cdpPort ? [`--remote-debugging-port=${cdpPort}`] : []),
    ],
  });
  // Without --upload, captures only go to disk. A recording that ends on its own (time limit, tab
  // closed) still makes the extension open the Upload page, a moment after it's saved: close it.
  if (!upload) {
    context.on('page', (p) => {
      p.waitForURL(/\/upload\?(.*&)?draft=/, { timeout: 15000 }).then(() => p.close(), () => {});
    });
  }
  const sw = context.serviceWorkers().find((w) => w.url().includes(EXT_ID)) || (await context.waitForEvent('serviceworker', { predicate: (w) => w.url().includes(EXT_ID), timeout: 15000 }));
  const page = context.pages()[0] || (await context.newPage());
  if (url !== 'about:blank') await page.goto(url, { waitUntil: 'domcontentloaded' });

  // The tab we opened; ids survive navigation.
  const tabId = await sw.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url === u) || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    return t && t.id;
  }, page.url());

  let current = null; // { mode, draftId, startedAt, tabId }
  let finishing = null;

  const getRec = () => sw.evaluate(() => globalThis.tjr.getRec());

  async function resolveTab(which) {
    if (which === 'active') return sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id);
    return tabId;
  }

  async function start({ mode = 'record', tab } = {}) {
    if (current) throw new Error(`A ${current.mode} is already running. Stop it first.`);
    const id = await resolveTab(tab);
    const r = await sw.evaluate(
      async ({ id, mode }) => {
        const t = await chrome.tabs.get(id);
        const res = mode === 'replay' ? await globalThis.tjr.startReplay(t) : await globalThis.tjr.startRecording(t);
        return { draftId: res.rec.draftId || null, startedAt: res.rec.startedAt, logs: res.rec.logs, url: t.url };
      },
      { id, mode },
    );
    current = { mode, tabId: id, ...r };
    return { ok: true, mode, ...r };
  }

  // Writes a draft to <out>/<time>-<kind>/ and, unless uploading, removes it from the extension.
  async function exportDraft(draftId) {
    let head = null;
    for (let i = 0; i < 50 && !head; i += 1) {
      head = await sw.evaluate(async (id) => {
        const d = await globalThis.tjr.getDraft(id);
        if (!d) return null;
        const { video, thumb, ...rest } = d;
        return rest;
      }, draftId);
      if (!head) await sleep(200);
    }
    if (!head) throw new Error('The recording was not saved.');
    const dir = path.join(out, `${stamp()}-${head.capture || head.type}`);
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    for (const part of ['video', 'thumb']) {
      const b64 = await sw.evaluate(
        async ({ id, part }) => {
          const blob = (await globalThis.tjr.getDraft(id))[part];
          if (!blob) return null;
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          return btoa(bin);
        },
        { id: draftId, part },
      );
      if (!b64) continue;
      const name = part === 'video' ? 'video.webm' : 'thumb.jpg';
      fs.writeFileSync(path.join(dir, name), Buffer.from(b64, 'base64'));
      files.push(name);
    }
    const { bundle, ...record } = head;
    fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify(bundle, null, 1));
    fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify(record, null, 1));
    files.push('bundle.json', 'record.json');
    if (!upload) {
      await sw.evaluate((id) => globalThis.tjr.deleteDraft(id), draftId);
      // A recording that ended on its own (time limit, tab closed) opened the Upload page.
      for (const p of context.pages()) if (p.url().includes(`draft=${draftId}`)) await p.close().catch(() => {});
    }
    const result = { ok: true, dir, files, draftId, capture: head.capture, durationMs: head.durationMs, counts: head.counts, uploadLink: uploadLink(draftId), uploadPage: upload };
    onSaved(result);
    return result;
  }

  async function stop() {
    if (!current) throw new Error('Nothing is running.');
    const c = current;
    if (c.mode === 'replay') {
      await sw.evaluate(() => globalThis.tjr.stopReplay());
      current = null;
      return { ok: true, mode: 'replay', stopped: true };
    }
    finishing = (async () => {
      const r = await sw.evaluate((open) => globalThis.tjr.stopRecording({ openUploadPage: open }), upload);
      current = null;
      if (!r || !r.ok) throw new Error((r && r.error) || 'The recording could not be stopped.');
      return exportDraft(r.draftId);
    })();
    try {
      return await finishing;
    } finally {
      finishing = null;
    }
  }

  async function save(ms = 180000) {
    if (!current || current.mode !== 'replay') throw new Error('Instant replay is not running. Start it with mode=replay.');
    const r = await sw.evaluate(({ ms, open }) => globalThis.tjr.saveReplay(ms, { openUploadPage: open }), { ms: Number(ms), open: upload });
    if (!r || !r.ok) throw new Error((r && r.error) || 'The replay could not be saved.');
    return exportDraft(r.draftId);
  }

  async function discard() {
    if (!current) return { ok: true };
    if (current.mode === 'replay') await sw.evaluate(() => globalThis.tjr.stopReplay());
    else await sw.evaluate(() => globalThis.tjr.stopRecording({ discard: true }));
    current = null;
    return { ok: true, discarded: true };
  }

  async function status() {
    const rec = await getRec();
    return {
      ok: true,
      running: rec ? rec.mode : null,
      startedAt: rec ? rec.startedAt : null,
      elapsedMs: rec && rec.startedAt ? Date.now() - rec.startedAt : 0,
      limitMs: rec ? rec.maxMs || rec.windowMs : null,
      url: rec ? rec.meta && rec.meta.url : page.url(),
      cdp: cdpPort ? `http://127.0.0.1:${cdpPort}` : null,
    };
  }

  // A recording also ends on its own at the 3-minute limit or when its tab closes: save it anyway.
  const watcher = setInterval(async () => {
    if (!current || current.mode !== 'record' || finishing) return;
    try {
      if (await getRec()) return;
      const c = current;
      current = null;
      await exportDraft(c.draftId);
    } catch (e) {
      /* browser closing */
    }
  }, 1000);

  async function close() {
    clearInterval(watcher);
    if (current && current.mode === 'record') await stop().catch(() => {});
    else if (current) await discard().catch(() => {});
    await context.close().catch(() => {});
  }

  return { context, page, sw, extensionId: EXT_ID, start, stop, save, discard, status, close };
}

/* ---------- CLI ---------- */
function parseArgs(argv) {
  const o = { url: null, mode: 'record', start: true, upload: false, serve: false, out: DEFAULT_OUT, port: DEFAULT_PORT, cdpPort: 9222, profile: undefined, headless: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--replay') o.mode = 'replay';
    else if (a === '--no-start') o.start = false;
    else if (a === '--upload') o.upload = true;
    else if (a === '--serve') o.serve = true;
    else if (a === '--headless') o.headless = true;
    else if (a === '--out') o.out = path.resolve(argv[(i += 1)]);
    else if (a === '--port') o.port = Number(argv[(i += 1)]);
    else if (a === '--cdp-port') o.cdpPort = Number(argv[(i += 1)]);
    else if (a === '--profile') o.profile = path.resolve(argv[(i += 1)]);
    else if (a === '-h' || a === '--help') o.help = true;
    else if (!a.startsWith('-') && !o.url) o.url = a;
    else throw new Error('Unknown option: ' + a);
  }
  return o;
}

const HELP = `Usage: node scripts/agent-record.mjs <url> [options]
       node scripts/agent-record.mjs --serve [--out dir]

Each saved capture prints an uploadLink: open it in your own browser (signed in to TJ Record, with
the extension) while this script runs, and the Upload page imports the capture from here.

  --replay        start instant replay (keeps the last 3 min) instead of a recording
  --no-start      just open the browser; start later with POST /start
  --serve         don't open a browser; only serve captures in --out, so their links work
  --upload        open the Upload page in the recorder's browser instead (needs a sign-in there)
  --out <dir>     where captures are written (default ./recordings)
  --port <n>      control API port (default 47900; links only work on 47900)
  --cdp-port <n>  DevTools port for browser MCP servers / Playwright (default 9222, 0 = off)
  --profile <dir> browser profile, keeps your ToolJet sign-in (default .agent-profile)
  --headless      no browser window

Control API (JSON):
  GET  /status
  GET  /drafts/<id>/<file>  a saved capture (record.json, bundle.json, video.webm, thumb.jpg)
  POST /start[?mode=record|replay][&tab=active]
  POST /stop                stop the recording and save it
  POST /save[?ms=60000]     save the last ms of instant replay (replay keeps running)
  POST /discard
  POST /quit                save a running recording, close the browser and exit`;

const CAPTURE_FILES = { 'record.json': 'application/json', 'bundle.json': 'application/json', 'video.webm': 'video/webm', 'thumb.jpg': 'image/jpeg' };

// The capture folder in `out` whose record.json has this draft id.
function findCapture(out, id) {
  if (!/^[0-9a-f-]{36}$/.test(id) || !fs.existsSync(out)) return null;
  for (const name of fs.readdirSync(out)) {
    try {
      if (JSON.parse(fs.readFileSync(path.join(out, name, 'record.json'), 'utf8')).id === id) return path.join(out, name);
    } catch (e) {
      /* not a capture */
    }
  }
  return null;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || (!o.url && !o.serve)) {
    console.log(HELP);
    process.exit(o.help ? 0 : 1);
  }
  const rec = o.serve ? null : await launchRecorder({ url: o.url, profile: o.profile, out: o.out, upload: o.upload, headless: o.headless, cdpPort: o.cdpPort, onSaved: (r) => console.log(JSON.stringify({ event: 'saved', ...r })) });
  let quitting = false;
  const quit = async () => {
    if (quitting) return;
    quitting = true;
    if (rec) await rec.close();
    server.close();
    process.exit(0);
  };
  const needBrowser = () => {
    if (!rec) throw new Error('Running with --serve: there is no browser to record.');
    return rec;
  };

  const routes = {
    'GET /status': () => (rec ? rec.status() : { ok: true, running: null, serving: o.out }),
    'POST /start': (q) => needBrowser().start({ mode: q.get('mode') || 'record', tab: q.get('tab') || undefined }),
    'POST /stop': () => needBrowser().stop(),
    'POST /save': (q) => needBrowser().save(q.get('ms') || 180000),
    'POST /discard': () => needBrowser().discard(),
    'POST /quit': async () => {
      setTimeout(quit, 50);
      return { ok: true, quitting: true };
    },
  };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    // Only curl/scripts and extensions: web pages you visit could otherwise reach this port (a
    // cross-site POST /quit, or DNS rebinding to read captures).
    const origin = req.headers.origin;
    const hostOk = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '');
    if (!hostOk || (origin && !origin.startsWith('chrome-extension://'))) {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'forbidden' }) + '\n');
    }
    const file = req.method === 'GET' && u.pathname.match(/^\/drafts\/([0-9a-f-]{36})\/([a-z.]+)$/);
    if (file) {
      const dir = findCapture(o.out, file[1]);
      const p = dir && CAPTURE_FILES[file[2]] && path.join(dir, file[2]);
      if (!p || !fs.existsSync(p)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'not_found' }) + '\n');
      }
      res.writeHead(200, { 'content-type': CAPTURE_FILES[file[2]], 'cache-control': 'no-store' });
      return fs.createReadStream(p).pipe(res);
    }
    const route = routes[`${req.method} ${u.pathname}`];
    let body;
    let code = 200;
    try {
      if (!route) throw Object.assign(new Error('Not found. See --help for the routes.'), { code: 404 });
      body = await route(u.searchParams);
    } catch (e) {
      code = e.code === 404 ? 404 : 409;
      body = { ok: false, error: e.message };
    }
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body) + '\n');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, '127.0.0.1', resolve);
  });

  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  if (o.serve) {
    console.log(JSON.stringify({ event: 'ready', control: `http://127.0.0.1:${o.port}`, serving: o.out }));
    return;
  }
  if (o.start) await rec.start({ mode: o.mode });
  console.log(JSON.stringify({ event: 'ready', control: `http://127.0.0.1:${o.port}`, cdp: o.cdpPort ? `http://127.0.0.1:${o.cdpPort}` : null, running: o.start ? o.mode : null, url: rec.page.url(), extensionId: rec.extensionId }));
  rec.context.on('close', () => {
    if (!quitting) process.exit(0);
  });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(JSON.stringify({ event: 'error', error: e.message }));
    process.exit(1);
  });
}
