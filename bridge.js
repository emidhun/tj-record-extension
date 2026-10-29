// Runs on the TJ Record app's origin. The Upload page (a ToolJet custom component, same-origin
// iframe) posts { tjr: 'draft:get', id } to the top window; this script fetches the draft from
// the extension and posts it back with the video and thumbnail as Blobs.
(() => {
  if (window.__tjrBridge) return;
  window.__tjrBridge = true;

  const VERSION = chrome.runtime.getManifest().version;

  // Only pages of the configured TJ Record app (same origin + /applications/<id>/…) may read drafts.
  const allowed = async () => {
    try {
      const { appUrl } = await chrome.storage.local.get('appUrl');
      if (!appUrl) return false;
      const u = new URL(appUrl);
      return (location.origin + location.pathname).startsWith(u.origin + u.pathname.replace(/\/+$/, '') + '/');
    } catch (e) {
      return false;
    }
  };

  const bytes = (b64) => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  };

  const fetchDraft = (id) =>
    new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'draft' });
      const parts = { video: [], thumb: [] };
      let head = null;
      let finished = false;
      const finish = (fn, value) => {
        if (finished) return;
        finished = true;
        try {
          port.disconnect();
        } catch (e) {
          /* already closed */
        }
        fn(value);
      };
      port.onMessage.addListener((msg) => {
        if (msg.error) return finish(msg.error === 'not_found' ? resolve : reject, msg.error === 'not_found' ? null : new Error(msg.error));
        if (msg.head) head = msg.head;
        if (msg.chunk) parts[msg.chunk.part].push(bytes(msg.chunk.data));
        if (msg.done) {
          const draft = head;
          draft.video = draft.videoType ? new Blob(parts.video, { type: draft.videoType }) : null;
          draft.thumb = draft.thumbType ? new Blob(parts.thumb, { type: draft.thumbType }) : null;
          finish(resolve, draft);
        }
        return undefined;
      });
      port.onDisconnect.addListener(() => finish(reject, new Error('The TJ Record extension stopped responding.')));
      port.postMessage({ id });
    });

  window.addEventListener('message', async (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object' || typeof m.tjr !== 'string' || /:reply$/.test(m.tjr)) return;
    if (e.origin !== location.origin || !e.source) return;
    const reply = (data) => {
      try {
        e.source.postMessage(Object.assign({ tjr: m.tjr + ':reply', rid: m.rid }, data), e.origin);
      } catch (err) {
        /* frame went away */
      }
    };
    if (!(await allowed())) return;
    try {
      if (m.tjr === 'hello') reply({ ok: true, version: VERSION });
      else if (m.tjr === 'draft:get') {
        const draft = await fetchDraft(String(m.id || ''));
        reply(draft ? { ok: true, draft } : { ok: false, error: 'not_found' });
      } else if (m.tjr === 'draft:done' || m.tjr === 'draft:discard') {
        await chrome.runtime.sendMessage({ type: 'draft:delete', id: String(m.id || '') });
        reply({ ok: true });
      }
    } catch (err) {
      reply({ ok: false, error: String((err && err.message) || err) });
    }
  });
})();
