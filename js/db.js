// IndexedDB による端末内保存。
// ☁️ 同期を設定していれば、変更は js/sync.js がサーバ（ConoHa）へ送る。
const DB_NAME = 'hakken-note';
const DB_VERSION = 3;
const DISCOVERIES = 'discoveries';
const TRIPS = 'trips'; // おでかけ（行き先ガチャ）の履歴
const META = 'meta'; // 同期の控え（送っていない変更・最後に受け取った番号など）

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
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META);
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

// ---- 変更の知らせ（同期用） ----
// この端末で記録を変えたとき（サーバから受け取った反映は除く）に呼ばれる：fn(kind, id, at)
// kind は 'd'（発見）／'t'（おでかけ）
let changeListener = null;
export function setChangeListener(fn) {
  changeListener = fn;
}
function changed(kind, id, at, opts) {
  if (!opts?.fromSync && changeListener) {
    try {
      changeListener(kind, id, at);
    } catch (e) {
      console.warn(e);
    }
  }
}
const stamp = (rec, opts) => (opts?.fromSync ? rec : { ...rec, updatedAt: new Date().toISOString() });

// ---- 発見 ----
export async function getAll() {
  const items = await run(DISCOVERIES, 'readonly', (s) => s.getAll());
  return (items || []).sort((a, b) => (b.foundAt || b.createdAt).localeCompare(a.foundAt || a.createdAt));
}
export const get = (id) => run(DISCOVERIES, 'readonly', (s) => s.get(id));
export async function put(item, opts) {
  const rec = stamp(item, opts);
  await run(DISCOVERIES, 'readwrite', (s) => s.put(rec));
  changed('d', rec.id, rec.updatedAt, opts);
  return rec;
}
export async function remove(id, opts) {
  await run(DISCOVERIES, 'readwrite', (s) => s.delete(id));
  changed('d', id, new Date().toISOString(), opts);
}
// この端末だけを空にする（サーバには伝えない）
export const clearAll = () => run(DISCOVERIES, 'readwrite', (s) => s.clear());

// ---- おでかけ履歴 ----
export async function getTrips() {
  const trips = await run(TRIPS, 'readonly', (s) => s.getAll());
  return (trips || []).sort(byDateDesc('decidedAt'));
}
export async function putTrip(trip, opts) {
  const rec = stamp(trip, opts);
  await run(TRIPS, 'readwrite', (s) => s.put(rec));
  changed('t', rec.id, rec.updatedAt, opts);
  return rec;
}
export async function removeTrip(id, opts) {
  await run(TRIPS, 'readwrite', (s) => s.delete(id));
  changed('t', id, new Date().toISOString(), opts);
}
export const clearTrips = () => run(TRIPS, 'readwrite', (s) => s.clear());

// ---- 同期の控え ----
export const metaGet = (key) => run(META, 'readonly', (s) => s.get(key));
export const metaSet = (key, value) => run(META, 'readwrite', (s) => s.put(value, key));
