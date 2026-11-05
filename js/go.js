// おでかけ：散策のスタート駅をランダムに決める。
import * as db from './db.js';
import { CATEGORIES, GROUPS, getCategory, categoriesInGroup } from './categories.js';
import { STATUS_LABEL, isActive, isIOS, directionsUrls, formatTime, formatDuration, walkStart, walkDuration, tripNotes, timeline } from './trip.js';
import { loadStations, candidates, pickRandom, distanceKm, nearestStation, lineGroups } from './stations.js';
import { createMap, categoryMarker } from './map.js';

/* global L */

const SETTINGS_KEY = 'go-settings';
const DEFAULTS = { mode: 'near', baseType: 'current', baseStation: '', minKm: 2, maxKm: 10, excludeVisited: true, cooldown: 5, lines: [], noTransfer: false };
const RECENT_KEY = 'go-recent'; // 抽選で出た駅名（新しい順）
const COOLDOWN_OPTIONS = [0, 1, 3, 5, 10, 20, 30, 50];
const RECENT_MAX = 50;
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

function loadRecent() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function pushRecent(name) {
  const list = [name, ...loadRecent()].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* 保存できなくても動作は続ける */
  }
}

function clearRecent() {
  try {
    localStorage.removeItem(RECENT_KEY);
  } catch {
    /* noop */
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
  const groups = lineGroups(stations);
  const allLines = new Set(groups.flatMap((g) => g.lines.map((l) => l.label)));
  settings.lines = (Array.isArray(settings.lines) ? settings.lines : []).filter((l) => allLines.has(l));
  let resultMap = null;

  main.innerHTML = `
    <h2>おでかけ</h2>
    <div id="active-trip"></div>
    <h3 class="go-form-title" id="go-form-title">🎲 行き先を決める</h3>
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
        <label class="check"><input type="checkbox" name="noTransfer" ${settings.noTransfer ? 'checked' : ''}> 乗り換えなしで行ける駅だけ（基準の駅と同じ路線）</label>
        <p class="muted small" id="no-transfer-note"></p>
      </div>

      <details class="line-filter" ${settings.lines.length ? 'open' : ''}>
        <summary>🚃 路線でしぼる：<span id="line-summary"></span></summary>
        <div class="line-groups">
          ${groups.map((g) => `
            <p class="cat-group">${esc(g.op)}</p>
            ${g.lines.map((l) => `
              <label class="cat-chip">
                <input type="checkbox" name="lines" value="${esc(l.label)}" ${settings.lines.includes(l.label) ? 'checked' : ''}>
                <span>${esc(l.name)} <small>${l.count}駅</small></span>
              </label>`).join('')}`).join('')}
        </div>
        <p class="muted small">JR は実際の列車の系統で分けています（例：東海道線は東海道線の列車が止まる駅だけ。新子安・東神奈川は京浜東北線）。湘南新宿ラインは東海道線・横須賀線と同じ線路を走るため、別の路線としては分けていません。</p>
        <button type="button" class="btn ghost small" id="lines-clear">選択を解除</button>
      </details>

      <label class="check"><input type="checkbox" name="excludeVisited" ${settings.excludeVisited ? 'checked' : ''}> 行ったことのある駅を除く</label>

      <label>一度出た駅を出さない期間
        <select name="cooldown">${COOLDOWN_OPTIONS.map((v) => `<option value="${v}" ${v === settings.cooldown ? 'selected' : ''}>${v === 0 ? 'なし（同じ駅が続けて出てもよい）' : `その後 ${v} 回の抽選`}</option>`).join('')}</select>
      </label>
      <p class="muted small cooldown-note"><span id="recent-info"></span> <button type="button" class="btn ghost small" id="recent-reset">抽選履歴をリセット</button></p>

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
      cooldown: Number(fd.get('cooldown')) || 0,
      lines: fd.getAll('lines'),
      noTransfer: fd.get('noTransfer') === 'on',
    };
  }

  function syncVisibility() {
    const s = readForm();
    document.getElementById('near-options').hidden = s.mode !== 'near';
    document.getElementById('base-station-wrap').hidden = s.baseType !== 'station';
    document.getElementById('line-summary').textContent = s.lines.length
      ? s.lines.map((l) => l.replace(/^\S+ /, '')).join('・')
      : 'すべての路線';
    const base = byName.get(s.baseStation);
    document.getElementById('no-transfer-note').textContent = !s.noTransfer
      ? ''
      : s.baseType === 'station'
        ? base
          ? `${base.n}駅の路線：${base.l.map((l) => l.replace(/^\S+ /, '')).join('・')}`
          : ''
        : '現在地の最寄り駅を基準にします。';
  }
  function renderRecentInfo() {
    const s = readForm();
    const recent = loadRecent().slice(0, s.cooldown);
    document.getElementById('recent-info').textContent = s.cooldown
      ? recent.length
        ? `いま除外中：${[...new Set(recent)].join('、')}`
        : 'いま除外中の駅はありません。'
      : '同じ駅が続けて出ることもあります。';
    document.getElementById('recent-reset').hidden = !s.cooldown || !recent.length;
  }
  document.getElementById('recent-reset').addEventListener('click', () => {
    clearRecent();
    renderRecentInfo();
    toast('抽選履歴をリセットしました');
  });
  renderRecentInfo();

  document.getElementById('lines-clear').addEventListener('click', () => {
    form.querySelectorAll('input[name=lines]').forEach((el) => (el.checked = false));
    syncVisibility();
    saveSettings(readForm());
  });

  form.addEventListener('change', () => {
    renderRecentInfo();
    syncVisibility();
    saveSettings(readForm());
  });
  syncVisibility();

  // ---- いまのおでかけ ----
  const goalOptions = (selected) => `
    <option value="" ${!selected ? 'selected' : ''}>決めずに自由に歩く</option>
    ${GROUPS.map((g) => `<optgroup label="${esc(g.name)}">${categoriesInGroup(g.id)
      .filter((c) => c.id !== 'sonota')
      .map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${c.icon} ${esc(c.name)}を探す</option>`)
      .join('')}</optgroup>`).join('')}`;

  const directionsButtons = (t) => {
    const u = directionsUrls(t);
    return `<a class="btn" href="${u.google}" target="_blank" rel="noopener noreferrer">🗺 行き方を調べる</a>
      ${isIOS() ? `<a class="btn ghost small" href="${u.apple}" target="_blank" rel="noopener noreferrer">Appleマップで開く</a>` : ''}`;
  };

  const TL_ICON = { start: '🚶', note: '💬', find: '🔍', end: '🏠' };
  const timelineHtml = (t, items, { editable = false } = {}) => {
    const ev = timeline(t, items);
    if (!ev.length) return '';
    return `<ol class="timeline">${ev
      .map(
        (e) => `<li class="tl-${e.kind}">
          <span class="tl-time">${formatTime(e.at)}</span>
          <span class="tl-text">${TL_ICON[e.kind]} ${
            e.kind === 'find'
              ? `<a href="#/view/${encodeURIComponent(e.item.id)}">${getCategory(e.item.category).icon} ${esc(e.text)}</a>`
              : esc(e.text)
          }</span>
          ${editable && e.kind === 'note' ? `<button type="button" class="btn ghost small tl-del" data-note="${esc(e.id)}" aria-label="このメモを削除">✕</button>` : ''}
        </li>`
      )
      .join('')}</ol>`;
  };

  let tick = null;
  async function renderActive() {
    const el = document.getElementById('active-trip');
    clearInterval(tick);
    const trips = await db.getTrips();
    const t = trips.find(isActive);
    document.getElementById('go-form-title').textContent = t ? '🎲 別の行き先を決める' : '🎲 行き先を決める';
    if (!t) {
      el.innerHTML = '';
      return null;
    }
    const items = (await db.getAll()).filter((it) => it.tripId === t.id);
    const goal = t.goal ? getCategory(t.goal) : null;
    const achieved = goal && items.some((it) => it.category === goal.id);
    const walking = t.status === 'arrived';
    const elapsed = () => (walking ? `散歩 ${formatDuration(walkDuration(t)) || '0分'}（${formatTime(walkStart(t))} 開始）` : '');

    el.innerHTML = `
      <section class="card active-trip">
        <p class="at-label">🚩 いまのおでかけ <span class="status ${t.status}">${STATUS_LABEL[t.status]}</span></p>
        <p class="station-name">${esc(t.name)}<small>駅</small> <span class="at-to">${walking ? 'を散歩中' : 'へ向かう'}</span></p>
        ${walking ? `<p class="at-elapsed" id="at-elapsed">${elapsed()}</p>` : ''}
        ${t.lines?.length ? `<ul class="lines">${t.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}

        <div class="at-goal">
          <p><b>目的</b>：${goal
            ? `駅の周りで「${goal.icon} ${esc(goal.name)}」を探す ${achieved ? '<span class="badge">✔ 達成！</span>' : ''}
               <a href="#/guide/${goal.id}" class="small">探し方を見る</a>`
            : '決めずに自由に歩いて、気になったものを記録する'}</p>
          <label class="small">目的を変える
            <select id="at-goal">${goalOptions(t.goal)}</select>
          </label>
        </div>

        <div class="row go-actions">
          ${walking
            ? `<a class="btn primary" href="#/new${t.goal ? `?cat=${t.goal}` : ''}">＋ 発見を記録する</a>
               <button type="button" class="btn" data-act="finish">🏠 帰る（散歩終了）</button>`
            : `<button type="button" class="btn primary" data-act="arrive">🚶 着いた！散歩を始める</button>
               ${directionsButtons(t)}`}
        </div>

        <form class="note-form" id="note-form">
          <input id="note-text" maxlength="100" placeholder="ひとことメモ（例：いい匂いのパン屋があった）" aria-label="ひとことメモ" autocomplete="off">
          <button type="submit" class="btn small">残す</button>
        </form>

        <div class="at-timeline">
          <p class="at-count">${walking ? '散歩の記録' : 'メモ'}：発見 <b>${items.length}</b> 件 ・ メモ <b>${tripNotes(t).length}</b> 件</p>
          ${timelineHtml(t, items, { editable: true }) || '<p class="muted small">ひとことメモや発見が、時刻つきでここに並びます。</p>'}
        </div>

        <p class="at-steps muted small">${walking
          ? '気になるものは「発見を記録する」、ちょっとした気づきは「ひとことメモ」に。帰るときは「帰る」を押してください。'
          : '駅に着いたら「着いた！散歩を始める」を押してください。散歩の時間を記録します。'}</p>
        <button type="button" class="btn ghost small" data-act="cancel">このおでかけを取りやめる</button>
      </section>`;

    if (walking) {
      tick = setInterval(() => {
        const e = document.getElementById('at-elapsed');
        if (!e) return clearInterval(tick);
        e.textContent = elapsed();
      }, 30000);
    }

    const latest = async () => (await db.getTrips()).find((x) => x.id === t.id);
    el.querySelector('#at-goal').addEventListener('change', async (e) => {
      await db.putTrip({ ...(await latest()), goal: e.target.value || null });
      renderActive();
    });
    el.querySelector('#note-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = el.querySelector('#note-text');
      const text = input.value.trim();
      if (!text) return;
      const cur = await latest();
      const notes = [...tripNotes(cur), { id: newId(), text, at: new Date().toISOString() }];
      await db.putTrip({ ...cur, notes, memo: '' });
      toast(`${formatTime(new Date().toISOString())} のメモを残しました`);
      await renderActive();
    });
    el.querySelectorAll('.tl-del').forEach((btn) =>
      btn.addEventListener('click', async () => {
        if (!confirm('このメモを削除しますか？')) return;
        const cur = await latest();
        await db.putTrip({ ...cur, notes: tripNotes(cur).filter((n) => n.id !== btn.dataset.note), memo: '' });
        renderActive();
      })
    );
    el.querySelectorAll('button[data-act]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const cur = await latest();
        const now = new Date().toISOString();
        if (btn.dataset.act === 'arrive') {
          await db.putTrip({ ...cur, status: 'arrived', walkStartedAt: now, visitedAt: cur.visitedAt || now });
          toast(`${formatTime(now)} 散歩開始！ ${cur.name}駅を駅コレクションに追加しました`, 3500);
        } else if (btn.dataset.act === 'finish') {
          if (!confirm('散歩を終えて帰りますか？')) return;
          const done = { ...cur, status: 'done', endedAt: now };
          await db.putTrip(done);
          toast(`おかえりなさい！ 散歩 ${formatDuration(walkDuration(done))}・発見 ${items.length} 件・メモ ${tripNotes(done).length} 件${achieved ? '・目的達成！' : ''}`, 5000);
        } else if (btn.dataset.act === 'cancel') {
          if (!confirm(`${cur.name}駅へのおでかけを取りやめますか？${items.length ? '（記録した発見は残ります）' : ''}`)) return;
          if (cur.visitedAt) await db.putTrip({ ...cur, status: 'done', endedAt: now });
          else await db.removeTrip(cur.id);
        }
        await renderActive();
        ({ visited } = await renderTrips());
      })
    );
    return t;
  }

  // ---- 履歴・コレクション ----
  async function renderTrips() {
    const trips = await db.getTrips();
    const visited = new Set(trips.filter((t) => t.visitedAt).map((t) => t.name));
    const n = [...visited].filter((name) => byName.has(name)).length;
    document.getElementById('collection').innerHTML = `行った駅 <b>${n}</b> / ${stations.length}（${((n / stations.length) * 100).toFixed(1)}%）`;
    document.getElementById('collection-bar').style.width = `${(n / stations.length) * 100}%`;
    const past = trips.filter((t) => !isActive(t));
    const allItems = await db.getAll();
    const list = document.getElementById('trips');
    list.innerHTML = past.length
      ? past
          .slice(0, 50)
          .map((t) => {
            const goal = t.goal || t.theme ? getCategory(t.goal || t.theme) : null;
            const tItems = allItems.filter((it) => it.tripId === t.id);
            const dur = t.endedAt ? walkDuration(t) : null;
            const tl = timelineHtml(t, tItems);
            return `
        <li data-id="${esc(t.id)}">
          <span class="trip-name">${esc(t.name)}駅</span>
          <span class="muted small">${t.visitedAt ? `✔ ${formatDay(t.visitedAt)} に行った` : `${formatDay(t.decidedAt)} に決定（未訪問）`}${goal ? ` ・ ${goal.icon}` : ''}${dur ? ` ・ 散歩 ${formatDuration(dur)}` : ''}</span>
          ${tl ? `<details class="trip-detail"><summary>散歩の記録（発見 ${tItems.length}・メモ ${tripNotes(t).length}）</summary>${tl}</details>` : ''}
          <span class="trip-actions">
            ${t.visitedAt
              ? `<button type="button" class="btn ghost small" data-act="unvisit">取り消し</button>`
              : `<button type="button" class="btn small" data-act="visit">行った！</button>`}
            <button type="button" class="btn ghost small" data-act="delete" aria-label="${esc(t.name)}駅を履歴から削除">✕</button>
          </span>
        </li>`;
          })
          .join('')
      : '<li class="muted small">まだ履歴はありません。行き先を決めて「ここに行く！」を押すと、おでかけが始まります。</li>';
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

  await renderActive();
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

    // 乗り換えなし：基準の駅（現在地なら最寄り駅）の路線に限る
    let sameLineAs = [];
    let transferNote = '';
    if (s.mode === 'near' && s.noTransfer) {
      const from = s.baseType === 'station' ? byName.get(s.baseStation) : nearestStation(stations, base);
      if (from) {
        sameLineAs = from.l;
        transferNote = `${from.n}駅から乗り換えなし`;
        if (s.baseType !== 'station') baseLabel = `現在地（最寄り：${from.n}駅）から`;
      }
    }

    const exclude = s.excludeVisited ? new Set(visited) : new Set();
    if (s.mode === 'near' && s.baseType === 'station') exclude.add(s.baseStation);
    const lines = new Set(s.lines);
    const list = candidates(
      stations,
      s.mode === 'near' ? { base, minKm: s.minKm, maxKm: s.maxKm, exclude, lines, sameLineAs } : { exclude, lines }
    );

    if (!list.length) {
      resultEl.innerHTML = `<div class="card"><p>条件に合う駅がありません。</p>
        <p class="muted small">${s.mode === 'near' ? '距離の範囲を広げるか、' : ''}${lines.size || sameLineAs.length ? '路線の条件をゆるめるか、' : ''}「行ったことのある駅を除く」を外してみてください。${
          s.mode === 'near' && s.baseType === 'current' ? '（神奈川県の駅から選んでいます。県外にいる場合は「駅を指定」が便利です）' : ''
        }</p></div>`;
      return;
    }

    // 直近 cooldown 回に出た駅を除く。候補がなくなる場合は除外する回数を減らす。
    const recent = loadRecent();
    let pool = list;
    let usedCooldown = 0;
    for (let k = Math.min(s.cooldown, recent.length); k > 0; k--) {
      const skip = new Set(recent.slice(0, k));
      const filtered = list.filter((st) => !skip.has(st.n));
      if (filtered.length) {
        pool = filtered;
        usedCooldown = k;
        break;
      }
    }
    const cooldownNote =
      s.cooldown && usedCooldown < Math.min(s.cooldown, recent.length)
        ? usedCooldown
          ? `候補が少ないため、直近 ${usedCooldown} 回分だけ除外しました。`
          : '候補が少ないため、最近出た駅も含めて選びました。'
        : '';

    const choice = pickRandom(pool);
    pushRecent(choice.n);
    renderRecentInfo();
    const filterNote = [transferNote, lines.size ? `路線：${s.lines.map((l) => l.replace(/^\S+ /, '')).join('・')}` : '']
      .filter(Boolean)
      .join(' ／ ');
    await showResult(choice, { count: pool.length, baseLabel, base, cooldownNote, filterNote });
  }

  async function showResult(st, { count, baseLabel, base, cooldownNote = '', filterNote = '' }) {
    if (resultMap) {
      resultMap.stop();
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

    resultEl.innerHTML = `
      <div class="card go-result">
        <p class="muted small">${filterNote ? `${esc(filterNote)}<br>` : ''}候補 ${count} 駅から選びました${cooldownNote ? `<br>${esc(cooldownNote)}` : ''}</p>
        <p class="station-name">${esc(st.n)}<small>駅</small></p>
        <ul class="lines">${st.l.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
        ${st.km !== null ? `<p>${esc(baseLabel)} 直線で約 <b>${st.km.toFixed(1)} km</b></p>` : ''}
        <div class="hint">
          <p class="m0">目的（お題）：駅の周りで<b>「${theme.icon} ${esc(theme.name)}」</b>を探す${isNew ? '（図鑑に未登録！）' : ''}</p>
          <p class="m0 small">${esc(theme.hint)} <a href="#/guide/${theme.id}">探し方を見る</a></p>
          <label class="small m0">目的を変える<select id="go-goal">${goalOptions(theme.id)}</select></label>
        </div>
        <div class="minimap" id="go-map"></div>
        <p class="muted small">${nearby ? `この駅の周り（${NEARBY_KM}km）には、あなたの発見が ${nearby} 件あります。` : 'この駅の周りでの発見はまだありません。'}</p>
        <div class="row go-actions">
          <button type="button" class="btn primary" id="go-commit">ここに行く！</button>
          <button type="button" class="btn" id="go-again">🎲 もう一回</button>
          ${directionsButtons(st)}
        </div>
      </div>`;
    drawBtn.disabled = false;

    resultMap = createMap(document.getElementById('go-map'), { center: [st.lat, st.lng], zoom: 14 });
    addMap(resultMap);
    categoryMarker([st.lat, st.lng], '#2f6f4f').bindTooltip(`${st.n}駅`, { permanent: true, direction: 'top', offset: [0, -8] }).addTo(resultMap);
    L.circle([st.lat, st.lng], { radius: NEARBY_KM * 1000, color: '#2f6f4f', weight: 1, fillOpacity: 0.05 }).addTo(resultMap);
    if (base) {
      L.circleMarker([base.lat, base.lng], { radius: 6, color: '#1e88e5', fillColor: '#1e88e5', fillOpacity: 1 }).addTo(resultMap);
      resultMap.fitBounds([[base.lat, base.lng], [st.lat, st.lng]], { padding: [30, 30], maxZoom: 14, animate: false });
    }
    const shownMap = resultMap;
    setTimeout(() => shownMap === resultMap && shownMap.invalidateSize({ animate: false }), 50);

    document.getElementById('go-again').addEventListener('click', draw);
    const commit = document.getElementById('go-commit');
    commit.addEventListener('click', async () => {
      const now = new Date().toISOString();
      const current = (await db.getTrips()).find(isActive);
      if (current) {
        if (!confirm(`いまのおでかけ（${current.name}駅）を終えて、${st.n}駅へのおでかけを始めますか？`)) return;
        if (current.visitedAt) await db.putTrip({ ...current, status: 'done', endedAt: now });
        else await db.removeTrip(current.id);
      }
      commit.disabled = true;
      const goal = document.getElementById('go-goal').value || null;
      await db.putTrip({
        id: newId(),
        name: st.n,
        lat: st.lat,
        lng: st.lng,
        lines: st.l,
        goal,
        memo: '',
        status: 'going',
        decidedAt: now,
        visitedAt: null,
        endedAt: null,
      });
      resultEl.innerHTML = '';
      if (resultMap) {
        resultMap.stop();
        resultMap.remove();
        resultMap = null;
      }
      await renderActive();
      ({ visited } = await renderTrips());
      document.getElementById('active-trip').scrollIntoView({ behavior: 'smooth', block: 'start' });
      toast(`${st.n}駅へのおでかけを始めました！`, 3500);
    });
    resultEl.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    draw();
  });
}
