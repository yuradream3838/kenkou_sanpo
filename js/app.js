import * as db from './db.js';
import { CATEGORIES, GROUPS, DIFFICULTY, FEELINGS, getCategory, getFeeling, categoriesInGroup } from './categories.js';
import { DEPTHS, depthOf, xpOf, summarize, FIRST_IN_CATEGORY_BONUS } from './progress.js';
import { processPhoto, blobToDataURL, dataURLToBlob } from './image.js';
import { readExif } from './exif.js';
import { createMap, categoryMarker, LAYERS, layerName } from './map.js';
import { renderGo } from './go.js';
import { getActiveTrip, STATUS_LABEL, walkDuration, formatDuration, tripNotes } from './trip.js';
import { CHANGELOG, APP_VERSION, compareVersions } from './changelog.js';

/* global L */

const EXPORT_FORMAT = 'hakken-note-export';

const main = document.getElementById('main');
const headerStats = document.getElementById('header-stats');
const toastEl = document.getElementById('toast');

let maps = [];
let objectUrls = [];
let leaveGuard = null; // 入力途中の離脱確認
let formDirty = false;

// ---------- ユーティリティ ----------

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function nl2br(s) {
  return esc(s).replace(/\n/g, '<br>');
}

function safeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

// 「ファイルから選択」で開く種類。image/* だけだと Android ではフォト（ギャラリー）が開くため、
// 画像の種類を個別に並べ、application/octet-stream も加えてファイル（ストレージ）の画面が開くようにする。
// 画像以外が選ばれた場合は isImageFile で弾く。
const PHOTO_FILE_ACCEPT = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif',
  'application/octet-stream',
].join(',');

const MAX_PHOTOS = 10;

// 発見の写真一覧。photos がなければ以前の 1 枚だけの形式（photo/thumb）を使う。
// photo/thumb は常に表紙（1 枚目）と同じにしておく（一覧・地図・古い書き出しとの互換のため）。
function photosOf(it) {
  if (Array.isArray(it.photos) && it.photos.length) return it.photos;
  return it.photo ? [{ id: 'p0', photo: it.photo, thumb: it.thumb || it.photo }] : [];
}

function isImageFile(file) {
  return (file.type || '').startsWith('image/') || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name || '');
}

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function blobUrl(blob) {
  const u = URL.createObjectURL(blob);
  objectUrls.push(u);
  return u;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// datetime-local 用のローカル時刻文字列
function toLocalInput(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDate(iso) {
  if (!iso) return '';
  const [d, t] = iso.split('T');
  const [y, m, day] = d.split('-');
  return `${y}年${Number(m)}月${Number(day)}日${t ? ' ' + t.slice(0, 5) : ''}`;
}

function toast(msg, ms = 2600) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), ms);
}

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* プライベートモード等では無視 */
  }
}

function cleanup() {
  maps.forEach((m) => {
    try {
      m.remove(); // おでかけ画面で既に外した地図が含まれることがある
    } catch {
      /* noop */
    }
  });
  maps = [];
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls = [];
  leaveGuard = null;
  formDirty = false;
}

function depthBadges(item) {
  const reached = new Set(depthOf(item));
  return `<span class="depth" aria-label="調査の深さ ${reached.size}/4">${DEPTHS.map(
    (d) => `<span class="dot ${reached.has(d.key) ? 'on' : ''}" title="${d.label}"></span>`
  ).join('')}</span>`;
}

function feelingsHtml(item, cls = 'feelings') {
  const fs = (item.feelings || []).map(getFeeling).filter(Boolean);
  return fs.length ? `<span class="${cls}">${fs.map((f) => `<span class="feel">${f.icon} ${esc(f.name)}</span>`).join('')}</span>` : '';
}

function nextStepHint(item) {
  const reached = new Set(depthOf(item));
  const next = DEPTHS.find((d) => !reached.has(d.key));
  if (!next) return '<p class="hint done">✔ 出典付きで裏付け済み。見事な調査です。</p>';
  const howto = {
    found: '写真か場所を記録しましょう。',
    noticed: '「何が気になったか」「なぜここにあるのか」の仮説を書いてみましょう。',
    researched: '図書館、市の文化財資料、地図などで調べて分かったことを書きましょう。',
    verified: '調べた資料（本・Webページ・説明板など）を出典として追加しましょう。',
  }[next.key];
  return `<p class="hint">次の段階「${next.label}」まで：${howto}（+${next.xp} XP）</p>`;
}

// ---------- ヘッダー ----------

async function updateHeader(items) {
  items = items || (await db.getAll());
  const s = summarize(items);
  headerStats.innerHTML = `
    <span class="lv">Lv.${s.level}</span>
    <span class="title">${esc(s.title)}</span>
    <span class="xpbar" title="${s.xp} / ${s.next} XP"><span style="width:${Math.round(s.progress * 100)}%"></span></span>`;
  return s;
}

// ---------- ルーター ----------

function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '') || 'list';
  const [path, query = ''] = hash.split('?');
  const parts = path.split('/');
  return { name: parts[0], id: parts[1], params: new URLSearchParams(query) };
}

async function router() {
  cleanup();
  const route = parseRoute();
  document.body.dataset.route = route.name;
  document.querySelectorAll('.nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === route.name);
  });
  window.scrollTo(0, 0);
  try {
    switch (route.name) {
      case 'map':
        return await renderMap(route.params);
      case 'zukan':
        return await renderZukan();
      case 'new':
        return await renderForm(null, route.params.get('cat'));
      case 'edit':
        return await renderForm(route.id);
      case 'view':
        return await renderDetail(route.id);
      case 'go':
        return await renderGo({ main, esc, toast, addMap: (m) => maps.push(m), updateHeader });
      case 'guide':
        return await renderGuide(route.id);
      case 'changelog':
        return await renderChangelog();
      case 'settings':
        return await renderSettings();
      default:
        return await renderList(route.params);
    }
  } catch (err) {
    console.error(err);
    main.innerHTML = `<div class="card error">エラーが発生しました：${esc(err.message)}</div>`;
  }
}

// ---------- ノート（一覧） ----------

async function renderList(params) {
  const items = await db.getAll();
  const s = await updateHeader(items);
  const cat = params.get('cat') || '';
  const feel = params.get('feel') || '';
  const q = (params.get('q') || '').trim();

  const filtered = items.filter((it) => {
    if (cat && it.category !== cat) return false;
    if (feel && !(it.feelings || []).includes(feel)) return false;
    if (q) {
      const text = [it.title, it.noticed, it.hypothesis, it.findings].join(' ');
      if (!text.includes(q)) return false;
    }
    return true;
  });

  const safetyDismissed = storageGet('safety-dismissed') === '1';
  const active = await getActiveTrip();
  const activeGoal = active?.goal ? getCategory(active.goal) : null;

  main.innerHTML = `
    ${safetyDismissed ? '' : `
    <div class="card notice" id="safety">
      <strong>安全に楽しむために</strong>
      <ul>
        <li>スマホの操作は、安全な場所で立ち止まってから。</li>
        <li>私有地や立入禁止の場所には入らない。</li>
        <li>人の顔・表札・車のナンバーは写さない。</li>
      </ul>
      <button class="btn small" id="dismiss-safety">わかった</button>
    </div>`}

    ${active ? `
    <a class="card active-mini" href="#/go">
      <span class="at-label">🚩 いまのおでかけ <span class="status ${active.status}">${STATUS_LABEL[active.status]}</span></span>
      <b>${esc(active.name)}駅${active.status === 'arrived' ? `を散歩中（${formatDuration(walkDuration(active)) || '0分'}）` : 'へ向かう'}</b>
      <span class="small">目的：${activeGoal ? `${activeGoal.icon} ${esc(activeGoal.name)}を探す` : '自由に歩く'}</span>
    </a>` : ''}

    <section class="card stats">
      <div class="stat"><b>${s.total}</b><span>発見</span></div>
      <div class="stat"><b>${s.days}</b><span>探索日数</span></div>
      <div class="stat"><b>${s.verified}</b><span>裏付け済み</span></div>
      <div class="stat"><b>${s.discoveredCats}</b><span>図鑑の種類</span></div>
    </section>
    <p class="xp-line">Lv.${s.level}「${esc(s.title)}」 ${s.xp} XP ・ 次のレベルまで ${s.next - s.xp} XP</p>

    <form class="filters" id="filters">
      <select name="cat" aria-label="カテゴリで絞り込み">
        <option value="">すべての種類</option>
        ${GROUPS.map((g) => `<optgroup label="${esc(g.name)}">${categoriesInGroup(g.id).map((c) => `<option value="${c.id}" ${c.id === cat ? 'selected' : ''}>${c.icon} ${esc(c.name)}</option>`).join('')}</optgroup>`).join('')}
      </select>
      <select name="feel" aria-label="気持ちで絞り込み">
        <option value="">すべての気持ち</option>
        ${FEELINGS.map((f) => `<option value="${f.id}" ${f.id === feel ? 'selected' : ''}>${f.icon} ${esc(f.name)}</option>`).join('')}
      </select>
      <input type="search" name="q" placeholder="キーワード" value="${esc(q)}" aria-label="キーワード検索">
    </form>

    ${items.length === 0 ? `
      <div class="empty">
        <p class="big">🔍</p>
        <p>まだ発見がありません。</p>
        <p>いつもの道を少しだけ寄り道して、<br>「なんだこれ？」を探してみましょう。</p>
        <a class="btn primary" href="#/new">最初の発見を記録する</a>
      </div>` : filtered.length === 0 ? `<p class="muted center">条件に合う発見はありません。</p>` : ''}

    <ul class="cards">
      ${filtered.map((it) => {
        const c = getCategory(it.category);
        return `<li>
          <a class="item" href="#/view/${encodeURIComponent(it.id)}">
            <span class="thumbwrap">${it.thumb ? `<img src="${blobUrl(it.thumb)}" alt="" loading="lazy">` : `<span class="noimg" style="background:${c.color}">${c.icon}</span>`}${photosOf(it).length > 1 ? `<span class="photo-count">📷${photosOf(it).length}</span>` : ''}</span>
            <span class="body">
              <span class="name">${esc(it.title || '（無題の発見）')}</span>
              <span class="meta">${c.icon} ${esc(c.name)} ・ ${esc(formatDate(it.foundAt).split(' ')[0])}</span>
              <span class="meta">${depthBadges(it)} <span class="xp">${xpOf(it)} XP</span> ${feelingsHtml(it, 'feelings mini')}</span>
            </span>
          </a>
        </li>`;
      }).join('')}
    </ul>`;

  const form = document.getElementById('filters');
  const apply = () => {
    const fd = new FormData(form);
    const p = new URLSearchParams();
    if (fd.get('cat')) p.set('cat', fd.get('cat'));
    if (fd.get('feel')) p.set('feel', fd.get('feel'));
    if (String(fd.get('q')).trim()) p.set('q', String(fd.get('q')).trim());
    const qs = p.toString();
    location.hash = '#/list' + (qs ? '?' + qs : '');
  };
  form.cat.addEventListener('change', apply);
  form.feel.addEventListener('change', apply);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    apply();
  });
  document.getElementById('dismiss-safety')?.addEventListener('click', () => {
    storageSet('safety-dismissed', '1');
    document.getElementById('safety').remove();
  });
}

// ---------- 詳細 ----------

async function renderDetail(id) {
  const it = await db.get(id);
  if (!it) {
    main.innerHTML = `<div class="card">この発見は見つかりませんでした。<a href="#/list">ノートへ戻る</a></div>`;
    return;
  }
  await updateHeader();
  const c = getCategory(it.category);
  const sources = (it.sources || []).filter((s) => s.title || s.url);
  const confidenceLabel = { guess: '推測', likely: 'ほぼ確実', sourced: '出典あり' }[it.confidence] || '未設定';
  const trip = it.tripId ? (await db.getTrips()).find((t) => t.id === it.tripId) : null;

  main.innerHTML = `
    <article class="detail">
      ${(() => {
        const ps = photosOf(it);
        if (!ps.length) return '';
        if (ps.length === 1) return `<img class="photo" src="${blobUrl(ps[0].photo)}" alt="${esc(it.title)}">`;
        return `<div class="gallery" id="gallery">${ps.map((ph, i) => `<img class="photo" src="${blobUrl(ph.photo)}" alt="${esc(it.title)}（${i + 1}/${ps.length}）" loading="lazy">`).join('')}</div>
          <p class="gallery-count" id="gallery-count">1 / ${ps.length} <span class="muted small">（横にスワイプ）</span></p>`;
      })()}
      <div class="card">
        <p class="meta"><a href="#/guide/${c.id}">${c.icon} ${esc(c.name)}</a> ・ ${esc(formatDate(it.foundAt))}</p>
        ${trip ? `<p class="meta">🚩 ${esc(trip.name)}駅へのおでかけで発見</p>` : ''}
        <h2>${esc(it.title || '（無題の発見）')}</h2>
        ${feelingsHtml(it)}
        <p>${depthBadges(it)} <span class="xp">${xpOf(it)} XP</span> ・ 確信度：${esc(confidenceLabel)}</p>
        ${nextStepHint(it)}
      </div>

      ${it.noticed ? `<section class="card"><h3>気づいたこと</h3><p>${nl2br(it.noticed)}</p></section>` : ''}
      ${it.hypothesis ? `<section class="card"><h3>仮説</h3><p>${nl2br(it.hypothesis)}</p></section>` : ''}
      ${it.findings ? `<section class="card"><h3>調べて分かったこと</h3><p>${nl2br(it.findings)}</p></section>` : ''}
      ${sources.length ? `<section class="card"><h3>出典</h3><ul class="sources">${sources.map((s) => {
        const url = safeUrl(s.url);
        const label = esc(s.title || s.url);
        return `<li>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label}</li>`;
      }).join('')}</ul></section>` : ''}

      ${it.location ? `<section class="card"><h3>場所</h3><div class="minimap" id="detail-map"></div>
        <p class="muted small">緯度 ${it.location.lat.toFixed(5)} / 経度 ${it.location.lng.toFixed(5)}${it.location.accuracy ? `（誤差 約${Math.round(it.location.accuracy)}m）` : ''}</p></section>` : ''}

      <div class="actions">
        <a class="btn primary" href="#/edit/${encodeURIComponent(it.id)}">編集・調査を追記</a>
        <button class="btn danger" id="delete">削除</button>
      </div>
    </article>`;

  const gallery = document.getElementById('gallery');
  if (gallery) {
    const total = gallery.children.length;
    gallery.addEventListener('scroll', () => {
      const i = Math.round(gallery.scrollLeft / gallery.clientWidth) + 1;
      document.getElementById('gallery-count').innerHTML = `${Math.min(i, total)} / ${total} <span class="muted small">（横にスワイプ）</span>`;
    }, { passive: true });
  }

  if (it.location) {
    const m = createMap(document.getElementById('detail-map'), { center: [it.location.lat, it.location.lng], zoom: 16 });
    categoryMarker([it.location.lat, it.location.lng], c.color).addTo(m);
    maps.push(m);
  }

  document.getElementById('delete').addEventListener('click', async () => {
    if (!confirm('この発見を削除しますか？（元に戻せません）')) return;
    await db.remove(it.id);
    toast('削除しました');
    location.hash = '#/list';
  });
}

// ---------- 記録フォーム ----------

async function renderForm(id, presetCategory = null) {
  const existing = id ? await db.get(id) : null;
  if (id && !existing) {
    main.innerHTML = `<div class="card">この発見は見つかりませんでした。</div>`;
    return;
  }
  const beforeItems = await db.getAll();
  await updateHeader(beforeItems);
  // 新しい記録は、いまのおでかけに紐づける（編集のときは元の紐づけを保つ）
  const activeTrip = existing ? null : await getActiveTrip();

  const it = existing || {
    id: newId(),
    title: '',
    category: CATEGORIES.some((c) => c.id === presetCategory) ? presetCategory : '',
    foundAt: toLocalInput(new Date()),
    location: null,
    noticed: '',
    hypothesis: '',
    findings: '',
    sources: [],
    confidence: 'guess',
    photo: null,
    thumb: null,
  };
  const state = {
    photos: photosOf(it).map((ph) => ({ ...ph })),
    location: it.location,
    sources: it.sources && it.sources.length ? it.sources.map((s) => ({ ...s })) : [{ title: '', url: '' }],
  };

  main.innerHTML = `
    <form class="record" id="record" novalidate>
      <h2>${existing ? '発見を編集' : '新しい発見'}</h2>
      ${existing ? '' : '<p class="notice-inline">⚠ 入力は安全な場所で立ち止まって。人の顔・表札・ナンバーは写さないでください。</p>'}

      <section class="card">
        <h3>写真</h3>
        <div id="photo-preview" class="photo-preview"></div>
        <div class="row">
          <label class="btn">📷 撮影<input type="file" accept="image/*" capture="environment" id="photo-camera" hidden></label>
          <label class="btn">📁 ファイルから選択<input type="file" accept="${PHOTO_FILE_ACCEPT}" id="photo-file" multiple hidden></label>
        </div>
        <p class="muted small">1つの発見に ${MAX_PHOTOS} 枚まで。ファイルからはまとめて選べます。1枚目が表紙になります。<br>写真は縮小して保存され、撮影位置などのメタデータは削除されます。</p>
      </section>

      ${activeTrip ? `
      <label class="check trip-link"><input type="checkbox" name="linkTrip" checked> 🚩 ${esc(activeTrip.name)}駅へのおでかけの発見にする</label>` : ''}

      <section class="card">
        <h3>なにを見つけた？</h3>
        <label>名前（仮でOK）<input name="title" maxlength="80" value="${esc(it.title)}" placeholder="例：坂の途中の小さな石柱"></label>
        <fieldset class="cats">
          <legend>種類</legend>
          ${GROUPS.map((g) => `
            <p class="cat-group">${esc(g.name)}</p>
            ${categoriesInGroup(g.id).map((c) => `
            <label class="cat-chip">
              <input type="radio" name="category" value="${c.id}" ${it.category === c.id ? 'checked' : ''}>
              <span>${c.icon} ${esc(c.name)}</span>
            </label>`).join('')}`).join('')}
        </fieldset>
        <fieldset class="cats feel-chips">
          <legend>どう感じた？（いくつでも・なくてもOK）</legend>
          ${FEELINGS.map((f) => `
            <label class="cat-chip">
              <input type="checkbox" name="feelings" value="${f.id}" ${(it.feelings || []).includes(f.id) ? 'checked' : ''}>
              <span>${f.icon} ${esc(f.name)}</span>
            </label>`).join('')}
        </fieldset>
        <label>発見した日時<input type="datetime-local" name="foundAt" value="${esc(it.foundAt)}"></label>
        <p class="exif-row" id="exif-time" hidden></p>
      </section>

      <section class="card">
        <h3>場所</h3>
        <div class="row">
          <button type="button" class="btn" id="loc-current">📍 現在地を記録</button>
          <button type="button" class="btn ghost" id="loc-clear">場所を外す</button>
        </div>
        <p class="muted small" id="loc-status"></p>
        <p class="exif-row" id="exif-loc" hidden></p>
        <div class="minimap" id="form-map"></div>
        <p class="muted small">地図をタップすると場所を修正できます。位置情報は端末の中だけに保存されます。</p>
      </section>

      <section class="card">
        <h3>気づいたこと・仮説</h3>
        <label>何が気になった？ 心が動いた理由は？<textarea name="noticed" rows="3" placeholder="例：道の真ん中に、文字が刻まれた石が残っている／夕日が坂の向こうに沈んでいくのがきれいだった">${esc(it.noticed)}</textarea></label>
        <label>仮説：なぜここにある？<textarea name="hypothesis" rows="3" placeholder="例：昔の分かれ道の道しるべ？">${esc(it.hypothesis)}</textarea></label>
      </section>

      <section class="card">
        <h3>調べて分かったこと</h3>
        <p class="muted small">あとから追記できます。帰ってから図書館や市の資料で調べるのもおすすめ。</p>
        <textarea name="findings" rows="5" placeholder="例：江戸時代の○○道と△△道の分岐点に建てられた道標だった">${esc(it.findings)}</textarea>
        <h4>出典</h4>
        <div id="sources"></div>
        <button type="button" class="btn small" id="add-source">＋ 出典を追加</button>
        <fieldset class="confidence">
          <legend>確信度</legend>
          ${[['guess', '推測'], ['likely', 'ほぼ確実'], ['sourced', '出典あり']].map(([v, l]) => `
            <label><input type="radio" name="confidence" value="${v}" ${it.confidence === v ? 'checked' : ''}> ${l}</label>`).join('')}
        </fieldset>
      </section>

      <div class="actions sticky">
        <a class="btn ghost" href="${existing ? `#/view/${encodeURIComponent(it.id)}` : '#/list'}">キャンセル</a>
        <button type="submit" class="btn primary">保存</button>
      </div>
    </form>`;

  const form = document.getElementById('record');
  const preview = document.getElementById('photo-preview');
  const locStatus = document.getElementById('loc-status');
  const sourcesEl = document.getElementById('sources');

  form.addEventListener('input', () => (formDirty = true));
  leaveGuard = () => !formDirty || confirm('入力中の内容は保存されていません。移動しますか？');

  // 写真
  function renderPreview(status = '') {
    preview.innerHTML = state.photos.length
      ? `<ul class="photo-grid">${state.photos
          .map(
            (ph, i) => `<li>
              <img src="${blobUrl(ph.thumb || ph.photo)}" alt="写真 ${i + 1}">
              ${i === 0 ? '<span class="cover-label">表紙</span>' : `<button type="button" class="ph-btn ph-cover" data-cover="${i}" aria-label="写真 ${i + 1} を表紙にする">★表紙に</button>`}
              <button type="button" class="ph-btn ph-del" data-del="${i}" aria-label="写真 ${i + 1} を外す">✕</button>
            </li>`
          )
          .join('')}</ul>`
      : '<p class="muted">写真なし</p>';
    if (status) preview.insertAdjacentHTML('beforeend', `<p class="muted small">${esc(status)}</p>`);
  }
  preview.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    const cover = e.target.closest('[data-cover]');
    if (del) {
      state.photos.splice(Number(del.dataset.del), 1);
    } else if (cover) {
      const [ph] = state.photos.splice(Number(cover.dataset.cover), 1);
      state.photos.unshift(ph);
    } else return;
    formDirty = true;
    renderPreview();
  });
  async function onPhoto(e) {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    const images = files.filter(isImageFile);
    if (images.length < files.length) toast('画像以外のファイルは追加しませんでした', 3500);
    const room = MAX_PHOTOS - state.photos.length;
    if (room <= 0) return toast(`写真は ${MAX_PHOTOS} 枚までです`);
    if (images.length > room) toast(`写真は ${MAX_PHOTOS} 枚までなので、${room} 枚だけ追加します`, 3500);
    const todo = images.slice(0, room);
    let failed = 0;
    for (let i = 0; i < todo.length; i++) {
      renderPreview(`写真を処理中… ${i + 1} / ${todo.length}`);
      try {
        const exif = await readExif(todo[i]); // 保存時にメタデータを消す前に、撮影日時・場所を読む
        const { photo, thumb } = await processPhoto(todo[i]);
        state.photos.push({ id: newId(), photo, thumb });
        formDirty = true;
        if (!exifTakenAt && !exifApplied && (exif.takenAt || exif.location)) {
          exifApplied = true; // 撮影日時・場所は、情報のある最初の写真から使う
          applyExif(exif);
        }
      } catch (err) {
        failed++;
        if (todo.length === 1) toast(err.message, 5000);
      }
    }
    if (failed && todo.length > 1) toast(`${failed} 枚は読み込めませんでした（HEIC 形式などは端末によって読み込めないことがあります）`, 5000);
    renderPreview();
  }
  let exifApplied = false;

  // 写真の撮影日時・撮影場所を、発見の日時・場所として使えるようにする
  const foundAtInput = form.querySelector('input[name=foundAt]');
  let foundAtTouched = !!existing;
  foundAtInput.addEventListener('input', () => (foundAtTouched = true));
  const fmtLocal = (v) => formatDate(v).replace(/^\d{4}年/, '');
  let exifTakenAt = null;
  const timeRow = document.getElementById('exif-time');
  function renderTimeRow() {
    timeRow.hidden = !exifTakenAt;
    if (!exifTakenAt) return;
    const same = foundAtInput.value === exifTakenAt;
    timeRow.innerHTML = `📷 写真の撮影日時：${esc(formatDate(exifTakenAt))} ${
      same ? '<span class="muted">（発見日時にしています）</span>' : '<button type="button" class="btn small" id="use-exif-time">この日時にする</button>'
    }`;
  }
  foundAtInput.addEventListener('input', renderTimeRow);
  timeRow.addEventListener('click', (e) => {
    if (e.target.id !== 'use-exif-time') return;
    foundAtInput.value = exifTakenAt;
    foundAtTouched = true;
    formDirty = true;
    renderTimeRow();
  });
  function applyExif({ takenAt, location }) {
    const locRow = document.getElementById('exif-loc');
    exifTakenAt = takenAt;
    locRow.hidden = !location;
    if (takenAt && !foundAtTouched) {
      foundAtInput.value = takenAt; // 新しい記録で日時を触っていなければ、撮影日時をそのまま使う
      toast(`写真の撮影日時（${fmtLocal(takenAt)}）を発見日時にしました`, 3500);
    }
    renderTimeRow();
    if (location) {
      locRow.innerHTML = `📷 写真に撮影場所が記録されています <button type="button" class="btn small" id="use-exif-loc">この場所を使う</button>`;
      document.getElementById('use-exif-loc').addEventListener('click', () => {
        setLocation({ ...location, accuracy: null, fromPhoto: true });
        formDirty = true;
        locRow.innerHTML = '📷 写真の撮影場所を使っています';
      });
    }
  }
  document.getElementById('photo-camera').addEventListener('change', onPhoto);
  document.getElementById('photo-file').addEventListener('change', onPhoto);
  renderPreview();

  // 場所
  const center = state.location
    ? [state.location.lat, state.location.lng]
    : beforeItems.find((x) => x.location)
      ? [beforeItems.find((x) => x.location).location.lat, beforeItems.find((x) => x.location).location.lng]
      : undefined;
  const fmap = createMap(document.getElementById('form-map'), { center, zoom: center ? 16 : undefined });
  maps.push(fmap);
  let marker = null;
  function setLocation(loc, pan = true) {
    state.location = loc;
    if (marker) {
      marker.remove();
      marker = null;
    }
    if (loc) {
      marker = L.marker([loc.lat, loc.lng]).addTo(fmap);
      if (pan) fmap.setView([loc.lat, loc.lng], Math.max(fmap.getZoom(), 16));
      locStatus.textContent = `緯度 ${loc.lat.toFixed(5)} / 経度 ${loc.lng.toFixed(5)}${loc.accuracy ? `（誤差 約${Math.round(loc.accuracy)}m）` : loc.fromPhoto ? '（写真の撮影場所）' : '（地図で指定）'}`;
    } else {
      locStatus.textContent = '場所は未記録です。';
    }
  }
  setLocation(state.location);
  fmap.on('click', (e) => {
    setLocation({ lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6), accuracy: null }, false);
    formDirty = true;
  });
  document.getElementById('loc-current').addEventListener('click', () => {
    if (!navigator.geolocation) return toast('この端末では位置情報を使えません');
    locStatus.textContent = '現在地を取得中…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation({
          lat: +pos.coords.latitude.toFixed(6),
          lng: +pos.coords.longitude.toFixed(6),
          accuracy: pos.coords.accuracy,
        });
        formDirty = true;
      },
      (err) => {
        locStatus.textContent = '';
        toast(err.code === 1 ? '位置情報の利用が許可されていません' : '現在地を取得できませんでした');
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
    );
  });
  document.getElementById('loc-clear').addEventListener('click', () => {
    setLocation(null);
    formDirty = true;
  });
  setTimeout(() => maps.includes(fmap) && fmap.invalidateSize(), 50); // 画面を移った後は何もしない

  // 出典
  function renderSources() {
    sourcesEl.innerHTML = state.sources
      .map((s, i) => `
        <div class="source-row" data-i="${i}">
          <input data-k="title" placeholder="資料名（例：○○市史 第2巻、現地の説明板）" value="${esc(s.title)}" maxlength="200">
          <input data-k="url" type="url" placeholder="URL（任意）" value="${esc(s.url)}" maxlength="500">
          <button type="button" class="btn ghost small" data-remove="${i}" aria-label="この出典を削除">✕</button>
        </div>`)
      .join('');
  }
  sourcesEl.addEventListener('input', (e) => {
    const row = e.target.closest('.source-row');
    if (!row) return;
    state.sources[+row.dataset.i][e.target.dataset.k] = e.target.value;
  });
  sourcesEl.addEventListener('click', (e) => {
    const i = e.target.dataset.remove;
    if (i === undefined) return;
    state.sources.splice(+i, 1);
    if (!state.sources.length) state.sources.push({ title: '', url: '' });
    formDirty = true;
    renderSources();
  });
  document.getElementById('add-source').addEventListener('click', () => {
    state.sources.push({ title: '', url: '' });
    renderSources();
  });
  renderSources();

  // 保存
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const category = fd.get('category');
    if (!category) {
      toast('カテゴリを選んでください（迷ったら「その他の発見」）');
      form.querySelector('.cats').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const now = new Date().toISOString();
    const item = {
      id: it.id,
      title: String(fd.get('title') || '').trim(),
      category,
      foundAt: String(fd.get('foundAt') || toLocalInput(new Date())),
      location: state.location,
      noticed: String(fd.get('noticed') || '').trim(),
      hypothesis: String(fd.get('hypothesis') || '').trim(),
      findings: String(fd.get('findings') || '').trim(),
      sources: state.sources
        .map((s) => ({ title: s.title.trim(), url: s.url.trim() }))
        .filter((s) => s.title || s.url),
      confidence: fd.get('confidence') || 'guess',
      feelings: fd.getAll('feelings').filter((f) => getFeeling(f)),
      tripId: existing ? existing.tripId || null : activeTrip && fd.get('linkTrip') === 'on' ? activeTrip.id : null,
      photos: state.photos,
      photo: state.photos[0]?.photo || null,
      thumb: state.photos[0]?.thumb || null,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    if (!item.photo && !item.location && !item.title) {
      toast('写真・場所・名前のどれかを記録してください');
      return;
    }

    const before = summarize(beforeItems);
    try {
      await db.put(item);
    } catch (err) {
      toast('保存に失敗しました：' + err.message);
      return;
    }
    requestPersistence();
    const afterItems = await db.getAll();
    const after = summarize(afterItems);
    const gained = after.xp - before.xp;
    const newCat = before.catCounts[category] === 0 && after.catCounts[category] > 0;

    formDirty = false;
    leaveGuard = null;
    location.hash = `#/view/${encodeURIComponent(item.id)}`;

    const msgs = [];
    if (gained > 0) msgs.push(`+${gained} XP`);
    if (newCat) msgs.push(`図鑑に「${getCategory(category).name}」を登録！（+${FIRST_IN_CATEGORY_BONUS}）`);
    if (after.level > before.level) msgs.push(`レベルアップ！ Lv.${after.level}「${after.title}」`);
    toast(msgs.length ? msgs.join(' ・ ') : '保存しました', 4000);
  });
}

// ---------- 地図 ----------

async function renderMap(params) {
  const items = await db.getAll();
  await updateHeader(items);
  const located = items.filter((it) => it.location);
  main.innerHTML = `
    <div class="fullmap-wrap">
      <div id="fullmap" class="fullmap"></div>
      <button class="btn map-locate" id="locate">📍 現在地</button>
      ${located.length === 0 ? '<p class="map-empty">場所付きの発見はまだありません。</p>' : ''}
    </div>`;
  const layer = params?.get('layer');
  const map = createMap(document.getElementById('fullmap'), { layer: LAYERS[layer] ? layer : 'pale' });
  if (LAYERS[layer]) toast(`地図を「${layerName(layer)}」にしました（右上で切り替え）`, 3500);
  maps.push(map);

  const bounds = [];
  for (const it of located) {
    const c = getCategory(it.category);
    const ll = [it.location.lat, it.location.lng];
    bounds.push(ll);
    const popup = document.createElement('div');
    popup.className = 'popup';
    popup.innerHTML = `
      ${it.thumb ? `<img src="${blobUrl(it.thumb)}" alt="">` : ''}
      <b>${esc(it.title || '（無題の発見）')}</b>
      <span>${c.icon} ${esc(c.name)}</span>
      <a href="#/view/${encodeURIComponent(it.id)}">詳しく見る</a>`;
    categoryMarker(ll, c.color).bindPopup(popup).addTo(map);
  }
  if (bounds.length === 1) map.setView(bounds[0], 16);
  else if (bounds.length > 1) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 });
  if (LAYERS[layer] && LAYERS[layer].minNativeZoom >= 10 && map.getZoom() < 13) map.setZoom(13); // 昔の写真は広域では表示されない

  let here = null;
  document.getElementById('locate').addEventListener('click', () => {
    if (!navigator.geolocation) return toast('この端末では位置情報を使えません');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const ll = [pos.coords.latitude, pos.coords.longitude];
        if (here) here.remove();
        here = L.circle(ll, { radius: Math.max(pos.coords.accuracy, 10), color: '#1e88e5', weight: 2, fillOpacity: 0.15 }).addTo(map);
        map.setView(ll, 16);
      },
      () => toast('現在地を取得できませんでした'),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
    );
  });
  setTimeout(() => maps.includes(map) && map.invalidateSize(), 50); // 画面を移った後は何もしない
}

// ---------- 図鑑 ----------

async function renderZukan() {
  const items = await db.getAll();
  const s = await updateHeader(items);
  const feelCounts = Object.fromEntries(FEELINGS.map((f) => [f.id, 0]));
  for (const it of items) for (const f of it.feelings || []) if (f in feelCounts) feelCounts[f]++;

  const tile = (c) => {
    const n = s.catCounts[c.id] || 0;
    const d = DIFFICULTY[c.difficulty] || DIFFICULTY[1];
    return n > 0
      ? `<li class="found"><a href="#/guide/${c.id}" style="--c:${c.color}">
          <span class="icon">${c.icon}</span>
          <span class="name">${esc(c.name)}</span>
          <span class="count">${n} 件</span></a></li>`
      : `<li class="locked"><a href="#/guide/${c.id}">
          <span class="icon">？</span>
          <span class="name">${esc(c.name)}</span>
          <span class="stars" title="${d.label}">${d.stars} ${d.label}</span>
          <span class="hint">${esc(c.hint)}</span>
          <span class="guide-link">探し方を見る →</span></a></li>`;
  };

  main.innerHTML = `
    <h2>発見図鑑</h2>
    <p>登録した種類 <b>${s.discoveredCats}</b> ・ 発見 <b>${s.total}</b> 件</p>
    <p class="muted small">種類をタップすると、見分け方や探す場所のガイドが見られます。</p>
    ${GROUPS.map((g) => `
      <h3 class="zukan-group">${esc(g.name)}</h3>
      <ul class="zukan">${categoriesInGroup(g.id).map(tile).join('')}</ul>`).join('')}

    <section class="card">
      <h3>こころの記録</h3>
      <p class="muted small">心が動いたものを、気持ちごとに振り返れます。</p>
      <ul class="feel-grid">
        ${FEELINGS.map((f) => `<li><a href="#/list?feel=${f.id}" class="${feelCounts[f.id] ? 'has' : ''}">
          <span class="icon">${f.icon}</span><span>${esc(f.name)}</span><b>${feelCounts[f.id]}</b></a></li>`).join('')}
      </ul>
    </section>

    <section class="card">
      <h3>経験値のしくみ</h3>
      <p class="muted small">歩いた距離ではなく、<b>どれだけ深く調べたか</b>で経験値が増えます。</p>
      <ul class="depth-legend">
        ${DEPTHS.map((d, i) => `<li><span class="depth">${DEPTHS.map((_, j) => `<span class="dot ${j <= i ? 'on' : ''}"></span>`).join('')}</span> <b>${d.label}</b> +${d.xp} XP <span class="muted">— ${d.desc}</span></li>`).join('')}
        <li>図鑑に新しい種類を登録すると +${FIRST_IN_CATEGORY_BONUS} XP</li>
      </ul>
    </section>`;
}

// ---------- 探し方ガイド ----------

async function renderGuide(id) {
  const c = CATEGORIES.find((x) => x.id === id);
  if (!c) {
    main.innerHTML = `<div class="card">この種類は見つかりませんでした。<a href="#/zukan">図鑑へ戻る</a></div>`;
    return;
  }
  const items = await db.getAll();
  await updateHeader(items);
  const mine = items.filter((it) => it.category === c.id);
  const d = DIFFICULTY[c.difficulty] || DIFFICULTY[1];
  const g = c.guide || {};
  const list = (arr) => `<ul class="guide-list">${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;

  main.innerHTML = `
    <p><a href="#/zukan">← 図鑑</a></p>
    <div class="card guide-head" style="--c:${c.color}">
      <span class="icon">${c.icon}</span>
      <div>
        <h2>${esc(c.name)}</h2>
        <p class="stars">${d.stars} ${d.label}</p>
        <p class="muted small">${esc(c.hint)}</p>
      </div>
    </div>

    ${g.look?.length ? `<section class="card"><h3>👀 見分けるポイント</h3>${list(g.look)}</section>` : ''}
    ${g.where?.length ? `<section class="card"><h3>📍 探す場所</h3>${list(g.where)}</section>` : ''}
    ${g.map ? `<section class="card"><h3>🗺 地図で探す</h3><p>${esc(g.map.text)}</p>
      <a class="btn" href="#/map?layer=${g.map.layer}">「${esc(layerName(g.map.layer))}」で地図を開く</a></section>` : ''}
    ${g.tip ? `<section class="card"><h3>💡 コツ</h3><p>${esc(g.tip)}</p></section>` : ''}
    ${g.caution ? `<p class="notice-inline">⚠ ${esc(g.caution)}</p>` : ''}

    <section class="card">
      <h3>あなたの記録</h3>
      ${mine.length
        ? `<p>${mine.length} 件見つけています。 <a href="#/list?cat=${c.id}">一覧で見る</a></p>`
        : '<p class="muted">まだ見つけていません。次の散策で探してみましょう。</p>'}
      <a class="btn primary" href="#/new?cat=${c.id}">この種類で記録する</a>
    </section>`;
}

// ---------- 設定 ----------

async function renderSettings() {
  const items = await db.getAll();
  await updateHeader(items);
  let persisted = null;
  try {
    persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null;
  } catch {
    /* noop */
  }
  let usage = '';
  try {
    if (navigator.storage?.estimate) {
      const e = await navigator.storage.estimate();
      usage = `使用量 約${(e.usage / 1024 / 1024).toFixed(1)} MB`;
    }
  } catch {
    /* noop */
  }

  main.innerHTML = `
    <h2>設定・データ</h2>
    <section class="card">
      <h3>データの保存場所</h3>
      <p>記録はすべて<b>この端末のブラウザの中だけ</b>に保存されます。サーバーには送信されません。</p>
      <p class="muted small">${usage}${persisted === null ? '' : persisted ? ' ・ 永続保存：有効' : ' ・ 永続保存：未許可（空き容量が少ないとブラウザに消される可能性があります）'}</p>
      <p class="muted small">機種変更やブラウザのデータ削除に備えて、定期的に書き出し（バックアップ）してください。</p>
      <div class="row">
        <button class="btn primary" id="export">書き出し（${items.length}件）</button>
        <label class="btn">読み込み<input type="file" accept="application/json,.json" id="import" hidden></label>
      </div>
    </section>
    <section class="card">
      <h3>このアプリについて</h3>
      <p>発見ノート v${APP_VERSION}</p>
      <p class="small">地図：<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a> ・ 地図ライブラリ：<a href="https://leafletjs.com/" target="_blank" rel="noopener">Leaflet</a></p>
      <p><a href="privacy.html">プライバシーポリシー・利用上の注意</a></p>
    </section>
    <section class="card">
      <h3>更新履歴</h3>
      ${changelogHtml(CHANGELOG.slice(0, 2))}
      <p><a href="#/changelog">すべての更新履歴を見る（${CHANGELOG.length}件）</a></p>
    </section>
    <section class="card">
      <h3>すべて削除</h3>
      <p class="muted small">この端末に保存された発見と、おでかけの履歴をすべて削除します。元に戻せません。</p>
      <button class="btn danger" id="wipe">すべて削除</button>
    </section>`;

  document.getElementById('export').addEventListener('click', () => exportData(items));
  document.getElementById('import').addEventListener('change', importData);
  document.getElementById('wipe').addEventListener('click', async () => {
    if (!confirm(`${items.length}件の発見をすべて削除します。よろしいですか？`)) return;
    if (!confirm('本当に削除しますか？ 書き出していないデータは失われます。')) return;
    await db.clearAll();
    await db.clearTrips();
    toast('すべて削除しました');
    router();
  });
}

// ---------- 更新履歴 ----------

function changelogHtml(entries) {
  return `<ol class="changelog">${entries
    .map(
      (e) => `
      <li>
        <p class="cl-head"><b>v${esc(e.version)}</b> <span class="muted small">${esc(formatDate(e.date))}</span>${e.version === APP_VERSION ? ' <span class="badge">最新</span>' : ''}</p>
        <ul>${e.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
      </li>`
    )
    .join('')}</ol>`;
}

async function renderChangelog() {
  await updateHeader();
  main.innerHTML = `
    <h2>更新履歴</h2>
    <p class="muted small">いま使っているのは v${esc(APP_VERSION)} です。</p>
    <section class="card">${changelogHtml(CHANGELOG)}</section>
    <p><a class="btn" href="#/settings">設定に戻る</a></p>`;
  markVersionSeen();
}

const SEEN_VERSION_KEY = 'seen-version';

function markVersionSeen() {
  storageSet(SEEN_VERSION_KEY, APP_VERSION);
  document.getElementById('update-banner').hidden = true;
}

// 更新後に初めて開いたとき、前回見たバージョン以降の更新内容をお知らせする
function showUpdateBanner() {
  const seen = storageGet(SEEN_VERSION_KEY);
  // 以前から使っている人（このお知らせ機能より前の版の利用者）を判定する手がかり
  const returning = seen || storageGet('safety-dismissed') || storageGet('go-settings');
  if (!returning) {
    storageSet(SEEN_VERSION_KEY, APP_VERSION); // 初めて使う人には出さない
    return;
  }
  const since = seen || '0.3.0'; // お知らせ機能がなかった頃の利用者は 0.4.0 以降を表示
  const fresh = CHANGELOG.filter((e) => compareVersions(e.version, since) > 0);
  if (!fresh.length) return;
  const banner = document.getElementById('update-banner');
  banner.innerHTML = `
    <div class="ub-body">
      <b>🎉 v${esc(APP_VERSION)} に更新しました</b>
      <ul>${fresh.flatMap((e) => e.items).slice(0, 3).map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
      <div class="row">
        <a class="btn small primary" href="#/changelog">更新履歴を見る</a>
        <button type="button" class="btn small ghost" id="ub-close">閉じる</button>
      </div>
    </div>`;
  banner.hidden = false;
  document.getElementById('ub-close').addEventListener('click', markVersionSeen);
}

async function exportData(items) {
  const out = [];
  for (const it of items) {
    const photos = [];
    for (const ph of photosOf(it)) {
      photos.push({ id: ph.id, photo: await blobToDataURL(ph.photo), thumb: ph.thumb ? await blobToDataURL(ph.thumb) : null });
    }
    // 表紙は photos[0] と同じなので photo/thumb は書き出さない（ファイルを小さくするため）
    out.push({ ...it, photos, photo: null, thumb: null });
  }
  const trips = await db.getTrips();
  const json = JSON.stringify({ format: EXPORT_FORMAT, version: 3, exportedAt: new Date().toISOString(), items: out, trips });
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  const d = new Date();
  a.href = URL.createObjectURL(blob);
  a.download = `hakken-note-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  storageSet('last-export', d.toISOString());
}

const isDataImage = (v) => typeof v === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(v);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

// 書き出しファイルの写真を読み込む（新形式 photos[]／旧形式 photo・thumb の両方に対応）
async function importPhotos(raw) {
  const out = [];
  if (Array.isArray(raw.photos) && raw.photos.length) {
    for (const ph of raw.photos.slice(0, MAX_PHOTOS)) {
      if (!ph || !isDataImage(ph.photo)) continue;
      const photo = await dataURLToBlob(ph.photo);
      out.push({ id: str(ph.id, 100) || newId(), photo, thumb: isDataImage(ph.thumb) ? await dataURLToBlob(ph.thumb) : photo });
    }
  } else if (isDataImage(raw.photo)) {
    const photo = await dataURLToBlob(raw.photo);
    out.push({ id: 'p0', photo, thumb: isDataImage(raw.thumb) ? await dataURLToBlob(raw.thumb) : photo });
  }
  return out;
}

async function importData(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.format !== EXPORT_FORMAT || !Array.isArray(data.items)) throw new Error('発見ノートの書き出しファイルではありません');
    let count = 0;
    for (const raw of data.items) {
      if (!raw || typeof raw.id !== 'string') continue;
      const loc = raw.location;
      const item = {
        id: str(raw.id, 100),
        title: str(raw.title, 200),
        category: getCategory(raw.category).id,
        foundAt: str(raw.foundAt, 40),
        location:
          loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)
            ? { lat: loc.lat, lng: loc.lng, accuracy: Number.isFinite(loc.accuracy) ? loc.accuracy : null }
            : null,
        noticed: str(raw.noticed, 5000),
        hypothesis: str(raw.hypothesis, 5000),
        findings: str(raw.findings, 20000),
        sources: Array.isArray(raw.sources)
          ? raw.sources.slice(0, 50).map((s) => ({ title: str(s?.title, 200), url: str(s?.url, 500) }))
          : [],
        confidence: ['guess', 'likely', 'sourced'].includes(raw.confidence) ? raw.confidence : 'guess',
        feelings: Array.isArray(raw.feelings) ? raw.feelings.filter((f) => typeof f === 'string' && getFeeling(f)) : [],
        tripId: str(raw.tripId, 100) || null,
        photos: await importPhotos(raw),
        createdAt: str(raw.createdAt, 40) || new Date().toISOString(),
        updatedAt: str(raw.updatedAt, 40) || new Date().toISOString(),
      };
      item.photo = item.photos[0]?.photo || null;
      item.thumb = item.photos[0]?.thumb || null;
      await db.put(item);
      count++;
    }
    let tripCount = 0;
    for (const t of Array.isArray(data.trips) ? data.trips : []) {
      if (!t || typeof t.id !== 'string' || typeof t.name !== 'string') continue;
      await db.putTrip({
        id: str(t.id, 100),
        name: str(t.name, 100),
        lat: Number.isFinite(t.lat) ? t.lat : null,
        lng: Number.isFinite(t.lng) ? t.lng : null,
        lines: Array.isArray(t.lines) ? t.lines.slice(0, 20).map((l) => str(l, 100)) : [],
        theme: str(t.theme, 40),
        goal: str(t.goal, 40) || null,
        memo: str(t.memo, 200),
        notes: Array.isArray(t.notes)
          ? t.notes
              .filter((n) => n && typeof n.text === 'string')
              .slice(0, 500)
              .map((n) => ({ id: str(n.id, 100) || newId(), text: str(n.text, 200), at: str(n.at, 40) }))
          : [],
        walkStartedAt: str(t.walkStartedAt, 40) || null,
        status: ['going', 'arrived', 'done'].includes(t.status) ? t.status : 'done',
        decidedAt: str(t.decidedAt, 40) || new Date().toISOString(),
        visitedAt: str(t.visitedAt, 40) || null,
        endedAt: str(t.endedAt, 40) || null,
      });
      tripCount++;
    }
    toast(`発見${count}件・おでかけ履歴${tripCount}件を読み込みました（同じ記録は上書き）`);
    router();
  } catch (err) {
    toast('読み込みに失敗しました：' + err.message, 4000);
  }
}

// ---------- 永続保存・Service Worker ----------

async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {
    /* noop */
  }
}

// 更新の反映：アプリを開いたとき・画面に戻ってきたときに新しい版を確認し、
// 新しい版に切り替わったら（入力途中でなければ）自動で再読み込みする。
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return; // 初回インストール時は再読み込み不要
    if (formDirty) {
      toast('新しいバージョンがあります。保存後に画面を開き直すと反映されます', 5000);
      return;
    }
    reloading = true;
    location.reload();
  });
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
      const check = () => reg?.update?.().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
      setInterval(check, 30 * 60 * 1000);
    } catch (err) {
      console.warn('SW registration failed', err);
    }
  });
}

window.addEventListener('beforeunload', (e) => {
  if (formDirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// 入力途中で別画面へ移動しようとしたときの確認（キャンセル時はハッシュを戻す）
let lastHash = location.hash;
window.addEventListener('hashchange', () => {
  if (leaveGuard && !leaveGuard()) {
    history.replaceState(null, '', lastHash);
    return;
  }
  leaveGuard = null;
  lastHash = location.hash;
  router();
});

showUpdateBanner();
router();
