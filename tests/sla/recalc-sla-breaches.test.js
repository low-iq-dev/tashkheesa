// tests/sla/recalc-sla-breaches.test.js
//
// Tests sweepSlaBreaches() — the function that replaced the buggy
// `recalcSlaBreaches: markSlaBreach` alias. Three scenarios:
//   1. Happy path: 3 IN_REVIEW + paid orders past deadline → all breached
//   2. Resilience: 3 candidates, one of them is in REJECTED_FILES (matches
//      candidate query, but transitionCase rejects REJECTED_FILES → SLA_BREACH
//      with "Only active review cases can escalate"). Sweep continues, the
//      bad row goes to errors[], the good rows succeed.
//   3. No-arg call (the actual production bug): sweep no longer throws
//      when called with no argument; it returns the structured object.
//
// Skipped automatically when DATABASE_URL is not set.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const assert = require('assert');
const crypto = require('crypto');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🧹 sla/sweepSlaBreaches\n');

if (!process.env.DATABASE_URL) {
  t.skip('sweep-sla-breaches', 'DATABASE_URL not set');
  return;
}

const TEST_PREFIX = 'test-sweep-';

const { pool, execute, queryOne } = require('../../src/pg');
const lifecycle = require('../../src/case_lifecycle');
const { sweepSlaBreaches, recalcSlaBreaches, CASE_STATUS } = lifecycle;

function uid(label) {
  return TEST_PREFIX + label + '-' + crypto.randomBytes(4).toString('hex');
}

// Insert a paid order whose SLA has expired. The candidate query in
// sweepSlaBreaches selects rows by status IN_REVIEW/REJECTED_FILES with
// deadline_at <= now AND breached_at IS NULL — so we set all of those.
//
// accepted_at is left NULL (and sla_hours = 0) so deadlineFromAcceptance()
// returns null and markSlaBreach's "not yet past acceptance deadline"
// short-circuit doesn't fire.
async function insertOverdueOrder({ status }) {
  const id = uid(status.toLowerCase());
  const pastIso = new Date(Date.now() - 3600 * 1000).toISOString(); // 1h ago
  // paid_at is timestamptz, deadline_at is timestamp (no tz) — different
  // types, so we cast each parameter explicitly rather than aliasing.
  await execute(
    `INSERT INTO orders
       (id, status, payment_status, paid_at, deadline_at, breached_at,
        accepted_at, sla_hours, price, created_at, updated_at)
     VALUES ($1, $2, 'paid', $3::timestamptz, $3::timestamp, NULL,
             NULL, 0, 1500, NOW(), NOW())`,
    [id, status, pastIso]
  );
  return id;
}

async function getStatus(id) {
  const row = await queryOne('SELECT status FROM orders WHERE id = $1', [id]);
  return row ? String(row.status) : null;
}

// markSlaBreach transitions to SLA_BREACH and then auto-reassigns to
// ASSIGNED if any doctor is available — so checking final status is
// flaky in environments with eligible doctors. The durable signal is
// breached_at, which is set during the breach transition and never
// cleared by subsequent reassignment.
async function wasBreached(id) {
  const row = await queryOne('SELECT breached_at FROM orders WHERE id = $1', [id]);
  return Boolean(row && row.breached_at);
}

async function cleanup() {
  await execute(`DELETE FROM error_logs WHERE context LIKE $1`, ['%' + TEST_PREFIX + '%']);
  await execute(`DELETE FROM orders WHERE id LIKE $1`, [TEST_PREFIX + '%']);
}

(async function run() {
  try {
    // Make sure prior crashed runs didn't leave residue.
    await cleanup();

    // ── 1. Happy path: 3 IN_REVIEW candidates → all breached ───────
    try {
      const ids = [];
      for (let i = 0; i < 3; i++) {
        ids.push(await insertOverdueOrder({ status: 'IN_REVIEW' }));
      }

      const result = await sweepSlaBreaches();
      assert.ok(result, 'sweep should return a result object');
      assert.strictEqual(typeof result.swept, 'number', 'swept is a number');
      assert.strictEqual(typeof result.breached, 'number', 'breached is a number');
      assert.ok(Array.isArray(result.errors), 'errors is an array');

      // The sweep is global, so other in-flight rows from elsewhere may
      // count too. Bound the assertion to "our 3 are included".
      assert.ok(result.swept >= 3, 'swept should include our 3 rows, got ' + result.swept);
      assert.ok(result.breached >= 3, 'breached should include our 3, got ' + result.breached);

      for (const id of ids) {
        assert.ok(
          await wasBreached(id),
          `expected ${id} to have breached_at set after sweep`
        );
      }
      t.pass('happy path: 3 IN_REVIEW candidates past deadline are all breached');

      await execute(`DELETE FROM orders WHERE id = ANY($1::text[])`, [ids]);
    } catch (e) { t.fail('happy path', e); }

    // ── 2. Resilience: bad row in the middle does not poison the sweep ──
    try {
      const goodA = await insertOverdueOrder({ status: 'IN_REVIEW' });
      const bad   = await insertOverdueOrder({ status: 'REJECTED_FILES' }); // transitionCase rejects this
      const goodB = await insertOverdueOrder({ status: 'IN_REVIEW' });

      const result = await sweepSlaBreaches();
      assert.ok(result.swept >= 3, 'should sweep at least our 3 rows');

      // The bad row should be in the errors array, mentioning its id
      const ourError = result.errors.find((e) => e.case_id === bad);
      assert.ok(ourError, 'errors should contain entry for the REJECTED_FILES row');
      assert.match(
        String(ourError.error || ''), /escalate|transition/i,
        'error message should mention the rejected transition; got: ' + ourError.error
      );

      // The good rows should have breached_at set even though bad row failed
      assert.ok(
        await wasBreached(goodA),
        'goodA should still have breached_at set after bad row failure'
      );
      assert.ok(
        await wasBreached(goodB),
        'goodB should still have breached_at set after bad row failure'
      );

      // The bad row should NOT have breached_at set
      assert.strictEqual(
        await wasBreached(bad), false,
        'bad row should not have breached_at set'
      );

      t.pass('resilience: one bad row captured in errors[], other rows still breach');

      await execute(`DELETE FROM orders WHERE id = ANY($1::text[])`, [[goodA, bad, goodB]]);
    } catch (e) { t.fail('resilience', e); }

    // ── 3. The actual bug: no-arg call must not throw / unhandled-reject ──
    try {
      // Direct call (no candidates inserted; sweep over whatever happens
      // to be in the table — should still complete cleanly).
      let result;
      let threw = null;
      try { result = await sweepSlaBreaches(); } catch (err) { threw = err; }
      assert.strictEqual(threw, null, 'sweepSlaBreaches() must not throw on no-arg call');
      assert.ok(result, 'sweepSlaBreaches() returns a result object');

      // The historical name (the bug surface) — must hit the same function
      assert.strictEqual(
        recalcSlaBreaches, sweepSlaBreaches,
        'recalcSlaBreaches export must alias sweepSlaBreaches now'
      );

      let result2;
      let threw2 = null;
      try { result2 = await recalcSlaBreaches(); } catch (err) { threw2 = err; }
      assert.strictEqual(threw2, null, 'recalcSlaBreaches() must not throw on no-arg call');
      assert.ok(result2, 'recalcSlaBreaches() returns a result object');
      t.pass('no-arg recalcSlaBreaches() returns a result object instead of throwing');
    } catch (e) { t.fail('no-arg call', e); }
  } finally {
    try { await cleanup(); } catch (_) {}
    if (require.main === module) {
      try { await pool.end(); } catch (_) {}
    }
  }
})();
