// 図鑑カテゴリ。hint は未発見のときに表示する「探し方のヒント」。
export const CATEGORIES = [
  { id: 'michishirube', icon: '🪧', name: '道標・道しるべ', color: '#b5651d',
    hint: '道の分かれ目に立つ、行き先や地名を刻んだ石や柱。' },
  { id: 'kyokai', icon: '🪨', name: '境界石・境界標', color: '#7a7a7a',
    hint: '足元に埋まった小さな石や金属標。「市」「町」の文字が残ることも。' },
  { id: 'sekibutsu', icon: '🗿', name: '石仏・庚申塔・道祖神', color: '#8d6e63',
    hint: '道端や辻にひっそり立つ石像や石塔。年号が刻まれていることが多い。' },
  { id: 'hokora', icon: '⛩️', name: '小さな祠・神社', color: '#c62828',
    hint: '住宅の間や路地の奥にある、地図に載らないような祠。' },
  { id: 'ankyo', icon: '💧', name: '暗渠・川の跡', color: '#1e88e5',
    hint: '不自然に曲がる細道、車止め、蓋をされた水路。昔は川だったかも。' },
  { id: 'kyudo', icon: '🛤️', name: '旧道・古道の痕跡', color: '#6d4c41',
    hint: '幹線道路と並ぶ細い道、切通し、一里塚。昔の人の通り道。' },
  { id: 'kanban', icon: '🏮', name: '古い看板・広告', color: '#ef6c00',
    hint: '旧い電話番号や右から書かれた文字、ホーロー看板。' },
  { id: 'manhole', icon: '⭕', name: 'マンホール・路上のふた', color: '#455a64',
    hint: '自治体ごとに違う絵柄、旧い町名、用途不明の小さなふた。' },
  { id: 'tomason', icon: '❓', name: '用途不明物（トマソン）', color: '#8e24aa',
    hint: 'どこにも行けない階段、塞がれた扉。役目を終えたのに残るもの。' },
  { id: 'kenchiku', icon: '🏚️', name: 'レトロ建築', color: '#5d4037',
    hint: '看板建築、洋館、古い蔵。建てられた年代を想像してみよう。' },
  { id: 'kinenhi', icon: '📜', name: '記念碑・説明板', color: '#558b2f',
    hint: '公園の隅や交差点の碑。何を記念しているか読んでみよう。' },
  { id: 'chimei', icon: '🏷️', name: '古い地名の名残', color: '#00897b',
    hint: 'バス停、橋、電柱の住所表示に残る、今は使われない地名。' },
  { id: 'shizen', icon: '🌳', name: '巨木・湧水・自然', color: '#2e7d32',
    hint: '神社の大木、崖下の湧き水、街なかに残る林。' },
  { id: 'kurashi', icon: '⚙️', name: '産業・暮らしの痕跡', color: '#546e7a',
    hint: '線路跡、工場の名残、井戸、火の見櫓。かつての暮らしの跡。' },
  { id: 'sonota', icon: '✨', name: 'その他の発見', color: '#f9a825',
    hint: 'どの分類にも入らない「なんだこれ？」。' },
];

const byId = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

export function getCategory(id) {
  return byId[id] || byId.sonota;
}
