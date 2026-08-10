'use strict';

// Task 13 — eligibility 409 guards on POST /admin/cases/:id/assign.
// Tests the two new rejection codes added in §4.6:
//   DOCTOR_ONBOARDING_INCOMPLETE (409) — doctor.onboarding_complete is false
//   DOCTOR_SERVICE_NOT_OFFERED   (409) — no doctor_services row for the case's service_id
//
// Also verifies that an eligible doctor (onboarded + service mapped + same specialty,
// active, under cap) still gets a 200 successful assign.
//
// Mount pattern mirrors admin_command_api.test.js exactly: the admin router
// factory receives a stubbed pool whose client.query handler is dispatched on
// SQL patterns. No real DB is touched.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-admin-eligibility';
process.env.SUPERADMIN_EMAIL = 'ziad.wahsh@shifaegypt.com';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

const apiResponse = require('../../src/middleware/apiResponse');
const makeAdminRouter = require('../../src/routes/api/admin');

const SUPERADMIN = {
  id: 'd1d04fb8-cc53-4928-b412-60f763546d09',
  email: 'ziad.wahsh@shifaegypt.com',
  role: 'superadmin',
  name: 'Ziad El Wahsh',
};

function mintToken(payload, expiresIn = '15m') {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
}

// ─── shared test fixtures ─────────────────────────────────────────────────────

const SPECIALTY_ID = 'spec-cardiology';
const SERVICE_ID   = 'svc-ecg-12lead';

// A paid unassigned order with a known service_id.
const BASE_ORDER = {
  id: 'ord-elig-1', doctor_id: null, status: 'paid', payment_status: 'paid',
  paid_at: new Date(), specialty_id: SPECIALTY_ID, service_id: SERVICE_ID,
  urgency_tier: 'standard', sla_hours: 48,
};

// D1: onboarding_complete=false, mapped to SERVICE_ID → DOCTOR_ONBOARDING_INCOMPLETE
const D1 = {
  id: 'doc-d1', name: 'Dr D1', role: 'doctor', is_active: true, is_paused: false,
  onboarding_complete: false, specialty_id: SPECIALTY_ID,
  max_active_cases: 5, max_active_cases_urgent: 8,
};
const D1_OFFERS = true; // has a doctor_services row

// D2: onboarding_complete=true, NOT mapped to SERVICE_ID → DOCTOR_SERVICE_NOT_OFFERED
const D2 = {
  id: 'doc-d2', name: 'Dr D2', role: 'doctor', is_active: true, is_paused: false,
  onboarding_complete: true, specialty_id: SPECIALTY_ID,
  max_active_cases: 5, max_active_cases_urgent: 8,
};
const D2_OFFERS = false; // no doctor_services row

// D3: onboarding_complete=true, mapped to SERVICE_ID, same specialty, under cap → 200
const D3 = {
  id: 'doc-d3', name: 'Dr D3', role: 'doctor', is_active: true, is_paused: false,
  onboarding_complete: true, specialty_id: SPECIALTY_ID,
  max_active_cases: 5, max_active_cases_urgent: 8,
};
const D3_OFFERS = true;

// ─── helpers ──────────────────────────────────────────────────────────────────

function txClient(doctor, doctorOffers, load = 2) {
  const calls = [];
  const client = {
    calls,
    query: async (sql, params) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push(s);
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return { rows: [] };
      if (/FOR UPDATE/.test(s)) return { rows: [BASE_ORDER] };
      if (/FROM users WHERE id = \$1/.test(s)) return { rows: doctor ? [doctor] : [] };
      if (/FROM doctor_services WHERE doctor_id/.test(s)) return { rows: doctorOffers ? [{ 1: 1 }] : [] };
      if (/COUNT\(\*\) AS c FROM orders WHERE doctor_id/.test(s)) return { rows: [{ c: load }] };
      if (/^(UPDATE|INSERT)/i.test(s)) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };
  return client;
}

function makeApp(doctor, doctorOffers, load = 2) {
  const client = txClient(doctor, doctorOffers, load);
  const pool = { totalCount: 1, idleCount: 1, waitingCount: 0, connect: async () => client };
  const helpers = {
    safeGet: async () => null,
    safeAll: async () => [],
    safeRun: async () => ({ rowCount: 0 }),
  };
  const deploy = { gitSha: 'test', startedAt: Date.now(), startedAtIso: new Date().toISOString(), version: '0', mode: 'test' };
  const notifiers = {
    ensureConversation: async () => 'convo-stub',
    queueMultiChannelNotification: async () => ({ ok: true, results: {} }),
    notifyCaseAssigned: async () => ({ ok: true, messageId: 'stub' }),
  };
  const app = express();
  app.use(apiResponse);
  app.use(express.json());
  app.use('/api/v1/admin', makeAdminRouter(pool, helpers, deploy, notifiers));
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}`, client };
}

async function postAssign(doctor, doctorOffers, doctorId, load = 2) {
  const { server, base, client } = makeApp(doctor, doctorOffers, load);
  try {
    const res = await fetch(`${base}/api/v1/admin/cases/ord-elig-1/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mintToken(SUPERADMIN)}` },
      body: JSON.stringify({ doctorId }),
    });
    const body = await res.json().catch(() => null);
    return { res, body, calls: client.calls };
  } finally {
    server.close();
  }
}

// ─── tests ────────────────────────────────────────────────────────────────────

test('POST /assign — D1 (onboarding_complete=false, service mapped) → 409 DOCTOR_ONBOARDING_INCOMPLETE', async () => {
  const { res, body } = await postAssign(D1, D1_OFFERS, D1.id);
  assert.equal(res.status, 409);
  assert.equal(body.code, 'DOCTOR_ONBOARDING_INCOMPLETE');
});

test('POST /assign — D2 (onboarding_complete=true, service NOT mapped) → 409 DOCTOR_SERVICE_NOT_OFFERED', async () => {
  const { res, body } = await postAssign(D2, D2_OFFERS, D2.id);
  assert.equal(res.status, 409);
  assert.equal(body.code, 'DOCTOR_SERVICE_NOT_OFFERED');
});

test('POST /assign — D3 (onboarding_complete=true, service mapped, under cap) → 200 assigned', async () => {
  const { res, body, calls } = await postAssign(D3, D3_OFFERS, D3.id);
  assert.equal(res.status, 200);
  assert.equal(body.data.status, 'assigned');
  assert.equal(body.data.reassigned, false);
  assert.deepEqual(body.data.doctor, { id: D3.id, name: D3.name });
  assert.ok(calls.includes('COMMIT'));
  assert.ok(!calls.includes('ROLLBACK'));
});
