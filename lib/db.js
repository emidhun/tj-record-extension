// Finished recordings ("drafts") wait here until the TJ Record upload page takes them.
// Shared by the service worker, the offscreen recorder and the popup (all on the extension origin).
const DB_NAME = 'tj-record';
const STORE = 'drafts';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const putDraft = (draft) => run('readwrite', (s) => s.put(draft));
export const getDraft = (id) => run('readonly', (s) => s.get(id));
export const deleteDraft = (id) => run('readwrite', (s) => s.delete(id));
export const listDrafts = async () => {
  const all = (await run('readonly', (s) => s.getAll())) || [];
  return all.sort((a, b) => b.createdAt - a.createdAt);
};
