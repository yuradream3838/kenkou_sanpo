// アプリ本体をキャッシュしてオフラインでも記録できるようにする。
// 地図タイルは国土地理院のサーバーから都度取得する（キャッシュしない）。
const VERSION = 'hakken-note-v0.14.4';
const SHELL = [
  './',
  './index.html',
  './privacy.html',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/categories.js',
  './js/progress.js',
  './js/image.js',
  './js/exif.js',
  './js/map.js',
  './js/stations.js',
  './js/go.js',
  './js/trip.js',
  './js/sync.js',
  './js/sync-ui.js',
  './js/changelog.js',
  './data/stations/14.json',
  './manifest.webmanifest',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
  './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/layers-2x.png',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 地図タイル等はブラウザに任せる

  // ネットワーク優先（更新をすぐ反映）、オフライン時はキャッシュ。
  // cache: 'no-cache' でブラウザの HTTP キャッシュ（GitHub Pages は最大10分）を使わず、
  // 毎回サーバーに更新の有無を確認する（変更がなければ 304 で軽い）。
  event.respondWith(
    fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined))
      )
  );
});
