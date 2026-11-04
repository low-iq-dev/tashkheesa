// tests/notifications/whatsapp-single-attempt.test.js
//
// Part E (patient recovery, 2 Nov 2026) — end to end, against a migrated
// database and a FAKE Mac mini (a local HTTP server standing in for
// OPENCLAW_BASE_URL). "Delivered" is counted the way OpenClaw behaves: every
// /send the gateway accepted — answered 200, 202 or 502 — is a message in
// OpenClaw's delivery queue that will reach the phone once WhatsApp is up; a
// 530 (Cloudflare: origin unreachable) never reached it.
//
//   1. The 14 Oct shape: the mini answers 502 three times, then 200. The
//      payment reminder's WhatsApp is sent ONCE (one copy delivered), the row
//      is failed for good, and the phone-only patient gets ONE sms row.
//   2. The brief's literal case with a tunnel that is down: 530 three times
//      then 200, retries allowed — four calls, exactly one delivered, no SMS.
//   3. The unpaid sweep run three times in four minutes produces ONE row per
//      channel; re-queuing the failed WhatsApp key does not re-arm it.
//
// Skips itself (counted as skipped) in a no-database run.

'use strict';

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.stack || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); },
};

console.log('\n🔁  WhatsApp single attempt, end to end (Part E)\n');

if (process.env.TEST_RUNNER_NO_DB || !process.env.DATABASE_URL) {
  t.skip('Part E end to end', 'needs a migrated database');
  return;
}

async function check(name, fn) { try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); } }

(async () => {
  // ── the fake mini ──
  let script = [];
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let j = {}; try { j = JSON.parse(body); } catch (_) { /* empty */ }
      const status = script.length ? script.shift() : 200;
      calls.push({ ref: j.ref, status, body: j.body });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status < 300 ? { sent: true, message_id: 'oc_' + calls.length } : { error: status === 530 ? 'origin_unreachable' : 'cli_failed' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const suffix = crypto.randomBytes(3).toString('hex');
  const phone = '+2010' + String(Date.now()).slice(-8);
  Object.assign(process.env, {
    NOTIFICATIONS_WHATSAPP_ENABLED: 'true',
    NOTIFICATIONS_WHATSAPP_TRANSPORT: 'openclaw',
    OPENCLAW_BASE_URL: 'http://127.0.0.1:' + server.address().port,
    OPENCLAW_SEND_KEY: 'test-key',
    WHATSAPP_TEST_RECIPIENTS: phone.replace(/\D/g, ''),
    NOTIFICATION_MAX_RETRIES: '5',
  });
  delete process.env.TWILIO_MESSAGING_SERVICE_SID; delete process.env.TWILIO_SMS_FROM;

  const { queryOne, queryAll, execute } = require('../../src/pg');
  const { queueNotification } = require('../../src/notify');
  const { runNotificationWorker } = require('../../src/notification_worker');
  const lifecycle = require('../../src/case_lifecycle');

  const userId = 'pe-user-' + suffix;
  await execute(
    `INSERT INTO users (id, name, phone, role, lang, notify_whatsapp, created_at) VALUES ($1, 'Phone Only', $2, 'patient', 'ar', true, NOW())`,
    [userId, phone]);

  async function newOrder(over) {
    const id = crypto.randomUUID();
    await execute(
      `INSERT INTO orders (id, patient_id, status, payment_status, reference_id, payment_link, created_at, updated_at, submitted_at)
       VALUES ($1, $2, $3, 'unpaid', $4, $5, NOW() - INTERVAL '40 minutes', NOW(), NOW() - INTERVAL '31 minutes')`,
      // payment_link as routes/patient.js stores it: a bare path.
      [id, userId, (over && over.status) || 'submitted', 'TSH-T-' + id.slice(0, 6), '/portal/patient/pay/' + id]);
    return id;
  }
  const rowsFor = (orderId) => queryAll(
    "SELECT id, channel, status, attempts, dedupe_key, response FROM notifications WHERE order_id = $1 AND template LIKE 'payment_reminder_%' ORDER BY channel", [orderId]);
  // Time passes: every retry of this case's rows is due now.
  const rewind = (orderId) => execute("UPDATE notifications SET retry_after = NOW() - INTERVAL '1 second' WHERE order_id = $1 AND status = 'retry'", [orderId]);
  async function tick(orderId, n) { for (let i = 0; i < n; i++) { await runNotificationWorker(50); await rewind(orderId); } }
  const callsFor = (orderId) => calls.filter((c) => c.ref === orderId);
  const delivered = (orderId) => callsFor(orderId).filter((c) => c.status !== 530).length;

  const created = [];
  const extraUsers = [];
  try {
    await check('1. 502, 502, 502, 200 → the mini is called once, one copy delivered, the row is final, one SMS row', async () => {
      const orderId = await newOrder(); created.push(orderId);
      script = [502, 502, 502, 200];
      await lifecycle.dispatchUnpaidCaseReminders(orderId);
      await tick(orderId, 6);
      assert.strictEqual(callsFor(orderId).length, 1, JSON.stringify(callsFor(orderId)));
      assert.strictEqual(delivered(orderId), 1);
      const wa = (await rowsFor(orderId)).find((r) => r.channel === 'whatsapp');
      assert.strictEqual(wa.status, 'failed');
      assert.strictEqual(wa.attempts, 1);
      assert.strictEqual(JSON.parse(wa.response).no_retry, 'whatsapp_single_attempt');
      const sms = (await rowsFor(orderId)).filter((r) => r.channel === 'sms');
      assert.strictEqual(sms.length, 1, 'one sms row');
      assert.strictEqual(sms[0].dedupe_key, wa.dedupe_key.replace(':whatsapp:', ':sms:'));
      // SMS is not configured in the test env: written skipped, nothing thrown.
      assert.strictEqual(sms[0].status, 'skipped');
      assert.strictEqual(JSON.parse(sms[0].response).skipped, 'sms_unconfigured');
    });

    await check('2. 530, 530, 530, 200 (tunnel down, nothing reached the mini) → retried on the SAME row, exactly one delivered, no SMS', async () => {
      const orderId = await newOrder(); created.push(orderId);
      script = [530, 530, 530, 200];
      await lifecycle.dispatchUnpaidCaseReminders(orderId);
      await tick(orderId, 8);
      assert.strictEqual(callsFor(orderId).length, 4);
      assert.strictEqual(delivered(orderId), 1);
      const rows = await rowsFor(orderId);
      const wa = rows.filter((r) => r.channel === 'whatsapp');
      assert.strictEqual(wa.length, 1, 'one row, reused');
      assert.strictEqual(wa[0].status, 'sent');
      assert.strictEqual(rows.filter((r) => r.channel === 'sms').length, 0);
      // The body the mini received links to the pay page absolutely (the
      // order's payment_link is a bare path).
      const sentBody = callsFor(orderId).find((c) => c.status === 200).body;
      const base = String(process.env.APP_URL || 'https://tashkheesa.com').replace(/\/+$/, '');
      assert.ok(sentBody.indexOf(base + '/portal/patient/pay/' + orderId) !== -1, sentBody);
      assert.ok(!/(^|\s)\/portal\//.test(sentBody), 'no bare path: ' + sentBody);
    });

    await check('3. the sweep three times in four minutes → one row per channel; the failed key is never re-armed', async () => {
      const orderId = await newOrder(); created.push(orderId);
      script = [502];
      await lifecycle.dispatchUnpaidCaseReminders(orderId);
      await tick(orderId, 2);
      await lifecycle.dispatchUnpaidCaseReminders(orderId);
      await lifecycle.dispatchUnpaidCaseReminders(orderId);
      const rows = await rowsFor(orderId);
      const byChannel = {};
      rows.forEach((r) => { byChannel[r.channel] = (byChannel[r.channel] || 0) + 1; });
      assert.deepStrictEqual(byChannel, { email: 1, internal: 1, sms: 1, whatsapp: 1 });
      const wa = rows.find((r) => r.channel === 'whatsapp');
      const again = await queueNotification({ channel: 'whatsapp', toUserId: userId, orderId, template: 'payment_reminder_30m', dedupeKey: wa.dedupe_key, response: { case_id: orderId } });
      assert.strictEqual(again.skipped, 'deduped');
      assert.strictEqual(again.single_shot, true);
      await tick(orderId, 2);
      assert.strictEqual(callsFor(orderId).length, 1, 'still one call to the mini');
      assert.strictEqual((await queryOne('SELECT status FROM notifications WHERE id = $1', [wa.id])).status, 'failed');
    });
    await check('4. a row left in "sending" by a crashed tick is retired, never re-sent; its SMS keeps the queued payload (the resume link)', async () => {
      // Its own patient, so this draft is their newest case.
      const u2 = 'pe-user2-' + suffix;
      extraUsers.push(u2);
      await execute(
        `INSERT INTO users (id, name, phone, role, lang, notify_whatsapp, created_at) VALUES ($1, 'Draft Only', $2, 'patient', 'en', true, NOW())`,
        [u2, '+2012' + String(Date.now()).slice(-8)]);
      const draftId = crypto.randomUUID(); created.push(draftId);
      await execute(
        `INSERT INTO orders (id, patient_id, status, clinical_question, payment_status, source, draft_step, created_at, updated_at)
         VALUES ($1, $2, 'DRAFT', 'Chest pain on exertion for a week', 'unpaid', 'patient_app_v1', 1, NOW() - INTERVAL '3 hours', NOW() - INTERVAL '2 hours')`,
        [draftId, u2]);
      await require('../../src/services/draft_nudges').runDraftNudgeSweep({ ignoreQuietHours: true });
      // A crash mid-send: claimed, lease already expired, never answered.
      const stuck = await execute(
        "UPDATE notifications SET status = 'sending', retry_after = NOW() - INTERVAL '1 minute' WHERE order_id = $1 AND channel = 'whatsapp'", [draftId]);
      assert.strictEqual(stuck.rowCount, 1, 'the nudge queued a whatsapp row');
      // SMS "configured" and dry-run: processSms renders the body and reports its length.
      const saved = {};
      for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_MESSAGING_SERVICE_SID', 'NOTIFICATION_DRY_RUN']) saved[k] = process.env[k];
      Object.assign(process.env, { TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'test', TWILIO_MESSAGING_SERVICE_SID: 'MGtest', NOTIFICATION_DRY_RUN: 'true' });
      try { await tick(draftId, 3); }
      finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
      assert.strictEqual(callsFor(draftId).length, 0, 'the mini is not called again');
      const rows = await queryAll("SELECT channel, status, response FROM notifications WHERE order_id = $1 AND template = 'draft_resume_1h' ORDER BY channel", [draftId]);
      const wa = rows.find((r) => r.channel === 'whatsapp');
      assert.strictEqual(wa.status, 'failed');
      assert.strictEqual(JSON.parse(wa.response).error, 'stuck_sending_outcome_unknown');
      const sms = rows.filter((r) => r.channel === 'sms');
      assert.strictEqual(sms.length, 1, 'one sms row');
      const res = JSON.parse(sms[0].response);
      const { isCairoQuietHours, nextCairoTime } = require('../../src/utils/cairo_quiet_hours');
      if (isCairoQuietHours(new Date(), { startHour: 21, endHour: 9 })) {
        // Run at night (Cairo): the SMS waits for 09:00, untouched — and the
        // payload it will be rendered from still carries the token id.
        // retry_after is timestamp WITHOUT time zone holding UTC digits: compared in SQL.
        const row = await queryOne(
          `SELECT status, retry_after > (NOW() AT TIME ZONE 'UTC') AS future,
                  to_char(retry_after, 'YYYY-MM-DD"T"HH24:MI') AS at_utc
             FROM notifications WHERE order_id = $1 AND channel = 'sms'`, [draftId]);
        assert.strictEqual(row.status, 'queued');
        assert.strictEqual(row.future, true, 'deferred, not dropped');
        assert.strictEqual(row.at_utc, nextCairoTime(new Date(), 9).toISOString().slice(0, 16), 'the next 09:00 Cairo');
        assert.ok(res.resume_token_id, 'the queued payload keeps the resume token id');
      } else {
        assert.strictEqual(res.dryRun, true, JSON.stringify(res));
        // With the token id carried through, the link is /r/<22 chars>; without it,
        // the much longer /patient/new-case?resume=<uuid>.
        const expected = require('../../src/notify/sms_templates').renderSms('draft_resume_1h', 'en', { resume_token: 'A'.repeat(22) }, draftId).body.length;
        assert.strictEqual(res.length, expected);
      }
    });
  } finally {
    server.close();
    for (const id of created) await execute('DELETE FROM notifications WHERE order_id = $1', [id]).catch(() => {});
    await execute('DELETE FROM notifications WHERE to_user_id = $1', [userId]).catch(() => {});
    for (const id of created) await execute('DELETE FROM orders WHERE id = $1', [id]).catch(() => {});
    await execute('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
    for (const u of extraUsers) {
      await execute('DELETE FROM notifications WHERE to_user_id = $1', [u]).catch(() => {});
      await execute('DELETE FROM draft_resume_tokens WHERE patient_id = $1', [u]).catch(() => {});
      await execute('DELETE FROM users WHERE id = $1', [u]).catch(() => {});
    }
    try { await require('../../src/pg').pool.end(); } catch (_) { /* best effort */ }
  }
})();
