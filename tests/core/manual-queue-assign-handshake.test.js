// tests/core/manual-queue-assign-handshake.test.js
//
// A1 (AUDIT 2026-09-09) — regression guard: hand-assigning a doctor from the
// manual queue must ACTUALLY assign (open the doctor_assignments handshake),
// and an ineligible pick must fall the case back to the open pool with a named
// reason — never leave a paid case with a bare doctor_id write that no worker
// can see.
//
// Two layers, both runnable with no DB (the repo's local DB is intentionally
// unmigrated, so DB-integration assertions would skip):
//   1. UNIT — services/assign_case with injected deps: the eligibility gate
//      returns the right code per rule, and finalize drives assignDoctor + the
//      doctor notification.
//   2. STRUCTURAL — both manual-queue approve handlers call the shared service,
//      route the write through `effectiveDoctorId`, finalize on success, and
//      fall back to assignment_status='auto' + broadcast otherwise.
//
// Verified NEGATIVELY: each assertion was confirmed to fail with the fix
// reverted, then the fix restored.

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n🧭 A1 — manual-queue hand-assign opens the acceptance handshake\n');

const ROOT = path.join(__dirname, '..', '..');
function code(rel) { return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }

async function check(name, fn) {
  try {
    const why = await fn();
    if (why) t.fail(name, new Error(why));
    else t.pass(name);
  } catch (err) { t.fail(name, err); }
}

const svc = require('../../src/services/assign_case');

// ── Fixtures ────────────────────────────────────────────────────────────────
const PAID_ORDER = Object.freeze({
  id: 'ord-1', doctor_id: null, status: 'PAID', payment_status: 'paid',
  paid_at: '2026-09-09T10:00:00Z', specialty_id: 'spec-cardio', service_id: 'svc-echo',
  tier: 'standard', urgency_tier: 'standard', sla_hours: 48,
});
const GOOD_DOCTOR = Object.freeze({
  id: 'doc-1', name: 'Dr Eligible', role: 'doctor', is_active: true, is_paused: false,
  onboarding_complete: true, specialty_id: 'spec-cardio', max_active_cases: 5, max_active_cases_urgent: 8,
});

// queryOne dispatcher keyed on the SQL each call makes.
function makeQueryOne({ order = PAID_ORDER, doctor = GOOD_DOCTOR, offers = { ok: 1 }, load = 2 } = {}) {
  return async (sql) => {
    const s = String(sql);
    if (/FROM orders_active\s+WHERE id/.test(s)) return order;
    if (/FROM users WHERE id/.test(s)) return doctor;
    if (/FROM doctor_services/.test(s)) return offers;
    if (/COUNT\(\*\)/.test(s)) return { c: load };
    return null;
  };
}

// ── UNIT: the eligibility gate ───────────────────────────────────────────────

check('eligible doctor passes the gate', async () => {
  const r = await svc.checkHandpickedDoctorEligibility('ord-1', 'doc-1', {
    specialtyId: 'spec-cardio', serviceId: 'svc-echo', deps: { queryOne: makeQueryOne() },
  });
  if (!r.ok) return 'an eligible doctor was refused: ' + r.code;
});

const CASES = [
  ['paused doctor', { doctor: { ...GOOD_DOCTOR, is_paused: true } }, 'DOCTOR_PAUSED'],
  ['inactive doctor', { doctor: { ...GOOD_DOCTOR, is_active: false } }, 'DOCTOR_INACTIVE'],
  ['onboarding incomplete', { doctor: { ...GOOD_DOCTOR, onboarding_complete: false } }, 'DOCTOR_ONBOARDING_INCOMPLETE'],
  ['specialty mismatch', { doctor: { ...GOOD_DOCTOR, specialty_id: 'spec-derm' } }, 'SPECIALTY_MISMATCH'],
  ['does not offer service', { offers: null }, 'DOCTOR_SERVICE_NOT_OFFERED'],
  ['at capacity', { load: 5 }, 'DOCTOR_AT_CAPACITY'],
  ['not a doctor', { doctor: { ...GOOD_DOCTOR, role: 'patient' } }, 'DOCTOR_NOT_FOUND'],
  ['unpaid order', { order: { ...PAID_ORDER, payment_status: 'unpaid' } }, 'PAYMENT_NOT_CONFIRMED'],
  ['already has a doctor', { order: { ...PAID_ORDER, doctor_id: 'doc-other' } }, 'ALREADY_ASSIGNED'],
];
for (const [label, over, expectCode] of CASES) {
  check('gate blocks: ' + label + ' → ' + expectCode, async () => {
    const r = await svc.checkHandpickedDoctorEligibility('ord-1', 'doc-1', {
      specialtyId: 'spec-cardio', serviceId: 'svc-echo', deps: { queryOne: makeQueryOne(over) },
    });
    if (r.ok) return 'should have been blocked';
    if (r.code !== expectCode) return 'wrong code: got ' + r.code + ', want ' + expectCode;
    if (!r.reason) return 'no operator-facing reason text';
  });
}

// A NULL is_active is a legacy row that routes as active everywhere else — it
// must NOT block (COALESCE(is_active,true) semantics).
check('gate allows NULL is_active (legacy rows route as active)', async () => {
  const r = await svc.checkHandpickedDoctorEligibility('ord-1', 'doc-1', {
    specialtyId: 'spec-cardio', serviceId: 'svc-echo',
    deps: { queryOne: makeQueryOne({ doctor: { ...GOOD_DOCTOR, is_active: null } }) },
  });
  if (!r.ok) return 'a NULL is_active doctor was blocked — must read as active';
});

// ── UNIT: finalize drives the lifecycle assignment + doctor notification ──────

check('finalize calls assignDoctor AND queues the doctor notification', async () => {
  const calls = { assign: [], notify: [] };
  const r = await svc.finalizeHandpickedAssignment('ord-1', 'doc-1', {
    doctorName: 'Dr Eligible',
    deps: {
      caseLifecycle: { assignDoctor: async (cid, did) => { calls.assign.push([cid, did]); } },
      queueMultiChannelNotification: async (opts) => { calls.notify.push(opts); return { ok: true }; },
    },
  });
  if (!r.ok) return 'finalize reported failure on a clean path';
  if (calls.assign.length !== 1 || calls.assign[0][0] !== 'ord-1' || calls.assign[0][1] !== 'doc-1') {
    return 'assignDoctor was not called with (orderId, doctorId)';
  }
  if (calls.notify.length !== 1) return 'doctor notification was not queued';
  const n = calls.notify[0];
  if (n.template !== 'order_assigned_doctor') return 'wrong doctor template: ' + n.template;
  if (n.toUserId !== 'doc-1') return 'doctor notification not addressed to the doctor';
  if (!n.dedupe_key || !/order_assigned:ord-1:doc-1/.test(n.dedupe_key)) return 'missing per-doctor-per-case dedupe key';
  if (!Array.isArray(n.channels) || !n.channels.includes('internal')) return 'doctor notification not on the in-app bell';
});

check('finalize returns {ok:false} when assignDoctor throws (caller must fall back)', async () => {
  const r = await svc.finalizeHandpickedAssignment('ord-1', 'doc-1', {
    deps: {
      caseLifecycle: { assignDoctor: async () => { throw new Error('boom'); } },
      queueMultiChannelNotification: async () => ({ ok: true }),
    },
  });
  if (r.ok) return 'finalize hid an assignDoctor failure as success';
  if (r.code !== 'ASSIGN_FAILED') return 'wrong failure code: ' + r.code;
});

// A notification failure must NOT undo a durable assignment.
check('finalize stays ok when only the notification fails', async () => {
  const r = await svc.finalizeHandpickedAssignment('ord-1', 'doc-1', {
    deps: {
      caseLifecycle: { assignDoctor: async () => {} },
      queueMultiChannelNotification: async () => { throw new Error('notify down'); },
    },
  });
  if (!r.ok) return 'a notification failure wrongly reported the assignment as failed';
});

// ── STRUCTURAL: both handlers are wired through the shared service ────────────

const HANDLERS = [
  ['superadmin.js', 'src/routes/superadmin.js', "router.post('/superadmin/manual-queue/:id/approve'"],
  ['api/admin.js', 'src/routes/api/admin.js', "router.post('/manual-queue/:id/approve'"],
];

for (const [label, rel, anchor] of HANDLERS) {
  const src = code(rel);
  const start = src.indexOf(anchor);
  // Carve the handler body up to the next `router.post(` / `router.get(`.
  const after = start >= 0 ? src.slice(start + anchor.length) : '';
  const nextRoute = after.search(/router\.(post|get)\(/);
  const body = nextRoute > 0 ? after.slice(0, nextRoute) : after;

  check(label + ': locates the approve handler', () => {
    if (start < 0) return 'approve handler not found';
  });
  check(label + ': runs the full eligibility gate on a hand-pick', () => {
    if (!/checkHandpickedDoctorEligibility/.test(body)) return 'does not call checkHandpickedDoctorEligibility';
    if (!/effectiveDoctorId/.test(body)) return 'does not compute effectiveDoctorId from eligibility';
  });
  check(label + ': the routing write is keyed on effectiveDoctorId, not the raw pick', () => {
    // The branch that sets doctor_id in the UPDATE must use effectiveDoctorId.
    if (!/effectiveDoctorId\s*\)?\s*[\?\{]/.test(body) && !/if\s*\(\s*effectiveDoctorId/.test(body)) {
      return 'UPDATE branch not gated on effectiveDoctorId';
    }
  });
  check(label + ': finalizes the handshake on an eligible pick', () => {
    if (!/finalizeHandpickedAssignment/.test(body)) return 'does not call finalizeHandpickedAssignment';
  });
  check(label + ': falls back to the open pool when the pick is ineligible', () => {
    if (!/assignment_status = 'auto'/.test(body) && !/'auto'/.test(body)) return "no assignment_status='auto' fallback";
    if (!/broadcastOrderToSpecialty/.test(body)) return 'no broadcast fallback';
  });
}
