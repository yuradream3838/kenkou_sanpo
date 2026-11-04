# 発見ノート（kenkou_sanpo）

## 公開の運用
- GitHub Pages で `main` ブランチの `/ (root)` を公開している。
- **変更はコミットしたら、作業ブランチに加えて必ずすぐ `main` にも反映（push）する**（オーナーの指示）。
- アプリ本体を更新したら `sw.js` の `VERSION` と `js/app.js` の `APP_VERSION` を上げる（利用者のキャッシュ更新のため）。

## 開発メモ
- ビルド不要の静的 PWA。`python3 -m http.server` で確認できる。
- 詳細は README.md を参照。
