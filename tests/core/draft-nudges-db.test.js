// tests/core/draft-nudges-db.test.js
//
// Part A (patient recovery, 2 Nov 2026) against a migrated database: the
// eligibility SQL clause by clause (both status casings, practice, the
// 10-character rule, files, newest-draft-only, the 7-day cap, idle time, a
// recently opened link, opt-out, a coverage lead), the ladder end to end
// (1h, then 24h, never a third), stop-on-submit with the conversion counted,
// and the attention view's new columns.
//
// Skips itself (counted as skipped) in a no-database run.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'draft-nudges-db-test-secret';

const assert = require('assert');
const crypto = require('crypto');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.stack || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); },
};

console.log('\n🗄️   draft-resume nudges against the database (Part A)\n');

if (process.env.TEST_RUNNER_NO_DB || !process.env.DATABASE_URL) {
  t.skip('Part A against the database', 'needs a migrated database');
  return;
}

async function check(name, fn) { try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); } }

(async () => {
  const pg = require('../../src/pg');
  const { queryAll, queryOne, execute } = pg;
  const nudges = require('../../src/services/draft_nudges');
  const resume = require('../../src/services/draft_resume');
  const tag = crypto.randomBytes(3).toString('hex');
  const users = []; const orders = [];

  async function patient(over) {
    const id = 'dn-u-' + tag + '-' + users.length;
    const o = Object.assign({ phone: '+2010' + String(Date.now() + users.length).slice(-8), email: null, notify_whatsapp: true }, over || {});
    await execute(`INSERT INTO users (id, name, phone, email, role, lang, notify_whatsapp, is_active, created_at)
                   VALUES ($1, 'Draft Patient', $2, $3, 'patient', 'ar', $4, true, NOW())`, [id, o.phone, o.email, o.notify_whatsapp]);
    users.push(id);
    return id;
  }
  // ageMin / idleMin in minutes before now.
  async function draftFor(userId, over) {
    const o = Object.assign({ status: 'DRAFT', question: 'Headaches for two weeks', ageMin: 180, idleMin: 120, practice: false, source: 'patient_wizard_v2' }, over || {});
    const id = crypto.randomUUID();
    await execute(
      `INSERT INTO orders (id, patient_id, status, clinical_question, payment_status, source, is_practice, draft_step, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'unpaid', $5, $6, 1, NOW() - ($7 || ' minutes')::interval, NOW() - ($8 || ' minutes')::interval)`,
      [id, userId, o.status, o.question, o.source, o.practice, String(o.ageMin), String(o.idleMin)]);
    orders.push(id);
    return id;
  }
  async function eligibleIds() {
    const rows = await queryAll(nudges.ELIGIBLE_DRAFTS_SQL, [10000]);
    return new Set(rows.map((r) => r.id));
  }
  const notifs = (orderId) => queryAll("SELECT channel, template, dedupe_key FROM notifications WHERE order_id = $1 AND template LIKE 'draft\\_resume\\_%' ORDER BY channel", [orderId]);

  try {
    await check('eligibility: DRAFT and draft both qualify (the boot-time lowercase fixup)', async () => {
      const a = await draftFor(await patient(), { status: 'DRAFT' });
      const b = await draftFor(await patient(), { status: 'draft' });
      const e = await eligibleIds();
      assert.ok(e.has(a), 'DRAFT'); assert.ok(e.has(b), 'draft');
    });

    await check('eligibility: practice cases and demo/practice sources never qualify', async () => {
      const a = await draftFor(await patient(), { practice: true });
      const b = await draftFor(await patient(), { source: 'practice_seed' });
      const c = await draftFor(await patient(), { source: 'demo_appreview' });
      const e = await eligibleIds();
      assert.ok(!e.has(a) && !e.has(b) && !e.has(c));
    });

    await check('eligibility: a 9-character question with no file does not qualify; 10 characters does; a file alone does', async () => {
      const nine = await draftFor(await patient(), { question: '123456789' });
      const ten = await draftFor(await patient(), { question: '1234567890' });
      const fileOnly = await draftFor(await patient(), { question: '' });
      await execute("INSERT INTO order_files (id, order_id, url, label, created_at) VALUES ($1, $2, 'orders/draft/x/y.pdf', 'scan', NOW())", [crypto.randomUUID(), fileOnly]);
      const e = await eligibleIds();
      assert.ok(!e.has(nine), '9 chars'); assert.ok(e.has(ten), '10 chars'); assert.ok(e.has(fileOnly), 'file');
    });

    await check('eligibility: only the newest case of a patient — an older draft is not nudged', async () => {
      const u = await patient();
      const older = await draftFor(u, { ageMin: 600 });
      const newer = await draftFor(u, { ageMin: 300 });
      const e = await eligibleIds();
      assert.ok(!e.has(older)); assert.ok(e.has(newer));
    });

    await check('eligibility: a draft over 7 days old is not nudged', async () => {
      const old = await draftFor(await patient(), { ageMin: 8 * 24 * 60, idleMin: 8 * 24 * 60 });
      assert.ok(!(await eligibleIds()).has(old));
    });

    await check('eligibility: idle under 60 minutes, or a resume link opened in the last hour → not yet', async () => {
      const busy = await draftFor(await patient(), { idleMin: 30 });
      const u = await patient();
      const opened = await draftFor(u, { idleMin: 300 });
      const tok = await resume.mintToken({ orderId: opened, patientId: u, level: '1h' });
      await execute('UPDATE draft_resume_tokens SET last_opened_at = NOW() - INTERVAL \'20 minutes\' WHERE id = $1', [tok.id]);
      const e = await eligibleIds();
      assert.ok(!e.has(busy), 'busy'); assert.ok(!e.has(opened), 'resumed');
    });

    await check('eligibility: a WhatsApp opt-out, a coverage lead, or a submitted case → never', async () => {
      const out = await draftFor(await patient({ notify_whatsapp: false }));
      const u = await patient();
      const lead = await draftFor(u);
      await execute("INSERT INTO coverage_leads (id, patient_id, order_id, lang, source) VALUES ($1, $2, $3, 'ar', 'web')", ['cl-' + tag, u, lead]);
      const sub = await draftFor(await patient(), { status: 'submitted' });
      const e = await eligibleIds();
      assert.ok(!e.has(out), 'opted out'); assert.ok(!e.has(lead), 'lead'); assert.ok(!e.has(sub), 'submitted');
    });

    await check('ladder: 1h, then nothing until 24h idle, then 24h, then never a third', async () => {
      const u = await patient();
      const d = await draftFor(u, { idleMin: 90 });
      await nudges.runDraftNudgeSweep({ ignoreQuietHours: true });
      let rows = await notifs(d);
      assert.deepStrictEqual(rows.map((r) => r.channel + ':' + r.template), ['internal:draft_resume_1h', 'whatsapp:draft_resume_1h']);
      assert.ok(rows.every((r) => r.dedupe_key === 'draft_resume:' + d + ':1h'));
      await nudges.runDraftNudgeSweep({ ignoreQuietHours: true });
      assert.strictEqual((await notifs(d)).length, 2, 'no repeat of the 1h');
      await execute("UPDATE orders SET updated_at = NOW() - INTERVAL '25 hours' WHERE id = $1", [d]);
      await nudges.runDraftNudgeSweep({ ignoreQuietHours: true });
      rows = await notifs(d);
      assert.deepStrictEqual(rows.map((r) => r.template).sort(), ['draft_resume_1h', 'draft_resume_1h', 'draft_resume_24h', 'draft_resume_24h']);
      await execute("UPDATE orders SET updated_at = NOW() - INTERVAL '6 days' WHERE id = $1", [d]);
      await nudges.runDraftNudgeSweep({ ignoreQuietHours: true });
      assert.strictEqual((await notifs(d)).length, 4, 'never a third');
      const v = await queryOne("SELECT nudges_sent, last_nudge_at FROM v_needs_attention WHERE kind = 'abandoned_case' AND ref = $1", [d]);
      assert.ok(v, 'the draft is on the attention list');
      assert.strictEqual(v.nudges_sent, 2);
      assert.ok(v.last_nudge_at instanceof Date);
    });

    await check('stop-on-submit: a submitted draft gets no 24h, and the conversion is counted once', async () => {
      const u = await patient();
      const d = await draftFor(u, { idleMin: 90 });
      await nudges.runDraftNudgeSweep({ ignoreQuietHours: true });
      assert.strictEqual((await notifs(d)).length, 2);
      await execute("UPDATE orders SET status = 'submitted', submitted_at = NOW(), updated_at = NOW() - INTERVAL '25 hours' WHERE id = $1", [d]);
      const before = await queryOne("SELECT COALESCE(SUM(n), 0)::int AS n FROM funnel_daily_counts WHERE step = 'draft_resume_converted'", []);
      await nudges.runDraftNudgeSweep({ ignoreQuietHours: true });
      await nudges.runDraftNudgeSweep({ ignoreQuietHours: true });
      assert.strictEqual((await notifs(d)).length, 2, 'no 24h after submit');
      const tok = await queryOne('SELECT converted_at FROM draft_resume_tokens WHERE order_id = $1', [d]);
      assert.ok(tok.converted_at, 'converted');
      const after = await queryOne("SELECT COALESCE(SUM(n), 0)::int AS n FROM funnel_daily_counts WHERE step = 'draft_resume_converted'", []);
      assert.strictEqual(after.n - before.n, 1, 'counted once');
    });

    await check('resume: opening the link clears a queued nudge and takes the draft off the attention list', async () => {
      const u = await patient();
      const d = await draftFor(u, { idleMin: 90 });
      await nudges.runDraftNudgeSweep({ ignoreQuietHours: true });
      const tokRow = await queryOne('SELECT * FROM draft_resume_tokens WHERE order_id = $1', [d]);
      assert.ok(await queryOne("SELECT 1 FROM v_needs_attention WHERE kind = 'abandoned_case' AND ref = $1", [d]), 'listed before');
      await resume.recordOpen(tokRow);
      const pending = await queryOne("SELECT COUNT(*)::int AS n FROM notifications WHERE order_id = $1 AND status IN ('queued', 'retry')", [d]);
      assert.strictEqual(pending.n, 0, 'nothing left to send');
      const skipped = await queryOne("SELECT COUNT(*)::int AS n FROM notifications WHERE order_id = $1 AND response LIKE '%draft_resumed%'", [d]);
      assert.ok(skipped.n >= 1);
      assert.ok(!(await queryOne("SELECT 1 FROM v_needs_attention WHERE kind = 'abandoned_case' AND ref = $1", [d])), 'off the list once resumed');
      const opened = await queryOne('SELECT open_count, first_opened_at FROM draft_resume_tokens WHERE id = $1', [tokRow.id]);
      assert.strictEqual(opened.open_count, 1);
    });

    await check('token: the real row — X opens X; expired after 72 hours', async () => {
      const u = await patient();
      const x = await draftFor(u);
      const tok = await resume.mintToken({ orderId: x, patientId: u, level: '1h' });
      const ok = await resume.resolveToken(tok.token);
      assert.strictEqual(ok.ok, true); assert.strictEqual(ok.row.order_id, x);
      const stored = await queryOne('SELECT token_hash FROM draft_resume_tokens WHERE id = $1', [tok.id]);
      assert.notStrictEqual(stored.token_hash, tok.token, 'never the token itself');
      const late = await resume.resolveToken(tok.token, { now: new Date(Date.now() + 72 * 3600e3 + 1000) });
      assert.strictEqual(late.reason, 'expired');
    });
  } finally {
    for (const id of orders) {
      await execute('DELETE FROM notifications WHERE order_id = $1', [id]).catch(() => {});
      await execute('DELETE FROM order_files WHERE order_id = $1', [id]).catch(() => {});
      await execute('DELETE FROM draft_resume_tokens WHERE order_id = $1', [id]).catch(() => {});
      await execute('DELETE FROM coverage_leads WHERE order_id = $1', [id]).catch(() => {});
      await execute('DELETE FROM orders WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of users) {
      await execute('DELETE FROM notifications WHERE to_user_id = $1', [id]).catch(() => {});
      await execute('DELETE FROM users WHERE id = $1', [id]).catch(() => {});
    }
    try { await pg.pool.end(); } catch (_) { /* best effort */ }
  }
})();
