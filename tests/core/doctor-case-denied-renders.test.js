// tests/core/doctor-case-denied-renders.test.js
//
// The refusal screen must render (6 Oct 2026).
//
// On 25 Sep 2026 Dr Yomna Mohsen pressed Accept on a VIP paediatrics case and
// got "Something went wrong" six times in four minutes (err_5b920aea and
// five siblings in error_logs). The cause was not the accept path at all:
// every pool-accept refusal redirects to the case page, the case page called
// renderAccessDenied, and that render omitted the `files` local, so
// portal_doctor_case.ejs threw ReferenceError: files is not defined. The
// doctor never saw WHY she was refused — she saw a crash, and stopped using
// the platform. Commit 8161661 added the typeof guard for `files`.
//
// That fix guarded ONE local. The bug class is "the denial payload is a
// different, smaller shape than the happy-path payload, and the template
// reaches for something only the happy path provides". So this test does not
// re-check `files`: it renders the real template with EXACTLY the locals
// renderAccessDenied passes — read out of routes/doctor.js, so the test
// cannot drift from the route — for every refusal reason, and fails if any of
// them throws.
//
// A negative control proves the render really is load-bearing: strip the
// template's typeof guards and the same render must throw.

'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

const ROOT = path.join(__dirname, '..', '..');
const VIEWS = path.join(ROOT, 'src', 'views');
const VIEW_PATH = path.join(VIEWS, 'portal_doctor_case.ejs');

// Every reason renderAccessDenied is called with, plus the ?msg= codes the
// pool-accept guardrails redirect with (they ride the denial screen as
// errorMessage), plus an unknown code — a future guardrail's reason must not
// be able to crash the page before anyone writes copy for it.
const REASONS = [
  'assigned_to_other_doctor',
  'case_not_available',
  'case_unroutable',
  'specialty',
  'tier_not_supported',
  'account_inactive',
  'account_check_failed',
  'capacity',
  'already_taken',
  'case_declined',
  'case_handed_back',
  'a_reason_nobody_has_written_copy_for_yet',
  ''
];

console.log('\n🚫 Doctor case page — the refusal screen renders for every reason\n');

module.exports = (async function () {
  let viewSrc;
  try {
    viewSrc = fs.readFileSync(VIEW_PATH, 'utf8');
  } catch (e) {
    t.fail('read portal_doctor_case.ejs', e);
    return;
  }

  // ── Stub the chrome so this exercises the page's own logic ──────────────
  const stubbed = [];
  function stubPartials() {
    ['partials/header', 'partials/footer', 'partials/head', 'partials/foot'].forEach(function (p) {
      const fp = path.join(VIEWS, p + '.ejs');
      ejs.cache.set(fp, function () { return ''; });
      stubbed.push(fp);
    });
  }
  stubPartials();

  // ── The denial payload, read out of the route ───────────────────────────
  //
  // Parsed rather than hand-copied: if someone adds a key to renderAccessDenied
  // this test picks it up, and if someone REMOVES one the render below starts
  // failing — which is the whole point.
  let routeKeys = [];
  try {
    const routeSrc = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'doctor.js'), 'utf8');
    const fnStart = routeSrc.indexOf('async function renderAccessDenied(');
    if (fnStart < 0) throw new Error('renderAccessDenied not found in src/routes/doctor.js');
    const renderStart = routeSrc.indexOf("render('portal_doctor_case'", fnStart);
    if (renderStart < 0) throw new Error("renderAccessDenied no longer renders 'portal_doctor_case'");
    const block = routeSrc.slice(renderStart, routeSrc.indexOf('});', renderStart));
    routeKeys = (block.match(/^\s{6,}([A-Za-z_$][\w$]*)\s*[:,]/gm) || [])
      .map((s) => s.trim().replace(/[:,]$/, ''));
    // errorMessage arrives via a conditional spread on its own line
    // (`...(capacityMessage ? { errorMessage: capacityMessage } : {})`), which
    // the line-anchored match above cannot see. It is the one local the X6 fix
    // of 20 Sep 2026 added, so assert the route still carries it rather than
    // quietly assuming it.
    if (!/errorMessage/.test(block)) {
      throw new Error('renderAccessDenied no longer passes errorMessage — a refused doctor would be told nothing specific');
    }
    if (routeKeys.indexOf('errorMessage') === -1) routeKeys.push('errorMessage');
    if (routeKeys.length < 10) throw new Error('parsed only ' + routeKeys.length + ' locals from renderAccessDenied — the parser needs updating');
    t.pass('parsed ' + routeKeys.length + ' locals out of renderAccessDenied');
  } catch (e) {
    t.fail('parse the renderAccessDenied payload', e);
    return;
  }

  // Values for the keys the route passes. Shapes match the route exactly:
  // order is null, nothing is viewable, and `files` is ABSENT — not empty.
  const ROUTE_VALUES = {
    errorMessage: 'You are at your case limit.',
    portalFrame: true,
    portalRole: 'doctor',
    portalActive: 'queue',
    brand: 'Tashkheesa',
    title: 'Case Detail',
    user: { id: 'doc_test', name: 'Dr Test', role: 'doctor' },
    lang: 'en',
    isAr: false,
    order: null,
    blurred: false,
    canViewDetails: false,
    accessDenied: true,
    reason: '',
    activeTab: 'cases',
    nextPath: '/portal/doctor/case/abc',
    acceptActionUrl: '/portal/doctor/case/abc/accept',
    streakCount: 0
  };

  // Ambient locals the app's own middleware puts on res.locals for EVERY
  // render (src/server.js ~600 for tt). These are legitimately not in the
  // route's payload, so supplying them is not cheating.
  const AMBIENT = {
    tt: function (k, en /*, ar */) { return en; },
    t: function (k, fb) { return fb || k; },
    csrfToken: 'testcsrf',
    cspNonce: 'testnonce',
    isAnnotatableName: function () { return false; }
  };

  function denialLocals(reason, withErrorMessage) {
    const out = Object.assign({}, AMBIENT);
    routeKeys.forEach(function (k) {
      if (k === 'errorMessage' && !withErrorMessage) return; // spread is conditional in the route
      if (Object.prototype.hasOwnProperty.call(ROUTE_VALUES, k)) out[k] = ROUTE_VALUES[k];
      else out[k] = null; // a key we have no value for: null is the honest default
    });
    out.reason = reason;
    // `files` is deliberately NOT set — that absence is the original bug.
    return out;
  }

  // ── 1. Every reason renders, with and without the refusal message ───────
  let failures = [];
  REASONS.forEach(function (reason) {
    [true, false].forEach(function (withMsg) {
      [true, false].forEach(function (isAr) {
        const locals = denialLocals(reason, withMsg);
        locals.isAr = isAr;
        locals.lang = isAr ? 'ar' : 'en';
        try {
          const html = ejs.render(viewSrc, locals, { filename: VIEW_PATH });
          if (!html || html.length < 50) {
            failures.push(reason + ' (msg=' + withMsg + ', ar=' + isAr + '): rendered almost nothing');
          }
        } catch (e) {
          failures.push(reason + ' (msg=' + withMsg + ', ar=' + isAr + '): ' + ((e && e.message) || e));
        }
      });
    });
  });

  if (failures.length) {
    t.fail('the refusal screen renders for every reason', new Error(failures.slice(0, 4).join(' | ') + (failures.length > 4 ? ' | …and ' + (failures.length - 4) + ' more' : '')));
  } else {
    t.pass('the refusal screen renders for all ' + REASONS.length + ' reasons, both languages, with and without a refusal message');
  }

  // ── 2. The reason the doctor was refused must actually be shown ─────────
  //
  // The crash hid the reason; a silent denial screen hides it just as well.
  try {
    const locals = denialLocals('capacity', true);
    const html = ejs.render(viewSrc, locals, { filename: VIEW_PATH });
    if (html.indexOf('You are at your case limit.') === -1) {
      throw new Error('errorMessage is not rendered — the doctor is refused without being told why');
    }
    t.pass('the refusal message reaches the page');
  } catch (e) {
    t.fail('the refusal message reaches the page', e);
  }

  // ── 3. Negative control: the guards are load-bearing ────────────────────
  //
  // Without this, a template that stopped touching these locals at all would
  // pass test 1 while proving nothing.
  try {
    const unguarded = viewSrc.replace(/typeof\s+(\w+)\s*!==\s*'undefined'/g, 'true');
    let threw = false;
    try {
      ejs.render(unguarded, denialLocals('case_not_available', false), { filename: VIEW_PATH });
    } catch (_) {
      threw = true;
    }
    if (!threw) {
      throw new Error('stripping the typeof guards did NOT break the render — this test is not exercising the denial path');
    }
    t.pass('negative control: the typeof guards are what keep the denial render alive');
  } catch (e) {
    t.fail('negative control: the typeof guards are what keep the denial render alive', e);
  }

  // Leave ejs.cache as we found it (the runner also clears between files).
  stubbed.forEach(function (fp) { try { ejs.cache.set(fp, undefined); } catch (_) {} });
})();
