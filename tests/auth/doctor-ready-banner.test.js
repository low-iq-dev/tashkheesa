// tests/auth/doctor-ready-banner.test.js
//
// AUDIT-NO-COMPLETION-STATE-2026-09-20
//
// A doctor who finished onboarding got no confirmation: the two nudges simply
// vanished and they landed on a dashboard of zeros. Dr Ahmed Hegazy finished
// on 13 Sep 15:43 and was still asking "how do I complete it" two days later.
//
// The risk in the fix is the opposite failure - telling a doctor they are
// ready when they are not, or stacking "your account is complete" underneath
// "confirm your services". These pin the conditions.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n✅ AUDIT-NO-COMPLETION-STATE - doctor "account complete" state\n');

const src = fs.readFileSync(path.join(__dirname, '../../src/routes/doctor.js'), 'utf8');
const fnStart = src.indexOf('async function _computeReadyBannerFlag');
const fn = fnStart > -1 ? src.slice(fnStart, src.indexOf('\n}', fnStart)) : '';

// 1. The flag function exists and is wired into the per-request middleware.
try {
  assert.ok(fnStart > -1, '_computeReadyBannerFlag is missing from doctor.js');
  assert.ok(/_computeReadyBannerFlag\(req, res\)/.test(src),
    '_computeReadyBannerFlag is never called from the request middleware');
  t.pass('flag is computed once per request, like the other two banners');
} catch (e) { t.fail('flag is computed once per request, like the other two banners', e); }

// 2. It NEVER stacks with either nudge.
try {
  assert.ok(/doctorServicesBanner\s*===\s*true\)\s*return/.test(fn),
    'does not bail out when the services nudge is showing');
  assert.ok(/doctorTierBanner\s*===\s*true\)\s*return/.test(fn),
    'does not bail out when the tier nudge is showing');
  t.pass('never renders under an unresolved nudge');
} catch (e) { t.fail('never renders under an unresolved nudge', e); }

// 3. It never promises cases to a doctor who cannot receive them.
try {
  assert.ok(/is_active === false/.test(fn), 'does not check is_active');
  assert.ok(/is_paused === true/.test(fn), 'does not check is_paused');
  assert.ok(/pending_approval === true/.test(fn), 'does not check pending_approval');
  assert.ok(/sla_tiers_confirmed_at\)\s*return/.test(fn), 'does not require confirmed tiers');
  assert.ok(/await shouldLandOnServices\(row\)\)\s*return/.test(fn),
    'does not reuse the shared services-complete predicate');
  t.pass('an unassignable or unfinished doctor is never told they are ready');
} catch (e) { t.fail('an unassignable or unfinished doctor is never told they are ready', e); }

// 4. Self-retiring: gone once the doctor has ever held a case.
try {
  assert.ok(/COUNT\(\*\)::int AS c FROM orders WHERE doctor_id/.test(fn),
    'does not check whether the doctor has ever held a case');
  assert.ok(/Number\(seen\.c\) > 0\)\s*return/.test(fn),
    'does not retire itself once a case exists');
  t.pass('retires itself on the first assignment - no dismissal state needed');
} catch (e) { t.fail('retires itself on the first assignment - no dismissal state needed', e); }

// 5. Fails to OFF, like both nudges.
try {
  const tail = fn.slice(fn.lastIndexOf('catch'));
  assert.ok(/doctorReadyBanner = false/.test(tail),
    'the catch block does not fail the banner to OFF');
  t.pass('a failure leaves the banner off rather than claiming readiness');
} catch (e) { t.fail('a failure leaves the banner off rather than claiming readiness', e); }

// 6. The orders read satisfies the repo's own allowlist lint.
try {
  assert.ok(/FROM orders WHERE doctor_id = \$1 AND deleted_at IS NULL/.test(fn),
    'the orders read is unfiltered - must use orders_active or deleted_at IS NULL');
  t.pass('orders read carries deleted_at IS NULL');
} catch (e) { t.fail('orders read carries deleted_at IS NULL', e); }

// 7. The partial renders, is bilingual, and is included on the landing page.
try {
  const p = path.join(__dirname, '../../src/views/partials/doctor/ready_banner.ejs');
  assert.ok(fs.existsSync(p), 'ready_banner.ejs does not exist');
  const ejs = fs.readFileSync(p, 'utf8');
  assert.ok(/حسابك مكتمل/.test(ejs), 'missing the Arabic confirmation line');
  assert.ok(/Your account is complete/.test(ejs), 'missing the English confirmation line');
  assert.ok(/doctorReadyBanner/.test(ejs), 'the partial does not read the flag');

  const dash = fs.readFileSync(path.join(__dirname, '../../src/views/portal_doctor_dashboard.ejs'), 'utf8');
  assert.ok(/partials\/doctor\/ready_banner/.test(dash),
    'the landing page does not include the partial');
  t.pass('bilingual partial rendered on the page a doctor actually lands on');
} catch (e) { t.fail('bilingual partial rendered on the page a doctor actually lands on', e); }

// 8. It answers the question Hegazy actually asked: what happens next.
try {
  const ejs = fs.readFileSync(path.join(__dirname, '../../src/views/partials/doctor/ready_banner.ejs'), 'utf8');
  assert.ok(/notified when a case is assigned/i.test(ejs),
    'does not say what happens next in English');
  assert.ok(/هتوصلك إشعار/.test(ejs), 'does not say what happens next in Arabic');
  t.pass('states what happens next, not just that the account is done');
} catch (e) { t.fail('states what happens next, not just that the account is done', e); }
