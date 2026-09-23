/* public/js/app_smart_banner.js — Android smart banner (app funnel 2026-09-23).
 *
 * Served from 'self' so it needs no CSP nonce. The markup
 * (views/partials/app_smart_banner.ejs) is rendered only when PLAY_STORE_URL is
 * set, and ships `hidden`; this script reveals it for Android user agents that
 * have not dismissed it in the last 30 days. Every storage access is wrapped:
 * private windows and blocked site data throw, and the banner must still work
 * (it just will not remember a dismissal).
 */
(function () {
  'use strict';
  var KEY = 'tk_app_banner_dismissed_at';
  var TTL_MS = 30 * 24 * 60 * 60 * 1000;

  function isAndroid() {
    try { return /Android/i.test(String(navigator.userAgent || '')); } catch (_) { return false; }
  }

  function dismissedRecently() {
    try {
      var v = window.localStorage.getItem(KEY);
      var at = v ? parseInt(v, 10) : 0;
      return !!at && (Date.now() - at) < TTL_MS;
    } catch (_) { return false; }
  }

  function rememberDismissal() {
    try { window.localStorage.setItem(KEY, String(Date.now())); } catch (_) { /* ignore */ }
  }

  function init() {
    try {
      var el = document.querySelector('[data-app-smart-banner]');
      if (!el || !isAndroid() || dismissedRecently()) return;
      el.hidden = false;
      document.documentElement.classList.add('tk-has-app-banner');
      var close = el.querySelector('[data-app-smart-banner-close]');
      if (close) {
        close.addEventListener('click', function () {
          rememberDismissal();
          el.hidden = true;
          document.documentElement.classList.remove('tk-has-app-banner');
        });
      }
    } catch (_) { /* a banner must never break the page */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
