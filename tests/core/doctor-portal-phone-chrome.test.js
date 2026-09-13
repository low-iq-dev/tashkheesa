// tests/core/doctor-portal-phone-chrome.test.js
//
// 2026-09-13 (mobile B1, B7, B8, B9). Source-level pins for the consultant
// portal's phone chrome. The browser-level checks for the same things (tab bar
// shown, mirrored in Arabic, fonts actually requested, digits rendered, manifest
// served) are in scripts/mobile-shots.js (`npm run mobile:check`), which needs
// Chrome and a local server and so cannot run here.
'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n📲 doctor portal phone chrome (mobile B1/B7/B8/B9)\n');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripEjsComments = (s) => s.replace(/<%#[\s\S]*?%>/g, '');

function check(name, fn) {
  try {
    const err = fn();
    if (err) t.fail(name, new Error(err)); else t.pass(name);
  } catch (e) { t.fail(name, e); }
}

// The doctor-only branch of a `<% if (portalRoleName === 'doctor') { %> … <% } else { %>` block
// that contains `marker`.
function doctorBranchContaining(src, marker) {
  const idx = src.indexOf(marker);
  if (idx < 0) return null;
  const open = src.lastIndexOf("<% if (portalRoleName === 'doctor') { %>", idx);
  const els = src.indexOf('<% } else { %>', open);
  return open >= 0 && els > idx ? src.slice(open, els) : null;
}

const layout = stripEjsComments(read('src/views/layouts/portal.ejs'));

check('B7: the doctor portal requests exactly two font families (Inter, Noto Sans Arabic) with display=swap', () => {
  const branch = doctorBranchContaining(layout, 'fonts.googleapis.com/css2?family=Inter');
  if (!branch) return 'no doctor-only Google Fonts link in portal.ejs';
  const hrefs = branch.match(/https:\/\/fonts\.googleapis\.com\/css2\?[^"]+/g) || [];
  if (hrefs.length !== 1) return 'expected one fonts link in the doctor branch, found ' + hrefs.length;
  const fams = new URL(hrefs[0].replace(/&amp;/g, '&')).searchParams.getAll('family').map((f) => f.split(':')[0].replace(/\+/g, ' '));
  if (fams.sort().join('|') !== 'Inter|Noto Sans Arabic') return 'families: ' + fams.join(', ');
  if (!/display=swap/.test(hrefs[0])) return 'no display=swap';
  return null;
});

check('B7: the other frames keep their own font link (superadmin/admin/patient untouched)', () => {
  return /Plus\+Jakarta\+Sans/.test(layout) ? null : 'the non-doctor font link was removed — owner-styles.css still uses Plus Jakarta Sans';
});

check('B7: doctor stylesheets no longer lead with a family the portal stopped loading', () => {
  const css = read('public/css/doctor-portal.css');
  const m = css.match(/--dr-font:\s*([^;]+);/);
  if (!m) return '--dr-font not found';
  if (!/^\s*['"]?Inter/.test(m[1])) return '--dr-font does not lead with Inter: ' + m[1];
  if (!/Noto Sans Arabic/.test(m[1])) return '--dr-font has no Arabic family: ' + m[1];
  if (/DM Sans|DM Mono|JetBrains Mono/.test((css.match(/--dr-font-mono:\s*([^;]+);/) || [])[1] || '')) return '--dr-font-mono still names an unloaded family';
  return null;
});

check('B8: counts and money in the doctor views are formatted with Western digits', () => {
  const files = ['portal_doctor_dashboard.ejs', 'portal_doctor_services.ejs', 'portal_doctor_earnings.ejs'];
  const bad = [];
  for (const f of files) {
    const src = read('src/views/' + f);
    const fnRe = /function\s+(_fmtNum|_fmtEgp|_money|_fmtMoney)\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*\}/g;
    let m;
    while ((m = fnRe.exec(src))) if (/ar-EG/.test(m[2])) bad.push(f + ' ' + m[1]);
  }
  return bad.length ? 'Arabic-Indic number formatting in: ' + bad.join(', ') : null;
});

check('B9: manifest is valid, standalone, and uses the brand teal as theme colour', () => {
  const man = JSON.parse(read('public/manifest.webmanifest'));
  const brand = (read('public/css/portal-variables.css').match(/--v2-brand:\s*(#[0-9A-Fa-f]{6})/) || [])[1];
  if (man.display !== 'standalone') return 'display is ' + man.display;
  if (!brand || String(man.theme_color).toLowerCase() !== brand.toLowerCase()) return 'theme_color ' + man.theme_color + ' ≠ --v2-brand ' + brand;
  if (!/تشخيصة/.test(man.name) || !/Tashkheesa Consultants/.test(man.name)) return 'name is ' + man.name;
  for (const size of [192, 512]) {
    const icon = (man.icons || []).find((i) => i.sizes === size + 'x' + size);
    if (!icon) return 'no ' + size + 'px icon';
    const buf = fs.readFileSync(path.join(ROOT, 'public', icon.src));
    if (buf.readUInt32BE(16) !== size || buf.readUInt32BE(20) !== size) return icon.src + ' is not ' + size + 'x' + size;
  }
  return null;
});

check('B9: manifest + app metas are in the doctor frame only, and no service worker is registered', () => {
  const branch = doctorBranchContaining(layout, 'rel="manifest"');
  if (!branch) return 'no doctor-only <link rel="manifest">';
  for (const needle of ['name="theme-color"', 'name="apple-mobile-web-app-capable"', 'rel="apple-touch-icon"']) {
    if (!branch.includes(needle)) return 'doctor branch is missing ' + needle;
  }
  if (/serviceWorker/.test(layout) || /serviceWorker/.test(read('src/views/partials/footer.ejs'))) return 'a service worker is registered';
  if (/rel="manifest"/.test(read('src/views/layouts/public.ejs'))) return 'the manifest leaked into the public layout';
  return null;
});

check('B1: the doctor frame has a 5-item tab bar (Today, Cases, Messages, Earnings, More)', () => {
  const branch = doctorBranchContaining(layout, 'class="portal-tabbar"');
  if (!branch) return 'no .portal-tabbar in the doctor branch';
  const nav = branch.slice(branch.indexOf('class="portal-tabbar"'), branch.indexOf('</nav>', branch.indexOf('class="portal-tabbar"')));
  for (const href of ['/portal/doctor/today', '/portal/doctor/cases', '/portal/messages', '/portal/doctor/earnings']) {
    if (!nav.includes('href="' + href + '"')) return 'tab bar has no ' + href;
  }
  if (!/data-action="toggle-sidebar"/.test(nav)) return '"More" does not open the drawer';
  // Four links get their class from _tabAttrs(); the fifth is the More button.
  const items = (nav.match(/<a href="[^"]+"<%- _tabAttrs\('/g) || []).length + (nav.match(/<button[^>]*class="portal-tabbar__item"/g) || []).length;
  if (items !== 5) return 'tab bar has ' + items + ' items, expected 5';
  if (!/doctorUnreadMessages/.test(branch)) return 'Messages has no unread badge source';
  if (!/res\.locals\.doctorUnreadMessages\s*=/.test(read('src/routes/doctor.js'))) return 'doctor.js never sets doctorUnreadMessages';
  return null;
});

check('B1: Guide is reachable from the drawer', () => {
  return /href="\/portal\/doctor\/guide"/.test(read('src/views/partials/doctor/sidebar.ejs')) ? null : 'sidebar.ejs has no Guide link';
});
