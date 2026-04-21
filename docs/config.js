// ─────────────────────────────────────────────
//  API ベース URL 設定
//  ローカル開発 (localhost) では空文字 → 相対URLのまま
//  GitHub Pages から使う場合は Render のURLを設定
// ─────────────────────────────────────────────
window.API_BASE = (
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1'
)
  ? ''
  : 'https://RENDER-APP-NAME.onrender.com';
