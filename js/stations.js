// 駅データ（国土数値情報 鉄道データを加工）の読み込みと、行き先の抽選。
// 都道府県を増やすときは data/stations/<都道府県コード>.json を追加し、PREFECTURES に登録する。
export const PREFECTURES = [{ code: '14', name: '神奈川県', file: 'data/stations/14.json' }];

const cache = new Map();

export async function loadStations(code = '14') {
  if (cache.has(code)) return cache.get(code);
  const pref = PREFECTURES.find((p) => p.code === code);
  if (!pref) throw new Error('未対応の都道府県です');
  const res = await fetch(pref.file);
  if (!res.ok) throw new Error('駅データを読み込めませんでした');
  const data = await res.json();
  cache.set(code, data);
  return data;
}

// 2 点間の距離（km）
export function distanceKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * 条件に合う駅の候補を返す。
 * @param {Array} stations 駅一覧
 * @param {Object} opt
 *   base: {lat,lng}|null   基準地点（null なら県内すべて）
 *   minKm, maxKm           基準地点からの距離の範囲
 *   exclude: Set<string>   除外する駅名
 *   lines: Set<string>     指定した路線のどれかを通る駅だけ（空なら絞らない）
 *   sameLineAs: string[]   この路線のどれかを通る駅だけ（乗り換えなし。空なら絞らない）
 */
export function candidates(
  stations,
  { base = null, minKm = 0, maxKm = Infinity, exclude = new Set(), lines = new Set(), sameLineAs = [] } = {}
) {
  const same = new Set(sameLineAs);
  return stations
    .filter((s) => !exclude.has(s.n))
    .filter((s) => !lines.size || s.l.some((l) => lines.has(l)))
    .filter((s) => !same.size || s.l.some((l) => same.has(l)))
    .map((s) => ({ ...s, km: base ? distanceKm(base, s) : null }))
    .filter((s) => s.km === null || (s.km >= minKm && s.km <= maxKm));
}

// 指定地点から一番近い駅
export function nearestStation(stations, point) {
  let best = null;
  let bestKm = Infinity;
  for (const s of stations) {
    const km = distanceKm(point, s);
    if (km < bestKm) {
      best = s;
      bestKm = km;
    }
  }
  return best ? { ...best, km: bestKm } : null;
}

// 路線を運営会社ごとにまとめる（表示用）
const OPERATOR_ORDER = ['JR東日本', 'JR東海', '小田急', '京急', '東急', '相鉄', '京王', '横浜市営地下鉄', 'みなとみらい線',
  'シーサイドライン', '江ノ電', '湘南モノレール', '箱根登山鉄道', '伊豆箱根鉄道', '大山観光電鉄'];

export function lineGroups(stations) {
  const counts = new Map();
  for (const s of stations) for (const l of s.l) counts.set(l, (counts.get(l) || 0) + 1);
  const groups = new Map();
  for (const [label, count] of counts) {
    const i = label.indexOf(' ');
    const op = i < 0 ? label : label.slice(0, i);
    const name = i < 0 ? label : label.slice(i + 1);
    if (!groups.has(op)) groups.set(op, []);
    groups.get(op).push({ label, name, count });
  }
  const rank = (op) => (OPERATOR_ORDER.includes(op) ? OPERATOR_ORDER.indexOf(op) : 99);
  return [...groups.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0], 'ja'))
    .map(([op, lines]) => ({ op, lines: lines.sort((a, b) => b.count - a.count) }));
}

// 暗号論的乱数で一様に 1 つ選ぶ
export function pickRandom(list) {
  if (!list.length) return null;
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return list[buf[0] % list.length];
}
