// tests/core/classifier-learning.test.js
//
// LEARNING LOOP 2026-08-25 — contract guard.
//
// The load-bearing decision in this feature is not the SQL, it is the WEIGHTING
// RULE: a patient override is a noisy label, because the patients most likely
// to override a specialty suggestion are the ones least sure which specialty
// they need. Weight those equally with a clinician's reassignment and the
// learner teaches the model the confusion instead of the correction — quietly,
// confidently, and at volume.
//
// So the weighting is asserted directly, by calling it, rather than grepped.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

function expect(cond, msg) { if (!cond) throw new Error(msg); }

console.log('\n🧠 Classifier learning loop\n');

const ROOT = path.join(__dirname, '..', '..');
const learning = require(path.join(ROOT, 'src', 'services', 'classifier_learning.js'));
const LEARN = fs.readFileSync(path.join(ROOT, 'src', 'services', 'classifier_learning.js'), 'utf8');
const CLASSIFIER = fs.readFileSync(path.join(ROOT, 'src', 'services', 'specialty_classifier.js'), 'utf8');
const JOB = fs.readFileSync(path.join(ROOT, 'src', 'services', 'classify_job.js'), 'utf8');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'src', 'migrations', '095_classifier_learning.sql'), 'utf8');

// ── 1. The weighting rule ───────────────────────────────────────────────────
try {
  const w = learning._weightFor;

  // A clinician looking at the case. Full weight, confirmed or not — their
  // judgement does not need the pipeline to ratify it.
  expect(w('doctor', false) === 1.0, 'a doctor reassignment must carry full weight');
  expect(w('admin', false) === 1.0, 'an operator reassignment must carry full weight');
  expect(w('superadmin', false) === 1.0, 'a superadmin reassignment must carry full weight');

  // A patient's choice is a HYPOTHESIS. It counts only once the case completed
  // on that specialty and nobody reassigned it.
  expect(w('patient', true) > 0, 'a confirmed patient override must count for something');
  expect(w('patient', true) < w('doctor', true),
    'a confirmed patient override must count for LESS than a clinician reassignment');
  expect(w('patient', false) === 0,
    'an UNCONFIRMED patient override must count for nothing — it is more likely the ' +
    'confusion the suggestion existed to resolve than a correction of it');

  // An unknown or missing role is treated as the patient case, which is the
  // conservative direction: it under-counts a real signal rather than
  // inventing one.
  expect(w(null, false) === 0, 'a missing actor_role must default to the low-trust path');
  expect(w('', true) === w('patient', true), 'an empty actor_role must behave as patient');
  t.pass('weighting: clinician 1.0; patient 0.5 only when confirmed; unconfirmed and unknown 0');
} catch (e) { t.fail('weighting rule', e); }

// ── 2. Confirmation means the routing actually held ─────────────────────────
try {
  expect(/LOWER\(COALESCE\(ord\.status, ''\)\) IN \('completed', 'delivered', 'closed'\)/.test(LEARN),
    'confirmation must require the case to have COMPLETED');
  expect(/ord\.specialty_id IS NOT DISTINCT FROM o\.patient_specialty_id/.test(LEARN),
    'confirmation must require the case to have completed on the specialty the human chose');
  expect(/NOT EXISTS \(\s*SELECT 1 FROM specialty_classification_overrides later/.test(LEARN),
    'confirmation must require that nobody overrode the case AGAIN afterwards — a ' +
    'later reassignment means the first correction was wrong');
  t.pass('confirmation = completed + on that specialty + never reassigned again');
} catch (e) { t.fail('confirmation test', e); }

// ── 3. Nothing steers the model without a human ─────────────────────────────
try {
  expect(/status = qualifies \? 'candidate' : 'below_threshold'/.test(LEARN),
    "the job must only ever produce 'candidate' — never 'accepted'");
  expect(!/status[^\n]{0,40}=[^\n]{0,20}'accepted'/.test(
    LEARN.slice(LEARN.indexOf('async function aggregateCorrections'),
                LEARN.indexOf('// ─── Read path'))),
    'the aggregation must never write accepted status itself');
  expect(/WHERE c\.status = 'accepted'/.test(LEARN),
    'only accepted rows may be read into the prompt');
  expect(/WHEN classifier_corrections\.status IN \('accepted', 'rejected'\)\s*\n?\s*THEN classifier_corrections\.status/.test(LEARN),
    "a human decision must survive the next run — otherwise 'rejected' means 'not yet' " +
    'and the same pair returns as a fresh candidate forever');
  t.pass('candidates only; human decisions are preserved across runs');
} catch (e) { t.fail('human gate', e); }

// ── 4. Corrections go in the USER message, never the system prompt ──────────
//
// The system prompt carries the routing-not-diagnosing guardrails and has a
// snapshot test pinning them. Appending operator-reviewed text to it would let
// a correction quietly weaken a clinical safety rail.
try {
  const sysIdx = CLASSIFIER.indexOf('const SYSTEM_PROMPT');
  const sysEnd = CLASSIFIER.indexOf('function _buildUserPrompt');
  const systemBlock = CLASSIFIER.slice(sysIdx, sysEnd);
  expect(!/correctionsBlock/.test(systemBlock),
    'SYSTEM_PROMPT must not carry corrections — it holds the clinical guardrails and ' +
    'a snapshot test pins them');
  expect(/_buildUserPrompt\(caseText, fileMetadata, specialtiesWithServices, correctionsBlock\)/.test(CLASSIFIER),
    'the user prompt builder must accept the corrections block');
  expect(/correctionsBlock \|\| ''/.test(CLASSIFIER),
    'an absent corrections block must render as empty, not as "undefined"');
  t.pass('corrections reach the model through the user message only');
} catch (e) { t.fail('prompt injection site', e); }

// ── 5. The learner may never break classification ───────────────────────────
try {
  const idx = JOB.indexOf('let correctionsBlock');
  expect(idx !== -1, 'classify_job must build a corrections block');
  const block = JOB.slice(idx, idx + 600);
  expect(/try \{[\s\S]*catch/.test(block),
    'reading corrections must be wrapped — a learner that cannot be read must not stop a ' +
    "patient's case being classified");
  expect(/correctionsBlock = ''/.test(JOB),
    'the fallback must be an empty block, i.e. exactly the behaviour before the learner existed');
  t.pass('a failed corrections read degrades to the pre-learner classifier');
} catch (e) { t.fail('failure posture', e); }

// ── 6. Rendered as observation, not as a rule ───────────────────────────────
try {
  expect(/These are observations,/.test(LEARN),
    'the prompt block must frame corrections as observations');
  expect(/belongs in the first specialty, route it there anyway/.test(LEARN),
    'the prompt block must explicitly tell the model it may still route to the original ' +
    'specialty — history must not override the case in front of it');
  expect(/r\.from_specialty_name && r\.to_specialty_name/.test(LEARN),
    'a correction naming a deleted specialty must be dropped rather than put a dangling ' +
    'instruction in front of the model');
  t.pass('corrections are framed as history the model may override, and stale ones are dropped');
} catch (e) { t.fail('prompt framing', e); }

// ── 7. Migration ────────────────────────────────────────────────────────────
try {
  expect(/ADD COLUMN IF NOT EXISTS actor_role TEXT/.test(MIGRATION),
    'migration must add actor_role — without it the aggregation cannot tell a patient ' +
    'override from a clinician reassignment');
  expect(/SET actor_role = 'patient'\s*\n\s*WHERE actor_role IS NULL/.test(MIGRATION),
    'historical rows must backfill to the LOW-trust role, so a mislabelled row under-counts ' +
    'a real signal rather than inventing one');
  expect(/CREATE UNIQUE INDEX IF NOT EXISTS idx_classifier_corrections_pair/.test(MIGRATION),
    'the pair index must be UNIQUE — the upsert depends on it, and without it re-running ' +
    'the job duplicates every correction');
  expect(/COALESCE\(from_service_id, ''\)/.test(MIGRATION),
    'the unique index must COALESCE nullable service ids, or NULLs compare unequal and ' +
    'specialty-level corrections duplicate on every run');
  t.pass('migration 095: actor_role + conservative backfill + a unique index the upsert can rely on');
} catch (e) { t.fail('migration 095', e); }

// ── 8. All four override writers record who they are ────────────────────────
try {
  const writers = [
    ['src/routes/patient.js', "'patient'"],
    ['src/routes/api/cases_draft.js', "'patient'"],
    ['src/routes/api/admin.js', "'admin'"],
    ['src/routes/superadmin.js', "'superadmin'"],
  ];
  for (const [rel, role] of writers) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const i = src.indexOf('INSERT INTO specialty_classification_overrides');
    expect(i !== -1, rel + ' must still write an override row');
    const stmt = src.slice(i, i + 700);
    expect(/actor_role/.test(stmt), rel + ' must record actor_role on the override');
    expect(stmt.includes(role), rel + ' must record actor_role as ' + role);
  }
  t.pass('all four override writers stamp actor_role (patient / patient / admin / superadmin)');
} catch (e) { t.fail('actor_role writers', e); }
