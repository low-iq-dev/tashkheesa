// tests/core/coverage-leads-db.test.js
//
// Part C (patient recovery, 2 Nov 2026) against a migrated database: the
// draft API (GET coverage, POST coverage-lead) through the real router, one
// lead per draft (the partial unique index), the coverage_lead attention row,
// the draft-resume exclusion, "Notify waiting leads" dry run + send + second
// run, and conversion when the draft is later sent.
//
// Skips itself (counted as skipped) in a no-database run.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'coverage-leads-db-test-secret';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.stack || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); },
};

console.log('\n🗄️   coverage leads against the database (Part C)\n');

if (process.env.TEST_RUNNER_NO_DB || !process.env.DATABASE_URL) {
  t.skip('Part C against the database', 'needs a migrated database');
  return;
}

async function check(name, fn) { try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); } }

(async () => {
  const pg = require('../../src/pg');
  const { queryOne, queryAll, execute } = pg;
  const cl = require('../../src/services/coverage_leads');
  const nudges = require('../../src/services/draft_nudges');
  const tag = crypto.randomBytes(3).toString('hex');
  const spec = 'spec-test-hidden-' + tag;
  const userId = 'cl-u-' + tag;
  const draftId = crypto.randomUUID();

  await execute("INSERT INTO specialties (id, name, name_ar, is_visible) VALUES ($1, $2, 'تخصص تجريبي', false)", [spec, 'Testology ' + tag]);
  await execute("INSERT INTO services (id, specialty_id, name, base_price, is_visible) VALUES ($1, $2, 'Testology read', 750, true)", ['svc-' + tag, spec]);
  await execute(`INSERT INTO users (id, name, phone, role, lang, notify_whatsapp, is_active, created_at)
                 VALUES ($1, 'Lead Patient', $2, 'patient', 'ar', true, true, NOW())`, [userId, '+2011' + String(Date.now()).slice(-8)]);
  await execute(`INSERT INTO orders (id, patient_id, status, clinical_question, payment_status, source, draft_step, reference_id, created_at, updated_at)
                 VALUES ($1, $2, 'DRAFT', 'Numbness in both hands for a month', 'unpaid', 'patient_app_v1', 2, $3, NOW() - INTERVAL '3 hours', NOW() - INTERVAL '2 hours')`,
    [draftId, userId, 'TSH-T-' + tag]);

  const app = express();
  app.use(require('../../src/middleware/apiResponse'));
  app.use((req, _res, next) => { req.user = { id: req.get('x-test-user') || userId, role: 'patient' }; next(); });
  app.use('/cases/draft', require('../../src/routes/api/coverage_leads'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function call(method, p, body, headers) {
    const res = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch (_) { /* empty */ }
    return { status: res.status, body: json };
  }

  try {
    await check('API GET coverage: the hidden specialty is offered, the open list and the copy come back, no lead yet', async () => {
      const r = await call('GET', '/cases/draft/' + draftId + '/coverage');
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const d = r.body.data;
      assert.strictEqual(d.notListedOption, true);
      assert.ok(d.hiddenSpecialties.some((s) => s.id === spec));
      assert.ok(Array.isArray(d.openSpecialties) && Array.isArray(d.reportReadOffers));
      assert.strictEqual(d.lead, null);
      assert.ok(/\{specialty\}/.test(d.copy.en) && /\{specialty\}/.test(d.copy.ar));
    });

    await check('API POST coverage-lead: 201 once, then 200 with the same lead (one per draft)', async () => {
      const a = await call('POST', '/cases/draft/' + draftId + '/coverage-lead', { wantedSpecialtyId: spec });
      const b = await call('POST', '/cases/draft/' + draftId + '/coverage-lead', { wantedSpecialtyId: spec });
      assert.strictEqual(a.status, 201, JSON.stringify(a.body));
      assert.strictEqual(b.status, 200);
      assert.strictEqual(b.body.data.created, false);
      assert.strictEqual(b.body.data.lead.id, a.body.data.lead.id);
      const n = await queryOne('SELECT COUNT(*)::int AS n FROM coverage_leads WHERE order_id = $1', [draftId]);
      assert.strictEqual(n.n, 1);
      const row = await queryOne('SELECT source, lang, phone FROM coverage_leads WHERE order_id = $1', [draftId]);
      assert.deepStrictEqual([row.source, row.lang, !!row.phone], ['api', 'ar', true]);
    });

    await check('API: another patient\'s draft is a 404; an open specialty is a 409', async () => {
      const other = await call('POST', '/cases/draft/' + draftId + '/coverage-lead', {}, { 'x-test-user': 'someone-else' });
      assert.strictEqual(other.status, 404);
      const open = await queryOne('SELECT id FROM specialties WHERE COALESCE(is_visible, true) = true LIMIT 1', []);
      if (open) {
        const d2 = crypto.randomUUID();
        await execute(`INSERT INTO orders (id, patient_id, status, payment_status, created_at, updated_at) VALUES ($1, $2, 'draft', 'unpaid', NOW(), NOW())`, [d2, userId]);
        const r = await call('POST', '/cases/draft/' + d2 + '/coverage-lead', { wantedSpecialtyId: open.id });
        await execute('DELETE FROM orders WHERE id = $1', [d2]);
        assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'SPECIALTY_OPEN');
      }
    });

    await check('the lead is on the attention list as coverage_lead, the draft is not abandoned_case, and gets no nudge', async () => {
      const row = await queryOne("SELECT summary, severity, nudges_sent FROM v_needs_attention WHERE kind = 'coverage_lead' AND summary LIKE $1", ['%Testology ' + tag + '%']);
      assert.ok(row, 'listed');
      assert.strictEqual(row.severity, 3);
      assert.strictEqual(row.nudges_sent, null);
      assert.ok(!(await queryOne("SELECT 1 FROM v_needs_attention WHERE kind = 'abandoned_case' AND ref = $1", [draftId])));
      const eligible = await queryAll(nudges.ELIGIBLE_DRAFTS_SQL, [10000]);
      assert.ok(!eligible.some((r) => r.id === draftId), 'no draft-resume nudge for a lead\'s draft');
    });

    await check('notify: dry run counts; refused while hidden; after opening, sends once; a second run sends nothing', async () => {
      const dry = await cl.notifyWaitingLeads({ specialtyId: spec, dryRun: true });
      assert.deepStrictEqual([dry.ok, dry.count], [true, 1]);
      const hidden = await cl.notifyWaitingLeads({ specialtyId: spec, confirm: 'Testology ' + tag });
      assert.strictEqual(hidden.code, 'NOT_OPEN');
      await execute('UPDATE specialties SET is_visible = true WHERE id = $1', [spec]);
      const sent = await cl.notifyWaitingLeads({ specialtyId: spec, confirm: 'testology ' + tag });
      assert.deepStrictEqual([sent.ok, sent.notified], [true, 1]);
      const rows = await queryAll("SELECT channel, response FROM notifications WHERE dedupe_key LIKE 'coverage\\_lead:%' AND to_user_id = $1 ORDER BY channel", [userId]);
      assert.deepStrictEqual(rows.map((r) => r.channel), ['internal', 'whatsapp']);
      assert.ok(JSON.parse(rows[0].response).resume_token_id, 'links back to the kept draft');
      const again = await cl.notifyWaitingLeads({ specialtyId: spec, confirm: 'Testology ' + tag });
      assert.deepStrictEqual([again.count, again.notified], [0, 0]);
      const after = await queryAll("SELECT 1 FROM notifications WHERE dedupe_key LIKE 'coverage\\_lead:%' AND to_user_id = $1", [userId]);
      assert.strictEqual(after.length, 2);
      assert.ok(!(await queryOne("SELECT 1 FROM v_needs_attention WHERE kind = 'coverage_lead' AND summary LIKE $1", ['%Testology ' + tag + '%'])), 'off the list once told');
    });

    await check('conversion: the draft sent later marks the lead converted', async () => {
      await execute("UPDATE orders SET status = 'submitted', submitted_at = NOW() WHERE id = $1", [draftId]);
      await cl.markConverted();
      const row = await queryOne('SELECT converted_order_id FROM coverage_leads WHERE order_id = $1', [draftId]);
      assert.strictEqual(row.converted_order_id, draftId);
    });
  } finally {
    server.close();
    await execute('DELETE FROM notifications WHERE to_user_id = $1', [userId]).catch(() => {});
    await execute('DELETE FROM draft_resume_tokens WHERE patient_id = $1', [userId]).catch(() => {});
    await execute('DELETE FROM coverage_leads WHERE patient_id = $1', [userId]).catch(() => {});
    await execute('DELETE FROM orders WHERE patient_id = $1', [userId]).catch(() => {});
    await execute('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
    await execute('DELETE FROM services WHERE id = $1', ['svc-' + tag]).catch(() => {});
    await execute('DELETE FROM specialties WHERE id = $1', [spec]).catch(() => {});
    try { await pg.pool.end(); } catch (_) { /* best effort */ }
  }
})();
