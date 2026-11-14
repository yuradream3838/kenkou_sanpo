<?php
// 発見ノート AI 用の窓口（ai.php） v1 — 読み取り専用
// 他の AI（Claude・ChatGPT・Gemini など）が記録を読むための URL。
//   https://（置いた場所）/ai.php?t=AI用トークン
// トークン（64桁の16進）の SHA-256 が config.php の SANPO_READ_HASH と一致したときだけ読める。書き換え・削除はできない。
// 既定は Markdown（text/plain）。&fmt=json で JSON。
//
//   （なし）                       案内・データの説明・最近の散歩と発見
//   &a=walks[&page=]               散歩（おでかけ）の一覧
//   &a=walk&id=                    1 回の散歩：時刻つきの記録・発見・写真
//   &a=finds[&cat=&feel=&from=&to=&page=]   発見の一覧（種類・気持ち・期間で絞り込み。from/to は YYYY-MM-DD）
//   &a=find&id=                    発見 1 件
//   &a=search&q=                   キーワード検索（発見と散歩のメモ）
//   &a=img&id=&size=photo|thumb    写真（JPEG）

require __DIR__ . '/common.php';

const PER_PAGE = 50;

if ($SANPO_CONFIG_ERROR) out(500, ['error' => $SANPO_CONFIG_ERROR, 'message' => 'サーバの config.php を確認してください。']);

$token = $_GET['t'] ?? '';
if (!tokenMatches($token, SANPO_READ_HASH)) {
  usleep(400000);
  out(401, ['error' => 'auth', 'message' => 'トークンが違うか、AI 用の窓口が有効になっていません。']);
}

$fmt = ($_GET['fmt'] ?? '') === 'json' ? 'json' : 'md';
$a = $_GET['a'] ?? 'index';

// ---- URL ----
$https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
$self = ($https ? 'https' : 'http') . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost') . ($_SERVER['SCRIPT_NAME'] ?? '/ai.php');
function u(array $q = []): string {
  global $self, $token, $fmt;
  $q = array_merge(['t' => $token], $q);
  if ($fmt === 'json' && !isset($q['size'])) $q['fmt'] = 'json';
  return $self . '?' . http_build_query($q);
}
function imgUrl(string $id, string $size = 'photo'): string {
  global $self, $token;
  return $self . '?' . http_build_query(['t' => $token, 'a' => 'img', 'id' => $id, 'size' => $size]);
}

// ---- 写真 ----
if ($a === 'img') {
  $id = safeId($_GET['id'] ?? null);
  $size = $_GET['size'] ?? 'photo';
  if ($id === null || !in_array($size, ['photo', 'thumb'], true)) out(400, ['error' => 'id']);
  $path = photoPath($id, $size);
  if (!file_exists($path)) out(404, ['error' => 'none']);
  header('Content-Type: image/jpeg');
  header('Content-Length: ' . filesize($path));
  readfile($path);
  exit;
}

// ---- データを読む ----
function live(string $kind): array {
  $out = [];
  foreach (allRecords($kind) as $r) {
    if (!empty($r['deleted']) || !is_array($r['data'] ?? null)) continue;
    $d = $r['data'];
    if (!empty($d['hideFromAi'])) continue;   // 「AI に見せない」
    $out[$d['id'] ?? $r['id']] = $d;
  }
  return $out;
}
$finds = live('d');
$walks = live('t');

function s($v): string { return is_string($v) ? trim($v) : ''; }
function lbl(array $d, string $k): string { return s($d['labels'][$k] ?? ''); }

// 日時を日本時間で（"2026-11-03T14:22"（端末の時刻）や ISO 形式の両方を受ける）
function jst($v): string {
  $v = s($v);
  if ($v === '') return '';
  if (preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/', $v)) return str_replace('T', ' ', $v);
  $t = strtotime($v);
  return $t ? date('Y-m-d H:i', $t) : $v;
}
function sortKeyFind(array $d): string { return jst($d['foundAt'] ?? '') ?: jst($d['createdAt'] ?? ''); }
function sortKeyWalk(array $d): string { return jst($d['walkStartedAt'] ?? '') ?: jst($d['visitedAt'] ?? '') ?: jst($d['decidedAt'] ?? ''); }

uasort($finds, fn($x, $y) => strcmp(sortKeyFind($y), sortKeyFind($x)));
uasort($walks, fn($x, $y) => strcmp(sortKeyWalk($y), sortKeyWalk($x)));

function minutesBetween($a, $b): ?int {
  $ta = strtotime(s($a)); $tb = strtotime(s($b));
  return ($ta && $tb && $tb >= $ta) ? (int)round(($tb - $ta) / 60) : null;
}
function durationText(?int $min): string {
  if ($min === null) return '';
  return $min < 60 ? "{$min}分" : intdiv($min, 60) . '時間' . ($min % 60 ? ($min % 60) . '分' : '');
}
function walkStatus(array $w): string {
  return ['going' => '移動中', 'arrived' => '散歩中', 'done' => '終了'][$w['status'] ?? 'done'] ?? '終了';
}

// AI に渡す形（JSON）
function findOut(array $d): array {
  return [
    'id' => $d['id'] ?? '',
    'title' => s($d['title'] ?? ''),
    'category' => ['id' => $d['category'] ?? '', 'name' => lbl($d, 'category'), 'group' => lbl($d, 'group')],
    'feelings' => $d['labels']['feelings'] ?? [],
    'foundAt' => jst($d['foundAt'] ?? ''),
    'location' => is_array($d['location'] ?? null) ? ['lat' => $d['location']['lat'] ?? null, 'lng' => $d['location']['lng'] ?? null] : null,
    'noticed' => s($d['noticed'] ?? ''),
    'hypothesis' => s($d['hypothesis'] ?? ''),
    'findings' => s($d['findings'] ?? ''),
    'sources' => $d['sources'] ?? [],
    'confidence' => lbl($d, 'confidence'),
    'walkId' => $d['tripId'] ?? null,
    'photos' => array_map(fn($p) => ['url' => imgUrl($p), 'thumb' => imgUrl($p, 'thumb')], $d['photos'] ?? []),
    'url' => u(['a' => 'find', 'id' => $d['id'] ?? '']),
  ];
}
function walkOut(array $w, array $finds): array {
  $start = $w['walkStartedAt'] ?? (($w['status'] ?? '') !== 'going' ? ($w['visitedAt'] ?? null) : null);
  $mine = array_values(array_filter($finds, fn($f) => ($f['tripId'] ?? null) === ($w['id'] ?? '')));
  return [
    'id' => $w['id'] ?? '',
    'station' => s($w['name'] ?? ''),
    'lines' => $w['lines'] ?? [],
    'status' => walkStatus($w),
    'goal' => lbl($w, 'goal'),
    'decidedAt' => jst($w['decidedAt'] ?? ''),
    'walkStartedAt' => jst($start),
    'endedAt' => jst($w['endedAt'] ?? ''),
    'walkMinutes' => !empty($w['endedAt']) ? minutesBetween($start, $w['endedAt']) : null,
    'notes' => array_map(fn($n) => ['at' => jst($n['at'] ?? ''), 'text' => s($n['text'] ?? '')], $w['notes'] ?? []),
    'findIds' => array_map(fn($f) => $f['id'], $mine),
    'url' => u(['a' => 'walk', 'id' => $w['id'] ?? '']),
  ];
}

// ---- Markdown ----
function md(string $text): void {
  header('Content-Type: text/plain; charset=utf-8');
  echo $text;
  exit;
}
function line(string $label, string $value): string { return $value === '' ? '' : "- {$label}：{$value}\n"; }
function findLine(array $d): string {
  $title = s($d['title'] ?? '') ?: '（無題の発見）';
  $bits = array_filter([lbl($d, 'category'), sortKeyFind($d), implode('・', $d['labels']['feelings'] ?? [])]);
  return "- [{$title}](" . u(['a' => 'find', 'id' => $d['id'] ?? '']) . ")（" . implode(' ／ ', $bits) . "）\n";
}
function walkLine(array $w, array $finds): string {
  $o = walkOut($w, $finds);
  $bits = array_filter([$o['walkStartedAt'] ?: $o['decidedAt'], $o['status'], $o['walkMinutes'] !== null ? '散歩 ' . durationText($o['walkMinutes']) : '', '発見 ' . count($o['findIds']) . '件', $o['goal'] ? '目的：' . $o['goal'] : '']);
  return "- [{$o['station']}駅](" . $o['url'] . ")（" . implode(' ／ ', $bits) . "）\n";
}
function findMd(array $d, array $walks, int $level = 2): string {
  $o = findOut($d);
  $h = str_repeat('#', $level);
  $t = "{$h} " . ($o['title'] ?: '（無題の発見）') . "\n\n";
  $t .= line('種類', trim($o['category']['name'] . ($o['category']['group'] ? "（{$o['category']['group']}）" : '')));
  $t .= line('発見した日時', $o['foundAt']);
  if ($o['location']) {
    $la = $o['location']['lat']; $lo = $o['location']['lng'];
    $t .= line('場所', "{$la}, {$lo}（地図: https://maps.gsi.go.jp/#17/{$la}/{$lo}/ ）");
  }
  $t .= line('気持ち', implode('、', $o['feelings']));
  if ($o['walkId'] && isset($walks[$o['walkId']])) {
    $w = $walks[$o['walkId']];
    $t .= line('散歩', '[' . s($w['name'] ?? '') . '駅へのおでかけ](' . u(['a' => 'walk', 'id' => $o['walkId']]) . ')');
  }
  $t .= line('確信度', $o['confidence']);
  foreach (['noticed' => '気づいたこと', 'hypothesis' => '仮説', 'findings' => '調べて分かったこと'] as $k => $label) {
    if ($o[$k] !== '') $t .= "\n{$h}# {$label}\n\n" . $o[$k] . "\n";
  }
  if ($o['sources']) {
    $t .= "\n{$h}# 出典\n\n";
    foreach ($o['sources'] as $src) {
      $title = s($src['title'] ?? ''); $url = s($src['url'] ?? '');
      $t .= '- ' . ($title ?: $url) . ($url && $title ? " <{$url}>" : '') . "\n";
    }
  }
  if ($o['photos']) {
    $t .= "\n{$h}# 写真（" . count($o['photos']) . "枚）\n\n";
    foreach ($o['photos'] as $i => $p) $t .= "- 写真" . ($i + 1) . ": " . $p['url'] . "\n";
  }
  return $t;
}

function paged(array $list): array {
  $page = max(1, (int)($_GET['page'] ?? 1));
  return [array_slice($list, ($page - 1) * PER_PAGE, PER_PAGE), $page, (int)ceil(count($list) / PER_PAGE)];
}
function pageNav(array $q, int $page, int $pages): string {
  if ($pages <= 1) return '';
  $t = "\n{$page} / {$pages} ページ";
  if ($page < $pages) $t .= "　次のページ: " . u($q + ['page' => $page + 1]);
  return $t . "\n";
}

// ---- 案内 ----
if ($a === 'index') {
  if ($fmt === 'json') {
    out(200, [
      'app' => '発見ノート（散歩で見つけたものを調べて記録するアプリ）',
      'counts' => ['finds' => count($finds), 'walks' => count($walks)],
      'recentWalks' => array_map(fn($w) => walkOut($w, $finds), array_slice(array_values($walks), 0, 5)),
      'recentFinds' => array_map('findOut', array_slice(array_values($finds), 0, 10)),
      'endpoints' => [
        'walks' => u(['a' => 'walks']), 'finds' => u(['a' => 'finds']),
        'search' => u(['a' => 'search', 'q' => 'キーワード']),
      ],
    ]);
  }
  $t = "# 発見ノート — AI 向けの案内\n\n";
  $t .= "これは、持ち主が散歩（おでかけ）の中で見つけたものを写真・気づき・仮説・調べたことと一緒に記録した「発見ノート」のデータです（読み取り専用）。\n";
  $t .= "日時はすべて日本時間です。写真は長い辺 1600px で、撮影位置などの情報は消してあります。\n\n";
  $t .= "## 言葉の意味\n\n";
  $t .= "- 発見：散歩で見つけたもの 1 件。種類（道標・暗渠・喫茶店など）、気持ち（きれい・なつかしい など）、気づいたこと、仮説、調べて分かったこと、出典、確信度（推測／ほぼ確実／出典あり）、写真を持つ。\n";
  $t .= "- 散歩（おでかけ）：駅を決めて出かけた 1 回分。目的（探す種類）、散歩の開始・終了時刻、時刻つきのひとことメモ、そのときの発見を持つ。\n\n";
  $t .= "## 件数\n\n- 発見：" . count($finds) . " 件\n- 散歩：" . count($walks) . " 回\n\n";
  $t .= "## 最近の散歩\n\n" . (implode('', array_map(fn($w) => walkLine($w, $finds), array_slice(array_values($walks), 0, 5))) ?: "（まだありません）\n");
  $t .= "\n## 最近の発見\n\n" . (implode('', array_map('findLine', array_slice(array_values($finds), 0, 10))) ?: "（まだありません）\n");
  $t .= "\n## ほかの URL\n\n";
  $t .= "- 散歩の一覧: " . u(['a' => 'walks']) . "\n";
  $t .= "- 発見の一覧: " . u(['a' => 'finds']) . "\n";
  $t .= "- 発見の絞り込み: " . u(['a' => 'finds']) . "&cat=種類ID&feel=気持ちの名前&from=YYYY-MM-DD&to=YYYY-MM-DD\n";
  $t .= "- 検索: " . u(['a' => 'search', 'q' => 'キーワード']) . "\n";
  $t .= "- どの URL も末尾に &fmt=json を付けると JSON で返します。\n";
  md($t);
}

// ---- 散歩 ----
if ($a === 'walks') {
  [$list, $page, $pages] = paged(array_values($walks));
  if ($fmt === 'json') out(200, ['total' => count($walks), 'page' => $page, 'pages' => $pages, 'items' => array_map(fn($w) => walkOut($w, $finds), $list)]);
  md("# 散歩の一覧（" . count($walks) . " 回・新しい順）\n\n" . (implode('', array_map(fn($w) => walkLine($w, $finds), $list)) ?: "（まだありません）\n") . pageNav(['a' => 'walks'], $page, $pages));
}

if ($a === 'walk') {
  $id = safeId($_GET['id'] ?? null);
  if ($id === null || !isset($walks[$id])) out(404, ['error' => 'none']);
  $w = $walks[$id];
  $o = walkOut($w, $finds);
  $mine = array_filter($finds, fn($f) => ($f['tripId'] ?? null) === $id);
  if ($fmt === 'json') out(200, $o + ['finds' => array_map('findOut', array_values($mine))]);
  $t = "# {$o['station']}駅への散歩\n\n";
  $t .= line('路線', implode('、', $o['lines']));
  $t .= line('状態', $o['status']);
  $t .= line('目的', $o['goal'] ? $o['goal'] . 'を探す' : '自由に歩く');
  $t .= line('散歩の開始', $o['walkStartedAt']);
  $t .= line('散歩の終了', $o['endedAt']);
  $t .= line('散歩の時間', durationText($o['walkMinutes']));
  // 時刻順の記録
  $ev = [];
  if ($o['walkStartedAt']) $ev[] = [$o['walkStartedAt'], '散歩開始'];
  foreach ($o['notes'] as $n) $ev[] = [$n['at'], 'メモ：' . $n['text']];
  foreach ($mine as $f) $ev[] = [sortKeyFind($f), '発見：[' . (s($f['title'] ?? '') ?: '（無題の発見）') . '](' . u(['a' => 'find', 'id' => $f['id']]) . ')（' . lbl($f, 'category') . '）'];
  if ($o['endedAt']) $ev[] = [$o['endedAt'], '散歩終了'];
  usort($ev, fn($x, $y) => strcmp($x[0], $y[0]));
  if ($ev) {
    $t .= "\n## 時刻順の記録\n\n";
    foreach ($ev as [$at, $text]) $t .= "- " . substr($at, 11, 5) . " {$text}\n";
  }
  if ($mine) {
    $t .= "\n## この散歩の発見\n\n";
    foreach ($mine as $f) $t .= "\n" . findMd($f, $walks, 3);
  }
  md($t);
}

// ---- 発見 ----
function filterFinds(array $finds): array {
  $cat = s($_GET['cat'] ?? ''); $feel = s($_GET['feel'] ?? '');
  $from = s($_GET['from'] ?? ''); $to = s($_GET['to'] ?? '');
  return array_values(array_filter($finds, function ($d) use ($cat, $feel, $from, $to) {
    if ($cat !== '' && ($d['category'] ?? '') !== $cat && lbl($d, 'category') !== $cat) return false;
    if ($feel !== '' && !in_array($feel, $d['labels']['feelings'] ?? [], true) && !in_array($feel, $d['feelings'] ?? [], true)) return false;
    $day = substr(sortKeyFind($d), 0, 10);
    if ($from !== '' && $day < $from) return false;
    if ($to !== '' && $day > $to) return false;
    return true;
  }));
}

if ($a === 'finds') {
  $all = filterFinds($finds);
  [$list, $page, $pages] = paged($all);
  if ($fmt === 'json') out(200, ['total' => count($all), 'page' => $page, 'pages' => $pages, 'items' => array_map('findOut', $list)]);
  $q = array_filter(['a' => 'finds', 'cat' => $_GET['cat'] ?? '', 'feel' => $_GET['feel'] ?? '', 'from' => $_GET['from'] ?? '', 'to' => $_GET['to'] ?? '']);
  md("# 発見の一覧（" . count($all) . " 件・新しい順）\n\n" . (implode('', array_map('findLine', $list)) ?: "（条件に合う発見はありません）\n") . pageNav($q, $page, $pages));
}

if ($a === 'find') {
  $id = safeId($_GET['id'] ?? null);
  if ($id === null || !isset($finds[$id])) out(404, ['error' => 'none']);
  if ($fmt === 'json') out(200, findOut($finds[$id]));
  md(findMd($finds[$id], $walks, 1));
}

// ---- 検索 ----
if ($a === 'search') {
  $q = s($_GET['q'] ?? '');
  if ($q === '') out(400, ['error' => 'q']);
  $hitFinds = array_values(array_filter($finds, function ($d) use ($q) {
    $text = implode(' ', [s($d['title'] ?? ''), s($d['noticed'] ?? ''), s($d['hypothesis'] ?? ''), s($d['findings'] ?? ''), lbl($d, 'category')]);
    return mb_stripos($text, $q) !== false;
  }));
  $hitNotes = [];
  foreach ($walks as $w) foreach ($w['notes'] ?? [] as $n) {
    if (mb_stripos(s($n['text'] ?? ''), $q) !== false) $hitNotes[] = ['walk' => $w, 'note' => $n];
  }
  if ($fmt === 'json') {
    out(200, ['q' => $q, 'finds' => array_map('findOut', $hitFinds), 'notes' => array_map(fn($h) => [
      'at' => jst($h['note']['at'] ?? ''), 'text' => s($h['note']['text'] ?? ''), 'walk' => u(['a' => 'walk', 'id' => $h['walk']['id']]),
    ], $hitNotes)]);
  }
  $t = "# 「{$q}」の検索結果\n\n## 発見（" . count($hitFinds) . " 件）\n\n" . (implode('', array_map('findLine', $hitFinds)) ?: "（なし）\n");
  $t .= "\n## 散歩のメモ（" . count($hitNotes) . " 件）\n\n";
  foreach ($hitNotes as $h) {
    $t .= "- " . jst($h['note']['at'] ?? '') . " " . s($h['note']['text'] ?? '') . "（[" . s($h['walk']['name'] ?? '') . "駅の散歩](" . u(['a' => 'walk', 'id' => $h['walk']['id']]) . ")）\n";
  }
  if (!$hitNotes) $t .= "（なし）\n";
  md($t);
}

out(400, ['error' => 'action']);
