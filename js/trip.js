// おでかけ（行き先を決めてから終えるまで）の状態。
// status: 'going' 移動中 → 'arrived' 散歩中（「着いた」で開始）→ 'done' 終了（「帰る」で終了）。
// 散歩の開始時刻は walkStartedAt（なければ visitedAt）、終了時刻は endedAt。
// notes: [{ id, text, at }] 散歩中のひとことメモ（時刻つき）。
// status を持たない古い履歴は終了扱いにする。
import * as db from './db.js';

export const STATUS_LABEL = { going: '移動中', arrived: '散歩中', done: '終了' };

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

const pad = (n) => String(n).padStart(2, '0');

export function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}分`;
  return `${Math.floor(min / 60)}時間${min % 60 ? `${min % 60}分` : ''}`;
}

export function walkStart(trip) {
  return trip.walkStartedAt || (trip.status !== 'going' ? trip.visitedAt : null) || null;
}

// 散歩の時間（終了していなければ今まで）
export function walkDuration(trip, now = Date.now()) {
  const start = walkStart(trip);
  if (!start) return null;
  const end = trip.endedAt ? Date.parse(trip.endedAt) : now;
  return end - Date.parse(start);
}

// 以前の「ひとことメモ（1つだけ）」はメモの1件目として扱う
export function tripNotes(trip) {
  const notes = Array.isArray(trip.notes) ? trip.notes : [];
  if (!notes.length && trip.memo) return [{ id: 'memo', text: trip.memo, at: trip.decidedAt }];
  return notes;
}

/**
 * 散歩の流れ（時刻順）：開始・ひとことメモ・発見・終了
 * @returns [{ at, kind: 'start'|'note'|'find'|'end', text, id?, item? }]
 */
export function timeline(trip, items = []) {
  const ev = [];
  const start = walkStart(trip);
  if (start) ev.push({ at: start, kind: 'start', text: `${trip.name}駅に着いて散歩開始` });
  for (const n of tripNotes(trip)) ev.push({ at: n.at, kind: 'note', text: n.text, id: n.id });
  // 発見は「発見した日時」（写真の撮影日時などで直したもの）の位置に並べる
  for (const it of items) {
    const t = it.foundAt ? Date.parse(it.foundAt) : NaN;
    ev.push({ at: Number.isFinite(t) ? new Date(t).toISOString() : it.createdAt, kind: 'find', text: it.title || '（無題の発見）', item: it });
  }
  if (trip.endedAt && start) ev.push({ at: trip.endedAt, kind: 'end', text: '帰る（散歩終了）' });
  return ev.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
