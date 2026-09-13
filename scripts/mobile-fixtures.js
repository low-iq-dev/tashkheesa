#!/usr/bin/env node
'use strict';

/**
 * Local-only fixtures for the phone layout guard (scripts/mobile-shots.js).
 *
 * Why this exists (2026-09-13): the doctor portal could not be screenshotted
 * on a phone with any case on screen — the audit account had no cases, so the
 * case detail and report editor (the screen that matters most) had never been
 * looked at. This seeds ONE doctor, ONE patient and a handful of orders that
 * put every doctor screen into a non-empty state.
 *
 * Safety:
 *   - Refuses any DATABASE_URL whose host is not localhost / 127.0.0.1 / ::1.
 *     There is no flag to override that. Production is never a target.
 *   - Every row it writes carries the `mobilefx-` id prefix and is deleted and
 *     rewritten on each run, so it is idempotent and touches nothing else.
 *   - Emails are @example.com and phones are in the unallocated +20 100 000 00xx
 *     block, so even a misconfigured notification worker has nowhere real to send.
 *
 * Usage:
 *   MOBILE_DATABASE_URL=postgresql://localhost:5432/tashkheesa_mobile \
 *     node scripts/mobile-fixtures.js [--migrate]
 *
 * --migrate runs src/db.migrate() first. Two migrations are data-only fixes
 * that assert rows which exist only in production (059: four price rows; 067:
 * eight named doctors). On an empty database their post-conditions cannot hold,
 * so ONLY those two are recorded as applied when they fail that way. Any other
 * migration failure is fatal.
 */

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const PREFIX = 'mobilefx-';
const PROD_DATA_ONLY_MIGRATIONS = {
  '059': /Migration 059 post-condition failed/,
  '067': /Migration 067 post-condition failed/
};

function resolveDbUrl() {
  let url = process.env.MOBILE_DATABASE_URL;
  if (!url) {
    // Default: the local DATABASE_URL's credentials, pointed at a separate
    // tashkheesa_mobile database. Never the suite's own database — booting the
    // server migrates whatever it is pointed at.
    try {
      const u = new URL(process.env.DATABASE_URL || 'postgresql://localhost:5432/tashkheesa');
      u.pathname = '/tashkheesa_mobile';
      url = u.toString();
    } catch (_) {
      url = 'postgresql://localhost:5432/tashkheesa_mobile';
    }
  }
  let host;
  try { host = new URL(url).hostname; } catch (_) { host = ''; }
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new Error('mobile-fixtures refuses a non-local database (host "' + host + '"). ' +
      'Point MOBILE_DATABASE_URL at a local scratch database.');
  }
  return url;
}

const IDS = {
  doctor: PREFIX + 'doctor',
  patient: PREFIX + 'patient',
  orderNew: PREFIX + 'order-new',
  orderUrgent: PREFIX + 'order-urgent',
  orderReview: PREFIX + 'order-review',
  orderDue: PREFIX + 'order-due',
  orderDone: PREFIX + 'order-done',
  conversation: PREFIX + 'conv-review',
  // Part C (refunds). A second doctor owns these so the doctor-portal
  // screenshots above stay byte-comparable, and an operator reviews them.
  doctor2: PREFIX + 'doctor2',
  ops: PREFIX + 'ops',
  rfPre: PREFIX + 'rf-pre',          // paid, no consultant yet → full refund
  rfStd: PREFIX + 'rf-std',          // Standard, consultant working → review, no surcharge
  rfBreach: PREFIX + 'rf-breach',    // VIP, deadline missed, surcharge refunded automatically
  rfPartial: PREFIX + 'rf-partial',  // VIP, 600 already paid back → remainder
  rfPending: PREFIX + 'rf-pending',  // patient request waiting for review
  rfApproved: PREFIX + 'rf-approved',// approved, not paid yet
  rfDenied: PREFIX + 'rf-denied'     // denied with a reason
};

function hoursFromNow(h) { return new Date(Date.now() + h * 3600 * 1000); }

async function columnsOf(client, table) {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  return new Set(r.rows.map((x) => x.column_name));
}

// Insert only the columns this schema actually has, so the fixture keeps
// working as migrations add or drop columns.
async function insertRow(client, table, row) {
  const have = await columnsOf(client, table);
  const cols = Object.keys(row).filter((c) => have.has(c));
  const vals = cols.map((c) => row[c]);
  const ph = cols.map((_, i) => '$' + (i + 1)).join(', ');
  await client.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph})`, vals);
}

async function cleanup(client) {
  // Every table with a column that can point at a fixture row. Several passes
  // because foreign keys make the order matter and it is not worth hard-coding.
  const r = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema='public'
        AND column_name IN ('order_id','doctor_id','patient_id','user_id','to_user_id',
                            'sender_id','conversation_id','requested_by','actor_user_id')
        AND table_name NOT IN ('orders','users')
        AND table_name IN (SELECT table_name FROM information_schema.tables
                            WHERE table_schema='public' AND table_type='BASE TABLE')`
  );
  for (let pass = 0; pass < 3; pass++) {
    for (const { table_name, column_name } of r.rows) {
      await client.query('SAVEPOINT fx');
      try {
        await client.query(`DELETE FROM ${table_name} WHERE ${column_name} LIKE $1`, [PREFIX + '%']);
        await client.query('RELEASE SAVEPOINT fx');
      } catch (_) {
        await client.query('ROLLBACK TO SAVEPOINT fx');
      }
    }
  }
  await client.query('DELETE FROM orders WHERE id LIKE $1', [PREFIX + '%']);
  await client.query('DELETE FROM users WHERE id LIKE $1', [PREFIX + '%']);
}

async function seed(client) {
  const spec = await client.query(
    `SELECT s.id AS specialty_id, sv.id AS service_id
       FROM services sv JOIN specialties s ON s.id = sv.specialty_id
      ORDER BY (s.id = 'spec-cardiothoracic') DESC, sv.id LIMIT 1`
  );
  if (!spec.rows.length) throw new Error('No services/specialties rows — run with --migrate first.');
  const { specialty_id: specialtyId, service_id: serviceId } = spec.rows[0];

  await insertRow(client, 'users', {
    id: IDS.doctor, email: 'mobilefx-doctor@example.com', password_hash: null,
    name: 'Ahmed Mobile Fixture', name_ar: 'أحمد تجربة', role: 'doctor',
    specialty_id: specialtyId, phone: '+201000000001', country_code: 'EG', country: 'EG',
    lang: 'en', is_active: true, pending_approval: false, is_paused: false,
    approved_at: new Date(), onboarding_complete: true,
    sla_tiers_supported: JSON.stringify(['standard', 'vip', 'urgent']),
    // Deliberately NULL: the "confirm your delivery speeds" banner is one of the
    // things the phone audit found repeated on every page.
    sla_tiers_confirmed_at: null,
    created_at: new Date()
  });
  await insertRow(client, 'doctor_specialties', {
    id: PREFIX + 'ds', doctor_id: IDS.doctor, specialty_id: specialtyId, created_at: new Date()
  });
  await insertRow(client, 'users', {
    id: IDS.patient, email: 'mobilefx-patient@example.com', name: 'Mona Fixture', role: 'patient',
    phone: '+201000000002', country_code: 'EG', country: 'EG', lang: 'en', is_active: true,
    gender: 'F', date_of_birth: '1968-03-14', created_at: new Date()
  });

  const base = {
    patient_id: IDS.patient, specialty_id: specialtyId, service_id: serviceId,
    language: 'en', payment_status: 'paid', payment_method: 'instapay', paid_at: hoursFromNow(-30),
    country: 'EG', currency: 'EGP', locked_currency: 'EGP',
    clinical_question: 'Is surgery needed now, or can this be managed medically for six months?',
    medical_history: 'Hypertension, type 2 diabetes. Former smoker.',
    created_at: hoursFromNow(-30)
  };
  const orders = [
    // Waiting for acceptance, VIP, 90-minute acceptance countdown.
    Object.assign({}, base, {
      id: IDS.orderNew, reference_id: 'TSH-FX0001', doctor_id: IDS.doctor, status: 'assigned',
      tier: 'vip', urgency_tier: 'vip', sla_hours: 18, price: 2400, base_price: 1600,
      urgency_uplift_amount: 800, locked_price: 2400, doctor_fee: 1920,
      acceptance_deadline_at: hoursFromNow(1.5), updated_at: hoursFromNow(-0.5)
    }),
    // Waiting for acceptance, Urgent.
    Object.assign({}, base, {
      id: IDS.orderUrgent, reference_id: 'TSH-FX0002', doctor_id: IDS.doctor, status: 'assigned',
      tier: 'urgent', urgency_tier: 'urgent', sla_hours: 4, price: 3200, base_price: 1600,
      urgency_uplift_amount: 1600, locked_price: 3200, doctor_fee: 2560,
      acceptance_deadline_at: hoursFromNow(0.6), updated_at: hoursFromNow(-0.2)
    }),
    // Accepted, in review, draft report, due in 15h.
    Object.assign({}, base, {
      id: IDS.orderReview, reference_id: 'TSH-FX0003', doctor_id: IDS.doctor, status: 'in_review',
      tier: 'vip', urgency_tier: 'vip', sla_hours: 18, price: 2400, base_price: 1600,
      urgency_uplift_amount: 800, locked_price: 2400, doctor_fee: 1920,
      accepted_at: hoursFromNow(-3), deadline_at: hoursFromNow(15), sla_deadline: hoursFromNow(15),
      diagnosis_text: 'CT chest: 2.1 cm spiculated nodule, right upper lobe. No mediastinal lymphadenopathy.',
      impression_text: null, recommendation_text: null, updated_at: hoursFromNow(-1)
    }),
    // Accepted, Standard, due in 6h (inside the next-24h bucket).
    Object.assign({}, base, {
      id: IDS.orderDue, reference_id: 'TSH-FX0004', doctor_id: IDS.doctor, status: 'in_review',
      tier: 'standard', urgency_tier: 'standard', sla_hours: 48, price: 1600, base_price: 1600,
      urgency_uplift_amount: 0, locked_price: 1600, doctor_fee: 1280,
      accepted_at: hoursFromNow(-42), deadline_at: hoursFromNow(6), sla_deadline: hoursFromNow(6),
      updated_at: hoursFromNow(-2)
    }),
    // Completed.
    Object.assign({}, base, {
      id: IDS.orderDone, reference_id: 'TSH-FX0005', doctor_id: IDS.doctor, status: 'completed',
      tier: 'standard', urgency_tier: 'standard', sla_hours: 48, price: 1600, base_price: 1600,
      urgency_uplift_amount: 0, locked_price: 1600, doctor_fee: 1280,
      accepted_at: hoursFromNow(-100), deadline_at: hoursFromNow(-60), completed_at: hoursFromNow(-70),
      diagnosis_text: 'Normal study.', impression_text: 'No acute findings.',
      recommendation_text: 'Routine follow-up in 12 months.', updated_at: hoursFromNow(-70)
    })
  ];
  for (const o of orders) await insertRow(client, 'orders', o);

  const files = [
    { id: PREFIX + 'file-1', filename: 'chest-ct-axial.png', mime_type: 'image/png', url: '/assets/brand/tashkheesa-icon.svg', label: 'CT chest — axial' },
    { id: PREFIX + 'file-2', filename: 'radiology-report.pdf', mime_type: 'application/pdf', url: '/assets/brand/tashkheesa-icon.svg', label: 'Radiology report' },
    { id: PREFIX + 'file-3', filename: 'labs-2026-09.pdf', mime_type: 'application/pdf', url: '/assets/brand/tashkheesa-icon.svg', label: 'Labs' }
  ];
  for (const f of files) {
    await insertRow(client, 'order_files', Object.assign({ order_id: IDS.orderReview, size: 120000, created_at: hoursFromNow(-29) }, f));
  }

  await insertRow(client, 'conversations', {
    id: IDS.conversation, order_id: IDS.orderReview, patient_id: IDS.patient, doctor_id: IDS.doctor,
    status: 'active', created_at: hoursFromNow(-3), updated_at: hoursFromNow(-1)
  });
  const msgs = [
    { n: 1, sender: IDS.doctor, role: 'doctor', content: 'Thank you — I have started reviewing your scans.', read: true, h: -2.5 },
    { n: 2, sender: IDS.patient, role: 'patient', content: 'Thank you doctor. I uploaded the older CT from 2024 as well, it should be in the files.', read: false, h: -1.2 },
    { n: 3, sender: IDS.patient, role: 'patient', content: 'شكراً دكتور، هل تحتاج أي تحاليل إضافية؟', read: false, h: -1 }
  ];
  for (const m of msgs) {
    await insertRow(client, 'messages', {
      id: PREFIX + 'msg-' + m.n, conversation_id: IDS.conversation, sender_id: m.sender,
      sender_role: m.role, content: m.content, message_type: 'text', is_read: m.read,
      created_at: hoursFromNow(m.h)
    });
  }

  await seedRefunds(client, base);
}

// Part C (2026-09-13) — one order per refund state the patient form, the case
// timeline and the operator queue have to explain.
async function seedRefunds(client, base) {
  // refunds.refunded_at is TIMESTAMP (no zone) and the server session is UTC;
  // write these rows in UTC too or the timeline's times come out shifted.
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  await insertRow(client, 'users', {
    id: IDS.doctor2, email: 'mobilefx-doctor2@example.com', name: 'Sara Second Fixture', role: 'doctor',
    specialty_id: base.specialty_id, phone: '+201000000003', country_code: 'EG', country: 'EG',
    lang: 'en', is_active: true, pending_approval: false, approved_at: new Date(), onboarding_complete: true,
    sla_tiers_confirmed_at: new Date(), created_at: new Date()
  });
  await insertRow(client, 'users', {
    id: IDS.ops, email: 'mobilefx-ops@example.com', name: 'Omar Ops Fixture', role: 'superadmin',
    phone: '+201000000004', country_code: 'EG', lang: 'en', is_active: true, created_at: new Date()
  });

  const vip = { tier: 'vip', urgency_tier: 'vip', sla_hours: 18, price: 2400, base_price: 1600, urgency_uplift_amount: 800, locked_price: 2400 };
  const std = { tier: 'standard', urgency_tier: 'standard', sla_hours: 48, price: 1600, base_price: 1600, urgency_uplift_amount: 0, locked_price: 1600 };
  const working = { doctor_id: IDS.doctor2, status: 'in_review', accepted_at: hoursFromNow(-20), deadline_at: hoursFromNow(20), sla_deadline: hoursFromNow(20) };
  const rows = [
    [IDS.rfPre, 'TSH-FX0101', vip, { doctor_id: null, status: 'paid' }],
    [IDS.rfStd, 'TSH-FX0102', std, working],
    [IDS.rfBreach, 'TSH-FX0103', vip, { doctor_id: IDS.doctor2, status: 'breached', accepted_at: hoursFromNow(-30), deadline_at: hoursFromNow(-12), sla_deadline: hoursFromNow(-12), breached_at: hoursFromNow(-12) }],
    [IDS.rfPartial, 'TSH-FX0104', vip, working],
    [IDS.rfPending, 'TSH-FX0105', std, working],
    [IDS.rfApproved, 'TSH-FX0106', vip, working],
    [IDS.rfDenied, 'TSH-FX0107', std, working]
  ];
  for (const [id, ref, tier, state] of rows) {
    await insertRow(client, 'orders', Object.assign({}, base, tier, state, { id, reference_id: ref, updated_at: hoursFromNow(-1) }));
  }

  const refund = (o) => Object.assign({
    refunded_by: IDS.patient, requested_by: IDS.patient, instapay_handle: '+201000000002'
  }, o);
  const refunds = [
    // The system refunded the VIP surcharge when the deadline passed, and it was paid.
    refund({ id: PREFIX + 'rf-1', order_id: IDS.rfBreach, reason: 'sla_breach', status: 'paid', amount_egp: 800,
      requested_amount: 800, approved_amount: 800, refunded_by: 'system', requested_by: 'system', instapay_handle: null,
      instapay_reference: 'IPX-800123', refunded_at: hoursFromNow(-12), paid_at: hoursFromNow(-6),
      paid_to_number: '+201000000002', paid_by: IDS.ops,
      notes: 'Auto-refund: SLA deadline passed without case completion (tier vip). Awaiting InstaPay payout.' }),
    // An operator already paid back 600 of 2400.
    refund({ id: PREFIX + 'rf-2', order_id: IDS.rfPartial, reason: 'operator_refund', status: 'paid', amount_egp: 600,
      requested_amount: 600, approved_amount: 600, refunded_by: IDS.ops, requested_by: IDS.ops,
      instapay_reference: 'IPX-445566', refunded_at: hoursFromNow(-50), reviewed_at: hoursFromNow(-49), reviewed_by: IDS.ops,
      paid_at: hoursFromNow(-48), paid_to_number: '+201000000002', paid_by: IDS.ops,
      notes: 'Operator-initiated refund — see audit log — goodwill for a delayed file request' }),
    refund({ id: PREFIX + 'rf-3', order_id: IDS.rfPending, reason: 'patient_request', status: 'pending', amount_egp: 1600,
      requested_amount: 1600, patient_reason: 'I found a consultant locally who can see me this week, so I no longer need the written opinion.',
      refunded_at: hoursFromNow(-0.4) }),
    refund({ id: PREFIX + 'rf-4', order_id: IDS.rfApproved, reason: 'patient_request', status: 'approved', amount_egp: 2400,
      requested_amount: 2400, approved_amount: 1200, reviewed_by: IDS.ops, reviewed_at: hoursFromNow(-3),
      patient_reason: 'The files I uploaded were for the wrong family member.', refunded_at: hoursFromNow(-26) }),
    refund({ id: PREFIX + 'rf-5', order_id: IDS.rfDenied, reason: 'patient_request', status: 'denied', amount_egp: 1600,
      requested_amount: 1600, patient_reason: 'Changed my mind.', reviewed_by: IDS.ops, reviewed_at: hoursFromNow(-5),
      denial_reason: 'Your consultant has already reviewed your scans and is writing the report, so this case is past the point of a full refund.',
      refunded_at: hoursFromNow(-30) })
  ];
  for (const r of refunds) await insertRow(client, 'refunds', r);
}

async function migrateWithProdDataTolerance(dbUrl) {
  // src/pg reads DATABASE_URL at require time.
  process.env.DATABASE_URL = dbUrl;
  process.env.PG_SSL = 'false';
  const db = require(path.join(__dirname, '..', 'src', 'db'));
  const { pool } = require(path.join(__dirname, '..', 'src', 'pg'));
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await db.migrate();
      return;
    } catch (err) {
      const msg = String(err && err.message || err);
      const hit = Object.keys(PROD_DATA_ONLY_MIGRATIONS).find((k) => PROD_DATA_ONLY_MIGRATIONS[k].test(msg));
      if (!hit) throw err;
      const file = require('fs').readdirSync(path.join(__dirname, '..', 'src', 'migrations'))
        .find((f) => f.startsWith(hit + '_'));
      console.log('[mobile-fixtures] ' + file + ' asserts production-only rows; recording it as applied on this scratch DB');
      await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
    }
  }
  throw new Error('migrate did not converge');
}

async function run({ migrate } = {}) {
  const dbUrl = resolveDbUrl();
  if (migrate) await migrateWithProdDataTolerance(dbUrl);
  const { Client } = require('pg');
  const client = new Client({ connectionString: dbUrl, ssl: false });
  await client.connect();
  try {
    await client.query('BEGIN');
    await cleanup(client);
    await seed(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
  return IDS;
}

module.exports = { run, IDS, PREFIX, resolveDbUrl };

if (require.main === module) {
  run({ migrate: process.argv.includes('--migrate') })
    .then((ids) => { console.log('[mobile-fixtures] seeded', Object.values(ids).join(', ')); process.exit(0); })
    .catch((err) => { console.error('[mobile-fixtures] FAILED:', err.message); process.exit(1); });
}
