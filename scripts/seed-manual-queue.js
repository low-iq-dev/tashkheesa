#!/usr/bin/env node
'use strict';

// Theme 14 Phase 5 — manual-queue test data seeder.
//
// Creates a handful of orders in the assignment_status='manual_queue'
// state (with paired low-confidence specialty_classifications rows) so
// the /superadmin/manual-queue UI can be exercised end-to-end on staging
// or a freshly-deployed prod before any real low-confidence case lands.
//
// All seeded rows carry the sentinel prefix `seed-mq-` on `orders.id`
// and `users.id` so cleanup is a one-shot DELETE by prefix. The schema
// has no `is_demo` column today; the sentinel prefix is the durable
// identifier for the demo set.
//
// Usage:
//   node scripts/seed-manual-queue.js --env=<local|prod> --i-really-mean-it
//   node scripts/seed-manual-queue.js --env=<local|prod> --cleanup
//
// The --i-really-mean-it flag is mandatory for the write path. The
// cleanup path is gated on --env to prevent prod cleanup by typo.
//
// DATABASE_URL / PG_SSL come from env (the npm wrapper sets them locally;
// Render injects them in production). For prod runs, source
// .env.production first.

const crypto = require('node:crypto');
const { pool, queryOne, queryAll, execute } = require('../src/pg');

const PREFIX = 'seed-mq-';
const FIXTURE_CONFIDENCE_MIN = 0.20;
const FIXTURE_CONFIDENCE_MAX = 0.54;  // strictly below the live `minimum` (0.55)

function uid(label) {
  return PREFIX + (label ? label + '-' : '') + crypto.randomBytes(4).toString('hex');
}

// ---- args ----
const args = process.argv.slice(2);
const envFlag = args.find((a) => a.startsWith('--env=')) || '';
const env = envFlag.split('=')[1] || '';
const cleanup = args.includes('--cleanup');
const confirmed = args.includes('--i-really-mean-it');

if (!['local', 'prod'].includes(env)) {
  console.error('Usage: scripts/seed-manual-queue.js --env=<local|prod> [--i-really-mean-it | --cleanup]');
  process.exit(2);
}

if (!cleanup && !confirmed) {
  console.error('Refusing to seed without --i-really-mean-it. Re-run with the guard flag.');
  process.exit(2);
}

// ---- cleanup ----
async function runCleanup() {
  console.log('[' + env + '] Removing all ' + PREFIX + '* rows …');
  const dropped = {
    specialty_classifications: 0,
    specialty_classification_overrides: 0,
    order_events: 0,
    orders: 0,
    users: 0
  };
  dropped.specialty_classifications = (await execute(
    `DELETE FROM specialty_classifications WHERE case_id LIKE $1`,
    [PREFIX + '%']
  )).rowCount;
  dropped.specialty_classification_overrides = (await execute(
    `DELETE FROM specialty_classification_overrides WHERE case_id LIKE $1`,
    [PREFIX + '%']
  )).rowCount;
  dropped.order_events = (await execute(
    `DELETE FROM order_events WHERE order_id LIKE $1`,
    [PREFIX + '%']
  )).rowCount;
  dropped.orders = (await execute(
    `DELETE FROM orders WHERE id LIKE $1`,
    [PREFIX + '%']
  )).rowCount;
  dropped.users = (await execute(
    `DELETE FROM users WHERE id LIKE $1`,
    [PREFIX + '%']
  )).rowCount;
  console.log('[' + env + '] Deleted:', dropped);
}

// ---- fixture catalog ----
//
// Three representative low-confidence scenarios. Specialty + service IDs
// are resolved at runtime against the live catalog (visible rows only);
// scenarios degrade gracefully when a chosen specialty isn't seeded in
// the target DB (skipped with a warning, no crash).
const SCENARIOS = [
  {
    label: 'vague-chest-pain',
    patientName: 'Demo Patient · Vague chest pain',
    clinicalQuestion:
      'Intermittent chest tightness for 3 weeks, no clear trigger. Mentions occasional dizziness and shortness of breath after light walking. Has not seen a cardiologist before.',
    medicalHistory: 'No prior cardiac history. Family history positive for hypertension.',
    preferredSpecialty: 'spec-cardiology'
  },
  {
    label: 'ambiguous-skin',
    patientName: 'Demo Patient · Ambiguous skin lesion',
    clinicalQuestion:
      'A small raised lesion on the forearm that has not changed in 6 months but is recently itchy. Patient unsure whether to see a dermatologist or general practitioner.',
    medicalHistory: 'No prior skin conditions reported.',
    preferredSpecialty: 'spec-dermatology'
  },
  {
    label: 'unclear-lab',
    patientName: 'Demo Patient · Unclear lab abnormalities',
    clinicalQuestion:
      'Recent routine blood panel returned mildly elevated liver enzymes and a borderline ANA. Asking what to do next — is this autoimmune, hepatic, or both?',
    medicalHistory: 'No prior chronic illness; on no medications.',
    preferredSpecialty: 'lab_pathology'
  }
];

async function ensurePatient(scenario) {
  const id = uid('pat-' + scenario.label);
  const email = id + '@seed.local';
  await execute(
    `INSERT INTO users (id, email, name, role, password_hash, created_at, is_active)
     VALUES ($1, $2, $3, 'patient', 'x', NOW(), true)`,
    [id, email, scenario.patientName]
  );
  return await queryOne(`SELECT id, name, email FROM users WHERE id = $1`, [id]);
}

async function pickServiceForSpecialty(specialtyId) {
  const row = await queryOne(
    `SELECT id, base_price, currency FROM services
      WHERE specialty_id = $1 AND COALESCE(is_visible, true) = true
      ORDER BY id ASC LIMIT 1`,
    [specialtyId]
  );
  return row || null;
}

async function createManualQueueOrder({ patient, scenario }) {
  // Resolve specialty + service from the live visible catalog.
  const specialty = await queryOne(
    `SELECT id FROM specialties WHERE id = $1 AND COALESCE(is_visible, true) = true`,
    [scenario.preferredSpecialty]
  );
  if (!specialty) {
    console.warn('[seed] skipping ' + scenario.label + ' — specialty ' + scenario.preferredSpecialty + ' not visible');
    return null;
  }
  const service = await pickServiceForSpecialty(specialty.id);
  if (!service) {
    console.warn('[seed] skipping ' + scenario.label + ' — no visible service under ' + specialty.id);
    return null;
  }

  const orderId = uid('order-' + scenario.label);
  const referenceId = ('MQ-' + scenario.label.split('-').map((s) => s[0]).join('').toUpperCase()
                       + '-' + crypto.randomBytes(2).toString('hex')).toUpperCase();

  const price = Number(service.base_price) || 1500;
  await execute(
    `INSERT INTO orders
       (id, patient_id, specialty_id, service_id,
        base_price, price, status, payment_status,
        assignment_status, urgency_tier, sla_hours,
        clinical_question, medical_history,
        reference_id, draft_step, created_at, updated_at)
     VALUES
       ($1, $2, $3, $4, $5, $5, 'new', 'paid',
        'manual_queue', 'standard', 48,
        $6, $7, $8, 3, NOW(), NOW())`,
    [orderId, patient.id, specialty.id, service.id, price,
     scenario.clinicalQuestion, scenario.medicalHistory, referenceId]
  );

  // Paired classification row at sub-minimum confidence — exactly the
  // signal that puts a real production case in the manual queue.
  const confidence = (
    FIXTURE_CONFIDENCE_MIN +
    Math.random() * (FIXTURE_CONFIDENCE_MAX - FIXTURE_CONFIDENCE_MIN)
  ).toFixed(2);
  await execute(
    `INSERT INTO specialty_classifications
       (id, case_id, specialty_id, service_id, confidence, reasoning, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [uid('cls-' + scenario.label), orderId, specialty.id, service.id, Number(confidence),
     'Seeded fixture: AI classifier confidence intentionally below the live minimum threshold to populate the manual-queue UI for testing.']
  );

  return { id: orderId, reference: referenceId, confidence };
}

// ---- main ----
async function main() {
  if (cleanup) {
    await runCleanup();
    return;
  }

  console.log('[' + env + '] Seeding ' + SCENARIOS.length + ' manual-queue fixtures …');
  const created = [];
  for (const scenario of SCENARIOS) {
    const patient = await ensurePatient(scenario);
    const order = await createManualQueueOrder({ patient, scenario });
    if (order) {
      console.log('  + ' + scenario.label + ' → ' + order.reference + ' (confidence ' + order.confidence + ')');
      created.push(order);
    }
  }
  console.log('[' + env + '] Seeded ' + created.length + ' fixtures with prefix ' + PREFIX);
  console.log('[' + env + '] Cleanup: scripts/seed-manual-queue.js --env=' + env + ' --cleanup');
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('[seed-manual-queue] FAILED:', err && err.message);
    console.error(err && err.stack);
    pool.end().finally(() => process.exit(1));
  });
