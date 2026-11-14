<?php
// 発見ノート ☁️ 同期サーバ（sync.php） v1
// アプリ（スマホ・PC）が記録と写真を預け、ほかの端末で受け取るための窓口。
// 置き方：sync.php・ai.php・common.php・config.php（config.php.example を元に作る）を同じフォルダに置く。
//
// 認証：ヘッダ X-Sync-Auth（64桁の16進）の SHA-256 が config.php の SANPO_AUTH_HASH と一致すること。
// 操作（?a=）
//   meta              GET   {rev}
//   changes&since=N   GET   {rev, items:[記録…]}（N より後に変わった記録。N=0 ならすべて）
//   put               POST  {device, items:[{kind, id, updatedAt, deleted, data}]} → {rev, accepted:[キー], rejected:[サーバの記録]}
//                           updatedAt がサーバのものより古い記録は保存せず rejected で返す（新しいほうを残す）
//   pmissing          POST  {ids:[写真ID]} → {missing:[サーバにまだ無い写真ID]}
//   pput&id=&size=    POST  本文＝JPEG（size は photo か thumb）。同じものがあれば何もしない
//   photo&id=&size=   GET   写真（JPEG）

require __DIR__ . '/common.php';

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($origin, SANPO_ALLOWED_ORIGINS, true)) {
  header('Access-Control-Allow-Origin: ' . $origin);
  header('Vary: Origin');
  header('Access-Control-Allow-Headers: X-Sync-Auth, X-Device, Content-Type');
  header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
  header('Access-Control-Max-Age: 600');
}
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }
if ($origin !== '' && !in_array($origin, SANPO_ALLOWED_ORIGINS, true)) out(403, ['error' => 'origin']);

if (!tokenMatches($_SERVER['HTTP_X_SYNC_AUTH'] ?? '', SANPO_AUTH_HASH)) {
  usleep(400000);
  out(401, ['error' => 'auth']);
}

$a = $_GET['a'] ?? 'meta';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$device = mb_substr(rawurldecode((string)($_SERVER['HTTP_X_DEVICE'] ?? '')), 0, 40);

function readBody(int $max): string {
  $len = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
  if ($len > $max) out(413, ['error' => 'too_large']);
  $body = (string)file_get_contents('php://input');
  if (strlen($body) > $max) out(413, ['error' => 'too_large']);
  return $body;
}

function readJsonBody(): array {
  $j = json_decode(readBody(SANPO_MAX_JSON_BYTES), true);
  if (!is_array($j)) out(400, ['error' => 'format']);
  return $j;
}

if ($a === 'meta') {
  out(200, ['rev' => currentRev()]);
}

// 変わった記録を返す
if ($a === 'changes') {
  if ($method !== 'GET') out(405, ['error' => 'method']);
  $since = (int)($_GET['since'] ?? 0);
  $rev = currentRev();
  $items = [];
  if ($since <= 0) {
    foreach (SANPO_KINDS as $k) foreach (allRecords($k) as $r) $items[] = $r;
  } else {
    $seen = [];
    $log = dataDir() . '/changes.log';
    $fh = file_exists($log) ? @fopen($log, 'r') : false;
    if ($fh) {
      while (($line = fgets($fh)) !== false) {
        $p = explode("\t", rtrim($line, "\n"));
        if (count($p) !== 3 || (int)$p[0] <= $since) continue;
        $seen[$p[1] . ':' . $p[2]] = [$p[1], $p[2]];
      }
      fclose($fh);
    }
    foreach ($seen as [$k, $id]) {
      if (!in_array($k, SANPO_KINDS, true) || safeId($id) === null) continue;
      $r = readRecord($k, $id);
      if ($r) $items[] = $r;
    }
  }
  out(200, ['rev' => $rev, 'items' => $items]);
}

// 記録を預ける（新しいほうを残す）
if ($a === 'put') {
  if ($method !== 'POST') out(405, ['error' => 'method']);
  $j = readJsonBody();
  $in = $j['items'] ?? null;
  if (!is_array($in) || count($in) > 500) out(400, ['error' => 'items']);
  $dir = dataDir();
  $lock = @fopen($dir . '/lock', 'c');
  if (!$lock || !flock($lock, LOCK_EX)) out(500, ['error' => 'lock']);
  $rev = currentRev();
  $accepted = [];
  $rejected = [];
  $logLines = '';
  $now = date('c');
  foreach ($in as $it) {
    $kind = $it['kind'] ?? '';
    $id = safeId($it['id'] ?? null);
    $updatedAt = $it['updatedAt'] ?? '';
    if (!in_array($kind, SANPO_KINDS, true) || $id === null || !is_string($updatedAt)
        || !preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/', $updatedAt)) {
      continue;
    }
    $deleted = !empty($it['deleted']);
    $data = $deleted ? null : ($it['data'] ?? null);
    if (!$deleted && !is_array($data)) continue;
    $cur = readRecord($kind, $id);
    $key = $kind . ':' . $id;
    if ($cur && strcmp((string)($cur['updatedAt'] ?? ''), $updatedAt) > 0) {
      $rejected[] = $cur;   // サーバのほうが新しい
      continue;
    }
    if ($cur && (string)($cur['updatedAt'] ?? '') === $updatedAt && (bool)($cur['deleted'] ?? false) === $deleted) {
      $accepted[] = $key;   // 同じものをもう一度送ってきた
      continue;
    }
    $rev++;
    $rec = [
      'kind' => $kind, 'id' => $id, 'updatedAt' => $updatedAt, 'deleted' => $deleted,
      'rev' => $rev, 'savedAt' => $now, 'device' => $device, 'data' => $data,
    ];
    if (!writeAtomic(recordPath($kind, $id), json_encode($rec, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES))) {
      flock($lock, LOCK_UN);
      out(500, ['error' => 'write']);
    }
    $logLines .= $rev . "\t" . $kind . "\t" . $id . "\n";
    $accepted[] = $key;
  }
  if ($logLines !== '') {
    @file_put_contents($dir . '/changes.log', $logLines, FILE_APPEND);
    writeAtomic($dir . '/rev.txt', (string)$rev);
  }
  flock($lock, LOCK_UN);
  out(200, ['rev' => $rev, 'accepted' => $accepted, 'rejected' => $rejected]);
}

// サーバにまだ無い写真
if ($a === 'pmissing') {
  if ($method !== 'POST') out(405, ['error' => 'method']);
  $j = readJsonBody();
  $ids = $j['ids'] ?? null;
  if (!is_array($ids) || count($ids) > 2000) out(400, ['error' => 'ids']);
  $missing = [];
  foreach ($ids as $id) {
    $id = safeId($id);
    if ($id === null) continue;
    if (!file_exists(photoPath($id, 'photo')) || !file_exists(photoPath($id, 'thumb'))) $missing[] = $id;
  }
  out(200, ['missing' => array_values(array_unique($missing))]);
}

// 写真を預ける
if ($a === 'pput') {
  if ($method !== 'POST') out(405, ['error' => 'method']);
  $id = safeId($_GET['id'] ?? null);
  $size = $_GET['size'] ?? '';
  if ($id === null || !in_array($size, ['photo', 'thumb'], true)) out(400, ['error' => 'id']);
  $body = readBody(SANPO_MAX_PHOTO_BYTES);
  if (strlen($body) < 4 || substr($body, 0, 2) !== "\xFF\xD8") out(400, ['error' => 'format']);   // JPEG だけ
  $path = photoPath($id, $size);
  if (!file_exists($path) && !writeAtomic($path, $body)) out(500, ['error' => 'write']);
  out(200, ['ok' => true]);
}

// 写真を返す
if ($a === 'photo') {
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

out(400, ['error' => 'action']);
