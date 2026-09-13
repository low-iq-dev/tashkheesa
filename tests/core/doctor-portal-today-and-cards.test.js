// tests/core/doctor-portal-today-and-cards.test.js
//
// 2026-09-13 (mobile B2, B3). Source pins for Today's phone order and the
// compact case cards. The browser checks (real order on a 390px screen, the
// collapsed secondary cards, card heights <= 120px, sticky filter tabs,
// desktop order unchanged) are in scripts/mobile-shots.js.
'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: (n) => console.log('  ✅ ' + n),
  fail: (n, e) => { console.error('  ❌ ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: (n, r) => console.log('  ⏭️  ' + n + ' (' + r + ')')
};

console.log('\n🗂️  Today order + case cards on phones (mobile B2/B3)\n');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripEjs = (s) => s.replace(/<%#[\s\S]*?%>/g, '');
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

function check(name, fn) {
  try {
    const err = fn();
    if (err) t.fail(name, new Error(err)); else t.pass(name);
  } catch (e) { t.fail(name, e); }
}

const today = stripEjs(read('src/views/portal_doctor_dashboard.ejs'));
const cases = stripEjs(read('src/views/portal_doctor_cases.ejs'));
const css = stripCss(read('public/css/portal-global.css'));

check('Today never labels a case with a retired or borrowed tier name', () => {
  if (/'Fast-track'|"Fast-track"|Fast Track/i.test(today)) return 'Today still renders "Fast-track"';
  // "Urgent" is a tier. It may only come from the tier mapping, never as a
  // due-within-24h label on a case of another tier.
  const pills = today.match(/<span class="dd-sla-pill[^"]*">[^<]*<\/span>/g) || [];
  const literal = pills.filter((p) => /Urgent|عاجلة/.test(p));
  return literal.length ? 'hard-coded urgency pill: ' + literal.join(' | ') : null;
});

check('Today: new assignments show their acceptance countdown', () => {
  const start = today.indexOf('data-tour="case-queue"');
  const end = today.indexOf('<!-- RECENT ALERTS -->', start);
  const block = today.slice(start, end);
  return /_slaTimeLabel\(c\)/.test(block) ? null : 'the New Assignments rows do not render _slaTimeLabel';
});

check('Today: every section carries a phone-order class, and the disclosure starts hidden', () => {
  for (const cls of ['dd-m-new', 'dd-m-due', 'dd-m-unread', 'dd-m-stats', 'dd-m-rest']) {
    if (!today.includes(cls)) return 'missing ' + cls;
  }
  const btn = today.match(/<button[^>]*data-dd-more[^>]*>/);
  if (!btn) return 'no More disclosure button';
  if (!/\shidden[\s>]/.test(btn[0])) return 'the More button is not hidden by default (no-JS would show a dead button)';
  if (!/aria-controls="dd-page"/.test(btn[0]) || !/id="dd-page"/.test(today)) return 'disclosure not wired to #dd-page';
  return null;
});

check('Today phone order is new → due → unread → stats → more → rest', () => {
  const order = {};
  const re = /\.page-doctor-dashboard \.(dd-m-new|dd-m-due|dd-m-unread|dd-m-stats|dd-more-toggle|dd-m-rest)\s*\{\s*order:\s*(\d+)/g;
  let m;
  while ((m = re.exec(css))) order[m[1]] = Number(m[2]);
  const seq = ['dd-m-new', 'dd-m-due', 'dd-m-unread', 'dd-m-stats', 'dd-more-toggle', 'dd-m-rest'];
  for (let i = 1; i < seq.length; i++) {
    if (!(order[seq[i - 1]] < order[seq[i]])) return 'order: ' + JSON.stringify(order);
  }
  return null;
});

check('Case cards have one primary action, and unaccepted cases do not claim to accept', () => {
  const cta = cases.match(/<span class="v2-case-row__cta"[^>]*>([\s\S]*?)<\/span>/);
  if (!cta) return 'no .v2-case-row__cta in portal_doctor_cases.ejs';
  if (!/aria-hidden="true"/.test(cta[0])) return 'the visual action is not aria-hidden inside the row link';
  if (/tt\('Accept'/.test(cta[1])) return 'the row claims "Accept" but only opens the case';
  return null;
});

check('Phone card rules out-rank doctor-portal-v2.css (which loads later)', () => {
  const needed = ['.v2-case-row {', '.v2-case-row__badge {', '.v2-status-key {'];
  for (const n of needed) {
    const re = new RegExp('body\\.doctor-theme\\.portal-v2 \\.portal-content ' + n.replace(/[.{]/g, (c) => '\\' + c));
    if (!re.test(css)) return 'phone rule for ' + n + ' is not scoped to body.doctor-theme.portal-v2 .portal-content';
  }
  return null;
});
