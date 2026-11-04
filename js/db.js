// IndexedDB による端末内保存。データはサーバーに送信しない。
const DB_NAME = 'hakken-note';
const DB_VERSION = 2;
const DISCOVERIES = 'discoveries';
const TRIPS = 'trips'; // おでかけ（行き先ガチャ）の履歴

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DISCOVERIES)) {
        db.createObjectStore(DISCOVERIES, { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains(TRIPS)) {
        db.createObjectStore(TRIPS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    let result;
    reqToPromise(fn(t.objectStore(storeName))).then((r) => (result = r));
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const byDateDesc = (key) => (a, b) => String(b[key] || '').localeCompare(String(a[key] || ''));

// ---- 発見 ----
export async function getAll() {
  const items = await run(DISCOVERIES, 'readonly', (s) => s.getAll());
  return (items || []).sort((a, b) => (b.foundAt || b.createdAt).localeCompare(a.foundAt || a.createdAt));
}
export const get = (id) => run(DISCOVERIES, 'readonly', (s) => s.get(id));
export const put = (item) => run(DISCOVERIES, 'readwrite', (s) => s.put(item));
export const remove = (id) => run(DISCOVERIES, 'readwrite', (s) => s.delete(id));
export const clearAll = () => run(DISCOVERIES, 'readwrite', (s) => s.clear());

// ---- おでかけ履歴 ----
export async function getTrips() {
  const trips = await run(TRIPS, 'readonly', (s) => s.getAll());
  return (trips || []).sort(byDateDesc('decidedAt'));
}
export const putTrip = (trip) => run(TRIPS, 'readwrite', (s) => s.put(trip));
export const removeTrip = (id) => run(TRIPS, 'readwrite', (s) => s.delete(id));
export const clearTrips = () => run(TRIPS, 'readwrite', (s) => s.clear());
