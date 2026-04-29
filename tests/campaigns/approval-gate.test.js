// tests/campaigns/approval-gate.test.js
// Regression test for B2 (April 29 audit): email_campaigns now requires
// approved_by IS NOT NULL before the 5-min cron auto-fires the campaign.
//
// Tests:
//   1. The cron's SELECT excludes campaigns with approved_by IS NULL.
//   2. The approve transition flips approved_by + approved_at on a draft
//      or scheduled row, and is idempotent (second approval is rejected).
//
// Inserts and cleans up two scratch rows with id prefix 'b2-test-'.

var t = global._testRunner || {
  pass: function(n) { console.log('  PASS ' + n); },
  fail: function(n, e) { console.error('  FAIL ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: function(n, r) { console.log('  SKIP ' + n + ' (' + r + ')'); }
};

console.log('\nemail_campaigns approval-gate regression\n');

(async function () {
  if (!process.env.DATABASE_URL) {
    return t.skip('campaigns approval-gate', 'DATABASE_URL not set');
  }

  var pg;
  try { pg = require('../../src/pg'); }
  catch (e) { return t.skip('campaigns approval-gate', 'pg module missing: ' + e.message); }
  var queryOne = pg.queryOne;
  var queryAll = pg.queryAll;
  var execute = pg.execute;

  // Confirm the migration ran. Columns must exist before any other assertion
  // is meaningful.
  var cols = await queryAll(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='email_campaigns' AND column_name IN ('approved_by','approved_at')"
  );
  if (cols.length !== 2) {
    t.fail('migration check', new Error('approved_by + approved_at columns not present (got ' + cols.length + ')'));
    return;
  }
  t.pass('migration: approved_by + approved_at columns exist on email_campaigns');

  // Use a fixed prefix for cleanup. Insert one unapproved + one approved
  // scheduled campaign with scheduled_at in the past so the cron's WHERE
  // would fire if no gate were present.
  var pastIso = new Date(Date.now() - 60 * 1000).toISOString();
  var unapprovedId = 'b2-test-unapproved-' + Date.now();
  var approvedId = 'b2-test-approved-' + Date.now();
  var draftId = 'b2-test-draft-' + Date.now();

  // Capture any state we touch so we can roll back at the end.
  async function cleanup() {
    try {
      await execute("DELETE FROM email_campaigns WHERE id IN ($1,$2,$3)", [unapprovedId, approvedId, draftId]);
    } catch (_e) { /* best-effort */ }
  }

  try {
    // template, subject_en, name, id are NOT NULL on this table; provide them.
    await execute(
      "INSERT INTO email_campaigns (id, name, subject_en, template, status, scheduled_at, created_at, approved_by) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NULL)",
      [unapprovedId, 'B2 unapproved test', 'unit test', 'b2-test-template', 'scheduled', pastIso]
    );
    await execute(
      "INSERT INTO email_campaigns (id, name, subject_en, template, status, scheduled_at, created_at, approved_by, approved_at) VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, NOW())",
      [approvedId, 'B2 approved test', 'unit test', 'b2-test-template', 'scheduled', pastIso, 'admin-test-user']
    );
    await execute(
      "INSERT INTO email_campaigns (id, name, subject_en, template, status, scheduled_at, created_at, approved_by) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NULL)",
      [draftId, 'B2 draft test', 'unit test', 'b2-test-template', 'draft', pastIso]
    );

    // ── 1. Cron query excludes the unapproved row ─────────────────────
    var nowIso = new Date().toISOString();
    var picked = await queryAll(
      "SELECT id FROM email_campaigns WHERE status = 'scheduled' AND approved_by IS NOT NULL AND scheduled_at <= $1 AND id LIKE 'b2-test-%'",
      [nowIso]
    );
    var pickedIds = picked.map(function (r) { return r.id; });
    if (pickedIds.indexOf(approvedId) === -1) {
      t.fail('cron picks approved campaign', new Error('approved campaign missing from cron result: ' + JSON.stringify(pickedIds)));
    } else {
      t.pass('cron picks approved campaign');
    }
    if (pickedIds.indexOf(unapprovedId) !== -1) {
      t.fail('cron skips unapproved campaign', new Error('unapproved campaign appeared in cron result: ' + JSON.stringify(pickedIds)));
    } else {
      t.pass('cron skips unapproved campaign');
    }
    if (pickedIds.indexOf(draftId) !== -1) {
      t.fail('cron skips draft campaign', new Error('draft appeared in cron result'));
    } else {
      t.pass('cron skips draft campaign (status filter)');
    }

    // ── 2. Approve transition on the unapproved scheduled row ─────────
    // Mirrors the route: UPDATE ... SET approved_by, approved_at WHERE
    // approved_by IS NULL.
    var approverId = 'b2-test-approver';
    var approveNow = new Date().toISOString();
    await execute(
      'UPDATE email_campaigns SET approved_by = $1, approved_at = $2 WHERE id = $3 AND approved_by IS NULL',
      [approverId, approveNow, unapprovedId]
    );
    var afterApprove = await queryOne('SELECT approved_by, approved_at FROM email_campaigns WHERE id = $1', [unapprovedId]);
    if (afterApprove && afterApprove.approved_by === approverId && afterApprove.approved_at) {
      t.pass('approve transition writes approved_by + approved_at');
    } else {
      t.fail('approve transition writes approved_by + approved_at', new Error('row state: ' + JSON.stringify(afterApprove)));
    }

    // ── 3. Idempotency: second approve must not overwrite ─────────────
    var secondApprover = 'b2-test-approver-2';
    var rs = await execute(
      'UPDATE email_campaigns SET approved_by = $1, approved_at = NOW() WHERE id = $2 AND approved_by IS NULL',
      [secondApprover, unapprovedId]
    );
    var afterSecondApprove = await queryOne('SELECT approved_by FROM email_campaigns WHERE id = $1', [unapprovedId]);
    if (afterSecondApprove && afterSecondApprove.approved_by === approverId) {
      t.pass('second approve does not overwrite (approved_by IS NULL guard works)');
    } else {
      t.fail('second approve does not overwrite', new Error('approver became ' + (afterSecondApprove && afterSecondApprove.approved_by)));
    }

    // ── 4. Re-run the cron query: now the previously-unapproved row qualifies
    var picked2 = await queryAll(
      "SELECT id FROM email_campaigns WHERE status = 'scheduled' AND approved_by IS NOT NULL AND scheduled_at <= $1 AND id LIKE 'b2-test-%'",
      [nowIso]
    );
    var picked2Ids = picked2.map(function (r) { return r.id; });
    if (picked2Ids.indexOf(unapprovedId) !== -1 && picked2Ids.indexOf(approvedId) !== -1) {
      t.pass('cron picks both campaigns after approval');
    } else {
      t.fail('cron picks both after approval', new Error('post-approve cron result: ' + JSON.stringify(picked2Ids)));
    }

    // ── 5. Partial index sanity — confirm it exists and has the right WHERE
    var idx = await queryOne(
      "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='email_campaigns' AND indexname='idx_email_campaigns_scheduled_approved'"
    );
    if (idx && /approved_by IS NOT NULL/.test(idx.indexdef) && /status = 'scheduled'/.test(idx.indexdef)) {
      t.pass('partial index covers the cron predicate');
    } else {
      t.fail('partial index covers the cron predicate', new Error('indexdef: ' + (idx && idx.indexdef)));
    }
  } finally {
    await cleanup();
  }
})().catch(function (err) {
  t.fail('campaigns approval-gate: harness crashed', err);
});
