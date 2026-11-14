# 発見ノート（kenkou_sanpo）

## 公開の運用
- GitHub Pages で `main` ブランチの `/ (root)` を公開している。
- **変更はコミットしたら、作業ブランチに加えて必ずすぐ `main` にも反映（push）する**（オーナーの指示）。
- アプリ本体を更新したら、**`js/changelog.js` の先頭に更新履歴を追記**してバージョンを上げる（アプリ内の表示バージョンはここから決まる）。
  あわせて `sw.js` の `VERSION` も同じバージョンに上げる（利用者のキャッシュ更新のため）。
- 更新履歴は利用者向けの言葉で書く（何ができるようになったか・何が直ったか）。

## 開発メモ
- ビルド不要の静的 PWA。`python3 -m http.server` で確認できる。
- 詳細は README.md を参照。
- ☁️ 同期・AI 用の窓口の仕様は docs/SYNC_DESIGN.md。サーバは server/（PHP）。**同期の仕組み・API を変えたら docs/SYNC_DESIGN.md も同じコミットで更新する。**
- **server/config.php（合言葉・トークンのハッシュ）はコミットしない**（.gitignore 済み。ひな形は server/config.php.example）。
- 同期のテスト：server/ を `php -d opcache.enable=0 -S` で、アプリを `python3 -m http.server` で動かし、2 つのブラウザで送る・受け取る・同時編集・削除・AI 窓口を確かめる。
