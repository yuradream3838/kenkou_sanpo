// ☁️ ConoHa 同期：記録と写真をサーバ（server/sync.php）に預け、ほかの端末（PC など）で受け取る。
// - 1 件ずつ、変わったものだけ送る。同じ記録が両方で変わっていたら、更新時刻（updatedAt）が新しいほうを残す。
// - 写真は 1 枚ずつ（長い辺 1600px と一覧用 360px。位置情報などは保存時に消してある）。原寸は送らない。
// - サーバは記録を読める形で持つ（AI 用の窓口 ai.php から読むため）。守りは合言葉（書き込み用）と AI 用トークン（読むだけ）。
import * as db from './db.js';
import { getCategory, getFeeling, GROUPS } from './categories.js';

const SETTINGS_KEY = 'sync-settings';
const SALT = 'kenkou_sanpo-sync-v1';
const PBKDF2_ITER = 250000;
const CHECK_MS = 3 * 60 * 1000; // 開いている間、ほかの端末の変更を見に行く間隔
const PUSH_DELAY_MS = 10 * 1000; // 変更してから送るまで待つ時間
const CHUNK = 100;

export const DEFAULT_URL = 'https://nuts024.com/sanpo/sync.php';

// ---------- 設定 ----------
// URL がフォルダで終わっていたら sync.php を足す（"https://…/sanpo/" や "https://…/sanpo" でも動くように）
export function normalizeUrl(u) {
  const text = String(u || '').trim();
  if (!text) return text;
  try {
    const x = new URL(text);
    if (!/\.php$/i.test(x.pathname)) x.pathname = x.pathname.replace(/\/?$/, '/') + 'sync.php';
    x.search = '';
    x.hash = '';
    return x.href;
  } catch {
    return text;
  }
}

export function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {};
    if (s.url) s.url = normalizeUrl(s.url);
    return s;
  } catch {
    return {};
  }
}
export function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* 保存できない環境では同期は使えない */
  }
}
export function isConfigured(s = loadSettings()) {
  return !!(s.url && s.auth);
}
export function defaultDeviceName() {
  return /iPhone|iPad|Android/.test(navigator.userAgent) ? 'スマホ' : 'PC';
}

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

// 合言葉から、サーバに送る値（auth）と、サーバに貼る値（authHash）を作る。合言葉そのものは保存しない。
export async function deriveAuth(passphrase) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(SALT), iterations: PBKDF2_ITER },
    key,
    256
  );
  const auth = toHex(bits);
  return { auth, authHash: await sha256Hex(auth) };
}

// AI 用（読み取り専用）トークン
export async function newReadToken() {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  return { readToken: token, readHash: await sha256Hex(token) };
}
export function aiUrl(s = loadSettings()) {
  if (!s.url || !s.readToken) return '';
  return s.url.replace(/sync\.php(\?.*)?$/, 'ai.php') + '?t=' + s.readToken;
}

// ---------- 状態 ----------
let status = { running: false, lastSyncAt: null, error: null, pending: 0 };
const statusListeners = new Set();
export function onStatus(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}
function setStatus(patch) {
  status = { ...status, ...patch };
  const s = loadSettings();
  saveSettings({ ...s, lastSyncAt: status.lastSyncAt, lastError: status.error });
  statusListeners.forEach((fn) => fn(status));
}
export function getStatus() {
  const s = loadSettings();
  return { ...status, lastSyncAt: status.lastSyncAt || s.lastSyncAt || null, error: status.error ?? s.lastError ?? null };
}

// ---------- 送っていない変更（IndexedDB の meta に保存） ----------
let pendingChain = Promise.resolve();
function withPending(fn) {
  // 読んで書く処理が重ならないよう、順番に実行する
  pendingChain = pendingChain.then(async () => {
    const p = (await db.metaGet('pending')) || {};
    const r = await fn(p);
    await db.metaSet('pending', p);
    status.pending = Object.keys(p).length;
    return r;
  });
  return pendingChain;
}
export async function pendingCount() {
  return Object.keys((await db.metaGet('pending')) || {}).length;
}

// 全部を「送っていない変更」にする（初めて同期を設定したとき）
export async function markAllPending() {
  const [items, trips] = await Promise.all([db.getAll(), db.getTrips()]);
  const now = new Date().toISOString();
  await withPending((p) => {
    for (const it of items) p['d:' + it.id] = it.updatedAt || now;
    for (const t of trips) p['t:' + t.id] = t.updatedAt || now;
  });
}

// ---------- サーバとのやりとり ----------
// JSON を gzip で圧縮する（ConoHa の WAF が文章の中身で通信を止めないように）。使えないブラウザでは圧縮しない。
async function gzipJson(obj) {
  const text = JSON.stringify(obj);
  if (typeof CompressionStream === 'undefined') return { body: text, type: 'application/json' };
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return { body: await new Response(stream).blob(), type: 'application/octet-stream' };
}

async function api(a, { params = {}, method = 'GET', json, body, blob = false } = {}) {
  const s = loadSettings();
  const url = new URL(s.url);
  url.searchParams.set('a', a);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers = { 'X-Sync-Auth': s.auth, 'X-Device': encodeURIComponent(s.device || defaultDeviceName()) };
  if (json) {
    const packed = await gzipJson(json);
    body = packed.body;
    headers['Content-Type'] = packed.type;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  let res;
  try {
    res = await fetch(url, { method, headers, body, signal: ctrl.signal, cache: 'no-store' });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('サーバの応答がありません（時間切れ）');
    throw new Error(await diagnose(s.url));
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let code = '';
    let detail = '';
    try {
      const j = await res.json();
      code = j.error || '';
      detail = j.message || '';
    } catch {
      /* noop */
    }
    const msg = {
      auth: '合言葉が違います（config.php の SANPO_AUTH_HASH に「サーバに貼る値」が貼ってあるか確認）',
      origin: 'このサイトからの接続がサーバで許可されていません（config.php の SANPO_ALLOWED_ORIGINS を確認）',
      config: 'サーバに config.php がありません（config.php.example を config.php という名前でコピーして、sync.php と同じフォルダに置く）',
      config_syntax: 'サーバの config.php に書き間違いがあります（貼った値を \' \' で囲んでいるか、行の最後の ; があるか確認）',
      php: `サーバの PHP でエラーが出ています：${detail}`,
      too_large: '大きすぎて送れませんでした',
      gzip: 'サーバで圧縮したデータを読めませんでした（サーバの PHP に zlib が必要）',
      format: 'サーバが送ったデータを読めませんでした（サーバの sync.php を最新の版に置き直してください）',
    }[code];
    throw new Error(msg || `サーバのエラー（${res.status}${code ? ' ' + code : ''}）`);
  }
  return blob ? res.blob() : res.json();
}

export async function testConnection() {
  return api('meta');
}

// つながらないときの調べ（結果を文字でまとめる。合言葉の値は出さない）
export async function diagnoseDetail() {
  const s = loadSettings();
  const lines = [];
  const add = (k, v) => lines.push(`${k}: ${v}`);
  add('アプリ', location.href.split('#')[0]);
  add('ブラウザ', navigator.userAgent);
  add('オンライン', navigator.onLine ? 'はい' : 'いいえ');
  add('保存されたURL', JSON.stringify(s.url || ''));
  if (!s.url) return lines.join('\n');
  const url = new URL(s.url);
  url.searchParams.set('a', 'meta');
  const step = async (label, fn) => {
    try {
      const r = await fn();
      let body = '';
      try {
        body = r.type === 'opaque' ? '(中身は読めない形)' : (await r.text()).slice(0, 120);
      } catch (e) {
        body = '(読めない: ' + e.message + ')';
      }
      add(label, `${r.type} ${r.status} ${body}`);
    } catch (e) {
      add(label, `失敗 ${e.name}: ${e.message}`);
    }
  };
  await step('1 届くか(no-cors)', () => fetch(url, { mode: 'no-cors', cache: 'no-store' }));
  await step('2 読めるか(ヘッダなし)', () => fetch(url, { cache: 'no-store' }));
  await step('3 本番と同じ(ヘッダつき)', () =>
    fetch(url, { cache: 'no-store', headers: { 'X-Sync-Auth': s.auth || '0'.repeat(64), 'X-Device': encodeURIComponent(s.device || '') } })
  );
  const post = new URL(s.url);
  post.searchParams.set('a', 'pmissing');
  const packed = await gzipJson({ ids: [] });
  await step('4 送れるか(POST・圧縮)', () =>
    fetch(post, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'X-Sync-Auth': s.auth || '0'.repeat(64), 'X-Device': encodeURIComponent(s.device || ''), 'Content-Type': packed.type },
      body: packed.body,
    })
  );
  return lines.join('\n');
}

// つながらなかった理由をできるだけ見分ける
async function diagnose(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return 'サーバの URL の書き方が正しくありません';
  }
  if (location.protocol === 'https:' && u.protocol !== 'https:') {
    return 'サーバの URL を https:// で始めてください（http:// だとブラウザが接続を止めます）';
  }
  if (!navigator.onLine) return '電波がありません（オフライン）';
  // 中身は読めなくても、サーバまで届くかだけを確かめる
  try {
    await fetch(u.href, { mode: 'no-cors', cache: 'no-store' });
    return 'サーバには届いていますが、返事を読めませんでした。sync.php が古い（置き直す）、URL のフォルダ名の違い、ConoHa の WAF に止められた、などが考えられます。「🔍 つながらない原因を調べる」の結果を確かめてください';
  } catch {
    return 'サーバにつながりません。URL のドメイン・フォルダ名と電波を確認してください';
  }
}

// ---------- 記録の形をそろえる ----------
const isIso = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(v);
const DISCOVERY_FIELDS = ['id', 'title', 'category', 'foundAt', 'location', 'noticed', 'hypothesis', 'findings', 'sources',
  'confidence', 'feelings', 'tripId', 'createdAt', 'updatedAt', 'hideFromAi'];

function photosOf(it) {
  if (Array.isArray(it.photos) && it.photos.length) return it.photos;
  return it.photo ? [{ id: 'p0', photo: it.photo, thumb: it.thumb || it.photo }] : [];
}
const newPhotoId = () => (crypto.randomUUID ? crypto.randomUUID() : 'ph-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

// 写真の ID がほかの記録とぶつからないようにする（以前の形式の 'p0' などを付け直す）
async function normalizePhotos(it) {
  const ps = photosOf(it);
  let changedIds = !Array.isArray(it.photos) && ps.length > 0;
  const fixed = ps.map((ph) => {
    if (ph.id && /^[0-9A-Za-z_-]{8,64}$/.test(ph.id)) return ph;
    changedIds = true;
    return { ...ph, id: newPhotoId() };
  });
  if (!changedIds) return it;
  const next = { ...it, photos: fixed, photo: fixed[0]?.photo || null, thumb: fixed[0]?.thumb || null };
  await db.put(next, { fromSync: true });
  return next;
}

function confidenceLabel(v) {
  return { guess: '推測', likely: 'ほぼ確実', sourced: '出典あり' }[v] || '';
}

function discoveryToServer(it) {
  const data = {};
  for (const k of DISCOVERY_FIELDS) if (it[k] !== undefined) data[k] = it[k];
  data.photos = photosOf(it).map((p) => p.id);
  const c = getCategory(it.category);
  data.labels = {
    category: c.name,
    group: GROUPS.find((g) => g.id === c.group)?.name || '',
    feelings: (it.feelings || []).map(getFeeling).filter(Boolean).map((f) => f.name),
    confidence: confidenceLabel(it.confidence),
  };
  return data;
}

function tripToServer(t) {
  const data = { ...t };
  data.labels = { goal: t.goal ? getCategory(t.goal).name : '' };
  return data;
}

// サーバは JPEG だけを受け取るので、それ以外（読み込んだ PNG など）は JPEG にしてから送る
async function toJpeg(blob) {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (head[0] === 0xff && head[1] === 0xd8) return blob;
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // 透明な部分は白にする
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('写真を変換できませんでした'))), 'image/jpeg', 0.85)
  );
}

// ---------- 送る ----------
async function push() {
  const snapshot = { ...((await db.metaGet('pending')) || {}) };
  const keys = Object.keys(snapshot);
  if (!keys.length) return 0;

  const records = [];
  const photoBlobs = new Map(); // 写真ID → {photo, thumb}
  const trips = await db.getTrips();
  for (const key of keys) {
    const i = key.indexOf(':');
    const kind = key.slice(0, i);
    const id = key.slice(i + 1);
    const at = isIso(snapshot[key]) ? snapshot[key] : new Date().toISOString();
    if (kind === 'd') {
      let it = await db.get(id);
      if (!it) {
        records.push({ kind, id, updatedAt: at, deleted: true });
        continue;
      }
      it = await normalizePhotos(it);
      for (const p of photosOf(it)) photoBlobs.set(p.id, p);
      records.push({ kind, id, updatedAt: isIso(it.updatedAt) ? it.updatedAt : at, data: discoveryToServer(it) });
    } else if (kind === 't') {
      const t = trips.find((x) => x.id === id);
      if (!t) records.push({ kind, id, updatedAt: at, deleted: true });
      else records.push({ kind, id, updatedAt: isIso(t.updatedAt) ? t.updatedAt : at, data: tripToServer(t) });
    }
  }

  // 写真を先に送る（記録だけ届いて写真が無い、という状態を作らない）
  if (photoBlobs.size) {
    const { missing } = await api('pmissing', { method: 'POST', json: { ids: [...photoBlobs.keys()] } });
    for (const id of missing) {
      const p = photoBlobs.get(id);
      if (!p?.photo) continue;
      await api('pput', { method: 'POST', params: { id, size: 'photo' }, body: await toJpeg(p.photo) });
      await api('pput', { method: 'POST', params: { id, size: 'thumb' }, body: await toJpeg(p.thumb || p.photo) });
    }
  }

  const done = new Set();
  const rejected = [];
  for (let i = 0; i < records.length; i += CHUNK) {
    const res = await api('put', { method: 'POST', json: { items: records.slice(i, i + CHUNK) } });
    res.accepted.forEach((k) => done.add(k));
    rejected.push(...res.rejected);
  }
  // サーバのほうが新しかったものは、サーバの内容をこの端末に入れる
  for (const rec of rejected) {
    await applyRemote(rec);
    done.add(rec.kind + ':' + rec.id);
  }
  // 送っている間にまた変わったものは残す
  await withPending((p) => {
    for (const k of done) if (p[k] === snapshot[k]) delete p[k];
  });
  return done.size;
}

// ---------- 受け取る ----------
async function fetchPhoto(id, size) {
  return api('photo', { params: { id, size }, blob: true });
}

async function applyRemote(rec) {
  if (rec.kind === 'd') {
    if (rec.deleted) return db.remove(rec.id, { fromSync: true });
    const d = rec.data || {};
    const local = await db.get(rec.id);
    const have = new Map(local ? photosOf(local).map((p) => [p.id, p]) : []);
    const photos = [];
    for (const pid of d.photos || []) {
      if (have.has(pid)) photos.push(have.get(pid));
      else photos.push({ id: pid, photo: await fetchPhoto(pid, 'photo'), thumb: await fetchPhoto(pid, 'thumb') });
    }
    const item = {};
    for (const k of DISCOVERY_FIELDS) if (d[k] !== undefined) item[k] = d[k];
    item.id = rec.id;
    item.updatedAt = rec.updatedAt;
    item.photos = photos;
    item.photo = photos[0]?.photo || null;
    item.thumb = photos[0]?.thumb || null;
    return db.put(item, { fromSync: true });
  }
  if (rec.kind === 't') {
    if (rec.deleted) return db.removeTrip(rec.id, { fromSync: true });
    const t = { ...(rec.data || {}) };
    delete t.labels;
    t.id = rec.id;
    t.updatedAt = rec.updatedAt;
    return db.putTrip(t, { fromSync: true });
  }
}

async function pull() {
  const since = (await db.metaGet('lastRev')) || 0;
  const res = await api('changes', { params: { since } });
  const pending = (await db.metaGet('pending')) || {};
  let applied = 0;
  for (const rec of res.items) {
    const key = rec.kind + ':' + rec.id;
    // この端末で後から変えたもの（まだ送っていない）は、こちらを残す（次に送る）
    if (pending[key] && String(pending[key]) > String(rec.updatedAt)) continue;
    await applyRemote(rec);
    applied++;
    if (pending[key]) await withPending((p) => { if (p[key] === pending[key]) delete p[key]; });
  }
  await db.metaSet('lastRev', res.rev);
  return applied;
}

// ---------- まとめて同期 ----------
let running = null;
let again = false;
export async function syncNow() {
  if (!isConfigured()) return null;
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    setStatus({ running: true });
    try {
      const sent = await push();
      const got = await pull();
      setStatus({ running: false, error: null, lastSyncAt: new Date().toISOString(), pending: await pendingCount() });
      if (got) window.dispatchEvent(new CustomEvent('sync:applied', { detail: { count: got } }));
      return { sent, got };
    } catch (e) {
      setStatus({ running: false, error: e.message, pending: await pendingCount() });
      throw e;
    } finally {
      running = null;
      if (again) {
        again = false;
        setTimeout(() => syncNow().catch(() => {}), 500);
      }
    }
  })();
  return running;
}

// ---------- 自動 ----------
let pushTimer = null;
let started = false;
export function initSync() {
  db.setChangeListener((kind, id, at) => {
    if (!isConfigured()) return;
    withPending((p) => {
      p[kind + ':' + id] = at;
    }).then(() => {
      setStatus({});
      const s = loadSettings();
      if (!s.on) return;
      clearTimeout(pushTimer);
      pushTimer = setTimeout(() => syncNow().catch(() => {}), PUSH_DELAY_MS);
    });
  });
  if (started) return;
  started = true;
  const auto = () => {
    const s = loadSettings();
    if (isConfigured(s) && s.on && document.visibilityState === 'visible') syncNow().catch(() => {});
  };
  setTimeout(auto, 1500);
  document.addEventListener('visibilitychange', () => {
    const s = loadSettings();
    if (!isConfigured(s) || !s.on) return;
    if (document.visibilityState === 'visible') syncNow().catch(() => {});
    else if (status.pending) syncNow().catch(() => {}); // 閉じるとき、送っていない変更があれば送る
  });
  setInterval(auto, CHECK_MS);
}
