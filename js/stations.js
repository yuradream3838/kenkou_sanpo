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
 */
export function candidates(stations, { base = null, minKm = 0, maxKm = Infinity, exclude = new Set() } = {}) {
  return stations
    .filter((s) => !exclude.has(s.n))
    .map((s) => ({ ...s, km: base ? distanceKm(base, s) : null }))
    .filter((s) => s.km === null || (s.km >= minKm && s.km <= maxKm));
}

// 暗号論的乱数で一様に 1 つ選ぶ
export function pickRandom(list) {
  if (!list.length) return null;
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return list[buf[0] % list.length];
}
