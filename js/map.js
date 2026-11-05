// 地図は国土地理院の地図タイル（出典表示が必要）を使用する。
/* global L */
const GSI_ATTRIBUTION =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" rel="noopener">国土地理院</a>';

// 初期表示は神奈川県のおおよその中心
export const DEFAULT_CENTER = [35.4478, 139.6425];
export const DEFAULT_ZOOM = 10;

const GSI = 'https://cyberjapandata.gsi.go.jp/xyz';

// 地図の種類。maxNativeZoom を超えて拡大したときは画像を引き伸ばして表示する。
export const LAYERS = {
  pale: { name: '淡色地図', url: `${GSI}/pale/{z}/{x}/{y}.png`, minNativeZoom: 5, maxNativeZoom: 18 },
  std: { name: '標準地図', url: `${GSI}/std/{z}/{x}/{y}.png`, minNativeZoom: 5, maxNativeZoom: 18 },
  photo: { name: '航空写真（最新）', url: `${GSI}/seamlessphoto/{z}/{x}/{y}.jpg`, minNativeZoom: 5, maxNativeZoom: 18 },
  relief: { name: '色別標高図（土地の高さ）', url: `${GSI}/relief/{z}/{x}/{y}.png`, minNativeZoom: 5, maxNativeZoom: 15 },
  hillshade: { name: '陰影起伏図（地形の凹凸）', url: `${GSI}/hillshademap/{z}/{x}/{y}.png`, minNativeZoom: 5, maxNativeZoom: 16 },
  old1960: { name: '昔の航空写真（1961〜69年）', url: `${GSI}/ort_old10/{z}/{x}/{y}.png`, minNativeZoom: 10, maxNativeZoom: 17 },
  old1945: { name: '昔の航空写真（1945〜50年）', url: `${GSI}/ort_USA10/{z}/{x}/{y}.png`, minNativeZoom: 10, maxNativeZoom: 17 },
};

export function layerName(key) {
  return LAYERS[key]?.name || '';
}

export function createMap(el, { center = DEFAULT_CENTER, zoom = DEFAULT_ZOOM, layer = 'pale' } = {}) {
  const map = L.map(el, { zoomControl: true, attributionControl: true }).setView(center, zoom);
  const tiles = {};
  for (const [key, def] of Object.entries(LAYERS)) {
    tiles[def.name] = L.tileLayer(def.url, {
      attribution: GSI_ATTRIBUTION,
      minZoom: 5,
      maxZoom: 18,
      minNativeZoom: def.minNativeZoom,
      maxNativeZoom: def.maxNativeZoom,
    });
    tiles[def.name]._layerKey = key;
  }
  (tiles[layerName(layer)] || tiles[LAYERS.pale.name]).addTo(map);
  L.control.layers(tiles, null, { position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  return map;
}

export function categoryMarker(latlng, color) {
  return L.circleMarker(latlng, {
    radius: 9,
    color: '#fff',
    weight: 2,
    fillColor: color,
    fillOpacity: 0.95,
  });
}
