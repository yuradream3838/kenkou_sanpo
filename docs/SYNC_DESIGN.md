# 発見ノート ☁️ 同期・AI 閲覧（仕様）

最終更新: v0.14.0（2026-11-14）

健康管理アプリ（yuradream3838/health-app）の ConoHa 同期（`sync.php`）を参考にしているが、
**写真を扱うため・AI から読むため**に、仕組みは別物にしている（2章）。

## 1. 決めたこと（2026-11-14）

| 項目 | 決定 |
|---|---|
| AI から読む方式 | **サーバに読める形で置き、トークンで守る**（端末での暗号化はしない） |
| 原寸の写真 | **送らない**。送るのはアプリの中の写真（長い辺 1600px）と一覧用（360px） |
| 写真の位置情報 | **保存しない**（アプリが写真を保存するときに撮影位置などの情報を消している。サーバにもそのまま送る） |
| 自宅の周りのぼかし | **使わない** |

- 発見の「場所」（アプリで記録した緯度・経度）は記録の一部としてサーバに送られ、AI 用の窓口でも見える。
- 発見ごとに「🤖 AI 用の窓口に出さない」を付けられる（`hideFromAi`）。

## 2. 健康管理アプリとの違い

| | 健康管理アプリ | 発見ノート |
|---|---|---|
| 送り方 | データ全体を 1 つのファイル | **1 件ずつ・変わったものだけ** |
| 中身 | 端末で暗号化（サーバは読めない） | **読める形**（AI 用の窓口のため） |
| 写真 | なし | 1 枚ずつ別のファイル（変更しない・同じものは送り直さない） |
| ぶつかったとき | 項目ごとに混ぜる | **1 件ごとに、更新時刻が新しいほうを残す** |
| 過去の版 | 残す | 残さない（消したものは「消した印」を残す） |
| フォルダ・合言葉 | `/health/` | `/sanpo/`（別。片方が漏れてももう片方は守られる） |

## 3. 置くもの（server/）

| ファイル | 役割 | コミット |
|---|---|---|
| `sync.php` | アプリ用（読み書き） | する |
| `ai.php` | AI 用（読むだけ） | する |
| `common.php` | 共通の処理 | する |
| `config.php.example` | 設定のひな形 | する |
| `config.php` | 設定（合言葉・トークンのハッシュ） | **しない**（`.gitignore`） |

### 3-1. はじめての設定

1. ConoHa に `sanpo` フォルダを作り（例：`public_html/nuts024.com/sanpo/`）、`sync.php`・`ai.php`・`common.php` を置く。
2. `config.php.example` を `config.php` という名前でコピーして同じフォルダに置く。
3. スマホのアプリで「⚙設定 → ☁️ ConoHa 同期」に URL（例：`https://nuts024.com/sanpo/sync.php`）・端末の名前・合言葉を入れて「この合言葉で設定する」。
4. 出てきた「サーバに貼る値」を `config.php` の `SANPO_AUTH_HASH` に貼る。
5. アプリで「接続を確かめる」。この端末の記録と写真がすべて送られる。
6. PC：同じアプリをブラウザで開き、同じ URL と**同じ合言葉**を入れて「接続を確かめる」（サーバの設定はいらない）。
7. AI 用：アプリの「🤖 AI 用の窓口 → AI 用の URL を作る」→ 出てきた「サーバに貼る値（AI 用）」を `SANPO_READ_HASH` に貼る。「AI に渡す URL」を AI に渡す。

- `config.php` を書き換えてから反映されるまで、サーバのキャッシュ（opcache）で数秒かかることがある。
- 写真は 1 枚 数百KB なので、PHP の `upload_max_filesize`（初期値 2MB）のままで足りる。サーバ側の上限は 1 枚 8MB。
- `sanpo_data/` は初回に自動で作られ、`.htaccess` で外から直接は読めない。

### 3-2. データ（sanpo_data/）

```
d/{id}.json        発見 1 件   {kind:"d", id, updatedAt, deleted, rev, savedAt, device, data}
t/{id}.json        おでかけ 1 件（同じ形・kind:"t"）
p/{写真ID}_photo.jpg   写真（長い辺 1600px）
p/{写真ID}_thumb.jpg   一覧用（360px）
changes.log        変更の記録（1 行に「rev<TAB>kind<TAB>id」）
rev.txt            今の通し番号
```

- `data` はアプリの記録そのもの（写真は ID の一覧 `photos:[…]`）に、AI が読みやすいよう `labels`（種類の名前・グループ・気持ちの名前・確信度・おでかけの目的の名前）を足したもの。
- 消したときは `deleted:true`・`data:null` の記録を残す（ほかの端末からも消えるように）。写真のファイルは消さない。

## 4. sync.php（アプリ用）

認証：ヘッダ `X-Sync-Auth`（64桁の16進）。サーバは `sha256(この値)` が `SANPO_AUTH_HASH` と一致するかを比べる。違えば 401 `auth`（0.4秒待つ）。
`Origin` が `SANPO_ALLOWED_ORIGINS` に無ければ 403 `origin`。`X-Device`：端末の名前（`encodeURIComponent`）。

| a | メソッド | 内容 | 返事 |
|---|---|---|---|
| `meta` | GET | 今の通し番号 | `{rev}` |
| `changes&since=N` | GET | N より後に変わった記録（N=0 ならすべて） | `{rev, items:[記録…]}` |
| `put` | POST | 記録を預ける（JSON `{items:[{kind, id, updatedAt, deleted, data}]}`、1 回 500 件まで） | `{rev, accepted:["d:id",…], rejected:[サーバの記録…]}` |
| `pmissing` | POST | `{ids:[写真ID]}` のうち、サーバに無いもの | `{missing:[…]}` |
| `pput&id=&size=photo\|thumb` | POST | 写真（JPEG のみ・8MB まで）。同じものがあれば何もしない | `{ok:true}` |
| `photo&id=&size=` | GET | 写真 | JPEG |

- `put`：サーバの記録の `updatedAt` のほうが新しければ保存せず `rejected` で返す（アプリはそれを取り込む）。同じ `updatedAt` なら何もしない（送り直しても安全）。
- `updatedAt` は ISO 形式（`2026-11-14T01:00:00.000Z`）。
- エラー：400 `format`/`items`/`ids`/`id`/`action`、405 `method`、413 `too_large`、500 `config`/`mkdir`/`lock`/`write`。

## 5. ai.php（AI 用・読むだけ）

`https://…/sanpo/ai.php?t=AI用トークン`。`sha256(t)` が `SANPO_READ_HASH` と一致したときだけ読める（空なら使えない）。書き換えはできない。
既定は Markdown（`text/plain`）、`&fmt=json` で JSON。日時は日本時間。`hideFromAi` の発見は出さない。

| URL | 返すもの |
|---|---|
| （なし） | AI 向けの案内（データの説明・件数・最近の散歩 5 件・最近の発見 10 件・ほかの URL） |
| `&a=walks[&page=]` | 散歩の一覧（50 件ずつ） |
| `&a=walk&id=` | 1 回の散歩：路線・目的・開始と終了・散歩時間・時刻順の記録（メモ・発見）・発見の中身 |
| `&a=finds[&cat=&feel=&from=&to=&page=]` | 発見の一覧。`cat` は種類の ID か名前、`feel` は気持ちの ID か名前、`from`/`to` は `YYYY-MM-DD` |
| `&a=find&id=` | 発見 1 件（種類・日時・場所・気持ち・散歩・確信度・気づいたこと・仮説・調べて分かったこと・出典・写真の URL） |
| `&a=search&q=` | キーワード検索（発見と散歩のメモ） |
| `&a=img&id=&size=photo\|thumb` | 写真（JPEG） |

- トークンは URL に入るので、AI のサービス側の履歴に残る。漏れたと思ったら、アプリの「作り直す」→ `SANPO_READ_HASH` を貼り替える（古い URL は使えなくなる）。

## 6. アプリ側（js/sync.js・js/sync-ui.js）

- 合言葉から PBKDF2-SHA256（salt `kenkou_sanpo-sync-v1`・250,000 回・256bit）で `X-Sync-Auth` の値を作る。合言葉そのものは保存しない。設定は `localStorage["sync-settings"]`。
- 記録を変えると（`db.put`・`db.remove`・`db.putTrip`・`db.removeTrip`）、`updatedAt` を今にして「送っていない変更」（IndexedDB の `meta.pending`＝`{"d:id": 変えた時刻}`）に入れる。サーバから受け取った反映（`fromSync`）は入れない。
- 送る：写真を先に（`pmissing` → `pput`）、そのあと記録（`put`）。送っている間にまた変わったものは残す。以前の形式の写真 ID（`p0` など）は送る前に付け直す。JPEG 以外の写真は JPEG にしてから送る。
- 受け取る：`changes&since=最後に受け取った番号`。この端末で後から変えた（まだ送っていない）ものはこちらを残す。写真は手元に無いものだけ取ってくる。受け取ったら画面を描き直す（入力中・設定画面を除く）。
- 自動（「自動で同期する」）：開いたとき・画面に戻ったとき・開いている間 3 分ごと・変更して 10 秒後・画面を閉じるとき。
- 「すべて削除」はこの端末だけ（サーバは消さない）。「サーバから全部受け取り直す」で戻せる。

## 7. テスト

サーバ（`server/`）を PHP の組み込みサーバ（`php -d opcache.enable=0 -S`）で、アプリを `python3 -m http.server` で動かし、
2 つのブラウザ（スマホ役・PC 役）で次を確かめた（v0.14.0）：
合言葉を貼る前は 401 → 貼ると全部送る／PC で受け取る（写真 2 枚・おでかけ中の散歩とメモ）／PC で編集 → スマホに届く／
消すと伝わる（消した印）／同時に編集すると新しいほうが残る／AI 用の窓口（案内・発見・写真、AI に見せないものは出ない）／
違う合言葉は 401／自動で送り、もう一方は画面に戻ったときに受け取って描き直す。
