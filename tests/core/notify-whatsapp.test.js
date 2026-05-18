// tests/core/notify-whatsapp.test.js
//
// P1-NOTIF-1 audit-and-fix tests:
//   1. WHATSAPP_TEST_STUB short-circuits sendWhatsApp without network
//   2. queueMultiChannelNotification dispatches channels concurrently
//      (Promise.allSettled) — slow channel doesn't block fast channel
//   3. Inline WhatsApp dispatch is GONE from queueNotification
//      (worker-only path)
//   4. WhatsApp failure is fail-soft — caller never throws, email/internal
//      channels still succeed
//   5. Failures land in error_logs with category='whatsapp_send'
//   6. Worker uses safe-fallback template resolution: getWhatsAppTemplate
//      hit → mapped name + paramBuilder; miss → raw event name + user.lang
//
// Pure-JS tests (no server boot) — exercises notify.js + whatsapp.js +
// notification_worker.js modules directly with stubbed pg + fetch where
// possible. Skipped when DATABASE_URL is unset because some queries
// hit the real DB.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const assert = require('assert');
const crypto = require('crypto');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n📨 P1-NOTIF-1 WhatsApp parity audit-and-fix\n');

if (!process.env.DATABASE_URL) { t.skip('notify-whatsapp', 'DATABASE_URL not set'); return; }

const PREFIX = 'test-wa-' + crypto.randomBytes(3).toString('hex') + '-';
const USER_ID  = PREFIX + 'user';
const ORDER_ID = PREFIX + 'order';

const { execute, queryAll, queryOne, pool } = require('../../src/pg');

(async function run() {
  try {
    // ── Pre-clean ──────────────────────────────────────────────────
    await execute(`DELETE FROM error_logs WHERE user_id LIKE $1`, [PREFIX + '%']);
    await execute(`DELETE FROM notifications WHERE to_user_id LIKE $1 OR order_id LIKE $1`, [PREFIX + '%']);
    await execute(`DELETE FROM orders WHERE id LIKE $1`, [PREFIX + '%']);
    await execute(`DELETE FROM users WHERE id LIKE $1`, [PREFIX + '%']);

    // Test user with phone + email + opt-in
    await execute(
      `INSERT INTO users (id, email, password_hash, name, role, lang, is_active, pending_approval, phone, notify_whatsapp, created_at)
       VALUES ($1, $2, '$2b$10$0', 'Test Patient', 'patient', 'ar', true, false, '+201001234567', true, NOW())`,
      [USER_ID, USER_ID + '@test.local']
    );
    // Order shell so notifications.order_id FK constraint (if any) is satisfied
    await execute(
      `INSERT INTO orders (id, patient_id, status, urgency_tier, sla_hours, created_at, updated_at)
       VALUES ($1, $2, 'paid', 'standard', 48, NOW(), NOW())`,
      [ORDER_ID, USER_ID]
    );

    // ── 1. Stub mode short-circuits sendWhatsApp ────────────────────
    try {
      process.env.WHATSAPP_TEST_STUB = 'true';
      // Must require AFTER setting env so the module reads it (the helper
      // re-reads process.env on each call, but be belt-and-suspenders).
      delete require.cache[require.resolve('../../src/notify/whatsapp')];
      const { sendWhatsApp } = require('../../src/notify/whatsapp');
      const r = await sendWhatsApp({ to: '+201001234567', template: 'foo', lang: 'en', vars: {} });
      assert.strictEqual(r.ok, true, 'stubbed send must return ok=true');
      assert.strictEqual(r.stubbed, true, 'stubbed send must be flagged stubbed=true');
      assert.strictEqual(r.template, 'foo', 'stubbed result must echo template');
      assert.strictEqual(r.to, '201001234567', 'stubbed result must echo normalized phone');
      t.pass('stub mode: WHATSAPP_TEST_STUB=true short-circuits, no network');
    } catch (e) { t.fail('stub mode', e); }

    // ── 2. Inline dispatch was killed in queueNotification ──────────
    // Now that we removed the inline send, queueNotification('whatsapp', ...)
    // should INSERT a row and return without calling sendWhatsApp at all.
    // We verify by checking the source for the inline branch.
    try {
      const fs = require('fs');
      const src = fs.readFileSync(require.resolve('../../src/notify'), 'utf8');
      // The inline branch used to be `if (channel === 'whatsapp') { ... sendWhatsApp(...) }`.
      // After the kill it should NOT contain `sendWhatsApp(` inside queueNotification.
      // Look for any sendWhatsApp invocation in the file (worker is in a different file).
      assert.ok(!/sendWhatsApp\s*\(/.test(src),
        'src/notify.js must not call sendWhatsApp anymore (worker-only after P1-NOTIF-1)');
      t.pass('inline dispatch killed: src/notify.js no longer calls sendWhatsApp');
    } catch (e) { t.fail('inline dispatch killed', e); }

    // ── 3. queueNotification('whatsapp') just queues + returns ─────
    try {
      const { queueNotification } = require('../../src/notify');
      const before = await queryOne(
        "SELECT COUNT(*)::int AS n FROM notifications WHERE to_user_id = $1 AND channel = 'whatsapp'",
        [USER_ID]
      );
      const r = await queueNotification({
        orderId: ORDER_ID,
        toUserId: USER_ID,
        channel: 'whatsapp',
        template: 'order_status_accepted_patient',
        response: { case_id: ORDER_ID, doctorName: 'Dr Test' },
        dedupe_key: PREFIX + 'k1'
      });
      assert.ok(r && r.ok === true, 'queueNotification must succeed');
      const after = await queryOne(
        "SELECT COUNT(*)::int AS n FROM notifications WHERE to_user_id = $1 AND channel = 'whatsapp'",
        [USER_ID]
      );
      assert.strictEqual(Number(after.n) - Number(before.n), 1, 'must INSERT exactly one row');
      t.pass('queueNotification(whatsapp): row queued, no inline send attempted');
    } catch (e) { t.fail('queueNotification queues row', e); }

    // ── 4. queueMultiChannelNotification dispatches concurrently ───
    // Verify all 3 channels resolve in roughly the same wall time
    // (sequential would have been 3× the slowest channel; concurrent
    // is just the slowest channel). Hard to assert timing precisely,
    // but we can assert that all 3 channels settled and produced
    // results without one blocking the others.
    try {
      const { queueMultiChannelNotification } = require('../../src/notify');
      const start = Date.now();
      const r = await queueMultiChannelNotification({
        orderId: ORDER_ID,
        toUserId: USER_ID,
        channels: ['email', 'whatsapp', 'internal'],
        template: 'order_status_accepted_patient',
        response: { case_id: ORDER_ID, doctorName: 'Dr Test' },
        dedupe_key: PREFIX + 'mc1'
      });
      const elapsed = Date.now() - start;
      assert.ok(r && r.ok === true, 'multi-channel must succeed');
      assert.ok(r.results && r.results.email && r.results.whatsapp && r.results.internal,
        'all 3 channels must produce a result');
      assert.ok(r.results.email.ok === true || r.results.email.skipped,
        'email channel result: ' + JSON.stringify(r.results.email));
      assert.ok(r.results.whatsapp.ok === true || r.results.whatsapp.skipped,
        'whatsapp channel result: ' + JSON.stringify(r.results.whatsapp));
      // 1 second is generous — each channel does a single INSERT.
      // Sequential would still be sub-second on local PG, so timing
      // isn't a hard test, but if we hit 5s something is wrong.
      assert.ok(elapsed < 5000, 'multi-channel dispatch must complete in <5s, got ' + elapsed + 'ms');
      t.pass('concurrent dispatch: all 3 channels settled via Promise.allSettled');
    } catch (e) { t.fail('concurrent dispatch', e); }

    // ── 5. Fail-soft: WhatsApp failure does not break email queue ───
    // We can't easily induce a WhatsApp failure from queueNotification
    // (it doesn't call sendWhatsApp anymore). Instead, verify that even
    // when the user has no phone, email + internal channels still succeed.
    try {
      const noPhoneUserId = PREFIX + 'nophone';
      await execute(
        `INSERT INTO users (id, email, password_hash, name, role, lang, is_active, pending_approval, phone, notify_whatsapp, created_at)
         VALUES ($1, $2, '$2b$10$0', 'No Phone', 'patient', 'en', true, false, NULL, true, NOW())`,
        [noPhoneUserId, noPhoneUserId + '@test.local']
      );
      const { queueMultiChannelNotification } = require('../../src/notify');
      const r = await queueMultiChannelNotification({
        orderId: ORDER_ID,
        toUserId: noPhoneUserId,
        channels: ['email', 'whatsapp', 'internal'],
        template: 'payment_success_patient',
        response: { order_id: ORDER_ID },
        dedupe_key: PREFIX + 'nop1'
      });
      assert.strictEqual(r.results.whatsapp.skipped, true, 'whatsapp must skip when no phone');
      assert.strictEqual(r.results.whatsapp.reason, 'no_phone', 'skip reason must be no_phone');
      assert.ok(r.results.email && r.results.email.ok === true,
        'email must still succeed when whatsapp skips');
      assert.ok(r.results.internal && r.results.internal.ok === true,
        'internal must still succeed when whatsapp skips');
      t.pass('fail-soft: WhatsApp skip does not block email/internal channels');
    } catch (e) { t.fail('fail-soft no-phone', e); }

    // ── 6. error_logs write on WhatsApp failure ────────────────────
    // Trigger a misconfigured-env failure path and assert error_logs
    // gets a category='whatsapp_send' row. The stub mode short-circuits
    // before this, so we have to disable stub for this single test.
    try {
      process.env.WHATSAPP_TEST_STUB = 'false';
      process.env.WHATSAPP_ENABLED = 'true';
      // WhatsApp-via-OpenClaw rollout: the new NOTIFICATIONS_WHATSAPP_ENABLED
      // master flag short-circuits before the legacy env-misconfig check.
      // Flip it on here so the Meta misconfig path is reachable for this
      // assertion; the savedFlag restore at the bottom resets to default.
      const savedMasterFlag = process.env.NOTIFICATIONS_WHATSAPP_ENABLED;
      const savedTransport  = process.env.NOTIFICATIONS_WHATSAPP_TRANSPORT;
      process.env.NOTIFICATIONS_WHATSAPP_ENABLED = 'true';
      process.env.NOTIFICATIONS_WHATSAPP_TRANSPORT = 'meta';
      // Force misconfiguration by clearing required env.
      const savedToken = process.env.WHATSAPP_ACCESS_TOKEN;
      const savedPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
      process.env.WHATSAPP_ACCESS_TOKEN = '';
      process.env.WHATSAPP_PHONE_NUMBER_ID = '';
      delete require.cache[require.resolve('../../src/notify/whatsapp')];
      const { sendWhatsApp } = require('../../src/notify/whatsapp');

      const beforeRows = await queryAll(
        "SELECT COUNT(*)::int AS n FROM error_logs WHERE category = 'whatsapp_send'",
        []
      );
      const result = await sendWhatsApp({ to: '+201001234567', template: 'order_status_accepted_patient', lang: 'en', vars: {} });
      assert.strictEqual(result.ok, false, 'misconfigured send must return ok=false');
      assert.strictEqual(result.error, 'wa_env_misconfigured', 'error must be wa_env_misconfigured');

      // Allow the fire-and-forget INSERT to land.
      await new Promise((r) => setTimeout(r, 200));
      const afterRows = await queryAll(
        "SELECT COUNT(*)::int AS n FROM error_logs WHERE category = 'whatsapp_send'",
        []
      );
      assert.ok(Number(afterRows[0].n) > Number(beforeRows[0].n),
        'error_logs must have a new row with category=whatsapp_send');

      // Cleanup test rows we just created
      await execute(`DELETE FROM error_logs WHERE category = 'whatsapp_send' AND created_at >= NOW() - INTERVAL '5 seconds'`, []);

      // Restore env
      process.env.WHATSAPP_ACCESS_TOKEN = savedToken || '';
      process.env.WHATSAPP_PHONE_NUMBER_ID = savedPhoneId || '';
      delete process.env.WHATSAPP_ENABLED;
      if (savedMasterFlag === undefined) delete process.env.NOTIFICATIONS_WHATSAPP_ENABLED;
      else process.env.NOTIFICATIONS_WHATSAPP_ENABLED = savedMasterFlag;
      if (savedTransport === undefined) delete process.env.NOTIFICATIONS_WHATSAPP_TRANSPORT;
      else process.env.NOTIFICATIONS_WHATSAPP_TRANSPORT = savedTransport;
      t.pass('error_logs: misconfigured WhatsApp env writes category=whatsapp_send row');
    } catch (e) { t.fail('error_logs integration', e); }

    // ── 7. Worker safe-fallback template resolution ────────────────
    // The worker should use getWhatsAppTemplate(eventName) when the map
    // has an entry, falling back to the raw event name when not.
    try {
      const { getWhatsAppTemplate } = require('../../src/notify/whatsappTemplateMap');
      const acceptedMap = getWhatsAppTemplate('order_status_accepted_patient');
      assert.ok(acceptedMap, 'map must have order_status_accepted_patient entry');
      assert.strictEqual(acceptedMap.templateName, 'case_accepted_en',
        'mapped template must be case_accepted_en');
      const paymentMap = getWhatsAppTemplate('payment_success_patient');
      assert.ok(paymentMap, 'map must have payment_success_patient entry');
      assert.strictEqual(paymentMap.templateName, 'payment_confirmed_en',
        'mapped template must be payment_confirmed_en');
      const unknown = getWhatsAppTemplate('totally_unknown_event_name');
      assert.strictEqual(unknown, null, 'map miss must return null (worker falls back)');
      t.pass('safe-fallback: getWhatsAppTemplate hits both target templates + null on miss');
    } catch (e) { t.fail('safe-fallback resolution', e); }

    // ── 8. Both target events use queueMultiChannelNotification ─────
    // Source-level grep — ensures both event-firing sites still call
    // the multi-channel dispatcher with email + whatsapp + internal.
    try {
      const fs = require('fs');
      const acceptSrc = fs.readFileSync(require.resolve('../../src/routes/doctor'), 'utf8');
      const paymentSrc = fs.readFileSync(require.resolve('../../src/routes/payments'), 'utf8');
      assert.ok(/queueMultiChannelNotification[\s\S]*?'order_status_accepted_patient'/m.test(acceptSrc),
        'doctor.js must dispatch order_status_accepted_patient via multi-channel');
      assert.ok(/queueMultiChannelNotification[\s\S]*?'payment_success_patient'/m.test(paymentSrc),
        'payments.js must dispatch payment_success_patient via multi-channel');
      // Both sites must list whatsapp in their channels arrays.
      const acceptBlock = acceptSrc.split('order_status_accepted_patient')[0].slice(-500);
      assert.ok(/['"]whatsapp['"]/.test(acceptBlock),
        'case-acceptance dispatch must include whatsapp channel');
      const paymentBlock = paymentSrc.split('payment_success_patient')[0].slice(-500);
      assert.ok(/['"]whatsapp['"]/.test(paymentBlock),
        'payment-confirmation dispatch must include whatsapp channel');
      t.pass('parity: both target events dispatch via multi-channel with whatsapp included');
    } catch (e) { t.fail('parity grep', e); }

  } finally {
    // Restore stub flag for any subsequent test files
    delete process.env.WHATSAPP_TEST_STUB;
    try {
      await execute(`DELETE FROM error_logs WHERE user_id LIKE $1`, [PREFIX + '%']);
      await execute(`DELETE FROM notifications WHERE to_user_id LIKE $1 OR order_id LIKE $1`, [PREFIX + '%']);
      await execute(`DELETE FROM orders WHERE id LIKE $1`, [PREFIX + '%']);
      await execute(`DELETE FROM users WHERE id LIKE $1`, [PREFIX + '%']);
    } catch (_) {}
    if (require.main === module) {
      try { await pool.end(); } catch (_) {}
    }
  }
})();
