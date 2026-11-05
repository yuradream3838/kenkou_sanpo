// おでかけ（行き先を決めてから終えるまで）の状態。
// status: 'going' 移動中 → 'arrived' 到着 → 'done' 終了。
// status を持たない古い履歴は終了扱いにする。
import * as db from './db.js';

export const STATUS_LABEL = { going: '移動中', arrived: '到着', done: '終了' };

export function isActive(trip) {
  return trip && (trip.status === 'going' || trip.status === 'arrived');
}

export async function getActiveTrip() {
  const trips = await db.getTrips();
  return trips.find(isActive) || null;
}

export function isIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// 地図アプリで、駅までの行き方（電車）を開くリンク。駅名ではなく座標で指定する（名前だと場所が特定できないことがあるため）。
export function directionsUrls({ lat, lng }) {
  return {
    google: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=transit`,
    apple: `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=r`,
  };
}
