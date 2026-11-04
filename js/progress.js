// 経験値は「歩いた距離」ではなく「調べた深さ」で決まる。
import { CATEGORIES } from './categories.js';

export const DEPTHS = [
  { key: 'found', label: '見つけた', xp: 10, desc: '写真か場所を記録した' },
  { key: 'noticed', label: '気づいた', xp: 20, desc: '気になった点や仮説を書いた' },
  { key: 'researched', label: '調べた', xp: 30, desc: '調べて分かったことを書いた' },
  { key: 'verified', label: '裏付けた', xp: 50, desc: '出典付きで確かめた' },
];

export const FIRST_IN_CATEGORY_BONUS = 30;

const filled = (s) => typeof s === 'string' && s.trim().length > 0;

export function depthOf(item) {
  const reached = [];
  if (item.photo || item.location || filled(item.title)) reached.push('found');
  if (filled(item.noticed) || filled(item.hypothesis)) reached.push('noticed');
  if (filled(item.findings)) reached.push('researched');
  if (filled(item.findings) && (item.sources || []).some((s) => filled(s.title) || filled(s.url))) {
    reached.push('verified');
  }
  return reached;
}

export function depthLevel(item) {
  return depthOf(item).length; // 0-4
}

export function xpOf(item) {
  const reached = new Set(depthOf(item));
  return DEPTHS.filter((d) => reached.has(d.key)).reduce((sum, d) => sum + d.xp, 0);
}

// レベル L に必要な累計経験値 = 50 * L * (L - 1)
export function levelFromXp(xp) {
  let level = 1;
  while (50 * (level + 1) * level <= xp) level++;
  const current = 50 * level * (level - 1);
  const next = 50 * (level + 1) * level;
  return { level, current, next, progress: (xp - current) / (next - current) };
}

const TITLES = [
  [1, '散歩ビギナー'],
  [3, '路上の観察者'],
  [5, '街の調査員'],
  [8, '地域の探究者'],
  [12, '街の語り部'],
  [20, '痕跡読みの達人'],
];

export function titleFor(level) {
  let t = TITLES[0][1];
  for (const [lv, name] of TITLES) if (level >= lv) t = name;
  return t;
}

export function summarize(items) {
  let xp = 0;
  const catCounts = Object.fromEntries(CATEGORIES.map((c) => [c.id, 0]));
  const days = new Set();
  let verified = 0;
  for (const it of items) {
    xp += xpOf(it);
    catCounts[it.category] = (catCounts[it.category] || 0) + 1;
    if (it.foundAt) days.add(it.foundAt.slice(0, 10));
    if (depthLevel(it) === 4) verified++;
  }
  const discoveredCats = Object.values(catCounts).filter((n) => n > 0).length;
  xp += discoveredCats * FIRST_IN_CATEGORY_BONUS;
  return {
    xp,
    ...levelFromXp(xp),
    title: titleFor(levelFromXp(xp).level),
    total: items.length,
    days: days.size,
    verified,
    catCounts,
    discoveredCats,
  };
}
