// tests/core/theme7b-refunds-schema.test.js
//
// Theme 7b Phase 1 — refunds table schema regression guard.
//
// Asserts that migration 048_refund_workflow.sql:
//   1. Adds the expected workflow columns via ADD COLUMN IF NOT EXISTS
//      (idempotent re-runs).
//   2. Backfills existing rows to status='paid' (existing rows are all
//      system-generated SLA-breach payouts written by
//      services/sla_breach.issueBreachRefund).
//   3. Sets status NOT NULL + DEFAULT 'pending' AFTER the backfill.
//   4. Creates the partial unique index that prevents two pending
//      refund requests on the same order.
//   5. Wraps the whole thing in BEGIN/COMMIT.
//
// Source-grep style — matches Theme 1/5/6/7 lint pattern.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n💸 Theme 7b Phase 1 — refunds workflow migration shape\n');

const MIG = path.join(__dirname, '..', '..', 'src', 'migrations', '048_refund_workflow.sql');

if (!fs.existsSync(MIG)) {
  t.fail('locate migration 048', new Error('src/migrations/048_refund_workflow.sql not found'));
} else {
  const sql = fs.readFileSync(MIG, 'utf8');

  // ── 1. BEGIN/COMMIT wrapper ──────────────────────────────────────
  try {
    if (!/^BEGIN;/m.test(sql)) throw new Error('BEGIN; not present at start of migration');
    if (!/^COMMIT;/m.test(sql)) throw new Error('COMMIT; not present at end of migration');
    t.pass('migration 048 wraps in BEGIN/COMMIT');
  } catch (e) { t.fail('BEGIN/COMMIT wrapper', e); }

  // ── 2. Required ADD COLUMN IF NOT EXISTS for each new column ──────
  const REQUIRED_COLUMNS = [
    ['status',              /TEXT/i],
    ['requested_amount',    /NUMERIC\s*\(\s*10\s*,\s*2\s*\)/i],
    ['approved_amount',     /NUMERIC\s*\(\s*10\s*,\s*2\s*\)/i],
    ['instapay_handle',     /TEXT/i],
    ['instapay_reference',  /TEXT/i],
    ['paymob_refund_id',    /TEXT/i],
    ['denial_reason',       /TEXT/i],
    ['patient_reason',      /TEXT/i],
    ['requested_by',        /TEXT/i],
    ['reviewed_by',         /TEXT/i],
    ['reviewed_at',         /TIMESTAMPTZ/i],
    ['paid_at',             /TIMESTAMPTZ/i],
  ];
  for (const [col, typeRe] of REQUIRED_COLUMNS) {
    try {
      // Match: ADD COLUMN IF NOT EXISTS <col> <type-spec>
      const re = new RegExp(
        'ALTER\\s+TABLE\\s+refunds\\s+ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+' +
        col + '\\s+([A-Z\\(\\),0-9\\s]+?)(;|\\n)',
        'i'
      );
      const m = sql.match(re);
      if (!m) throw new Error('ADD COLUMN IF NOT EXISTS ' + col + ' ... not found');
      if (!typeRe.test(m[1])) {
        throw new Error('column `' + col + '` does not declare expected type — got `' + m[1].trim() + '`');
      }
      t.pass('migration adds `' + col + '` (' + m[1].trim() + ')');
    } catch (e) { t.fail('column ' + col, e); }
  }

  // ── 3. Backfill UPDATE: WHERE status IS NULL → status='paid' ──────
  try {
    const BACKFILL_RE = /UPDATE\s+refunds\s*[\s\S]+?WHERE\s+status\s+IS\s+NULL/i;
    if (!BACKFILL_RE.test(sql)) {
      throw new Error('UPDATE refunds ... WHERE status IS NULL backfill not found (idempotent re-run guard)');
    }
    if (!/SET\s+[\s\S]+?status\s*=\s*'paid'/i.test(sql)) {
      throw new Error('backfill UPDATE does not set status=\'paid\' for existing rows');
    }
    if (!/paid_at\s*=\s*refunded_at\s+AT\s+TIME\s+ZONE\s+'UTC'/i.test(sql)) {
      throw new Error('backfill UPDATE does not cast refunded_at AT TIME ZONE \'UTC\' for paid_at (TZ drift defense)');
    }
    if (!/approved_amount\s*=\s*amount_egp/i.test(sql)) {
      throw new Error('backfill UPDATE does not set approved_amount = amount_egp');
    }
    if (!/requested_amount\s*=\s*amount_egp/i.test(sql)) {
      throw new Error('backfill UPDATE does not set requested_amount = amount_egp');
    }
    t.pass('backfill UPDATE: status=\'paid\', paid_at/reviewed_at from refunded_at, amounts from amount_egp, idempotent via WHERE status IS NULL');
  } catch (e) { t.fail('backfill UPDATE shape', e); }

  // ── 4. NOT NULL + DEFAULT after backfill ──────────────────────────
  try {
    if (!/ALTER\s+COLUMN\s+status\s+SET\s+NOT\s+NULL/i.test(sql)) {
      throw new Error('status column is not locked NOT NULL after backfill');
    }
    if (!/ALTER\s+COLUMN\s+status\s+SET\s+DEFAULT\s+'pending'/i.test(sql)) {
      throw new Error('status column does not get DEFAULT \'pending\' (safe-by-default for new inserts)');
    }
    t.pass('status column SET NOT NULL + SET DEFAULT \'pending\' applied after backfill');
  } catch (e) { t.fail('status NOT NULL + DEFAULT', e); }

  // ── 5. Indexes — at least the partial-unique on pending status ───
  const REQUIRED_INDEXES = [
    ['idx_refunds_status',         /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_refunds_status\b/i],
    ['idx_refunds_requested_by',   /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_refunds_requested_by\b/i],
    ['idx_refunds_status_created', /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_refunds_status_created\b/i],
    ['uniq_refunds_pending_per_order (partial unique)', /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+uniq_refunds_pending_per_order[\s\S]+?WHERE\s+status\s+IN\s*\(\s*'pending'\s*,\s*'auto_approved'\s*\)/i],
  ];
  for (const [name, re] of REQUIRED_INDEXES) {
    try {
      if (!re.test(sql)) throw new Error('index `' + name + '` not declared');
      t.pass('index `' + name + '` declared idempotently');
    } catch (e) { t.fail('index ' + name, e); }
  }

  // ── 6. NO CHECK constraint on status (per Ziad's brief: enforced at app layer) ─
  try {
    if (/CHECK\s*\(\s*status\s+IN\s*\(/i.test(sql)) {
      throw new Error('migration adds CHECK constraint on status — Ziad\'s Phase 1 brief specified app-layer enforcement only for v1');
    }
    t.pass('no CHECK constraint on status (app-layer enforcement per Phase 1 brief)');
  } catch (e) { t.fail('no CHECK constraint', e); }
}

// ── 7. services/sla_breach.js writer: B3 — system breach refunds are written
//      as 'auto_approved' (system-approved, AWAITING PAYOUT), never 'paid'.
//      No money has moved at write time (no Paymob/InstaPay refund API is
//      wired), so claiming 'paid' was a lie. An operator marks the row 'paid'
//      after the InstaPay transfer via admin_refund_mark_paid. The writer must
//      also populate requested_amount/approved_amount, or mark-paid's
//      finalAmount (approved ?? requested) is null and the refund can never be
//      paid out (NO_AMOUNT).
try {
  const SLA = path.join(__dirname, '..', '..', 'src', 'services', 'sla_breach.js');
  const slaSrc = fs.readFileSync(SLA, 'utf8');
  // The INSERT spans multiple lines with a column list and a VALUES clause.
  // Match greedily to the closing `);` of the execute() call, not to the
  // first `)` (which is the column-list close paren).
  const INSERT_RE = /INSERT\s+INTO\s+refunds[\s\S]+?VALUES[\s\S]+?\)\s*`/i;
  const m = slaSrc.match(INSERT_RE);
  if (!m) throw new Error('INSERT INTO refunds not found in services/sla_breach.js');
  if (!/'auto_approved'/.test(m[0])) {
    throw new Error('services/sla_breach.js INSERT does not write status=\'auto_approved\' — B3: a system breach refund is owed-but-unpaid, it must land in the awaiting-payment queue, not claim money was sent');
  }
  if (/\bstatus[\s\S]*'paid'/.test(m[0]) || /'paid'[\s\S]*\bstatus/.test(m[0])) {
    throw new Error('services/sla_breach.js INSERT still writes status=\'paid\' — B3 regression: no money moves at breach time, do not claim paid');
  }
  // Confirm `status` is in the column list (the substring `status` could
  // appear in the values too — check the COLUMN list specifically).
  const COL_LIST_RE = /INSERT\s+INTO\s+refunds\s*\(([^)]+)\)/i;
  const cm = slaSrc.match(COL_LIST_RE);
  if (!cm || !/\bstatus\b/.test(cm[1])) {
    throw new Error('services/sla_breach.js INSERT does not include `status` in the column list');
  }
  // B3: the payout amount must be carried so mark-paid can finalize it.
  if (!/\brequested_amount\b/.test(cm[1]) || !/\bapproved_amount\b/.test(cm[1])) {
    throw new Error('services/sla_breach.js INSERT does not populate requested_amount + approved_amount — mark-paid finalAmount (approved ?? requested) would be null → NO_AMOUNT, refund unpayable');
  }
  t.pass('services/sla_breach.js INSERT writes status=\'auto_approved\' + requested/approved amounts (B3: owed-but-unpaid, payable via mark-paid)');
} catch (e) { t.fail('sla_breach status=\'auto_approved\' (B3)', e); }
