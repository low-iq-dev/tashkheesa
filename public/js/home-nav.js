/* Tashkheesa home page — the phone/tablet menu (≤1100px; see marketing.css).
 *
 * The menu is a native <details data-home-menu> in views/index.ejs: it opens,
 * closes, takes keyboard focus and reports expanded/collapsed with no script.
 * This file only adds what a disclosure does not do by itself:
 *   - Escape closes it and returns focus to the button
 *   - a tap or click outside closes it
 *   - following a link closes it (the "How it works" link stays on this page)
 *   - it closes when the viewport grows past the breakpoint
 * External + defer: the site CSP has no 'unsafe-inline' for scripts.
 */
(function () {
  var menu = document.querySelector('[data-home-menu]');
  if (!menu) return;
  var button = menu.querySelector('summary');

  function close(returnFocus) {
    if (!menu.open) return;
    menu.open = false;
    if (returnFocus && button) button.focus();
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' || e.key === 'Esc') close(menu.contains(document.activeElement));
  });
  document.addEventListener('click', function (e) {
    if (!menu.contains(e.target)) close(false);
  });
  menu.addEventListener('click', function (e) {
    var link = e.target && e.target.closest ? e.target.closest('a') : null;
    if (link) close(false);
  });
  if (window.matchMedia) {
    var wide = window.matchMedia('(min-width: 1101px)');
    var onWide = function (mq) { if (mq.matches) close(false); };
    if (wide.addEventListener) wide.addEventListener('change', onWide);
    else if (wide.addListener) wide.addListener(onWide);
  }
})();
