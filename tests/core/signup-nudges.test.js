// tests/core/signup-nudges.test.js — templated signed-up-no-case nudges (26 Sep 2026)
'use strict';
const path = require('path');
const { inQuietHours, levelFor } = require('../../src/services/signup_nudges');
const { getOpenClawBody } = require('../../src/notify/openclawTemplates');
const { categoryFor } = require('../../src/services/notification_groups');
const fs = require('fs');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); }
};
console.log('\n👋  signup nudges (templated, no AI)\n');
function check(name, fn) { try { fn(); t.pass(name); } catch (e) { t.fail(name, e); } }
function ok(c, m) { if (!c) throw new Error(m); }

check('levels: nothing before 1h, 1h until 24h, 24h until 72h, nothing after', () => {
  ok(levelFor(0.5) === null, '30 min');
  ok(levelFor(1) === '1h', '1h');
  ok(levelFor(23.9) === '1h', '23.9h');
  ok(levelFor(24) === '24h', '24h');
  ok(levelFor(71) === '24h', '71h');
  ok(levelFor(72) === null, '72h stops');
});

check('quiet hours are 22:00–09:00 Cairo', () => {
  // Cairo is UTC+3 in late September 2026 (DST).
  ok(inQuietHours(new Date('2026-09-26T19:30:00Z')) === true, '22:30 Cairo is quiet');
  ok(inQuietHours(new Date('2026-09-27T05:30:00Z')) === true, '08:30 Cairo is quiet');
  ok(inQuietHours(new Date('2026-09-27T06:30:00Z')) === false, '09:30 Cairo sends');
  ok(inQuietHours(new Date('2026-09-27T18:30:00Z')) === false, '21:30 Cairo sends');
});

check('both levels have AR + EN WhatsApp bodies with the link and the team signature', () => {
  for (const lvl of ['1h', '24h']) {
    const ar = getOpenClawBody('signup_no_case_' + lvl, 'ar', { patientName: 'منى', link: 'https://x/y' });
    const en = getOpenClawBody('signup_no_case_' + lvl, 'en', { link: 'https://x/y' });
    ok(ar && ar.includes('https://x/y') && ar.includes('فريق تشخيصة') && ar.includes('منى'), 'AR ' + lvl + ': ' + ar);
    ok(en && en.includes('https://x/y') && !/undefined/.test(en), 'EN ' + lvl + ': ' + en);
  }
});

check('bell groups them under Your cases; the sweep is registered and fenced', () => {
  ok(categoryFor('signup_no_case_1h') === 'cases', 'category');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'signup_nudges.js'), 'utf8');
  ok(/NOT EXISTS \(SELECT 1 FROM orders o WHERE o\.patient_id = u\.id\)/.test(src), 'stops once any case exists');
  ok(/signup_no_case:\$\{level\}:\$\{channel\}:\$\{u\.id\}/.test(src), 'one send per user per level per channel');
  ok(/created_at >= \$1/.test(src), 'old accounts excluded via FEATURE_START');
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf8');
  ok(/runSignupNudgeSweep\(\)/.test(server), 'sweep registered in server.js');
});
