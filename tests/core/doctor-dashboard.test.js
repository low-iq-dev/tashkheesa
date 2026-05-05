// tests/core/doctor-dashboard.test.js
//
// HTTP-level tests for the P1-DOC-5 doctor dashboard upgrade:
//   1. Smart routing dashboardMode (first-login / has-active /
//      history-only / new-doctor)
//   2. SLA banner (red ≤10%, amber 10-25%, none > 25%) per
//      orders.sla_hours, tier-agnostic
//   3. Welcome modal on first dashboard visit
//   4. POST /portal/doctor/onboarding/dismiss (idempotent 204)
//   5. Activity feed relative-time rendering (handler-enriched)
//
// Boots the real express app on a random port (mirrors the test
// pattern in tests/core/faq.test.js) and seeds 4 disposable doctors
// each in a different state.
//
// Skipped automatically when DATABASE_URL or JWT_SECRET is unset.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🩺 doctor dashboard smart routing + SLA banner + welcome modal (P1-DOC-5)\n');

if (!process.env.DATABASE_URL) { t.skip('doctor-dashboard', 'DATABASE_URL not set'); return; }
if (!process.env.JWT_SECRET)   { t.skip('doctor-dashboard', 'JWT_SECRET not set');   return; }

const PORT = String(20000 + Math.floor(Math.random() * 10000));
const BASE = 'http://127.0.0.1:' + PORT;
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'tashkheesa_portal';

const PREFIX = 'test-dd-' + crypto.randomBytes(3).toString('hex') + '-';
const DOC_FIRST    = PREFIX + 'first';     // first-login (NULL first_login_at, no cases)
const DOC_ACTIVE   = PREFIX + 'active';    // has-active mode + SLA banner
const DOC_HISTORY  = PREFIX + 'history';   // history-only (only completed cases)
const DOC_NEW      = PREFIX + 'new';       // new-doctor (first_login set, no cases)

const { execute, pool } = require('../../src/pg');
const { sign } = require('../../src/auth');

function cookieFor(id, lang) {
  return COOKIE_NAME + '=' + sign({
    id: id,
    role: 'doctor',
    email: id + '@test.local',
    name: 'Test Doctor',
    specialty_id: 'spec-cardiology',
    lang: lang || 'en'
  });
}

let serverProc = null;

async function bootServer() {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, { PORT, LAUNCH_GATE_OFF: '1' });
    serverProc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'server.js')], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let booted = false;
    const onData = (buf) => {
      if (!booted && /running on port/.test(buf.toString())) { booted = true; resolve(); }
    };
    serverProc.stdout.on('data', onData);
    serverProc.stderr.on('data', () => {});
    serverProc.once('exit', (code) => {
      if (!booted) reject(new Error('server exited before boot, code=' + code));
    });
    setTimeout(() => { if (!booted) reject(new Error('server boot timeout (15s)')); }, 15000);
  });
}

async function shutdownServer() {
  if (!serverProc) return;
  try { serverProc.kill('SIGTERM'); } catch (_) {}
  await new Promise((res) => setTimeout(res, 500));
  try { serverProc.kill('SIGKILL'); } catch (_) {}
  serverProc = null;
}

async function get(p, cookie) {
  const opts = { redirect: 'manual' };
  if (cookie) opts.headers = { Cookie: cookie };
  const res = await fetch(BASE + p, opts);
  const body = await res.text();
  return { status: res.status, body };
}

async function seedDoctor(id, opts) {
  // Always inserts with first_login_at = NULL. Callers that need a
  // returning-user state should call markReturning(id) afterward.
  // (Avoids the trap of trying to pass 'NOW()' as a parameter, which
  // Postgres rejects with "invalid input syntax for type timestamp".)
  void opts;
  await execute(
    `INSERT INTO users (id, email, password_hash, name, role, lang, is_active, pending_approval, specialty_id, first_login_at, created_at)
     VALUES ($1, $2, '$2b$10$0000000000000000000000', 'Test Doctor', 'doctor', 'en', true, false, 'spec-cardiology', NULL, NOW())`,
    [id, id + '@test.local']
  );
}

async function markReturning(id) {
  await execute(`UPDATE users SET first_login_at = NOW() WHERE id = $1`, [id]);
}

async function seedOrder(orderId, doctorId, status, opts) {
  // Minimal valid orders row. orders.deadline_at and accepted_at are
  // `timestamp without time zone` — to avoid TZ skew between JS UTC
  // ISO strings and Postgres NOW() in local time, we interpolate
  // INTERVALs computed entirely in SQL.
  const slaHours = opts.slaHours || 48;
  const tier = opts.tier || 'standard';
  // Hours until deadline (positive = future). Allow fractional values
  // by passing as numeric. Default = NULL → no deadline.
  const deadlineHoursAhead = (typeof opts.deadlineHoursAhead === 'number')
    ? opts.deadlineHoursAhead : null;
  const acceptedHoursAgo = (typeof opts.acceptedHoursAgo === 'number')
    ? opts.acceptedHoursAgo : null;
  const completedHoursAgo = (typeof opts.completedHoursAgo === 'number')
    ? opts.completedHoursAgo : null;
  await execute(
    `INSERT INTO orders (id, doctor_id, patient_id, specialty_id, status, urgency_tier, sla_hours,
                         deadline_at, accepted_at, completed_at, created_at, updated_at)
     VALUES ($1, $2, $3, 'spec-cardiology', $4, $5, $6,
             CASE WHEN $7::numeric IS NULL THEN NULL ELSE NOW() + ($7 * INTERVAL '1 hour') END,
             CASE WHEN $8::numeric IS NULL THEN NULL ELSE NOW() - ($8 * INTERVAL '1 hour') END,
             CASE WHEN $9::numeric IS NULL THEN NULL ELSE NOW() - ($9 * INTERVAL '1 hour') END,
             NOW(), NOW())`,
    [
      orderId,
      doctorId,
      PREFIX + 'patient',
      status,
      tier,
      slaHours,
      deadlineHoursAhead,
      acceptedHoursAgo,
      completedHoursAgo
    ]
  );
}

async function cleanup() {
  await execute(`DELETE FROM order_events WHERE order_id LIKE $1`, [PREFIX + '%']);
  // P1-DOC-7: widget seeds (messages, conversations, doctor_earnings) —
  // delete before orders so any FKs cascade cleanly.
  await execute(`DELETE FROM messages WHERE id LIKE $1`, [PREFIX + '%']);
  await execute(`DELETE FROM conversations WHERE id LIKE $1 OR doctor_id LIKE $1`, [PREFIX + '%']);
  await execute(`DELETE FROM doctor_earnings WHERE id LIKE $1 OR doctor_id LIKE $1`, [PREFIX + '%']);
  await execute(`DELETE FROM orders WHERE id LIKE $1 OR doctor_id LIKE $1`, [PREFIX + '%']);
  await execute(`DELETE FROM users WHERE id LIKE $1`, [PREFIX + '%']);
}

(async function run() {
  try {
    await cleanup();

    // ── Doctor 1: first-login (NULL first_login_at, no cases) ───────
    await seedDoctor(DOC_FIRST, {});

    // ── Doctor 2: has-active + SLA banner. Mark as returning so the
    // welcome overlay assertions in the has-active block don't fire. ──
    await seedDoctor(DOC_ACTIVE, {});
    await markReturning(DOC_ACTIVE);
    const slaH = 48;
    // 5% / 20% / 50% of 48h remaining → 2.4h / 9.6h / 24h ahead
    await seedOrder(PREFIX + 'order-red',   DOC_ACTIVE, 'in_review', { slaHours: slaH, deadlineHoursAhead: slaH * 0.05, acceptedHoursAgo: 24 });
    await seedOrder(PREFIX + 'order-amber', DOC_ACTIVE, 'in_review', { slaHours: slaH, deadlineHoursAhead: slaH * 0.20, acceptedHoursAgo: 24 });
    await seedOrder(PREFIX + 'order-green', DOC_ACTIVE, 'in_review', { slaHours: slaH, deadlineHoursAhead: slaH * 0.50, acceptedHoursAgo: 24 });

    // ── Doctor 3: history-only (only completed cases, returning) ────
    await seedDoctor(DOC_HISTORY, {});
    await markReturning(DOC_HISTORY);
    await seedOrder(PREFIX + 'order-done', DOC_HISTORY, 'completed', {
      slaHours: 48,
      acceptedHoursAgo: 7 * 24,
      completedHoursAgo: 6 * 24
    });

    // P1-DOC-7: seed widget content for DOC_HISTORY against the
    // existing order-done. One conversation + 2 unread patient messages
    // + 1 read patient message + 1 paid earning. The doctor_earnings
    // row uses appointment_id = order-id (matches the main-case
    // earnings_writer.js shape; covered_by COALESCE in the dashboard
    // query).
    await execute(
      `INSERT INTO conversations (id, order_id, patient_id, doctor_id, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'open', NOW() - INTERVAL '5 days', NOW())`,
      [PREFIX + 'conv-1', PREFIX + 'order-done', PREFIX + 'patient', DOC_HISTORY]
    );
    await execute(
      `INSERT INTO messages (id, conversation_id, sender_id, sender_role, content, message_type, is_read, created_at)
       VALUES
         ($1, $2, $3, 'patient', 'unread message a', 'text', false, NOW() - INTERVAL '2 hours'),
         ($4, $2, $3, 'patient', 'unread message b', 'text', false, NOW() - INTERVAL '1 hour'),
         ($5, $2, $3, 'patient', 'read message',     'text', true,  NOW() - INTERVAL '4 days')`,
      [
        PREFIX + 'msg-1', PREFIX + 'conv-1', PREFIX + 'patient',
        PREFIX + 'msg-2',
        PREFIX + 'msg-3'
      ]
    );
    await execute(
      `INSERT INTO doctor_earnings
         (id, doctor_id, appointment_id, gross_amount, commission_pct, earned_amount, status, paid_at, created_at)
       VALUES ($1, $2, $3, 1500, 80, 1200, 'paid', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days')`,
      [PREFIX + 'earn-1', DOC_HISTORY, PREFIX + 'order-done']
    );

    // ── Doctor 4: new-doctor (no cases at all, returning user) ──────
    await seedDoctor(DOC_NEW, {});
    await markReturning(DOC_NEW);

    try { await bootServer(); }
    catch (e) { t.skip('doctor-dashboard', 'server boot failed: ' + e.message); return; }

    try {
      const ping = await fetch(BASE + '/__version', { redirect: 'manual' });
      assert.ok(ping.status >= 200 && ping.status < 500, 'server alive');
    } catch (e) { t.skip('doctor-dashboard', 'server unreachable: ' + e.message); return; }

    // ── First-login mode: welcome modal present, mode set ───────────
    let firstBody = '';
    try {
      const r = await get('/portal/doctor', cookieFor(DOC_FIRST));
      assert.strictEqual(r.status, 200, 'GET /portal/doctor (first-login) must 200, got ' + r.status);
      firstBody = r.body;
      assert.ok(/data-mode="first-login"/.test(firstBody), 'page must declare data-mode="first-login"');
      // Match the rendered <div id="dd-welcome-overlay">, not the CSS
      // selector .dd-welcome-overlay in the always-present <style> block.
      assert.ok(/id="dd-welcome-overlay"/.test(firstBody), 'first-login must render welcome overlay element');
      assert.ok(/Welcome to Tashkheesa, Dr\./.test(firstBody), 'overlay must show approved welcome heading');
      assert.ok(firstBody.includes('Where new cases appear') &&
                firstBody.includes('Accepting a case') &&
                firstBody.includes('How your earnings work'),
                'all 3 panel titles must render verbatim from approved copy');
      t.pass('first-login mode: data-mode + welcome overlay + 3 approved panels');
    } catch (e) { t.fail('first-login mode', e); }

    // ── First-login mark fires server-side (fire-and-forget) ────────
    try {
      // Allow the async UPDATE to land.
      await new Promise((r) => setTimeout(r, 250));
      const row = await execute(
        'SELECT first_login_at FROM users WHERE id = $1',
        [DOC_FIRST]
      ).then(() => require('../../src/pg').queryAll(
        'SELECT first_login_at FROM users WHERE id = $1', [DOC_FIRST]
      ));
      assert.ok(row && row[0] && row[0].first_login_at, 'first_login_at must be set after dashboard hit');
      t.pass('first-login mark: server fire-and-forget UPDATE persisted');
    } catch (e) { t.fail('first-login mark', e); }

    // Subsequent visit → no overlay. The handler's fire-and-forget
    // UPDATE may not have committed yet on a fast test loop, so we
    // explicitly mark the doctor as returning here. The production
    // path is exercised separately by the "first-login mark" test
    // above, which gives the async UPDATE 250ms to land.
    try {
      await markReturning(DOC_FIRST);
      const r = await get('/portal/doctor', cookieFor(DOC_FIRST));
      assert.strictEqual(r.status, 200, 'second visit must 200');
      assert.ok(!/id="dd-welcome-overlay"/.test(r.body), 'returning user must not see welcome overlay');
      t.pass('returning user: welcome overlay not shown after first_login_at is set');
    } catch (e) { t.fail('returning user no-overlay', e); }

    // ── has-active mode + SLA banner red (any red wins) ─────────────
    try {
      const r = await get('/portal/doctor', cookieFor(DOC_ACTIVE));
      assert.strictEqual(r.status, 200, 'has-active GET must 200');
      assert.ok(/data-mode="has-active"/.test(r.body), 'page must declare data-mode="has-active"');
      // Match the rendered <div class="dd-sla-banner dd-sla-banner--red">,
      // not the CSS selectors in the always-present <style> block.
      assert.ok(/<div class="dd-sla-banner dd-sla-banner--red"/.test(r.body),
        'red SLA banner element must render when any case is ≤10% remaining');
      assert.ok(/approaching SLA/.test(r.body), 'banner copy must mention "approaching SLA"');
      assert.ok(!/id="dd-welcome-overlay"/.test(r.body), 'has-active doctor must not see welcome overlay');
      t.pass('has-active mode: data-mode + red SLA banner + no overlay');
    } catch (e) { t.fail('has-active mode', e); }

    // Without the red case, banner should drop to amber.
    try {
      await execute(
        'DELETE FROM orders WHERE id = $1',
        [PREFIX + 'order-red']
      );
      const r = await get('/portal/doctor', cookieFor(DOC_ACTIVE));
      assert.ok(/<div class="dd-sla-banner dd-sla-banner--amber"/.test(r.body),
        'amber SLA banner element must render when only amber-tier cases remain');
      assert.ok(!/<div class="dd-sla-banner dd-sla-banner--red"/.test(r.body),
        'red banner element must drop when no ≤10% case remains');
      t.pass('SLA banner: amber tier renders correctly when red is gone');
    } catch (e) { t.fail('SLA banner amber', e); }

    // Without amber too, banner should disappear.
    try {
      await execute(
        'DELETE FROM orders WHERE id = $1',
        [PREFIX + 'order-amber']
      );
      const r = await get('/portal/doctor', cookieFor(DOC_ACTIVE));
      assert.ok(!/<div class="dd-sla-banner /.test(r.body),
        'banner element must disappear when no case is ≤25% remaining');
      t.pass('SLA banner: absent when all cases > 25% SLA remaining');
    } catch (e) { t.fail('SLA banner none', e); }

    // ── history-only mode ───────────────────────────────────────────
    try {
      const r = await get('/portal/doctor', cookieFor(DOC_HISTORY));
      assert.strictEqual(r.status, 200, 'history-only GET must 200');
      assert.ok(/data-mode="history-only"/.test(r.body),
        'page must declare data-mode="history-only" for doctor with only completed cases');
      // The tips DIV is conditionally rendered only when _mode==='new-doctor'.
      // Class name appears in <style> always; the rendered <div> is what matters.
      assert.ok(!/<div class="dd-newdoc-tips"/.test(r.body),
        'new-doctor tips <div> must NOT be rendered in history-only mode');
      t.pass('history-only mode: data-mode set, new-doctor tips block not rendered');
    } catch (e) { t.fail('history-only mode', e); }

    // ── new-doctor mode ─────────────────────────────────────────────
    try {
      const r = await get('/portal/doctor', cookieFor(DOC_NEW));
      assert.strictEqual(r.status, 200, 'new-doctor GET must 200');
      assert.ok(/data-mode="new-doctor"/.test(r.body), 'page must declare data-mode="new-doctor"');
      assert.ok(/dd-newdoc-tips/.test(r.body), 'new-doctor tips block must render');
      assert.ok(/Get started/.test(r.body) || /بداية موفقة/.test(r.body),
        'new-doctor tips must include the get-started copy');
      t.pass('new-doctor mode: data-mode + tips block rendered');
    } catch (e) { t.fail('new-doctor mode', e); }

    // ── Dismiss endpoint: idempotent 204 ────────────────────────────
    try {
      // Reset DOC_NEW to NULL first so the test can observe the flip.
      await execute('UPDATE users SET first_login_at = NULL WHERE id = $1', [DOC_NEW]);
      const r1 = await fetch(BASE + '/portal/doctor/onboarding/dismiss', {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: cookieFor(DOC_NEW), 'Content-Type': 'application/json' }
      });
      assert.strictEqual(r1.status, 204, 'first dismiss must 204, got ' + r1.status);
      const r2 = await fetch(BASE + '/portal/doctor/onboarding/dismiss', {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: cookieFor(DOC_NEW), 'Content-Type': 'application/json' }
      });
      assert.strictEqual(r2.status, 204, 'second dismiss must also 204 (idempotent)');
      const { queryAll } = require('../../src/pg');
      const rows = await queryAll('SELECT first_login_at FROM users WHERE id = $1', [DOC_NEW]);
      assert.ok(rows && rows[0] && rows[0].first_login_at, 'dismiss must set first_login_at');
      t.pass('dismiss endpoint: idempotent 204, first_login_at set');
    } catch (e) { t.fail('dismiss endpoint', e); }

    // ── Activity feed: relativeTime rendered for any events ─────────
    try {
      // Seed an order_events row for DOC_HISTORY so the activity feed
      // has something to render.
      await execute(
        `INSERT INTO order_events (id, order_id, label, at, actor_role)
         VALUES ($1, $2, 'order_completed', NOW() - INTERVAL '3 hours', 'doctor')`,
        [PREFIX + 'event-1', PREFIX + 'order-done']
      );
      const r = await get('/portal/doctor', cookieFor(DOC_HISTORY));
      // Handler-enriched relativeTime should produce "3h ago" for the
      // 3-hours-ago event. View prefers ev.relativeTime over _relTime.
      assert.ok(/3h ago|2h ago|4h ago/.test(r.body),
        'activity feed must render handler-enriched relative time (Nh ago)');
      t.pass('activity feed: handler-enriched relativeTime used in render');
    } catch (e) { t.fail('activity feed relativeTime', e); }

    // ── P1-DOC-7: dashboard tour auto-chain (commit 2) ──────────────
    // First-login dashboard renders the welcome modal + dismiss handler.
    // Verify the dismiss handler now sets the localStorage flag and
    // calls window.startPortalTour(). Brittle textual assertion against
    // inline JS — matches the pattern already used by other dashboard
    // tests in this file.
    try {
      // The dismiss-endpoint test above flipped DOC_NEW's first_login_at
      // back to NOW(). Reset it so the welcome overlay + its inline
      // dismiss handler render again on this fetch.
      await execute('UPDATE users SET first_login_at = NULL WHERE id = $1', [DOC_NEW]);
      const r = await get('/portal/doctor', cookieFor(DOC_NEW));
      assert.ok(/id="dd-welcome-overlay"/.test(r.body), 'welcome overlay must render for first-login DOC_NEW');
      assert.ok(/tour_seen_dashboard_v1/.test(r.body),
        'dismiss handler must reference the localStorage tour-seen flag');
      assert.ok(/window\.startPortalTour/.test(r.body),
        'dismiss handler must call window.startPortalTour after dismiss');
      t.pass('P1-DOC-7 commit 2: dismiss handler auto-chains the tour via localStorage gate');
    } catch (e) { t.fail('tour auto-chain handler', e); }

    // ── P1-DOC-7: tour content refresh (commit 3) ───────────────────
    // The dashboard tour file must NOT contain the old P1-DOC-1 stub
    // copy. Repointed step 4 must reference the in-page case-queue
    // selector instead.
    try {
      const r = await fetch(BASE + '/js/tours/doctor-tour.js', { redirect: 'manual' });
      assert.strictEqual(r.status, 200, '/js/tours/doctor-tour.js must serve 200');
      const src = await r.text();
      assert.ok(!/Communicate with your patients securely/.test(src),
        'tour must no longer ship the old P1-DOC-1 stub copy');
      assert.ok(/data-tour="case-queue"/.test(src),
        'tour step 4 must target the new data-tour="case-queue" selector');
      assert.ok(/Open any case from your queue/.test(src),
        'tour step 4 must carry the refreshed copy referencing the queue');
      t.pass('P1-DOC-7 commit 3: tour content refreshed, no stub-page references');
    } catch (e) { t.fail('tour content refresh', e); }

    // ── P1-DOC-7: data-tour anchor on the dashboard (commit 3+4) ────
    try {
      const r = await get('/portal/doctor', cookieFor(DOC_HISTORY));
      assert.ok(/data-tour="case-queue"/.test(r.body),
        'dashboard must expose data-tour="case-queue" so the refreshed tour step has a target');
      t.pass('P1-DOC-7: dashboard exposes data-tour="case-queue" anchor');
    } catch (e) { t.fail('data-tour anchor', e); }

    // ── P1-DOC-7: widget — unread messages (commit 4) ───────────────
    // DOC_HISTORY was seeded with 2 unread + 1 read patient message
    // across 1 conversation. The widget should render count=2,
    // conversation_count=1, and link to the order-done case detail.
    try {
      const r = await get('/portal/doctor', cookieFor(DOC_HISTORY));
      assert.ok(/Unread messages/.test(r.body), 'unread messages widget label must render in EN');
      // Widget value cell: <div class="dd-widget-value">2</div>. Use a
      // tight regex so we're not matching the literal "2" elsewhere.
      assert.ok(/<div class="dd-widget-value">\s*2\s*<\/div>/.test(r.body),
        'unread messages widget must show count=2');
      assert.ok(/from 1 conversation\b/.test(r.body),
        'unread widget must show "from 1 conversation" (singular form)');
      // Click target = /portal/doctor/case/<order_id of most recent unread>
      const expectedHref = '/portal/doctor/case/' + encodeURIComponent(PREFIX + 'order-done');
      assert.ok(r.body.indexOf('href="' + expectedHref + '" class="dd-card dd-widget"') !== -1,
        'unread widget must link to most-recent unread case detail; expected href=' + expectedHref);
      t.pass('P1-DOC-7 commit 4: unread messages widget renders count + click target');
    } catch (e) { t.fail('unread messages widget', e); }

    // ── P1-DOC-7: widget — recently paid earning (commit 4) ─────────
    try {
      const r = await get('/portal/doctor', cookieFor(DOC_HISTORY));
      assert.ok(/Recently paid/.test(r.body), 'recent earnings widget label must render in EN');
      // Earned amount = 1200 → _fmtEgp formats as "1,200" (locale en-US).
      assert.ok(/EGP\s*1,200/.test(r.body),
        'earnings widget must render EGP-prefixed amount with locale formatting');
      const expectedHref = '/portal/doctor/case/' + encodeURIComponent(PREFIX + 'order-done');
      assert.ok(r.body.indexOf('href="' + expectedHref + '" class="dd-card dd-widget"') !== -1,
        'earnings widget must link to the case detail via COALESCE-resolved order_id');
      t.pass('P1-DOC-7 commit 4: recent earnings widget renders amount + click target');
    } catch (e) { t.fail('recent earnings widget', e); }

    // ── P1-DOC-7: widgets empty states (commit 4) ───────────────────
    // DOC_NEW has neither conversations nor doctor_earnings rows — both
    // widgets should render their muted placeholders.
    try {
      // Reset DOC_NEW to "returning" first so the welcome overlay isn't
      // covering everything (the widgets render either way, but we want
      // a clean assertion path).
      await markReturning(DOC_NEW);
      const r = await get('/portal/doctor', cookieFor(DOC_NEW));
      assert.ok(/No unread messages/.test(r.body),
        'no-data: empty unread-messages placeholder must render');
      assert.ok(/No recent earnings/.test(r.body),
        'no-data: empty recent-earnings placeholder must render');
      // Empty cards must NOT be wrapped in <a> (no click target).
      assert.ok(/<div class="dd-card dd-widget dd-widget--empty">/.test(r.body),
        'empty widgets must use <div class="dd-card dd-widget dd-widget--empty"> (non-clickable)');
      t.pass('P1-DOC-7 commit 4: widgets render empty placeholders for doctor with no data');
    } catch (e) { t.fail('widgets empty state', e); }

    // ── P1-DOC-7: widgets bilingual AR rendering (commit 4) ─────────
    // The lang resolution prefers user.lang from JWT over the ?lang
    // query param, so we sign a fresh AR cookie rather than appending
    // a query param.
    try {
      const r = await get('/portal/doctor', cookieFor(DOC_HISTORY, 'ar'));
      assert.strictEqual(r.status, 200, 'AR dashboard must 200');
      assert.ok(/رسائل غير مقروءة/.test(r.body), 'AR: unread messages label must render');
      assert.ok(/الأرباح الأخيرة/.test(r.body),  'AR: recent earnings label must render');
      assert.ok(/من محادثة واحدة/.test(r.body),
        'AR: unread widget must use singular AR form for 1 conversation');
      t.pass('P1-DOC-7 commit 4: widgets render bilingual (AR labels + singular form)');
    } catch (e) { t.fail('widgets AR rendering', e); }

  } finally {
    try { await shutdownServer(); } catch (_) {}
    try { await cleanup(); } catch (_) {}
    if (require.main === module) {
      try { await pool.end(); } catch (_) {}
    }
  }
})();
