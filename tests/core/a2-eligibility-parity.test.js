'use strict';
// Batch A2 (2026-09-21) — the eligibility parity matrix, hermetic half.
//
// The batch's entire subject is that four surfaces must give one answer:
// what BROADCAST invites, what the POOL QUEUE shows, what the reassignment
// PICKER selects, and what ACCEPT (and the view rule) permit. All four now
// derive tier and capacity from the same two helpers, and the pool queries
// derive their SQL predicate from those helpers via allowedOrderTierValues /
// orderTierSql. These tests prove the DERIVATIONS are exact: for every
// doctor-tier configuration × every order-tier spelling the orders table can
// carry, the pool predicate's answer equals doctorSupportsTier's answer —
// so a case the pool shows is a case the accept gate takes, by construction.
//
// The SQL-side halves (the ?| predicate in broadcast, = ANY in the pool
// arms) are pinned by tests/lint/batch-a2-routing-pins.test.js; the live-DB
// behaviour of the ?| clause itself is covered by src/__tests__/
// auto_assign.test.js (DB-gated).
//
// Runner-harness style (global._testRunner), NOT node:test: tests/run.js —
// the suite the baseline gates on — tallies only this harness.

const assert = require('node:assert/strict');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};
function check(name, fn) {
  try { fn(); t.pass(name); } catch (err) { t.fail(name, err); }
}

console.log('\n🔀 A2 — eligibility parity: broadcast / pool / picker / accept give one answer\n');

const {
  doctorSupportsTier,
  capFor,
  allowedOrderTierValues,
  orderTierSql
} = require('../../src/services/doctor_eligibility');

// Every shape users.sla_tiers_supported has been seen to carry: jsonb arrays,
// JSON strings, legacy spellings, NULL, junk.
const DOCTOR_TIER_CONFIGS = [
  null,                                   // pre-migration-033 rows → standard-only
  undefined,
  'not json',                             // unparseable → standard-only
  [],                                     // explicit empty → supports nothing
  ['standard'],
  ['standard', 'vip'],
  ['standard', 'vip', 'urgent'],
  ['urgent'],                             // urgent WITHOUT standard
  ['priority'],                           // retired spelling of VIP
  ['fast_track'],                         // pre-031 spelling of VIP
  '["standard","vip"]',                   // JSON-string storage
  ['VIP'],                                // case-insensitive
  ['bespoke_tier'],                       // a value no vocabulary knows
];

// Every order-tier state: (urgency_tier, tier) column pairs, including the
// blanks and legacy spellings, plus a junk value.
const ORDER_TIER_PAIRS = [
  [null, null], ['', ''], [' ', ''],           // default → standard
  ['standard', null], ['vip', null], ['urgent', null],
  ['fast_track', null], ['priority', null],     // legacy rows
  [null, 'vip'], ['', 'urgent'],                // urgency_tier blank → tier
  ['vip', 'standard'],                          // urgency_tier wins over tier
  ['URGENT ', null],                            // case/whitespace noise
  ['bespoke_tier', null],
];

// JS mirror of orderTierSql(): first non-'' of urgency_tier, tier, 'standard'
// (SQL NULLIF(x,'') = JS's `||` on the empty string), then TRIM+LOWER, and a
// whitespace-only pick reads 'standard'.
function sqlOrderTier(urgencyTier, tier) {
  const pick = (urgencyTier !== null && urgencyTier !== undefined && urgencyTier !== '')
    ? urgencyTier
    : ((tier !== null && tier !== undefined && tier !== '') ? tier : 'standard');
  const norm = String(pick).trim().toLowerCase();
  return norm || 'standard';
}

check('A2-2 parity: the pool predicate equals the accept gate for every doctor × order tier combination', () => {
  for (const doctorTiers of DOCTOR_TIER_CONFIGS) {
    const allowed = allowedOrderTierValues(doctorTiers);
    for (const [u, tt] of ORDER_TIER_PAIRS) {
      // What the pool SQL decides: orderTierSql('o.') = ANY(allowed).
      const poolShows = allowed.includes(sqlOrderTier(u, tt));
      // What Guardrail 3d and the view rule decide, with their exact input
      // expression: (order.urgency_tier || order.tier || 'standard').
      const acceptTakes = doctorSupportsTier(doctorTiers, (u || tt || 'standard'));
      assert.equal(
        poolShows, acceptTakes,
        `disagreement for doctor=${JSON.stringify(doctorTiers)} order=(${JSON.stringify(u)},${JSON.stringify(tt)}): ` +
        `pool says ${poolShows}, accept says ${acceptTakes}`
      );
    }
  }
});

check('A2-2: NULL / unparseable sla_tiers_supported reads standard-only — auto_assign\'s exact default', () => {
  assert.deepEqual(allowedOrderTierValues(null).sort(), ['standard']);
  assert.deepEqual(allowedOrderTierValues(undefined).sort(), ['standard']);
  assert.deepEqual(allowedOrderTierValues('not json').sort(), ['standard']);
  // Explicit [] is NOT the NULL default: the doctor turned everything off.
  assert.deepEqual(allowedOrderTierValues([]), []);
});

check('A2-2: a doctor who turned Urgent off is never shown / invited to an urgent case', () => {
  const stdVip = allowedOrderTierValues(['standard', 'vip']);
  assert.ok(!stdVip.includes('urgent'), 'urgent leaked into a standard+vip doctor\'s pool');
  assert.ok(stdVip.includes('standard') && stdVip.includes('vip'));
  // and the legacy order spellings of VIP still reach them
  assert.ok(stdVip.includes('fast_track') && stdVip.includes('priority'));
});

check('A2-2: orderTierSql is the sanctioned urgency_tier-first fallback, pinned', () => {
  assert.equal(
    orderTierSql('o.'),
    "COALESCE(NULLIF(LOWER(TRIM(COALESCE(NULLIF(o.urgency_tier, ''), NULLIF(o.tier, ''), 'standard'))), ''), 'standard')"
  );
});

check('A2-1/A2-3 parity: broadcast\'s and the picker\'s capacity filter equal the accept gate\'s, from capFor', () => {
  const doctors = [
    { max_active_cases: 5, max_active_cases_urgent: 2 },
    { max_active_cases: null, max_active_cases_urgent: null },  // no cap configured
    { max_active_cases: 0, max_active_cases_urgent: 0 },        // 0 = no cap (assign_case direction)
    { max_active_cases: 1, max_active_cases_urgent: 8 },
    { max_active_cases: 'x', max_active_cases_urgent: 3 },      // junk → no cap
  ];
  for (const d of doctors) {
    for (const tier of ['standard', 'vip', 'urgent']) {
      for (let load = 0; load <= 9; load++) {
        const cap = capFor(d, tier);
        // broadcast (A2-1) and the picker (A2-3) invite/select when:
        const invited = cap === 0 || load < cap;
        // the accept gate (Guardrail 4) refuses when:
        const acceptRefuses = cap > 0 && load >= cap;
        assert.equal(invited, !acceptRefuses,
          `capacity disagreement: d=${JSON.stringify(d)} tier=${tier} load=${load}`);
      }
    }
  }
  // VIP caps on max_active_cases, NOT max_active_cases_urgent — the X4 defect.
  assert.equal(capFor({ max_active_cases: 5, max_active_cases_urgent: 2 }, 'vip'), 5);
  assert.equal(capFor({ max_active_cases: 5, max_active_cases_urgent: 2 }, 'urgent'), 2);
});

check('A2-4: redactWithheldUntilAccept strips the patient\'s words and keeps the scheduling facts', () => {
  const { redactWithheldUntilAccept, WITHHELD_UNTIL_ACCEPT } = require('../../src/services/doctor_case_access');
  assert.ok(WITHHELD_UNTIL_ACCEPT.includes('slot_notes'), 'slot_notes is not on the withheld list');
  const appt = {
    id: 'apt1', status: 'pending_doctor', scheduled_at: '2026-09-22T10:00:00Z',
    doctor_proposed_time: null, slot_notes: 'my name is X and my history is …', notes: 'more free text'
  };
  const redacted = redactWithheldUntilAccept(appt);
  assert.ok(!('slot_notes' in redacted), 'slot_notes survived the pre-accept redaction');
  assert.ok(!('notes' in redacted), 'notes survived the pre-accept redaction');
  assert.equal(redacted.id, 'apt1');
  assert.equal(redacted.status, 'pending_doctor');
  assert.equal(redacted.scheduled_at, '2026-09-22T10:00:00Z');
  // and the original row is untouched (clone semantics)
  assert.equal(appt.slot_notes, 'my name is X and my history is …');
});
