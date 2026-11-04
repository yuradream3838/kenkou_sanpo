// 地図は国土地理院の地図タイル（出典表示が必要）を使用する。
/* global L */
const GSI_ATTRIBUTION =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>';

// 初期表示は神奈川県のおおよその中心
export const DEFAULT_CENTER = [35.4478, 139.6425];
export const DEFAULT_ZOOM = 10;

export function createMap(el, { center = DEFAULT_CENTER, zoom = DEFAULT_ZOOM } = {}) {
  const map = L.map(el, { zoomControl: true, attributionControl: true }).setView(center, zoom);
  const pale = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
    attribution: GSI_ATTRIBUTION,
    maxZoom: 18,
    minZoom: 5,
  });
  const std = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
    attribution: GSI_ATTRIBUTION,
    maxZoom: 18,
    minZoom: 5,
  });
  const photo = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', {
    attribution: GSI_ATTRIBUTION,
    maxZoom: 18,
    minZoom: 5,
  });
  pale.addTo(map);
  L.control.layers({ 淡色地図: pale, 標準地図: std, 航空写真: photo }, null, { position: 'topright' }).addTo(map);
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
