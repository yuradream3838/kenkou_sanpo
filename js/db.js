// IndexedDB による端末内保存。データはサーバーに送信しない。
const DB_NAME = 'hakken-note';
const DB_VERSION = 1;
const STORE = 'discoveries';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        let result;
        Promise.resolve(fn(store)).then((r) => (result = r));
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAll() {
  const items = await tx('readonly', (s) => reqToPromise(s.getAll()));
  return (items || []).sort((a, b) => (b.foundAt || b.createdAt).localeCompare(a.foundAt || a.createdAt));
}

export function get(id) {
  return tx('readonly', (s) => reqToPromise(s.get(id)));
}

export function put(item) {
  return tx('readwrite', (s) => reqToPromise(s.put(item)));
}

export function remove(id) {
  return tx('readwrite', (s) => reqToPromise(s.delete(id)));
}

export function clearAll() {
  return tx('readwrite', (s) => reqToPromise(s.clear()));
}
