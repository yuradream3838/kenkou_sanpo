<?php
// 発見ノート ☁️ 同期：sync.php と ai.php が共通で使う部分。
// データ（sanpo_data/）
//   d/{id}.json          発見 1 件（{kind:"d", id, updatedAt, deleted, rev, savedAt, device, data}）
//   t/{id}.json          おでかけ 1 件（同じ形、kind:"t"）
//   p/{id}_photo.jpg     写真（長い辺 1600px・位置情報などは端末で消してある）
//   p/{id}_thumb.jpg     写真の一覧用（360px）
//   changes.log          変更の記録（1 行に「rev<TAB>kind<TAB>id」）
//   rev.txt              今の通し番号

declare(strict_types=1);

// config.php が無い・書き間違いがあるときでも、アプリ（ブラウザ）が理由を読めるように、
// どの応答にも先に「このサイトからの呼び出しを許す」ヘッダを付ける。
const SANPO_DEFAULT_ORIGINS = ['https://yuradream3838.github.io'];
$SANPO_CONFIG_ERROR = null;   // null（問題なし）／'config'（無い）／'config_syntax'（書き間違い）
if (!file_exists(__DIR__ . '/config.php')) {
  $SANPO_CONFIG_ERROR = 'config';
} else {
  try {
    require __DIR__ . '/config.php';
    if (!defined('SANPO_AUTH_HASH') || !defined('SANPO_READ_HASH')) $SANPO_CONFIG_ERROR = 'config_syntax';
  } catch (Throwable $e) {
    $SANPO_CONFIG_ERROR = 'config_syntax';
  }
}

function allowedOrigins(): array {
  return defined('SANPO_ALLOWED_ORIGINS') && is_array(SANPO_ALLOWED_ORIGINS) ? SANPO_ALLOWED_ORIGINS : SANPO_DEFAULT_ORIGINS;
}

function sendCors(): void {
  $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
  if ($origin !== '' && in_array($origin, allowedOrigins(), true) && !headers_sent()) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
    header('Access-Control-Allow-Headers: X-Sync-Auth, X-Device, Content-Type');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Max-Age: 600');
  }
}

// PHP のエラーで止まったときも、理由を JSON で返す（画面にエラーの文字を出さない）
ini_set('display_errors', '0');
register_shutdown_function(function () {
  $e = error_get_last();
  if (!$e || !in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR], true)) return;
  if (!headers_sent()) {
    sendCors();
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
  }
  echo json_encode(['error' => 'php', 'message' => $e['message'] . ' (' . basename((string)$e['file']) . ':' . $e['line'] . ')'], JSON_UNESCAPED_UNICODE);
});

date_default_timezone_set('Asia/Tokyo');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('X-Robots-Tag: noindex, nofollow');

const SANPO_KINDS = ['d', 't'];
const SANPO_MAX_PHOTO_BYTES = 8 * 1024 * 1024;   // 写真 1 枚の上限
const SANPO_MAX_JSON_BYTES = 8 * 1024 * 1024;    // 記録をまとめて送るときの上限

function out(int $code, array $arr): void {
  http_response_code($code);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode($arr, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  exit;
}

function isHex64($v): bool { return is_string($v) && preg_match('/^[0-9a-f]{64}$/', $v) === 1; }

// 値（64桁の16進）の SHA-256 が、設定した値と一致するか
function tokenMatches($token, string $hash): bool {
  if (!isHex64($token) || !isHex64($hash)) return false;
  return hash_equals($hash, hash('sha256', $token));
}

function safeId($v): ?string {
  return (is_string($v) && preg_match('/^[0-9A-Za-z_-]{1,64}$/', $v) === 1) ? $v : null;
}

function dataDir(): string {
  $d = SANPO_DATA_DIR;
  foreach (['', '/d', '/t', '/p'] as $sub) {
    if (!is_dir($d . $sub)) @mkdir($d . $sub, 0700, true);
    if (!is_dir($d . $sub)) out(500, ['error' => 'mkdir']);
  }
  if (!file_exists($d . '/.htaccess')) {
    @file_put_contents($d . '/.htaccess',
      "<IfModule mod_authz_core.c>\nRequire all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\nOrder allow,deny\nDeny from all\n</IfModule>\n");
  }
  if (!file_exists($d . '/index.html')) @file_put_contents($d . '/index.html', '');
  return $d;
}

function currentRev(): int {
  $f = dataDir() . '/rev.txt';
  return file_exists($f) ? (int)trim((string)@file_get_contents($f)) : 0;
}

function recordPath(string $kind, string $id): string {
  return dataDir() . '/' . $kind . '/' . $id . '.json';
}

function readRecord(string $kind, string $id): ?array {
  $f = recordPath($kind, $id);
  if (!file_exists($f)) return null;
  $r = json_decode((string)@file_get_contents($f), true);
  return is_array($r) ? $r : null;
}

// すべての記録（消した印のものも含む）
function allRecords(string $kind): array {
  $out = [];
  foreach (glob(dataDir() . '/' . $kind . '/*.json') ?: [] as $f) {
    $r = json_decode((string)@file_get_contents($f), true);
    if (is_array($r)) $out[] = $r;
  }
  return $out;
}

function photoPath(string $id, string $size): string {
  return dataDir() . '/p/' . $id . '_' . $size . '.jpg';
}

// 書き込んでから名前を変える（途中で止まっても壊れたファイルを残さない）
function writeAtomic(string $path, string $body): bool {
  $tmp = $path . '.tmp' . bin2hex(random_bytes(4));
  if (@file_put_contents($tmp, $body) === false) return false;
  return @rename($tmp, $path);
}
