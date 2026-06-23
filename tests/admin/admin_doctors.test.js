'use strict';

// Tashkheesa Command admin API — GET /api/v1/admin/doctors (read-only roster).
// Hermetic: the router is built via its (db, helpers, deploy, deps) factory with
// stubbed helpers, so no real DB is touched. safeAll is stubbed to return fake
// doctor rows shaped exactly as node-postgres returns them (COUNT/bigint → string,
// numeric → string, float8 → number, timestamps → Date). Run with:
//   node --test tests/admin/admin_doctors.test.js
//
// JWT_SECRET + SUPERADMIN_EMAIL must be set BEFORE requiring the app modules,
// because src/middleware/requireJWT.js captures JWT_SECRET at module-load time.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-admin-command-doctors';
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
const PATIENT = { id: 'p-1', email: 'patient@example.com', role: 'patient', name: 'A Patient' };

function mintToken(payload, expiresIn = '15m') {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
}

// Build a throwaway express app with the admin router mounted exactly as
// api_v1.js mounts it (/api/v1/admin), with injected stub helpers.
function makeApp(stubs = {}) {
  const helpers = {
    safeGet: stubs.safeGet || (async () => null),
    safeAll: stubs.safeAll || (async () => []),
    safeRun: stubs.safeRun || (async () => ({ rowCount: 0 })),
  };
  const pool = stubs.pool || { totalCount: 1, idleCount: 1, waitingCount: 0 };
  const deploy = stubs.deploy || {
    gitSha: 'abc1234',
    startedAt: 1718352000000,
    startedAtIso: '2026-06-14T07:00:00.000Z',
    version: '1.0.0',
    mode: 'test',
  };
  const notifiers = stubs.notifiers || {
    ensureConversation: async () => 'convo-stub',
    queueMultiChannelNotification: async () => ({ ok: true, results: {} }),
    notifyCaseAssigned: async () => ({ ok: true, messageId: 'stub' }),
  };
  const app = express();
  app.use(apiResponse);
  app.use(express.json());
  app.use('/api/v1/admin', makeAdminRouter(pool, helpers, deploy, notifiers));
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function getDoctors(base, token) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/api/v1/admin/doctors`, { headers });
  const body = await res.json().catch(() => null);
  return { res, body };
}

// Fake doctor rows as node-postgres would hand them back: COUNT (bigint) and
// numeric come through as strings; float8 as a number; timestamps as Date.
// One row per derived status, across two specialties.
function fakeRows() {
  return [
    {
      id: 'doc-pending', name: 'Dr Pending', name_ar: 'د. منتظر', display_name: 'Dr P',
      email: 'pending@x.com', phone: '+201000000001', specialty_id: 'spec-cardiology', specialty: 'Cardiology',
      is_active: true, is_paused: false, is_available: false, pending_approval: true,
      max_active_cases: 5, max_active_cases_urgent: 8, sla_tiers_supported: '["standard","urgent"]',
      years_of_experience: 12, medical_license_number: 'LIC-PENDING',
      created_at: new Date('2026-06-10T08:00:00.000Z'), approved_at: null, last_seen_at: null,
      welcome_email_last_sent_at: null,
      load: '2', sla_hit: null, rating: null, rating_count: '0',
    },
    {
      id: 'doc-paused', name: 'Dr Paused', name_ar: null, display_name: null,
      email: 'paused@x.com', phone: null, specialty_id: 'spec-cardiology', specialty: 'Cardiology',
      is_active: true, is_paused: true, is_available: false, pending_approval: false,
      max_active_cases: 5, max_active_cases_urgent: 8, sla_tiers_supported: ['standard'],
      years_of_experience: null, medical_license_number: null,
      created_at: new Date('2026-05-01T08:00:00.000Z'), approved_at: new Date('2026-05-02T08:00:00.000Z'), last_seen_at: null,
      load: '0', sla_hit: null, rating: null, rating_count: '0',
    },
    {
      id: 'doc-active', name: 'Dr Active', name_ar: 'د. نشط', display_name: 'Dr A',
      email: 'active@x.com', phone: '+201000000003', specialty_id: 'spec-neurology', specialty: 'Neurology',
      is_active: true, is_paused: false, is_available: true, pending_approval: false,
      max_active_cases: 5, max_active_cases_urgent: 8, sla_tiers_supported: '["standard","priority","urgent"]',
      years_of_experience: 8, medical_license_number: 'LIC-ACTIVE',
      created_at: new Date('2026-04-01T08:00:00.000Z'), approved_at: new Date('2026-04-02T08:00:00.000Z'),
      last_seen_at: new Date('2026-06-21T08:00:00.000Z'),
      welcome_email_last_sent_at: new Date('2026-06-20T09:00:00.000Z'),
      load: '1', sla_hit: 0.75, rating: '4.5', rating_count: '4',
    },
    {
      id: 'doc-inactive', name: 'Dr Inactive', name_ar: null, display_name: null,
      email: 'inactive@x.com', phone: null, specialty_id: 'spec-neurology', specialty: 'Neurology',
      is_active: false, is_paused: false, is_available: false, pending_approval: false,
      max_active_cases: 5, max_active_cases_urgent: 8, sla_tiers_supported: null,
      years_of_experience: null, medical_license_number: null,
      created_at: new Date('2026-03-01T08:00:00.000Z'), approved_at: null, last_seen_at: null,
      load: '5', sla_hit: null, rating: null, rating_count: '0',
    },
  ];
}

// ─────────────────────────── 1. happy path ───────────────────────────

test('GET /doctors: happy path — envelope, mapping, status, summary', async () => {
  const { server, base } = makeApp({ safeAll: async () => fakeRows() });
  try {
    const token = mintToken(SUPERADMIN);
    const { res, body } = await getDoctors(base, token);

    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.ok(body.data && Array.isArray(body.data.doctors), 'data.doctors is an array');
    assert.ok(body.data.summary, 'data.summary present');
    assert.equal(body.data.doctors.length, 4);

    const byId = Object.fromEntries(body.data.doctors.map((d) => [d.id, d]));

    // status derivation, one per branch
    assert.equal(byId['doc-pending'].status, 'pending');
    assert.equal(byId['doc-paused'].status, 'paused');
    assert.equal(byId['doc-active'].status, 'active');
    assert.equal(byId['doc-inactive'].status, 'inactive');

    // camelCase mapping + nullables
    const active = byId['doc-active'];
    assert.equal(active.nameAr, 'د. نشط');
    assert.equal(active.displayName, 'Dr A');
    assert.equal(active.specialtyId, 'spec-neurology');
    assert.equal(active.specialty, 'Neurology');
    assert.equal(active.isAvailable, true);
    assert.equal(active.yearsOfExperience, 8);
    assert.equal(active.medicalLicenseNumber, 'LIC-ACTIVE');
    assert.equal(byId['doc-paused'].nameAr, null);
    assert.equal(byId['doc-paused'].displayName, null);
    assert.equal(byId['doc-paused'].phone, null);

    // load object shape
    assert.deepEqual(active.load, { active: 1, max: 5, maxUrgent: 8 });
    assert.deepEqual(byId['doc-inactive'].load, { active: 5, max: 5, maxUrgent: 8 });

    // slaTiersSupported parsed defensively (JSON string AND native array)
    assert.deepEqual(active.slaTiersSupported, ['standard', 'priority', 'urgent']);
    assert.deepEqual(byId['doc-pending'].slaTiersSupported, ['standard', 'urgent']);
    assert.deepEqual(byId['doc-paused'].slaTiersSupported, ['standard']); // native array
    assert.deepEqual(byId['doc-inactive'].slaTiersSupported, []); // null → []

    // slaHitRate + rating
    assert.equal(active.slaHitRate, 0.75);
    assert.equal(byId['doc-pending'].slaHitRate, null);
    assert.deepEqual(active.rating, { avg: 4.5, count: 4 });
    assert.deepEqual(byId['doc-pending'].rating, { avg: null, count: 0 });

    // timestamps via toIso (Date → ISO string; null → null)
    assert.equal(active.createdAt, '2026-04-01T08:00:00.000Z');
    assert.equal(active.lastSeenAt, '2026-06-21T08:00:00.000Z');
    assert.equal(byId['doc-pending'].approvedAt, null);

    // lastInvitedAt (slice 2b): welcome stamp → ISO; never-invited → null
    assert.equal(active.lastInvitedAt, '2026-06-20T09:00:00.000Z');
    assert.equal(byId['doc-pending'].lastInvitedAt, null);

    // sort: pending first, then ascending active load
    assert.equal(body.data.doctors[0].id, 'doc-pending');
    const tail = body.data.doctors.slice(1).map((d) => d.load.active);
    assert.deepEqual(tail, [...tail].sort((a, b) => a - b), 'non-pending sorted by load asc');
    assert.deepEqual(body.data.doctors.map((d) => d.id), ['doc-pending', 'doc-paused', 'doc-active', 'doc-inactive']);

    // summary
    assert.equal(body.data.summary.total, 4);
    assert.deepEqual(body.data.summary.byStatus, { active: 1, pending: 1, paused: 1, inactive: 1 });
    // bySpecialty: cardiology has pending+paused (0 active), neurology has 1 active
    const bySpec = Object.fromEntries(body.data.summary.bySpecialty.map((s) => [s.specialtyId, s]));
    assert.equal(bySpec['spec-cardiology'].activeCount, 0);
    assert.equal(bySpec['spec-cardiology'].specialty, 'Cardiology');
    assert.equal(bySpec['spec-neurology'].activeCount, 1);
    assert.equal(body.data.summary.bySpecialty.length, 2);
  } finally {
    server.close();
  }
});

// ─────────────────────────── 2. empty roster ───────────────────────────

test('GET /doctors: empty roster → doctors:[], summary zeroed', async () => {
  const { server, base } = makeApp({ safeAll: async () => [] });
  try {
    const { res, body } = await getDoctors(base, mintToken(SUPERADMIN));
    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.deepEqual(body.data.doctors, []);
    assert.equal(body.data.summary.total, 0);
    assert.deepEqual(body.data.summary.byStatus, { active: 0, pending: 0, paused: 0, inactive: 0 });
    assert.deepEqual(body.data.summary.bySpecialty, []);
  } finally {
    server.close();
  }
});

// ─────────────────────────── 3. no token → 401 ───────────────────────────

test('GET /doctors: no token → 401 AUTH_REQUIRED', async () => {
  const { server, base } = makeApp({ safeAll: async () => fakeRows() });
  try {
    const { res, body } = await getDoctors(base, null);
    assert.equal(res.status, 401);
    assert.equal(body.success, false);
    assert.equal(body.code, 'AUTH_REQUIRED');
  } finally {
    server.close();
  }
});

// ─────────────────────────── 4. patient role → 403 ───────────────────────────

test('GET /doctors: patient-role token → 403 FORBIDDEN', async () => {
  const { server, base } = makeApp({ safeAll: async () => fakeRows() });
  try {
    const { res, body } = await getDoctors(base, mintToken(PATIENT));
    assert.equal(res.status, 403);
    assert.equal(body.success, false);
    assert.equal(body.code, 'FORBIDDEN');
  } finally {
    server.close();
  }
});
