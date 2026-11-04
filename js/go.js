// おでかけ：散策のスタート駅をランダムに決める。
import * as db from './db.js';
import { CATEGORIES } from './categories.js';
import { loadStations, candidates, pickRandom, distanceKm } from './stations.js';
import { createMap, categoryMarker } from './map.js';

/* global L */

const SETTINGS_KEY = 'go-settings';
const DEFAULTS = { mode: 'near', baseType: 'current', baseStation: '', minKm: 2, maxKm: 10, excludeVisited: true };
const MIN_OPTIONS = [0, 1, 2, 3, 5, 10, 20];
const MAX_OPTIONS = [2, 3, 5, 10, 15, 20, 30, 50];
const NEARBY_KM = 1.5; // 「駅の周りの発見」とみなす距離

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* 保存できなくても動作は続ける */
  }
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : 'trip-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('この端末では位置情報を使えません'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) =>
        reject(new Error(err.code === 1 ? '位置情報の利用が許可されていません。「駅を指定」を使ってください' : '現在地を取得できませんでした')),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 120000 }
    );
  });
}

function formatDay(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {Object} ctx  app.js から受け取る共通機能
 *   main, esc, toast, addMap(map), updateHeader()
 */
export async function renderGo({ main, esc, toast, addMap, updateHeader }) {
  await updateHeader();
  const data = await loadStations('14');
  const stations = data.stations;
  const byName = new Map(stations.map((s) => [s.n, s]));
  const settings = loadSettings();
  let lastResult = null;
  let resultMap = null;

  main.innerHTML = `
    <h2>おでかけ</h2>
    <p class="muted small">${esc(data.prefName)}の ${stations.length} 駅から、散策のスタート地点をランダムに決めます。</p>

    <form class="card go-form" id="go-form">
      <fieldset class="segmented">
        <legend>選び方</legend>
        <label><input type="radio" name="mode" value="near" ${settings.mode === 'near' ? 'checked' : ''}><span>距離で選ぶ</span></label>
        <label><input type="radio" name="mode" value="pref" ${settings.mode === 'pref' ? 'checked' : ''}><span>県内どこでも</span></label>
      </fieldset>

      <div id="near-options">
        <fieldset class="inline-radios">
          <legend>どこから？</legend>
          <label><input type="radio" name="baseType" value="current" ${settings.baseType === 'current' ? 'checked' : ''}> 現在地</label>
          <label><input type="radio" name="baseType" value="station" ${settings.baseType === 'station' ? 'checked' : ''}> 駅を指定</label>
        </fieldset>
        <label id="base-station-wrap">基準の駅
          <input name="baseStation" list="station-list" value="${esc(settings.baseStation)}" placeholder="例：横浜" autocomplete="off">
        </label>
        <datalist id="station-list">${stations.map((s) => `<option value="${esc(s.n)}">`).join('')}</datalist>
        <div class="range-row">
          <label>最短
            <select name="minKm">${MIN_OPTIONS.map((v) => `<option value="${v}" ${v === settings.minKm ? 'selected' : ''}>${v} km</option>`).join('')}</select>
          </label>
          <span>〜</span>
          <label>最長
            <select name="maxKm">${MAX_OPTIONS.map((v) => `<option value="${v}" ${v === settings.maxKm ? 'selected' : ''}>${v} km</option>`).join('')}</select>
          </label>
        </div>
        <p class="muted small">距離は直線距離です。最短を設定すると、近すぎる駅（いつもの駅）を除けます。</p>
      </div>

      <label class="check"><input type="checkbox" name="excludeVisited" ${settings.excludeVisited ? 'checked' : ''}> 行ったことのある駅を除く</label>

      <button type="submit" class="btn primary big" id="draw">🎲 行き先を決める</button>
    </form>

    <div id="go-result" aria-live="polite"></div>

    <section class="card">
      <h3>駅コレクション</h3>
      <p id="collection"></p>
      <div class="progress"><span id="collection-bar"></span></div>
      <ul class="trips" id="trips"></ul>
    </section>

    <p class="muted small">駅データ：${esc(data.source)}（<a href="${esc(data.sourceUrl)}" target="_blank" rel="noopener">出典</a>）</p>`;

  const form = document.getElementById('go-form');
  const resultEl = document.getElementById('go-result');

  function readForm() {
    const fd = new FormData(form);
    return {
      mode: fd.get('mode') || 'near',
      baseType: fd.get('baseType') || 'current',
      baseStation: String(fd.get('baseStation') || '').trim().replace(/駅$/, ''),
      minKm: Number(fd.get('minKm')),
      maxKm: Number(fd.get('maxKm')),
      excludeVisited: fd.get('excludeVisited') === 'on',
    };
  }

  function syncVisibility() {
    const s = readForm();
    document.getElementById('near-options').hidden = s.mode !== 'near';
    document.getElementById('base-station-wrap').hidden = s.baseType !== 'station';
  }
  form.addEventListener('change', () => {
    syncVisibility();
    saveSettings(readForm());
  });
  syncVisibility();

  // ---- 履歴・コレクション ----
  async function renderTrips() {
    const trips = await db.getTrips();
    const visited = new Set(trips.filter((t) => t.visitedAt).map((t) => t.name));
    const n = [...visited].filter((name) => byName.has(name)).length;
    document.getElementById('collection').innerHTML = `行った駅 <b>${n}</b> / ${stations.length}（${((n / stations.length) * 100).toFixed(1)}%）`;
    document.getElementById('collection-bar').style.width = `${(n / stations.length) * 100}%`;
    const list = document.getElementById('trips');
    list.innerHTML = trips.length
      ? trips
          .slice(0, 50)
          .map(
            (t) => `
        <li data-id="${esc(t.id)}">
          <span class="trip-name">${esc(t.name)}駅</span>
          <span class="muted small">${t.visitedAt ? `✔ ${formatDay(t.visitedAt)} に行った` : `${formatDay(t.decidedAt)} に決定`}</span>
          <span class="trip-actions">
            ${t.visitedAt
              ? `<button type="button" class="btn ghost small" data-act="unvisit">取り消し</button>`
              : `<button type="button" class="btn small" data-act="visit">行った！</button>`}
            <button type="button" class="btn ghost small" data-act="delete" aria-label="${esc(t.name)}駅を履歴から削除">✕</button>
          </span>
        </li>`
          )
          .join('')
      : '<li class="muted small">まだ履歴はありません。行き先を決めて「ここに行く！」を押すと記録されます。</li>';
    return { trips, visited };
  }

  document.getElementById('trips').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('li').dataset.id;
    const trips = await db.getTrips();
    const trip = trips.find((t) => t.id === id);
    if (!trip) return;
    if (btn.dataset.act === 'visit') {
      await db.putTrip({ ...trip, visitedAt: new Date().toISOString() });
      toast(`${trip.name}駅をコレクションに追加しました`);
    } else if (btn.dataset.act === 'unvisit') {
      await db.putTrip({ ...trip, visitedAt: null });
    } else if (btn.dataset.act === 'delete') {
      if (!confirm(`${trip.name}駅を履歴から削除しますか？`)) return;
      await db.removeTrip(trip.id);
    }
    ({ visited } = await renderTrips());
  });

  let { visited } = await renderTrips();

  // ---- 抽選 ----
  async function pickTheme() {
    const items = await db.getAll();
    const found = new Set(items.map((i) => i.category));
    const notYet = CATEGORIES.filter((c) => c.id !== 'sonota' && !found.has(c.id));
    const pool = notYet.length ? notYet : CATEGORIES.filter((c) => c.id !== 'sonota');
    return { theme: pool[Math.floor(Math.random() * pool.length)], items, isNew: notYet.length > 0 };
  }

  async function draw() {
    const s = readForm();
    saveSettings(s);
    let base = null;
    let baseLabel = '';
    if (s.mode === 'near') {
      if (s.minKm >= s.maxKm) return toast('最短の距離は最長より短くしてください');
      if (s.baseType === 'station') {
        const st = byName.get(s.baseStation);
        if (!st) return toast('基準の駅が見つかりません。候補から選んでください');
        base = { lat: st.lat, lng: st.lng };
        baseLabel = `${st.n}駅から`;
      } else {
        resultEl.innerHTML = '<p class="muted center">現在地を確認しています…</p>';
        try {
          base = await getPosition();
        } catch (err) {
          resultEl.innerHTML = '';
          return toast(err.message, 4000);
        }
        baseLabel = '現在地から';
      }
    }

    const exclude = s.excludeVisited ? new Set(visited) : new Set();
    if (s.mode === 'near' && s.baseType === 'station') exclude.add(s.baseStation);
    const list = candidates(stations, s.mode === 'near' ? { base, minKm: s.minKm, maxKm: s.maxKm, exclude } : { exclude });

    if (!list.length) {
      resultEl.innerHTML = `<div class="card"><p>条件に合う駅がありません。</p>
        <p class="muted small">${s.mode === 'near' ? '距離の範囲を広げるか、' : ''}「行ったことのある駅を除く」を外してみてください。${
          s.mode === 'near' && s.baseType === 'current' ? '（神奈川県の駅から選んでいます。県外にいる場合は「駅を指定」が便利です）' : ''
        }</p></div>`;
      return;
    }

    const choice = pickRandom(list, lastResult?.n);
    lastResult = choice;
    await showResult(choice, { count: list.length, baseLabel, base });
  }

  async function showResult(st, { count, baseLabel, base }) {
    if (resultMap) {
      resultMap.remove();
      resultMap = null;
    }
    const drawBtn = document.getElementById('draw');
    drawBtn.disabled = true;

    resultEl.innerHTML = `<div class="card go-result"><p class="station-name rolling" id="rolling"></p></div>`;
    const rolling = document.getElementById('rolling');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduce) {
      for (let i = 0; i < 14; i++) {
        rolling.textContent = stations[Math.floor(Math.random() * stations.length)].n;
        await sleep(40 + i * 6);
      }
    }

    const { theme, items, isNew } = await pickTheme();
    const nearby = items.filter((it) => it.location && distanceKm(it.location, st) <= NEARBY_KM).length;
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${st.n}駅 神奈川県`)}`;

    resultEl.innerHTML = `
      <div class="card go-result">
        <p class="muted small">候補 ${count} 駅から選びました</p>
        <p class="station-name">${esc(st.n)}<small>駅</small></p>
        <ul class="lines">${st.l.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
        ${st.km !== null ? `<p>${esc(baseLabel)} 直線で約 <b>${st.km.toFixed(1)} km</b></p>` : ''}
        <p class="hint">今日のお題：駅の周りで<b>「${theme.icon} ${esc(theme.name)}」</b>を探してみよう${isNew ? '（図鑑に未登録！）' : ''}<br><span class="small">${esc(theme.hint)}</span></p>
        <div class="minimap" id="go-map"></div>
        <p class="muted small">${nearby ? `この駅の周り（${NEARBY_KM}km）には、あなたの発見が ${nearby} 件あります。` : 'この駅の周りでの発見はまだありません。'}</p>
        <div class="row go-actions">
          <button type="button" class="btn primary" id="go-commit">ここに行く！</button>
          <button type="button" class="btn" id="go-again">🎲 もう一回</button>
          <a class="btn ghost" href="${mapsUrl}" target="_blank" rel="noopener noreferrer">地図アプリで見る</a>
        </div>
      </div>`;
    drawBtn.disabled = false;

    resultMap = createMap(document.getElementById('go-map'), { center: [st.lat, st.lng], zoom: 14 });
    addMap(resultMap);
    categoryMarker([st.lat, st.lng], '#2f6f4f').bindTooltip(`${st.n}駅`, { permanent: true, direction: 'top', offset: [0, -8] }).addTo(resultMap);
    L.circle([st.lat, st.lng], { radius: NEARBY_KM * 1000, color: '#2f6f4f', weight: 1, fillOpacity: 0.05 }).addTo(resultMap);
    if (base) {
      L.circleMarker([base.lat, base.lng], { radius: 6, color: '#1e88e5', fillColor: '#1e88e5', fillOpacity: 1 }).addTo(resultMap);
      resultMap.fitBounds([[base.lat, base.lng], [st.lat, st.lng]], { padding: [30, 30], maxZoom: 14 });
    }
    setTimeout(() => resultMap && resultMap.invalidateSize(), 50);

    document.getElementById('go-again').addEventListener('click', draw);
    const commit = document.getElementById('go-commit');
    commit.addEventListener('click', async () => {
      commit.disabled = true;
      await db.putTrip({
        id: newId(),
        name: st.n,
        lat: st.lat,
        lng: st.lng,
        lines: st.l,
        theme: theme.id,
        decidedAt: new Date().toISOString(),
        visitedAt: null,
      });
      commit.textContent = '✔ 履歴に追加しました';
      toast(`${st.n}駅へ！ 着いたら履歴の「行った！」を押してください`, 4000);
      ({ visited } = await renderTrips());
    });
    resultEl.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    draw();
  });
}
