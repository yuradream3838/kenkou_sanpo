// ⚙設定の「☁️ ConoHa 同期」と「🤖 AI 用の窓口」。
import * as db from './db.js';
import {
  DEFAULT_URL, loadSettings, saveSettings, isConfigured, defaultDeviceName, deriveAuth, newReadToken, aiUrl,
  getStatus, onStatus, pendingCount, markAllPending, syncNow, testConnection,
} from './sync.js';

async function copy(text, toast) {
  try {
    await navigator.clipboard.writeText(text);
    toast('コピーしました');
  } catch {
    window.prompt('コピーしてください', text);
  }
}

function timeText(iso) {
  if (!iso) return 'まだありません';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export async function renderSyncSection(el, { esc, toast }) {
  const s = loadSettings();
  const configured = isConfigured(s);
  const st = getStatus();
  const pending = await pendingCount();
  const ai = aiUrl(s);

  el.innerHTML = `
    <h3>☁️ ConoHa 同期</h3>
    <p class="muted small">記録と写真（長い辺 1600px・位置情報などは消したもの）を自分のサーバに預けて、PC など別の端末と同じ記録を使います。AI 用の窓口からも読めるようになります。</p>

    ${configured && !s.initialPushed ? `
      <div class="sync-first">
        <p><b>あと少しで使えます</b></p>
        <ol class="small">
          <li>この値を ConoHa の <code>config.php</code> の <code>SANPO_AUTH_HASH</code> に貼る（PC など2台目以降で、すでに貼ってあれば不要）<br>
            <code class="hash">${esc(s.authHash || '')}</code>
            <button type="button" class="btn ghost small" data-copy="${esc(s.authHash || '')}">コピー</button></li>
          <li>「接続を確かめる」を押す。つながると、この端末の記録を送り、サーバの記録を受け取ります。</li>
        </ol>
        <div class="row">
          <button type="button" class="btn primary" id="sync-test">接続を確かめる</button>
          <button type="button" class="btn ghost small" id="sync-forget">設定をやり直す</button>
        </div>
        ${st.error ? `<p class="err-text small">⚠ ${esc(st.error)}</p>` : ''}
      </div>
    ` : ''}
    ${configured && s.initialPushed ? `
      <div class="sync-status ${st.error ? 'err' : ''}">
        <p>最後に同期：<b>${esc(timeText(st.lastSyncAt))}</b>${st.running ? '（同期中…）' : ''}</p>
        <p>送っていない変更：<b>${pending}</b> 件</p>
        ${st.error ? `<p class="err-text">⚠ ${esc(st.error)}</p>` : ''}
      </div>
      <div class="row">
        <button type="button" class="btn primary" id="sync-now">今すぐ同期</button>
        <label class="check"><input type="checkbox" id="sync-on" ${s.on ? 'checked' : ''}> 自動で同期する</label>
      </div>
      <details class="sync-more">
        <summary>同期の詳しい設定</summary>
        <p class="small">サーバ：${esc(s.url)}<br>この端末の名前：${esc(s.device || '')}</p>
        <p class="small">サーバに貼る値（書き込み用・<code>SANPO_AUTH_HASH</code>）：<br><code class="hash">${esc(s.authHash || '')}</code>
          <button type="button" class="btn ghost small" data-copy="${esc(s.authHash || '')}">コピー</button></p>
        <div class="row">
          <button type="button" class="btn small" id="sync-test">接続を確かめる</button>
          <button type="button" class="btn small" id="sync-refetch">サーバから全部受け取り直す</button>
          <button type="button" class="btn ghost small" id="sync-forget">この端末の同期設定を消す</button>
        </div>
      </details>
    ` : ''}
    ${!configured ? `
      <form id="sync-setup" class="sync-setup">
        <label>サーバの URL（sync.php）<input name="url" type="url" value="${esc(s.url || DEFAULT_URL)}" required></label>
        <label>この端末の名前<input name="device" maxlength="40" value="${esc(s.device || defaultDeviceName())}"></label>
        <label>合言葉（すべての端末で同じものを入れる。10文字以上）
          <input name="pass" type="password" minlength="10" autocomplete="new-password" required>
        </label>
        <p class="muted small">合言葉はこの端末に保存しません。忘れないように控えてください。</p>
        <button type="submit" class="btn primary">この合言葉で設定する</button>
      </form>
      <details class="sync-more">
        <summary>サーバの準備（初めてのとき）</summary>
        <ol class="small">
          <li>リポジトリの <code>server/</code> にある <code>sync.php</code>・<code>ai.php</code>・<code>common.php</code> を、ConoHa の同じフォルダ（例：<code>public_html/nuts024.com/sanpo/</code>）に置く。</li>
          <li><code>config.php.example</code> を <code>config.php</code> という名前でコピーして同じフォルダに置く。</li>
          <li>上の「この合言葉で設定する」を押すと出る「サーバに貼る値」を、<code>config.php</code> の <code>SANPO_AUTH_HASH</code> に貼る。</li>
          <li>「接続を確かめる」で確認する。PC では同じ URL と合言葉を入れるだけ（サーバの設定はいらない）。</li>
        </ol>
      </details>
    ` : ''}

    ${configured ? `
      <h3 class="ai-title">🤖 AI 用の窓口（読むだけ）</h3>
      <p class="muted small">この URL を Claude・ChatGPT・Gemini などに渡すと、記録を読んでもらえます（書き換え・削除はできません）。URL を知っている人は誰でも読めるので、扱いに注意してください。</p>
      ${ai ? `
        <p class="small">AI に渡す URL：<br><code class="hash">${esc(ai)}</code>
          <button type="button" class="btn ghost small" data-copy="${esc(ai)}">コピー</button></p>
        <p class="small">サーバに貼る値（AI 用・<code>SANPO_READ_HASH</code>）：<br><code class="hash">${esc(s.readHash)}</code>
          <button type="button" class="btn ghost small" data-copy="${esc(s.readHash)}">コピー</button></p>
        <button type="button" class="btn small" id="ai-new">作り直す（前の URL を使えなくする）</button>
      ` : `<button type="button" class="btn" id="ai-new">AI 用の URL を作る</button>`}
    ` : ''}`;

  const rerender = () => renderSyncSection(el, { esc, toast });
  el.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copy(b.dataset.copy, toast)));

  const off = onStatus(() => {
    if (!el.isConnected) return off();
    rerender();
    off();
  });

  el.querySelector('#sync-setup')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const pass = String(fd.get('pass') || '');
    if (pass.length < 10) return toast('合言葉は10文字以上にしてください');
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = '準備中…';
    try {
      const { auth, authHash } = await deriveAuth(pass);
      saveSettings({
        ...loadSettings(),
        url: String(fd.get('url')).trim(),
        device: String(fd.get('device') || '').trim() || defaultDeviceName(),
        auth,
        authHash,
        on: true,
        initialPushed: false,
      });
      toast('設定しました。「サーバに貼る値」を config.php に貼ってから「接続を確かめる」を押してください', 6000);
    } catch (err) {
      toast('設定できませんでした：' + err.message, 5000);
    }
    rerender();
  });

  el.querySelector('#sync-test')?.addEventListener('click', async () => {
    try {
      const m = await testConnection();
      toast(`つながりました（サーバの記録番号 ${m.rev}）`);
      const cur = loadSettings();
      if (!cur.initialPushed) {
        await markAllPending(); // 初めてつないだとき：この端末の記録を全部送る
        saveSettings({ ...loadSettings(), initialPushed: true });
      }
      await syncNow();
      toast('同期しました');
    } catch (err) {
      toast(err.message, 6000);
    }
    rerender();
  });

  el.querySelector('#sync-now')?.addEventListener('click', async () => {
    try {
      const cur = loadSettings();
      if (!cur.initialPushed) {
        await markAllPending();
        saveSettings({ ...loadSettings(), initialPushed: true });
      }
      const r = await syncNow();
      toast(r ? `同期しました（送った ${r.sent} 件・受け取った ${r.got} 件）` : '同期しました');
    } catch (err) {
      toast(err.message, 6000);
    }
    rerender();
  });

  el.querySelector('#sync-on')?.addEventListener('change', (e) => {
    saveSettings({ ...loadSettings(), on: e.target.checked });
    if (e.target.checked) syncNow().catch(() => {});
  });

  el.querySelector('#sync-refetch')?.addEventListener('click', async () => {
    if (!confirm('サーバにある記録を全部受け取り直します。この端末で送っていない変更は先に送ります。よろしいですか？')) return;
    try {
      await syncNow();
      await db.metaSet('lastRev', 0);
      const r = await syncNow();
      toast(`受け取り直しました（${r ? r.got : 0} 件）`);
    } catch (err) {
      toast(err.message, 6000);
    }
    rerender();
  });

  el.querySelector('#sync-forget')?.addEventListener('click', async () => {
    if (!confirm('この端末の同期設定を消します（記録は消えません。サーバのデータもそのまま）。よろしいですか？')) return;
    const { url, device } = loadSettings();
    saveSettings({ url, device });
    await db.metaSet('pending', {});
    await db.metaSet('lastRev', 0);
    rerender();
  });

  el.querySelector('#ai-new')?.addEventListener('click', async () => {
    if (loadSettings().readToken && !confirm('新しい URL を作ります。サーバの SANPO_READ_HASH を貼り替えると、前の URL は使えなくなります。よろしいですか？')) return;
    saveSettings({ ...loadSettings(), ...(await newReadToken()) });
    toast('作りました。「サーバに貼る値（AI 用）」を config.php の SANPO_READ_HASH に貼ってください', 6000);
    rerender();
  });
}
