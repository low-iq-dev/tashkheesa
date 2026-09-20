// tests/core/doctor-pre-accept-exposure.test.js
//
// A4 (FIX PLAN 2026-09-15) — pre-acceptance data exposure.
//
// What was wrong at f629142: a doctor could open the pre-accept brief of ANY
// case merely by holding its id. The case-detail handler sorted a case into
// accepted-by-me / unaccepted / assigned-to-someone-else and treated "the
// status is in UNACCEPTED_STATUSES" as authorisation on its own — no payment
// check, no specialty check, no account check. And the payload it then built
// still carried the patient's referring question, medical history and current
// medications (routes/doctor.js clinicalContext), the uploaded FILENAMES (which
// routinely carry the patient's name — the view's own comment says so), and the
// AI image-check output. The intelligence view, and three JSON/page surfaces
// beside it, authorised on `orders.doctor_id === me`, which case_lifecycle
// .assignDoctor sets at ASSIGNMENT time — i.e. before the doctor has accepted —
// so an assigned-but-unaccepted doctor read the patient's name, the AI
// extractions and the shared medical-record history.
//
// What this file pins:
//   (1) ONE entitlement rule (services/doctor_case_access.doctorCaseAccess)
//       over paid × assignment × specialty × account state, reusing the
//       launch-gates account rule (doctor_eligibility.doctorNewCaseBlockReason)
//       rather than defining a second one;
//   (2) its specialty predicate agrees with routes/doctor.js's existing
//       specialtyMatchSql — a blank specialty is FALSE on both sides, never a
//       wildcard;
//   (3) the REAL case-detail handler (plucked off router.stack, fake pg): an
//       entitled doctor sees the offer with every withheld field ABSENT FROM
//       THE PAYLOAD; unentitled / unpaid / wrong-specialty / account-blocked
//       are refused with the EXISTING fail-closed refusal; an accepted doctor
//       still sees everything;
//   (4) the REAL intelligence handler under the same conditions;
//   (5) the other pre-accept surfaces — the /api/cases/:id/intelligence JSON,
//       the patient-records JSON and the prescribe page — refuse a case this
//       doctor has not accepted;
//   (6) the pre-accept LIST payloads (queue "new" bucket / unassigned pool)
//       carry no clinical columns at all.
//
// Hermetic: no DATABASE_URL, nothing written anywhere. Withheld content is
// asserted ABSENT from the render payload by deep string scan, not by reading
// the template — a template gate is one careless edit away from a leak.

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n🙈 A4 — a doctor sees a pre-accept brief only when entitled, and never the patient\n');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function code(rel) { return stripComments(read(rel)); }
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

function check(name, fn) {
  try { const why = fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}
async function checkAsync(name, fn) {
  try { const why = await fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}
function fakeModule(p, exports) { require.cache[p] = { id: p, filename: p, loaded: true, exports }; }

// ── The sentinels ──────────────────────────────────────────────────────────
// Every one of these is something the patient owns. None may appear anywhere
// in a pre-accept payload; all must still appear post-accept.
const SECRET = Object.freeze({
  name: 'Mariam-ZZNAME-Hassan',
  email: 'mariam.ZZEMAIL@example.com',
  question: 'ZZQUESTION-chest-pain-on-exertion',
  history: 'ZZHISTORY-type-2-diabetes',
  meds: 'ZZMEDS-metformin-850',
  filename: 'Mariam-ZZFILENAME-Hassan-MRI.jpg',
  aiCheck: 'ZZAICHECK-poor-contrast',
  labValue: 'ZZLAB-troponin-high',
  record: 'ZZRECORD-discharge-summary',
});

// Deep scan: collect every string reachable in a payload, so a withheld value
// cannot hide under a key nobody thought to assert on. `user` is the viewing
// DOCTOR's own session and is deliberately skipped.
function allStrings(value, skipKeys, seen, out) {
  skipKeys = skipKeys || new Set(['user']);
  seen = seen || new Set();
  out = out || [];
  if (value == null) return out;
  if (typeof value === 'string') { out.push(value); return out; }
  if (typeof value !== 'object') return out;
  if (seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) { for (const v of value) allStrings(v, skipKeys, seen, out); return out; }
  for (const k of Object.keys(value)) {
    if (skipKeys.has(k)) continue;
    allStrings(value[k], skipKeys, seen, out);
  }
  return out;
}
function leakedSecrets(payload, secrets) {
  const hay = allStrings(payload).join(' ');
  return Object.entries(secrets).filter(([, v]) => hay.indexOf(v) !== -1).map(([k]) => k);
}

const ORDER_BASE = Object.freeze({
  id: 'ord-a4',
  status: 'PAID',
  payment_status: 'paid',
  doctor_id: null,
  specialty_id: 'spec-cardio',
  service_id: 'svc-1',
  patient_id: 'pat-1',
  patient_name: SECRET.name,
  patient_date_of_birth: '1984-03-02',
  patient_gender: 'female',
  specialty_name: 'Cardiology',
  specialty_name_ar: 'قلب',
  service_name: 'ECG review',
  urgency_tier: 'standard',
  sla_hours: 48,
  language: 'en',
  report_language: 'en',
  created_at: '2026-09-01T10:00:00.000Z',
  clinical_question: SECRET.question,
  medical_history: SECRET.history,
  current_medications: SECRET.meds,
});
const order = (over) => Object.assign({}, ORDER_BASE, over || {});
const doctorRow = (over) => Object.assign(
  { specialty_id: 'spec-cardio', is_active: true, is_paused: false, pending_approval: false, rejection_reason: null },
  over || {}
);

module.exports = (async function run() {

  // ═══ (1) one entitlement rule ═════════════════════════════════════════════
  let A = null;
  try { A = require(path.join(SRC, 'services', 'doctor_case_access')); }
  catch (e) { t.fail('(1) src/services/doctor_case_access.js loads', e); }

  check('(1) doctorCaseAccess decides entitlement from the case and the doctor: paid AND (assigned to them OR open to their specialty) AND account-eligible — never from possession of the case id', () => {
    if (!A || typeof A.doctorCaseAccess !== 'function') return 'doctorCaseAccess is not exported from src/services/doctor_case_access.js';
    const { CASE_ACCESS } = A;
    if (!CASE_ACCESS || CASE_ACCESS.FULL !== 'full' || CASE_ACCESS.OFFER !== 'offer' || CASE_ACCESS.DENIED !== 'denied') {
      return 'CASE_ACCESS must name the three levels full / offer / denied';
    }
    const call = (o, d) => A.doctorCaseAccess({ order: o, doctorId: 'doc-1', doctorRow: d === undefined ? doctorRow() : d }).level;
    const cases = [
      // [label, order overrides, doctor row, expected level]
      ['paid pool case in my specialty', {}, undefined, 'offer'],
      ['unpaid pool case in my specialty', { payment_status: 'pending', status: 'SUBMITTED' }, undefined, 'denied'],
      ['paid, captured counts as paid', { payment_status: 'captured' }, undefined, 'offer'],
      ['paid pool case in ANOTHER specialty', { specialty_id: 'spec-derm' }, undefined, 'denied'],
      ['paid pool case with NO specialty', { specialty_id: null }, undefined, 'denied'],
      ['doctor with NO specialty, pool case', {}, doctorRow({ specialty_id: null }), 'denied'],
      ['assigned to me, not yet accepted', { doctor_id: 'doc-1', status: 'ASSIGNED' }, undefined, 'offer'],
      ['assigned to me, cross-specialty, not yet accepted', { doctor_id: 'doc-1', status: 'ASSIGNED', specialty_id: 'spec-derm' }, undefined, 'offer'],
      ['assigned to me but UNPAID', { doctor_id: 'doc-1', status: 'ASSIGNED', payment_status: 'pending' }, undefined, 'denied'],
      ['assigned to another doctor', { doctor_id: 'doc-2', status: 'ASSIGNED' }, undefined, 'denied'],
      ['accepted by me', { doctor_id: 'doc-1', status: 'IN_REVIEW' }, undefined, 'full'],
      ['completed, mine', { doctor_id: 'doc-1', status: 'COMPLETED' }, undefined, 'full'],
      ['a status in neither bucket', { status: 'EXPIRED_UNPAID', payment_status: 'pending' }, undefined, 'denied'],
      ['cancelled, unassigned', { status: 'CANCELLED' }, undefined, 'denied'],
      // the account rule, reused from launch gates
      ['paused doctor', {}, doctorRow({ is_paused: true }), 'denied'],
      ['pending-approval doctor', {}, doctorRow({ pending_approval: true }), 'denied'],
      ['deactivated doctor', {}, doctorRow({ is_active: false }), 'denied'],
      ['rejected doctor', {}, doctorRow({ is_active: null, rejection_reason: 'Not approved' }), 'denied'],
      ['paused doctor on a case ASSIGNED to them but not accepted', { doctor_id: 'doc-1', status: 'ASSIGNED' }, doctorRow({ is_paused: true }), 'denied'],
      ['no users row at all (read failed / missing)', {}, null, 'denied'],
      ['stale rejection reason on an active account', {}, doctorRow({ is_active: true, rejection_reason: 'old' }), 'offer'],
      // acceptance is never revoked by account state
      ['paused doctor who has ALREADY accepted still sees the full case', { doctor_id: 'doc-1', status: 'IN_REVIEW' }, doctorRow({ is_paused: true }), 'full'],
    ];
    for (const [label, over, dr, want] of cases) {
      const got = call(order(over), dr);
      if (got !== want) return label + ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want);
    }
    return null;
  });

  check('(1) the account half of the rule is the launch-gates rule itself (doctor_eligibility.doctorNewCaseBlockReason), not a second definition', () => {
    if (!A) return 'doctor_case_access did not load';
    const src = code('src/services/doctor_case_access.js');
    if (!/require\(['"]\.\/doctor_eligibility['"]\)/.test(src)) {
      return 'doctor_case_access.js does not require ./doctor_eligibility — the account rule must be reused, never restated';
    }
    if (!/doctorNewCaseBlockReason\s*\(/.test(src)) return 'doctor_case_access.js never calls doctorNewCaseBlockReason';
    // No local re-implementation of the account flags.
    for (const col of ['is_paused', 'pending_approval', 'rejection_reason']) {
      if (new RegExp('\\b' + col + '\\b').test(src)) {
        return 'doctor_case_access.js reads ' + col + ' itself — that is a second definition of the account rule; delegate to doctorNewCaseBlockReason';
      }
    }
    return null;
  });

  // ═══ (2) the specialty half agrees with the existing SQL predicate ════════
  check('(2) the JS specialty predicate agrees with routes/doctor.js specialtyMatchSql on every shape — a blank specialty on either side is FALSE, never a wildcard', () => {
    if (!A || typeof A.specialtyMatches !== 'function') return 'specialtyMatches is not exported from doctor_case_access.js';
    const m = code('src/routes/doctor.js').match(/function\s+specialtyMatchSql\s*\([\s\S]*?\n\}/);
    if (!m) return 'specialtyMatchSql is gone from routes/doctor.js — the pool queries and this rule no longer share a definition';
    // eslint-disable-next-line no-eval
    const specialtyMatchSql = eval('(' + m[0] + ')');
    const values = ['spec-cardio', 'spec-derm', '', '   ', null, undefined];
    for (const caseSpec of values) {
      for (const docSpec of values) {
        const sql = specialtyMatchSql(caseSpec, 'o.specialty_id', () => '$1');
        // The SQL clause is evaluated against the DOCTOR's specialty as the bind.
        const sqlMatches = sql === 'FALSE'
          ? false
          : (String(docSpec == null ? '' : docSpec).trim() !== '' &&
             String(caseSpec).trim() === String(docSpec).trim());
        const js = A.specialtyMatches(caseSpec, docSpec);
        if (js !== sqlMatches) {
          return 'case=' + JSON.stringify(caseSpec) + ' doctor=' + JSON.stringify(docSpec) +
                 ': JS says ' + js + ', the SQL predicate says ' + sqlMatches;
        }
      }
    }
    return null;
  });

  check('(2) the pre-accept field list is declared, and names nothing the patient owns', () => {
    if (!A || !Array.isArray(A.PRE_ACCEPT_ORDER_FIELDS)) return 'PRE_ACCEPT_ORDER_FIELDS is not exported as an array';
    // Batch A (fix plan 2026-09-15): the clinical QUESTION is part of the
    // pre-accept brief — it is what the doctor reads to decide — so it moved
    // from the banned list to the required list. History, medications, notes
    // and every identity column stay banned.
    const banned = ['patient_name', 'medical_history', 'history', 'current_medications', 'medications', 'notes', 'patient_date_of_birth', 'date_of_birth', 'patient_email', 'patient_phone'];
    const bad = A.PRE_ACCEPT_ORDER_FIELDS.filter((f) => banned.indexOf(f) !== -1);
    if (bad.length) return 'the pre-accept field list names ' + bad.join(', ');
    for (const need of ['id', 'status', 'payment_status', 'service_name', 'specialty_name', 'urgency_tier', 'sla_hours', 'clinical_question']) {
      if (A.PRE_ACCEPT_ORDER_FIELDS.indexOf(need) === -1) return 'the offer must still carry ' + need + ' — the doctor has to be able to decide';
    }
    return null;
  });

  check('(2) redactPreAcceptFiles keeps the count and the kind, and drops the filename and the URL', () => {
    if (!A || typeof A.redactPreAcceptFiles !== 'function') return 'redactPreAcceptFiles is not exported';
    const out = A.redactPreAcceptFiles([
      { id: 'f1', url: '/files/f1', name: SECRET.filename, source: 'additional' },
      { id: 'f2', url: '/files/f2', name: 'scan-no-extension' },
    ]);
    if (!Array.isArray(out) || out.length !== 2) return 'the file COUNT must survive — the brief tells the doctor what is waiting';
    const hay = JSON.stringify(out);
    if (hay.indexOf(SECRET.filename) !== -1) return 'the real filename survived redaction: ' + hay;
    if (hay.indexOf('/files/') !== -1) return 'the file URL survived redaction: ' + hay;
    // The view derives the extension chip from `name`, so the kind must survive.
    if (!/jpg/i.test(String(out[0].name || ''))) return 'the file KIND was lost — the pre-accept brief shows "1 × JPG"; got ' + JSON.stringify(out[0]);
    return null;
  });

  // The list payloads spread `SELECT o.*` and redact by BLACKLIST, so this is
  // pinned against the columns the live orders table actually has, not against
  // the ones the payload happened to be read for.
  check('(2) redactPreAcceptOrderRow strips every patient-owned column AND every link to the case artefacts, while keeping what the offer needs', () => {
    if (!A || typeof A.redactPreAcceptOrderRow !== 'function') return 'redactPreAcceptOrderRow is not exported';
    const row = {
      id: 'ord-a4', status: 'PAID', payment_status: 'paid', service_name: 'ECG review',
      clinical_question: SECRET.question, medical_history: SECRET.history,
      current_medications: SECRET.meds, notes: SECRET.question,
      patient_name: SECRET.name, patient_date_of_birth: '1984-03-02',
      diagnosis_text: SECRET.history, impression_text: SECRET.history,
      recommendation_text: SECRET.history,
      case_files_url: 'https://files.example/' + SECRET.filename,
      report_url: 'https://files.example/report-' + SECRET.name + '.pdf',
      reassignment_reason: 'patient ' + SECRET.name + ' asked for another reader',
    };
    const redacted = A.redactPreAcceptOrderRow(row);
    const leaked = leakedSecrets(redacted, SECRET);
    if (leaked.length) return 'a pre-accept row still carries: ' + leaked.join(', ');
    for (const keep of ['id', 'status', 'payment_status', 'service_name']) {
      if (redacted[keep] !== row[keep]) return 'redaction also removed ' + keep + ', which the doctor needs to judge the offer';
    }
    return null;
  });

  // Fix round 1, spec review I3 — the canary.
  //
  // Naming the columns to DROP is only ever as good as the last person who
  // remembered to extend the list at migration time. This assertion makes the
  // question structural instead: a column this module has never classified
  // must not reach a pre-accept payload at all, so the next migration that
  // adds a free-text clinical column ships it WITHHELD by default rather than
  // exposed by default. It fails on a denylist and passes on a keep-list.
  check('(2) redactPreAcceptOrderRow is FAIL-CLOSED: a column nobody has classified yet does not survive into a pre-accept payload', () => {
    if (!A || typeof A.redactPreAcceptOrderRow !== 'function') return 'redactPreAcceptOrderRow is not exported';
    const out = A.redactPreAcceptOrderRow({
      id: 'ord-a4', status: 'PAID', payment_status: 'paid',
      zz_future_free_text: 'ZZFUTURE-the-next-migrations-free-text-column',
    });
    if ('zz_future_free_text' in out) {
      return 'an unclassified orders column survived pre-accept redaction — redaction names the columns it drops, so the next migration that adds free text ships it to every unaccepted doctor by default';
    }
    if (JSON.stringify(out).indexOf('ZZFUTURE') !== -1) return 'the unknown column survived under another key: ' + JSON.stringify(out);
    if (out.id !== 'ord-a4' || out.status !== 'PAID' || out.payment_status !== 'paid') {
      return 'fail-closed redaction also dropped the fields the offer needs: ' + JSON.stringify(out);
    }
    return null;
  });

  // The other half of fail-closed: it must not OVER-redact. Every column the
  // live orders table has today — listed via the Supabase MCP against
  // information_schema, SELECT-only, 2026-09-16 — that nothing classifies as
  // the patient's must still survive, or a doctor-facing list screen silently
  // loses a field and nobody finds out until a doctor complains.
  const LIVE_ORDERS_COLUMNS = Object.freeze([
    'id', 'patient_id', 'doctor_id', 'specialty_id', 'service_id', 'sla_hours', 'status', 'language',
    'urgency_flag', 'price', 'doctor_fee', 'created_at', 'updated_at', 'accepted_at', 'deadline_at',
    'completed_at', 'breached_at', 'reassigned_count', 'report_url', 'notes', 'diagnosis_text',
    'impression_text', 'recommendation_text', 'uploads_locked', 'additional_files_requested',
    'medical_history', 'current_medications', 'payment_status', 'payment_method', 'payment_reference',
    'payment_link', 'pre_breach_notified', 'sla_reminder_sent', 'video_consultation_selected',
    'video_consultation_price', 'addons_json', 'total_price_with_addons', 'sla_24hr_selected',
    'sla_24hr_price', 'sla_24hr_deadline', 'referral_code', 'referral_discount', 'intelligence_status',
    'reference_id', 'clinical_question', 'base_price', 'currency', 'sla_deadline', 'broadcast_sent_at',
    'broadcast_count', 'acceptance_deadline_at', 'tier', 'case_files_url', 'test_type', 'source',
    'country', 'urgency_tier', 'paid_at', 'draft_step', 'deleted_at', 'urgency_uplift_amount',
    'reassigned_to_doctor_id', 'reassigned_at', 'reassignment_reason', 'paymob_intention_id',
    'paymob_transaction_id', 'hmac_verified_at', 'sla_paused_at', 'sla_remaining_seconds',
    'assignment_status', 'no_sla_refund_eligibility', 'display_price', 'display_currency',
    'locked_price', 'locked_currency', 'price_snapshot_json',
  ]);

  check('(2) fail-closed redaction does not OVER-redact: every live orders column that is not withheld still reaches the pre-accept row', () => {
    if (!A || typeof A.redactPreAcceptOrderRow !== 'function') return 'redactPreAcceptOrderRow is not exported';
    const withheld = new Set(A.WITHHELD_UNTIL_ACCEPT || []);
    const row = {};
    for (const c of LIVE_ORDERS_COLUMNS) row[c] = 'v-' + c;
    const out = A.redactPreAcceptOrderRow(row);
    const lost = LIVE_ORDERS_COLUMNS.filter((c) => !withheld.has(c) && !(c in out));
    if (lost.length) return 'these live orders columns were dropped although nothing classifies them as the patient\'s: ' + lost.join(', ');
    const survived = LIVE_ORDERS_COLUMNS.filter((c) => withheld.has(c) && (c in out));
    if (survived.length) return 'withheld columns survived redaction: ' + survived.join(', ');
    return null;
  });

  // ═══ (3) + (4) + (6) the REAL doctor routes ══════════════════════════════
  await (async function doctorRouteHarness() {
    const R = (p) => require.resolve(path.join(SRC, p));
    const PG = R('pg.js'); const LOGGER = R('logger.js'); const DOC = R('routes/doctor.js');
    const swapped = [PG, LOGGER, DOC];
    let realPg, realLogger;
    try { realPg = require(PG); realLogger = require(LOGGER); require(DOC); }
    catch (e) { t.fail('(3) routes/doctor.js loads hermetically', e); return; }
    const saved = {};
    for (const p of swapped) saved[p] = require.cache[p];
    const restore = () => { for (const p of swapped) { if (saved[p]) require.cache[p] = saved[p]; else delete require.cache[p]; } };

    let scn = null;
    const rec = { accountReads: [] };

    const answerOne = async (sql, params) => {
      const s = norm(sql);
      if (/FROM orders_active o/.test(s) && /WHERE o\.id = \$1/.test(s)) return scn.order;
      if (/^SELECT \* FROM orders_active WHERE id = \$1$/.test(s)) return scn.order;
      if (/FROM users WHERE id = \$1/.test(s) && /is_paused/.test(s)) {
        rec.accountReads.push({ sql: s, params: params || [] });
        if (scn.throwAccount) throw new Error('simulated users read failure');
        return scn.doctor === undefined ? doctorRow() : scn.doctor;
      }
      if (/^SELECT name FROM users WHERE id = \$1$/.test(s)) return { name: SECRET.name };
      if (/SELECT intelligence_status FROM orders_active/.test(s)) return { intelligence_status: 'ready' };
      if (/FROM case_extractions WHERE case_id = \$1/.test(s)) {
        return { lab_values: JSON.stringify([{ name: SECRET.labValue, value: '1.2' }]), patient_info: JSON.stringify({ name: SECRET.name }) };
      }
      if (/COUNT\(\*\) as c FROM orders_active WHERE doctor_id = \$1/.test(s)) return { c: scn.loadCount == null ? 0 : scn.loadCount };
      if (/COUNT\(\*\) AS c/.test(s)) return { c: scn.loadCount == null ? 0 : scn.loadCount };
      if (/FROM conversations WHERE order_id/.test(s)) return null;
      if (/FROM appointments/.test(s)) return null;
      if (/FROM doctor_assignments/.test(s)) return null;
      if (/FROM doctor_services/.test(s)) return null;
      return null;
    };
    const answerAll = async (sql) => {
      const s = norm(sql);
      if (/FROM information_schema\.columns/.test(s)) {
        return [{ name: 'id' }, { name: 'url' }, { name: 'label' }, { name: 'created_at' }, { name: 'order_id' }];
      }
      if (/FROM order_files WHERE order_id = \$1/.test(s)) {
        return [{ id: 'f1', url: 'r2/key/one', name: SECRET.filename }];
      }
      if (/FROM order_additional_files/.test(s)) return [];
      if (/FROM case_annotations/.test(s)) return [];
      if (/FROM file_ai_checks WHERE order_id = \$1/.test(s)) {
        return [{ file_id: 'f1', is_medical_image: true, image_quality: 'poor', quality_issues: SECRET.aiCheck, detected_scan_type: 'MRI' }];
      }
      if (/FROM case_files WHERE case_id = \$1/.test(s)) return [];
      if (/queue_rows|FROM orders_active o/.test(s)) return scn.listRows || [];
      return [];
    };

    fakeModule(PG, Object.assign({}, realPg, {
      queryOne: answerOne,
      queryAll: answerAll,
      execute: async () => ({ rowCount: 0 }),
      withTransaction: async () => null,
    }));
    fakeModule(LOGGER, Object.assign({}, realLogger, { logErrorToDb: () => {} }));

    let casePage = null; let intelligence = null; let queuePage = null; let dashboardPage = null;
    try {
      delete require.cache[DOC];
      const router = require(DOC);
      const pick = (p, method) => {
        const layer = router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]);
        return layer ? layer.route.stack[layer.route.stack.length - 1].handle : null;
      };
      // The dashboard is registered on an ARRAY of paths, so match membership.
      const pickAny = (p, method) => {
        const layer = router.stack.find((l) => {
          if (!l.route || !l.route.methods[method]) return false;
          const rp = l.route.path;
          return Array.isArray(rp) ? rp.indexOf(p) !== -1 : rp === p;
        });
        return layer ? layer.route.stack[layer.route.stack.length - 1].handle : null;
      };
      casePage = pick('/portal/doctor/case/:caseId', 'get');
      intelligence = pick('/doctor/cases/:caseId/intelligence', 'get');
      queuePage = pick('/portal/doctor/queue', 'get');
      dashboardPage = pickAny('/portal/doctor/dashboard', 'get');
      if (!dashboardPage) throw new Error('GET /portal/doctor/dashboard not on router.stack');
      if (!casePage) throw new Error('GET /portal/doctor/case/:caseId not on router.stack');
      if (!intelligence) throw new Error('GET /doctor/cases/:caseId/intelligence not on router.stack');
      if (!queuePage) throw new Error('GET /portal/doctor/queue not on router.stack');
    } catch (e) {
      t.fail('(3) the doctor handlers are pluckable off router.stack', e);
      restore();
      return;
    }

    async function drive(handler, s, reqOver) {
      scn = s; rec.accountReads = [];
      const req = Object.assign({
        params: { caseId: s.order ? s.order.id : 'ord-a4' },
        user: { id: 'doc-1', role: 'doctor', specialty_id: 'spec-cardio' },
        originalUrl: '/portal/doctor/case/ord-a4',
        method: 'GET',
        requestId: 'req-a4',
        query: {},
        body: {},
      }, reqOver || {});
      const res = {
        locals: {}, statusCode: 200, view: null, payload: null, sent: null, redirected: null,
        status(c) { this.statusCode = c; return this; },
        render(v, p) { this.view = v; this.payload = p; return this; },
        send(b) { this.sent = b; return this; },
        json(o) { this.payload = o; return this; },
        redirect(u) { this.redirected = u; return this; },
      };
      let threw = null;
      try { await handler(req, res, (e) => { if (e) threw = e; }); } catch (e) { threw = e; }
      return { res, threw, accountReads: rec.accountReads.slice() };
    }

    // ── refusal shape: the EXISTING fail-closed refusal, not a new one ──────
    function refused(r) {
      if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
      if (r.res.statusCode !== 403) return 'answered ' + r.res.statusCode + ', want 403 (view=' + r.res.view + ')';
      if (r.res.payload && r.res.payload.accessDenied !== true) return 'rendered a case page instead of the refusal screen';
      if (r.res.payload && r.res.payload.order) return 'the refusal still carried an order object';
      const leaked = leakedSecrets(r.res.payload || r.res.sent || '', SECRET);
      if (leaked.length) return 'the refusal leaked ' + leaked.join(', ');
      return null;
    }
    function isOffer(r) {
      if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
      if (r.res.statusCode !== 200) return 'answered ' + r.res.statusCode + ', want the offer page';
      const p = r.res.payload;
      if (!p) return 'nothing was rendered';
      if (p.accessDenied) return 'the offer page was refused';
      if (p.canViewDetails !== false || p.blurred !== true) return 'the offer must stay redacted: canViewDetails=false, blurred=true';
      return null;
    }

    await checkAsync('(3) case page — entitled doctor (paid, unassigned, specialty match, account clear): sees the offer WITH the clinical question, and history / medications / patient name / filename / AI checks are ABSENT FROM THE PAYLOAD', async () => {
      const r = await drive(casePage, { order: order(), doctor: doctorRow() });
      const why = isOffer(r); if (why) return why;
      // Batch A (fix plan 2026-09-15): the question is policy-visible on the
      // entitlement-checked brief. Everything else the patient owns stays out.
      const leaked = leakedSecrets(r.res.payload, SECRET).filter((k) => k !== 'question');
      if (leaked.length) return 'the pre-accept payload still carries: ' + leaked.join(', ');
      const ctx = r.res.payload.clinicalContext;
      if (!ctx || ctx.question !== SECRET.question) return 'the entitled doctor was not shown the clinical question — the brief is what they decide on';
      if ('medicalHistory' in ctx || 'medications' in ctx) {
        return 'pre-accept clinicalContext must carry ONLY the question — history/medications keys must be absent, not blanked';
      }
      return null;
    });

    await checkAsync('(3) case page — the offer is still usable: service, specialty, tier, window, patient age and sex, report language and the file COUNT all survive', async () => {
      const r = await drive(casePage, { order: order(), doctor: doctorRow() });
      const why = isOffer(r); if (why) return why;
      const o = r.res.payload.order || {};
      const want = { service_name: 'ECG review', specialty_name: 'Cardiology', urgency_tier: 'standard', sla_hours: 48, patient_gender: 'female' };
      for (const [k, v] of Object.entries(want)) {
        if (o[k] !== v) return 'the offer lost ' + k + ' (got ' + JSON.stringify(o[k]) + ', want ' + JSON.stringify(v) + ')';
      }
      if (o.patient_age == null) return 'the offer lost patient_age';
      if (!Array.isArray(r.res.payload.files) || r.res.payload.files.length !== 1) {
        return 'the offer lost the file inventory — the doctor must be told what is waiting; got ' + JSON.stringify(r.res.payload.files);
      }
      if (r.res.payload.showAcceptButton !== true) return 'the entitled doctor was not offered the Accept button';
      return null;
    });

    await checkAsync('(3) case page — the doctor account is read LIVE for the entitlement decision, keyed on the requesting doctor', async () => {
      const r = await drive(casePage, { order: order(), doctor: doctorRow() });
      if (r.accountReads.length !== 1) return 'expected exactly one live users read, saw ' + r.accountReads.length;
      if (JSON.stringify(r.accountReads[0].params) !== JSON.stringify(['doc-1'])) {
        return 'the users read is not keyed on the requesting doctor: ' + JSON.stringify(r.accountReads[0].params);
      }
      for (const c of ['specialty_id', 'is_active', 'is_paused', 'pending_approval', 'rejection_reason']) {
        if (!new RegExp('\\b' + c + '\\b').test(r.accountReads[0].sql)) return 'the live users read does not select ' + c;
      }
      return null;
    });

    await checkAsync('(3) case page — UNPAID case: refused', async () => {
      return refused(await drive(casePage, { order: order({ payment_status: 'pending', status: 'SUBMITTED' }), doctor: doctorRow() }));
    });
    await checkAsync('(3) case page — case in ANOTHER specialty: refused', async () => {
      return refused(await drive(casePage, { order: order({ specialty_id: 'spec-derm' }), doctor: doctorRow() }));
    });
    await checkAsync('(3) case page — pool case with NO specialty is not open to everyone: refused', async () => {
      return refused(await drive(casePage, { order: order({ specialty_id: null }), doctor: doctorRow() }));
    });
    await checkAsync('(3) case page — A4 eligibility also asks tier and cap: a VIP case is refused to a standard-only doctor, a doctor AT their cap is refused, one UNDER it sees the offer', async () => {
      // Tier: sla_tiers_supported = ["standard"] on a VIP case → refused.
      let why = refused(await drive(casePage, { order: order({ urgency_tier: 'vip' }), doctor: doctorRow({ sla_tiers_supported: ['standard'] }) }));
      if (why) return 'standard-only doctor on a VIP case: ' + why;
      // Capacity: at their max_active_cases → refused; one under it → offer.
      why = refused(await drive(casePage, { order: order(), doctor: doctorRow({ max_active_cases: 2 }), loadCount: 2 }));
      if (why) return 'doctor at their cap: ' + why;
      const r = await drive(casePage, { order: order(), doctor: doctorRow({ max_active_cases: 2 }), loadCount: 1 });
      why = isOffer(r);
      if (why) return 'doctor under their cap: ' + why;
      return null;
    });

    await checkAsync('(3) case page — doctor who fails the launch-gates account rule (paused / pending / deactivated / rejected): refused', async () => {
      for (const [label, dr] of [
        ['paused', doctorRow({ is_paused: true })],
        ['pending approval', doctorRow({ pending_approval: true })],
        ['deactivated', doctorRow({ is_active: false })],
        ['rejected', doctorRow({ is_active: null, rejection_reason: 'Not approved' })],
      ]) {
        const why = refused(await drive(casePage, { order: order(), doctor: dr }));
        if (why) return label + ': ' + why;
      }
      return null;
    });
    await checkAsync('(3) case page — the account read THROWS: fails closed, refused', async () => {
      return refused(await drive(casePage, { order: order(), doctor: doctorRow(), throwAccount: true }));
    });
    await checkAsync('(3) case page — assigned to ANOTHER doctor: refused, as before', async () => {
      return refused(await drive(casePage, { order: order({ doctor_id: 'doc-2', status: 'ASSIGNED' }), doctor: doctorRow() }));
    });

    await checkAsync('(3) case page — assigned to this doctor but NOT yet accepted: sees the offer (with the question), not the patient', async () => {
      const r = await drive(casePage, { order: order({ doctor_id: 'doc-1', status: 'ASSIGNED' }), doctor: doctorRow() });
      const why = isOffer(r); if (why) return why;
      const leaked = leakedSecrets(r.res.payload, SECRET).filter((k) => k !== 'question');
      if (leaked.length) return 'an assigned-but-unaccepted doctor was shown: ' + leaked.join(', ');
      const ctx = r.res.payload.clinicalContext;
      if (!ctx || ctx.question !== SECRET.question) return 'the assigned-but-unaccepted doctor lost the question their offer is decided on';
      if ('medicalHistory' in ctx || 'medications' in ctx) return 'history/medications keys reached an unaccepted doctor';
      return null;
    });

    await checkAsync('(3) case page — ACCEPTED by this doctor: everything still shown, unchanged', async () => {
      const r = await drive(casePage, { order: order({ doctor_id: 'doc-1', status: 'IN_REVIEW' }), doctor: doctorRow() });
      if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
      const p = r.res.payload;
      if (!p || p.accessDenied) return 'the accepting doctor was refused their own case';
      if (p.canViewDetails !== true || p.blurred !== false) return 'the accepting doctor no longer gets the full case';
      const hay = allStrings(p).join(' ');
      for (const k of ['name', 'question', 'history', 'meds', 'filename']) {
        if (hay.indexOf(SECRET[k]) === -1) return 'the accepting doctor lost ' + k + ' — this gate is about permission, not about hiding it from everyone';
      }
      if (!p.clinicalContext || p.clinicalContext.question !== SECRET.question) return 'the accepting doctor lost clinicalContext.question';
      return null;
    });

    await checkAsync('(3) case page — a paused doctor who has ALREADY accepted keeps working their case', async () => {
      const r = await drive(casePage, { order: order({ doctor_id: 'doc-1', status: 'IN_REVIEW' }), doctor: doctorRow({ is_paused: true }) });
      if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
      if (!r.res.payload || r.res.payload.canViewDetails !== true) return 'a pause took a case away from the doctor holding it';
      return null;
    });

    // ── (4) the intelligence view ──────────────────────────────────────────
    await checkAsync('(4) intelligence view — ACCEPTED by this doctor: still renders', async () => {
      const r = await drive(intelligence, { order: order({ doctor_id: 'doc-1', status: 'IN_REVIEW' }), doctor: doctorRow() },
        { params: { caseId: 'ord-a4' }, originalUrl: '/doctor/cases/ord-a4/intelligence' });
      if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
      if (r.res.view !== 'doctor_case_intelligence') return 'the accepting doctor no longer gets the case file (status ' + r.res.statusCode + ')';
      return null;
    });
    await checkAsync('(4) intelligence view — assigned but NOT accepted: 403, and neither the patient name nor the AI extractions are loaded', async () => {
      const r = await drive(intelligence, { order: order({ doctor_id: 'doc-1', status: 'ASSIGNED' }), doctor: doctorRow() },
        { params: { caseId: 'ord-a4' }, originalUrl: '/doctor/cases/ord-a4/intelligence' });
      if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
      if (r.res.statusCode !== 403) return 'answered ' + r.res.statusCode + ', want 403';
      const leaked = leakedSecrets({ p: r.res.payload, s: r.res.sent }, SECRET);
      if (leaked.length) return 'the refusal leaked ' + leaked.join(', ');
      return null;
    });
    await checkAsync('(4) intelligence view — unassigned pool case, entitled doctor: still 403 (an offer is not a case file)', async () => {
      const r = await drive(intelligence, { order: order(), doctor: doctorRow() },
        { params: { caseId: 'ord-a4' }, originalUrl: '/doctor/cases/ord-a4/intelligence' });
      if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
      if (r.res.statusCode !== 403) return 'answered ' + r.res.statusCode + ', want 403';
      return null;
    });
    await checkAsync('(4) intelligence view — unpaid case assigned to this doctor: 403', async () => {
      const r = await drive(intelligence, { order: order({ doctor_id: 'doc-1', status: 'ASSIGNED', payment_status: 'pending' }), doctor: doctorRow() },
        { params: { caseId: 'ord-a4' }, originalUrl: '/doctor/cases/ord-a4/intelligence' });
      if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
      if (r.res.statusCode !== 403) return 'answered ' + r.res.statusCode + ', want 403';
      return null;
    });

    // ── (6) the pre-accept LIST payload ────────────────────────────────────
    await checkAsync('(6) queue "new" bucket — the pre-accept list payload carries no clinical columns at all', async () => {
      const r = await drive(queuePage, {
        order: order(),
        doctor: doctorRow(),
        listRows: [order()],
      }, { params: {}, query: { bucket: 'new' }, originalUrl: '/portal/doctor/queue' });
      if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
      const cases = (r.res.payload && r.res.payload.cases) || [];
      if (!cases.length) return 'the queue rendered no rows, so this assertion proves nothing';
      const leaked = leakedSecrets(cases, {
        question: SECRET.question, history: SECRET.history, meds: SECRET.meds, name: SECRET.name,
      });
      if (leaked.length) return 'a pre-accept queue row still carries: ' + leaked.join(', ');
      return null;
    });

    // The dashboard "priority queue" bucket is ('accepted','in_review'), and
    // 'accepted' is NOT accepted in this codebase (acceptance is accepted_at).
    // The card renders _initials(c.patient_name) straight off these rows.
    await checkAsync('(6) dashboard priority queue — a case ASSIGNED to this doctor but NOT accepted (status "accepted") carries no clinical content and no patient name', async () => {
      const r = await drive(dashboardPage, {
        order: order(),
        doctor: doctorRow(),
        listRows: [order({ doctor_id: 'doc-1', status: 'accepted' })],
      }, { params: {}, query: {}, originalUrl: '/portal/doctor/dashboard' });
      if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
      const pq = (r.res.payload && r.res.payload.priorityQueue) || [];
      if (!pq.length) return 'the priority queue rendered no rows, so this assertion proves nothing';
      const leaked = leakedSecrets(pq, {
        question: SECRET.question, history: SECRET.history, meds: SECRET.meds, name: SECRET.name,
      });
      if (leaked.length) return 'an assigned-but-unaccepted dashboard row still carries: ' + leaked.join(', ');
      return null;
    });

    await checkAsync('(6) dashboard priority queue — an IN_REVIEW case this doctor has accepted is unchanged', async () => {
      const r = await drive(dashboardPage, {
        order: order(),
        doctor: doctorRow(),
        listRows: [order({ doctor_id: 'doc-1', status: 'in_review' })],
      }, { params: {}, query: {}, originalUrl: '/portal/doctor/dashboard' });
      if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
      const pq = (r.res.payload && r.res.payload.priorityQueue) || [];
      if (!pq.length) return 'the priority queue rendered no rows, so this assertion proves nothing';
      if (allStrings(pq).join(' ').indexOf(SECRET.name) === -1) {
        return 'the accepting doctor lost the patient name on their OWN in-review case — this gate is about permission, not about hiding it from everyone';
      }
      return null;
    });

    restore();
  })();

  // ═══ (5) the other pre-accept surfaces ═══════════════════════════════════
  await (async function otherSurfaces() {
    const R = (p) => require.resolve(path.join(SRC, p));
    const PG = R('pg.js'); const SQLU = R('sql-utils.js'); const LOGGER = R('logger.js');
    const FLOW = R('routes/order_flow.js'); const MED = R('routes/medical_records.js'); const RX = R('routes/prescriptions.js');
    const swapped = [PG, SQLU, LOGGER, FLOW, MED, RX];
    let realPg, realSqlU, realLogger;
    try { realPg = require(PG); realSqlU = require(SQLU); realLogger = require(LOGGER); }
    catch (e) { t.fail('(5) the other route modules load', e); return; }
    const saved = {};
    for (const p of swapped) saved[p] = require.cache[p];
    const restore = () => { for (const p of swapped) { if (saved[p]) require.cache[p] = saved[p]; else delete require.cache[p]; } };

    let scn = null;
    const answerOne = async (sql) => {
      const s = norm(sql);
      if (/FROM orders_active/.test(s) && /WHERE/.test(s)) {
        // medical_records / prescriptions scope their SELECT to the doctor.
        if (/doctor_id = \$2/.test(s)) {
          const assigned = scn.order.doctor_id ? String(scn.order.doctor_id) : '';
          return assigned === 'doc-1' ? scn.order : null;
        }
        return scn.order;
      }
      if (/FROM case_extractions/.test(s)) return { lab_values: JSON.stringify([{ name: SECRET.labValue }]), patient_info: JSON.stringify({ name: SECRET.name }) };
      if (/FROM prescriptions WHERE order_id/.test(s)) return null;
      return null;
    };
    const answerAll = async (sql) => {
      const s = norm(sql);
      if (/FROM medical_records/.test(s)) return [{ id: 'mr-1', record_type: 'discharge_summary', title: SECRET.record }];
      if (/FROM case_files/.test(s)) return [];
      return [];
    };
    fakeModule(PG, Object.assign({}, realPg, { queryOne: answerOne, queryAll: answerAll, execute: async () => ({ rowCount: 0 }) }));
    fakeModule(SQLU, Object.assign({}, realSqlU, {
      safeGet: async (sql, params, dflt) => { const v = await answerOne(sql, params); return v === null || v === undefined ? (dflt === undefined ? null : dflt) : v; },
      safeAll: async (sql, params, dflt) => { const v = await answerAll(sql, params); return v && v.length ? v : (dflt === undefined ? [] : dflt); },
    }));
    fakeModule(LOGGER, Object.assign({}, realLogger, { logErrorToDb: () => {} }));

    function pluck(modPath, routePath, method, named) {
      delete require.cache[modPath];
      const mod = require(modPath);
      const router = (mod && mod.stack) ? mod : (mod && mod.router ? mod.router : null);
      if (!router) throw new Error(named + ': module exports no router');
      const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
      if (!layer) throw new Error(named + ': ' + method.toUpperCase() + ' ' + routePath + ' not on router.stack');
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }

    async function drive(handler, s, reqOver) {
      scn = s;
      const req = Object.assign({
        params: { id: 'ord-a4', caseId: 'ord-a4' },
        user: { id: 'doc-1', role: 'doctor' },
        originalUrl: '/x', method: 'GET', requestId: 'req-a4', query: {}, body: {},
      }, reqOver || {});
      const res = {
        locals: { lang: 'en' }, statusCode: 200, view: null, payload: null, sent: null,
        status(c) { this.statusCode = c; return this; },
        render(v, p) { this.view = v; this.payload = p; return this; },
        send(b) { this.sent = b; return this; },
        json(o) { this.payload = o; return this; },
        redirect(u) { this.redirected = u; return this; },
      };
      let threw = null;
      try { await handler(req, res, (e) => { if (e) threw = e; }); } catch (e) { threw = e; }
      return { res, threw };
    }

    try {
      let intelJson = null; let records = null;
      try {
        intelJson = pluck(FLOW, '/api/cases/:id/intelligence', 'get', 'order_flow');
        records = pluck(MED, '/portal/doctor/case/:caseId/patient-records', 'get', 'medical_records');
      } catch (e) { t.fail('(5) the JSON surfaces are pluckable', e); restore(); return; }

      await checkAsync('(5) GET /api/cases/:id/intelligence — a doctor ASSIGNED but not accepted is refused the AI extractions and the patient name', async () => {
        const r = await drive(intelJson, { order: order({ doctor_id: 'doc-1', status: 'ASSIGNED', intelligence_status: 'ready' }) });
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        if (r.res.statusCode !== 403) return 'answered ' + r.res.statusCode + ' with ' + JSON.stringify(r.res.payload);
        const leaked = leakedSecrets(r.res.payload || {}, SECRET);
        if (leaked.length) return 'the refusal leaked ' + leaked.join(', ');
        return null;
      });
      await checkAsync('(5) GET /api/cases/:id/intelligence — the doctor who ACCEPTED still gets it', async () => {
        const r = await drive(intelJson, { order: order({ doctor_id: 'doc-1', status: 'IN_REVIEW', intelligence_status: 'ready' }) });
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        if (r.res.statusCode !== 200) return 'the accepting doctor was refused (' + r.res.statusCode + ')';
        return null;
      });
      await checkAsync('(5) GET /api/cases/:id/intelligence — the PATIENT who owns the case is unaffected', async () => {
        const r = await drive(intelJson, { order: order({ doctor_id: null, intelligence_status: 'ready' }) },
          { user: { id: 'pat-1', role: 'patient' } });
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        if (r.res.statusCode !== 200) return 'the patient lost access to their own case (' + r.res.statusCode + ')';
        return null;
      });

      await checkAsync('(5) GET /portal/doctor/case/:caseId/patient-records — a doctor ASSIGNED but not accepted is refused the shared medical history', async () => {
        const r = await drive(records, { order: order({ doctor_id: 'doc-1', status: 'ASSIGNED' }) });
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        if (r.res.statusCode !== 403) return 'answered ' + r.res.statusCode + ' with ' + JSON.stringify(r.res.payload);
        const leaked = leakedSecrets(r.res.payload || {}, SECRET);
        if (leaked.length) return 'the refusal leaked ' + leaked.join(', ');
        return null;
      });
      // Fix round 1, spec review I1 — driven, not just source-checked. The
      // refusals ARE distinguishable: a case that is not this doctor's answers
      // 404, while the coming-soon and not-purchased refusals answer 403, so
      // this cannot be satisfied by either of those firing first.
      await checkAsync('(5) POST /portal/doctor/case/:caseId/prescribe — a doctor ASSIGNED but not accepted cannot read the patient by posting the form empty', async () => {
        let prescribePost = null;
        try { prescribePost = pluck(RX, '/portal/doctor/case/:caseId/prescribe', 'post', 'prescriptions'); }
        catch (e) { return 'the prescribe POST is not pluckable: ' + (e.message || e); }
        const r = await drive(prescribePost, { order: order({ doctor_id: 'doc-1', status: 'ASSIGNED' }) },
          { method: 'POST', body: {}, originalUrl: '/portal/doctor/case/ord-a4/prescribe' });
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        if (r.res.statusCode !== 404) {
          return 'answered ' + r.res.statusCode + ' — an assigned-but-unaccepted doctor reached past the gate (view=' + r.res.view + ')';
        }
        const leaked = leakedSecrets({ p: r.res.payload, s: r.res.sent }, SECRET);
        if (leaked.length) return 'the refusal leaked ' + leaked.join(', ');
        return null;
      });

      await checkAsync('(5) POST /portal/doctor/case/:caseId/prescribe — the doctor who ACCEPTED is not refused by THIS gate', async () => {
        let prescribePost = null;
        try { prescribePost = pluck(RX, '/portal/doctor/case/:caseId/prescribe', 'post', 'prescriptions'); }
        catch (e) { return 'the prescribe POST is not pluckable: ' + (e.message || e); }
        const r = await drive(prescribePost, { order: order({ doctor_id: 'doc-1', status: 'IN_REVIEW' }) },
          { method: 'POST', body: {}, originalUrl: '/portal/doctor/case/ord-a4/prescribe' });
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        if (r.res.statusCode === 404) return 'the accepting doctor was told their own case does not exist';
        return null;
      });

      await checkAsync('(5) GET /portal/doctor/case/:caseId/patient-records — the doctor who ACCEPTED still gets the records', async () => {
        const r = await drive(records, { order: order({ doctor_id: 'doc-1', status: 'IN_REVIEW' }) });
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        if (r.res.statusCode !== 200) return 'the accepting doctor was refused (' + r.res.statusCode + ')';
        return null;
      });
    } finally {
      restore();
    }
  })();

  // ═══ (8) the doctor analytics page ═══════════════════════════════════════
  // Fix round 1, adversarial review C1. recentCases joined the patient user row
  // and filtered on `o.doctor_id = $1` with no acceptance and no status filter,
  // and doctor_analytics.ejs printed `c.patient_name` — so EVERY
  // assigned-but-unaccepted case named the patient, with no reassignment or
  // any other precondition needed.
  await (async function analyticsSurface() {
    const R = (p) => require.resolve(path.join(SRC, p));
    const PG = R('pg.js'); const SQLU = R('sql-utils.js'); const LOGGER = R('logger.js');
    const AN = R('routes/analytics.js');
    const swapped = [PG, SQLU, LOGGER, AN];
    let realPg, realSqlU, realLogger;
    try { realPg = require(PG); realSqlU = require(SQLU); realLogger = require(LOGGER); }
    catch (e) { t.fail('(8) the analytics module deps load', e); return; }
    const saved = {};
    for (const p of swapped) saved[p] = require.cache[p];
    const restore = () => { for (const p of swapped) { if (saved[p]) require.cache[p] = saved[p]; else delete require.cache[p]; } };

    let scn = null;
    const answerOne = async () => ({ c: 0, t: 0, total: 0, count: 0 });
    const answerAll = async (sql) => {
      const s = norm(sql);
      if (/as patient_name/i.test(s)) return scn.rows;
      return [];
    };
    fakeModule(PG, Object.assign({}, realPg, { queryOne: answerOne, queryAll: answerAll, execute: async () => ({ rowCount: 0 }) }));
    fakeModule(SQLU, Object.assign({}, realSqlU, { tableExists: async () => false }));
    fakeModule(LOGGER, Object.assign({}, realLogger, { logErrorToDb: () => {} }));

    try {
      let handler = null;
      try {
        delete require.cache[AN];
        const router = require(AN);
        const layer = router.stack.find((l) => l.route && l.route.path === '/portal/doctor/analytics' && l.route.methods.get);
        if (!layer) throw new Error('GET /portal/doctor/analytics not on router.stack');
        handler = layer.route.stack[layer.route.stack.length - 1].handle;
      } catch (e) { t.fail('(8) GET /portal/doctor/analytics is pluckable', e); restore(); return; }

      const caseRow = (over) => Object.assign({
        id: 'ord-a4', status: 'ASSIGNED', doctor_id: 'doc-1',
        created_at: '2026-09-01T10:00:00.000Z', completed_at: null,
        service_name: 'ECG review', patient_name: SECRET.name, doctor_fee_egp: 120,
      }, over || {});

      const drive = async (rows) => {
        scn = { rows };
        const req = {
          params: {}, query: {}, body: {},
          user: { id: 'doc-1', role: 'doctor', lang: 'en' },
          originalUrl: '/portal/doctor/analytics', method: 'GET', requestId: 'req-a4',
        };
        const res = {
          locals: {}, statusCode: 200, view: null, payload: null, sent: null,
          status(c) { this.statusCode = c; return this; },
          render(v, p) { this.view = v; this.payload = p; return this; },
          send(b) { this.sent = b; return this; },
          json(o) { this.payload = o; return this; },
          set() { return this; },
        };
        let threw = null;
        try { await handler(req, res, (e) => { if (e) threw = e; }); } catch (e) { threw = e; }
        return { res, threw };
      };

      await checkAsync('(8) /portal/doctor/analytics — a case ASSIGNED but not yet accepted carries no patient identity onto the page', async () => {
        const r = await drive([caseRow()]);
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        const rows = (r.res.payload && r.res.payload.recentCases) || [];
        if (!rows.length) return 'the analytics page rendered no rows, so this assertion proves nothing';
        const leaked = leakedSecrets(rows, { name: SECRET.name });
        if (leaked.length) return 'the analytics table still names the patient of a case this doctor has NOT accepted';
        return null;
      });

      await checkAsync('(8) /portal/doctor/analytics — the doctor still sees the patient on a case they ACCEPTED, and the row keeps its service and fee', async () => {
        const r = await drive([caseRow({ status: 'IN_REVIEW' })]);
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        const rows = (r.res.payload && r.res.payload.recentCases) || [];
        if (!rows.length) return 'the analytics page rendered no rows';
        if (allStrings(rows).join(' ').indexOf(SECRET.name) === -1) {
          return 'the accepting doctor lost the patient name on their OWN case — this gate is about permission, not about hiding it from everyone';
        }
        if (rows[0].doctor_fee_egp !== 120 || rows[0].service_name !== 'ECG review') {
          return 'the analytics row lost the fee or the service: ' + JSON.stringify(rows[0]);
        }
        return null;
      });

      await checkAsync('(8) /portal/doctor/analytics — a COMPLETED case still names the patient', async () => {
        const r = await drive([caseRow({ status: 'COMPLETED', completed_at: '2026-09-05T10:00:00.000Z' })]);
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        const rows = (r.res.payload && r.res.payload.recentCases) || [];
        if (!rows.length) return 'the analytics page rendered no rows';
        if (allStrings(rows).join(' ').indexOf(SECRET.name) === -1) return 'the doctor lost the patient name on a case they completed';
        return null;
      });
    } finally {
      restore();
    }
  })();

  // ═══ (9) the annotations API ═════════════════════════════════════════════
  // Fix round 1, adversarial review C2. userCanViewCase asked `order.doctor_id
  // === user.id` — assignment, not acceptance — and three GETs rode it, one of
  // which returns annotated_image_data: the patient's actual scan with the
  // previous doctor's markup. Reachable because a REASSIGNED -> ASSIGNED
  // transition sets the new doctor_id with accepted_at = null while the
  // case_annotations rows survive.
  await (async function annotationsSurface() {
    const R = (p) => require.resolve(path.join(SRC, p));
    const PG = R('pg.js'); const LOGGER = R('logger.js'); const ANN = R('routes/annotations.js');
    const swapped = [PG, LOGGER, ANN];
    let realPg, realLogger;
    try { realPg = require(PG); realLogger = require(LOGGER); }
    catch (e) { t.fail('(9) the annotations module deps load', e); return; }
    const saved = {};
    for (const p of swapped) saved[p] = require.cache[p];
    const restore = () => { for (const p of swapped) { if (saved[p]) require.cache[p] = saved[p]; else delete require.cache[p]; } };

    let scn = null;
    const SCAN = 'data:image/png;base64,' + Buffer.from(SECRET.record).toString('base64');
    const answerOne = async (sql) => {
      const s = norm(sql);
      if (/FROM case_annotations/.test(s)) {
        return {
          id: 'ann-1', case_id: 'ord-a4', image_id: 'img-1', doctor_id: 'doc-9',
          doctor_name: 'Dr Previous', annotation_data: '{}', annotations_count: 2,
          annotated_image_data: SCAN,
        };
      }
      if (/FROM orders_active/.test(s)) {
        if (/doctor_id = \$2/.test(s)) {
          return String(scn.order.doctor_id || '') === 'doc-1' ? scn.order : null;
        }
        return scn.order;
      }
      return null;
    };
    const answerAll = async (sql) => {
      if (/FROM case_annotations/.test(norm(sql))) {
        return [{ id: 'ann-1', image_id: 'img-1', doctor_id: 'doc-9', annotations_count: 2, doctor_name: 'Dr Previous' }];
      }
      return [];
    };
    fakeModule(PG, Object.assign({}, realPg, { queryOne: answerOne, queryAll: answerAll, execute: async () => ({ rowCount: 0 }) }));
    fakeModule(LOGGER, Object.assign({}, realLogger, { logErrorToDb: () => {} }));

    try {
      let router = null;
      try { delete require.cache[ANN]; router = require(ANN); }
      catch (e) { t.fail('(9) routes/annotations.js loads hermetically', e); restore(); return; }
      const pick = (p, method) => {
        const layer = router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]);
        return layer ? layer.route.stack[layer.route.stack.length - 1].handle : null;
      };
      const byCase = pick('/api/annotations/case/:caseId', 'get');
      const byImage = pick('/api/annotations/:imageId', 'get');
      const image = pick('/api/annotations/:imageId/image', 'get');
      const save = pick('/api/annotations/save', 'post');
      if (!byCase || !byImage || !image || !save) {
        t.fail('(9) the annotation handlers are pluckable', new Error('one of the annotation routes is not on router.stack'));
        restore(); return;
      }

      const drive = async (handler, order, reqOver) => {
        scn = { order };
        const req = Object.assign({
          params: { caseId: 'ord-a4', imageId: 'img-1' },
          user: { id: 'doc-1', role: 'doctor' },
          originalUrl: '/api/annotations', method: 'GET', requestId: 'req-a4', query: {}, body: {},
        }, reqOver || {});
        const res = {
          locals: {}, statusCode: 200, payload: null, sent: null,
          status(c) { this.statusCode = c; return this; },
          json(o) { this.payload = o; return this; },
          send(b) { this.sent = b; return this; },
          set() { return this; },
          render(v, p) { this.view = v; this.payload = p; return this; },
        };
        let threw = null;
        try { await handler(req, res, (e) => { if (e) threw = e; }); } catch (e) { threw = e; }
        return { res, threw };
      };

      const assigned = order({ doctor_id: 'doc-1', status: 'ASSIGNED' });
      const accepted = order({ doctor_id: 'doc-1', status: 'IN_REVIEW' });

      await checkAsync('(9) GET /api/annotations/case/:caseId — a doctor ASSIGNED but not accepted cannot enumerate the case annotations', async () => {
        const r = await drive(byCase, assigned);
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        if (r.res.statusCode !== 403) return 'answered ' + r.res.statusCode + ' with ' + JSON.stringify(r.res.payload);
        return null;
      });

      await checkAsync('(9) GET /api/annotations/:imageId/image — a doctor ASSIGNED but not accepted cannot pull the patient\'s annotated scan', async () => {
        const r = await drive(image, assigned);
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        if (r.res.statusCode !== 403) return 'answered ' + r.res.statusCode + ' — the patient\'s scan was served to a doctor who has accepted nothing';
        if (Buffer.isBuffer(r.res.sent)) return 'image bytes were sent anyway';
        return null;
      });

      await checkAsync('(9) GET /api/annotations/:imageId — a doctor ASSIGNED but not accepted is refused', async () => {
        const r = await drive(byImage, assigned);
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        if (r.res.statusCode !== 403) return 'answered ' + r.res.statusCode + ' with ' + JSON.stringify(r.res.payload);
        return null;
      });

      await checkAsync('(9) POST /api/annotations/save — a doctor ASSIGNED but not accepted cannot write on the patient\'s scan either', async () => {
        const r = await drive(save, assigned, { method: 'POST', body: { imageId: 'img-1', caseId: 'ord-a4', annotationState: {}, annotatedImage: SCAN, objectCount: 1 } });
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        if (r.res.statusCode !== 403) return 'answered ' + r.res.statusCode + ' with ' + JSON.stringify(r.res.payload);
        return null;
      });

      await checkAsync('(9) the doctor who ACCEPTED still reads the annotations and the annotated image', async () => {
        const list = await drive(byCase, accepted);
        if (list.threw) return 'list handler threw: ' + (list.threw.message || list.threw);
        if (list.res.statusCode !== 200) return 'the accepting doctor was refused the annotation list (' + list.res.statusCode + ')';
        const img = await drive(image, accepted);
        if (img.threw) return 'image handler threw: ' + (img.threw.message || img.threw);
        if (img.res.statusCode !== 200) return 'the accepting doctor was refused the annotated image (' + img.res.statusCode + ')';
        if (!Buffer.isBuffer(img.res.sent)) return 'the accepting doctor got no image bytes';
        return null;
      });

      await checkAsync('(9) the PATIENT who owns the case still reads their own annotations', async () => {
        const r = await drive(byCase, order({ doctor_id: 'doc-1', status: 'IN_REVIEW' }), { user: { id: 'pat-1', role: 'patient' } });
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        if (r.res.statusCode !== 200) return 'the patient lost access to their own case annotations (' + r.res.statusCode + ')';
        return null;
      });
    } finally {
      restore();
    }
  })();

  // ═══ (10) the report download ════════════════════════════════════════════
  // Fix round 1, adversarial review I1. userCanViewCase asked `doctor_id ===
  // user.id`, and /download-report deliberately exempts doctors from the
  // delivered-status gate, so on a delivered-then-reassigned case the new
  // doctor could fetch orders.report_url before accepting anything.
  await (async function reportSurface() {
    const R = (p) => require.resolve(path.join(SRC, p));
    const PG = R('pg.js'); const LOGGER = R('logger.js'); const STORAGE = R('storage.js');
    const REP = R('routes/reports.js');
    const swapped = [PG, LOGGER, STORAGE, REP];
    let realPg, realLogger, realStorage;
    try { realPg = require(PG); realLogger = require(LOGGER); realStorage = require(STORAGE); }
    catch (e) { t.fail('(10) the reports module deps load', e); return; }
    const saved = {};
    for (const p of swapped) saved[p] = require.cache[p];
    const restore = () => { for (const p of swapped) { if (saved[p]) require.cache[p] = saved[p]; else delete require.cache[p]; } };

    let scn = null;
    const answerOne = async (sql) => {
      const s = norm(sql);
      if (/FROM orders_active/.test(s)) return scn.order;
      if (/FROM report_exports/.test(s)) return null;
      return null;
    };
    fakeModule(PG, Object.assign({}, realPg, { queryOne: answerOne, queryAll: async () => [], execute: async () => ({ rowCount: 0 }) }));
    fakeModule(LOGGER, Object.assign({}, realLogger, { logErrorToDb: () => {} }));
    fakeModule(STORAGE, Object.assign({}, realStorage, { getSignedDownloadUrl: async () => 'https://signed.example/report.pdf' }));

    try {
      let handler = null;
      try {
        delete require.cache[REP];
        const router = require(REP);
        const layer = router.stack.find((l) => l.route && l.route.path === '/portal/case/:caseId/download-report' && l.route.methods.get);
        if (!layer) throw new Error('GET /portal/case/:caseId/download-report not on router.stack');
        handler = layer.route.stack[layer.route.stack.length - 1].handle;
      } catch (e) { t.fail('(10) the download-report handler is pluckable', e); restore(); return; }

      const REPORT_KEY = 'reports/' + SECRET.name + '.pdf';
      const drive = async (o, user) => {
        scn = { order: o };
        const req = {
          params: { caseId: 'ord-a4' }, query: {}, body: {},
          user: user || { id: 'doc-1', role: 'doctor' },
          originalUrl: '/portal/case/ord-a4/download-report', method: 'GET', requestId: 'req-a4',
        };
        const res = {
          locals: {}, statusCode: 200, payload: null, sent: null, redirected: null, view: null,
          status(c) { this.statusCode = c; return this; },
          send(b) { this.sent = b; return this; },
          json(o2) { this.payload = o2; return this; },
          render(v, p) { this.view = v; this.payload = p; return this; },
          redirect(a, b) { this.redirected = (b === undefined ? a : b); return this; },
          set() { return this; },
        };
        let threw = null;
        try { await handler(req, res, (e) => { if (e) threw = e; }); } catch (e) { threw = e; }
        return { res, threw };
      };

      await checkAsync('(10) GET /download-report — a doctor ASSIGNED but not accepted cannot fetch the report of a delivered-then-reassigned case', async () => {
        const r = await drive(order({ doctor_id: 'doc-1', status: 'ASSIGNED', report_url: REPORT_KEY }));
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        if (r.res.statusCode !== 403) return 'answered ' + r.res.statusCode + ' (redirect=' + r.res.redirected + ')';
        if (r.res.redirected) return 'the report was served anyway: ' + r.res.redirected;
        return null;
      });

      await checkAsync('(10) GET /download-report — the doctor who DELIVERED it keeps their own report (status "completed")', async () => {
        const r = await drive(order({ doctor_id: 'doc-1', status: 'COMPLETED', report_url: REPORT_KEY }));
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        if (!r.res.redirected) return 'the delivering doctor was refused their own report (' + r.res.statusCode + ')';
        return null;
      });

      await checkAsync('(10) GET /download-report — no over-blocking on the other spellings of delivered ("done", "delivered")', async () => {
        for (const st of ['done', 'delivered', 'report_ready']) {
          const r = await drive(order({ doctor_id: 'doc-1', status: st, report_url: REPORT_KEY }));
          if (r.threw) return st + ': handler threw: ' + (r.threw.message || r.threw);
          if (!r.res.redirected) return 'a doctor lost the report of their own case in status "' + st + '" (' + r.res.statusCode + ')';
        }
        return null;
      });

      await checkAsync('(10) GET /download-report — the doctor mid-review still downloads the draft, and the PATIENT is unaffected', async () => {
        const mine = await drive(order({ doctor_id: 'doc-1', status: 'IN_REVIEW', report_url: REPORT_KEY }));
        if (mine.threw) return 'handler threw: ' + (mine.threw.message || mine.threw);
        if (!mine.res.redirected) return 'the accepting doctor lost pre-delivery access to the PDF they are about to submit';
        const pat = await drive(order({ doctor_id: 'doc-1', status: 'COMPLETED', report_url: REPORT_KEY }), { id: 'pat-1', role: 'patient' });
        if (pat.threw) return 'handler threw: ' + (pat.threw.message || pat.threw);
        if (!pat.res.redirected) return 'the patient lost their own delivered report (' + pat.res.statusCode + ')';
        return null;
      });
    } finally {
      restore();
    }
  })();

  // ═══ (11) the video appointment surfaces ═════════════════════════════════
  // Fix round 1, adversarial review I2. appointments.doctor_id is bound to
  // orders.doctor_id at booking time — the ASSIGNED doctor — and the doctor
  // appointments board selected u_pat.name and u_pat.email straight off it.
  await (async function videoSurface() {
    const R = (p) => require.resolve(path.join(SRC, p));
    const PG = R('pg.js'); const LOGGER = R('logger.js'); const VID = R('routes/video.js');
    const swapped = [PG, LOGGER, VID];
    let realPg, realLogger;
    try { realPg = require(PG); realLogger = require(LOGGER); }
    catch (e) { t.fail('(11) the video module deps load', e); return; }
    const saved = {};
    for (const p of swapped) saved[p] = require.cache[p];
    const restore = () => { for (const p of swapped) { if (saved[p]) require.cache[p] = saved[p]; else delete require.cache[p]; } };

    const SOON = new Date(Date.now() + 36 * 3600 * 1000).toISOString();
    let scn = null;
    // The appointments TABLE carries no patient_name / patient_email columns —
    // see the INSERT in POST /portal/video/book. They are join aliases that
    // only the board query adds, so `SELECT * FROM appointments` must answer
    // with the core row here or the fixture would invent a leak the real query
    // cannot produce. The identity a detail page renders comes from its own
    // users lookup below, which is the real vector.
    const appointmentCore = () => ({
      id: 'apt-1', order_id: 'ord-a4', doctor_id: 'doc-1', patient_id: 'pat-1',
      specialty_id: 'spec-cardio', scheduled_at: SOON, status: 'pending_doctor',
      price: 0, currency: 'EGP', video_call_id: null, payment_id: null,
      rescheduled_from: null, doctor_proposed_time: null,
    });
    const appointmentBoardRow = () => Object.assign(appointmentCore(), {
      patient_name: SECRET.name, patient_email: SECRET.email, service_name: 'ECG review',
      // the acceptance facts the board must consult, however it spells them
      case_status: scn && scn.order ? scn.order.status : null,
      case_doctor_id: scn && scn.order ? scn.order.doctor_id : null,
      order_status: scn && scn.order ? scn.order.status : null,
      order_doctor_id: scn && scn.order ? scn.order.doctor_id : null,
    });
    const answerOne = async (sql, params) => {
      const s = norm(sql);
      if (/FROM appointments WHERE id = \$1/.test(s)) return appointmentCore();
      if (/FROM orders_active/.test(s)) return scn.order;
      if (/FROM users WHERE id = \$1/.test(s)) {
        const who = (params && params[0]) || '';
        if (String(who) === 'doc-1') return { id: 'doc-1', name: 'Dr Me', email: 'dr@example.com', specialty_id: 'spec-cardio' };
        return { id: 'pat-1', name: SECRET.name, email: SECRET.email };
      }
      if (/FROM doctor_earnings/.test(s)) return { total: 0 };
      if (/COUNT\(\*\)/.test(s)) return { count: 0 };
      if (/FROM video_calls/.test(s)) return null;
      if (/FROM appointment_payments/.test(s)) return null;
      return null;
    };
    const answerAll = async (sql) => {
      if (/FROM appointments/.test(norm(sql))) return [appointmentBoardRow()];
      return [];
    };
    fakeModule(PG, Object.assign({}, realPg, {
      queryOne: answerOne, queryAll: answerAll,
      execute: async () => ({ rowCount: 0 }), withTransaction: async () => null,
    }));
    fakeModule(LOGGER, Object.assign({}, realLogger, { logErrorToDb: () => {} }));

    try {
      let board = null; let detail = null;
      try {
        delete require.cache[VID];
        const router = require(VID);
        const pick = (p, method) => {
          const layer = router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]);
          return layer ? layer.route.stack[layer.route.stack.length - 1].handle : null;
        };
        board = pick('/portal/doctor/appointments', 'get');
        detail = pick('/portal/video/appointment/:id', 'get');
        if (!board) throw new Error('GET /portal/doctor/appointments not on router.stack');
        if (!detail) throw new Error('GET /portal/video/appointment/:id not on router.stack');
      } catch (e) { t.fail('(11) the video handlers are pluckable', e); restore(); return; }

      const drive = async (handler, o, reqOver) => {
        scn = { order: o };
        const req = Object.assign({
          params: { id: 'apt-1', appointmentId: 'apt-1' },
          user: { id: 'doc-1', role: 'doctor' },
          cookies: {}, query: {}, body: {},
          originalUrl: '/portal/doctor/appointments', method: 'GET', requestId: 'req-a4',
        }, reqOver || {});
        const res = {
          locals: {}, statusCode: 200, view: null, payload: null, sent: null,
          status(c) { this.statusCode = c; return this; },
          render(v, p) { this.view = v; this.payload = p; return this; },
          send(b) { this.sent = b; return this; },
          json(o2) { this.payload = o2; return this; },
          redirect(u) { this.redirected = u; return this; },
          set() { return this; },
        };
        let threw = null;
        try { await handler(req, res, (e) => { if (e) threw = e; }); } catch (e) { threw = e; }
        return { res, threw };
      };

      await checkAsync('(11) /portal/doctor/appointments — an appointment on a case ASSIGNED but not accepted shows neither the patient\'s name nor their email', async () => {
        const r = await drive(board, order({ doctor_id: 'doc-1', status: 'ASSIGNED' }));
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        if (!r.res.payload) return 'nothing was rendered';
        const rows = r.res.payload.appointments || [];
        if (!rows.length) return 'the board rendered no appointments, so this assertion proves nothing';
        const leaked = leakedSecrets(r.res.payload, { name: SECRET.name, email: SECRET.email });
        if (leaked.length) return 'the doctor appointments board still carries: ' + leaked.join(', ');
        return null;
      });

      await checkAsync('(11) /portal/doctor/appointments — the doctor who ACCEPTED the case still sees who they are meeting, and the board still works', async () => {
        const r = await drive(board, order({ doctor_id: 'doc-1', status: 'IN_REVIEW' }));
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        const rows = (r.res.payload && r.res.payload.appointments) || [];
        if (!rows.length) return 'the board rendered no appointments';
        if (allStrings(r.res.payload).join(' ').indexOf(SECRET.name) === -1) {
          return 'the accepting doctor lost the name of the patient they are about to meet';
        }
        if (!rows[0].scheduled_at || rows[0].status !== 'pending_doctor') {
          return 'the appointment row lost the facts the board is for: ' + JSON.stringify(rows[0]);
        }
        return null;
      });

      await checkAsync('(11) /portal/video/appointment/:id — the detail page withholds the patient from a doctor who has accepted nothing, and shows them once accepted', async () => {
        const pre = await drive(detail, order({ doctor_id: 'doc-1', status: 'ASSIGNED' }), { originalUrl: '/portal/video/appointment/apt-1' });
        if (pre.threw) return 'handler threw: ' + (pre.threw.message || pre.threw);
        const leaked = leakedSecrets(pre.res.payload || {}, { name: SECRET.name, email: SECRET.email });
        if (leaked.length) return 'the appointment detail page still carries: ' + leaked.join(', ');
        const post = await drive(detail, order({ doctor_id: 'doc-1', status: 'IN_REVIEW' }), { originalUrl: '/portal/video/appointment/apt-1' });
        if (post.threw) return 'handler threw: ' + (post.threw.message || post.threw);
        if (allStrings(post.res.payload || {}).join(' ').indexOf(SECRET.name) === -1) {
          return 'the accepting doctor lost the patient on their own appointment';
        }
        return null;
      });
    } finally {
      restore();
    }
  })();

  // ═══ (7) no surface left behind ══════════════════════════════════════════
  check('(7) every doctor-facing case surface authorises on ACCEPTANCE, not on "orders.doctor_id is me" (assignDoctor sets doctor_id BEFORE the doctor accepts)', () => {
    const SURFACES = [
      ['case page + intelligence view', 'src/routes/doctor.js'],
      ['patient-records JSON', 'src/routes/medical_records.js'],
      ['/api/cases/:id/intelligence JSON', 'src/routes/order_flow.js'],
      ['prescribe page + prescribe POST', 'src/routes/prescriptions.js'],
      ['doctor analytics', 'src/routes/analytics.js'],
      ['annotations API', 'src/routes/annotations.js'],
      ['report view / download / generate / email', 'src/routes/reports.js'],
      ['video appointments', 'src/routes/video.js'],
    ];
    const missing = SURFACES.filter(([, rel]) => !/doctor_case_access/.test(code(rel)));
    if (missing.length) {
      return missing.map(([l]) => l).join(', ') + ' — this surface does not go through the shared entitlement rule';
    }
    return null;
  });

  // Fix round 1, spec review I1. The file's own comments state the principle
  // twice ("gating only the GET would leave the POST openly craftable") and
  // then the acceptance gate was added to the GET alone.
  check('(7) the prescribe POST is gated too — gating only the GET leaves the POST craftable', () => {
    const src = code('src/routes/prescriptions.js');
    const i = src.indexOf("router.post('/portal/doctor/case/:caseId/prescribe'");
    if (i < 0) return 'the prescribe POST is gone from prescriptions.js';
    const body = src.slice(i, src.indexOf('\nrouter.', i + 10));
    if (!/doctorHasAcceptedCase\s*\(/.test(body)) {
      return 'POST /prescribe never asks whether this doctor ACCEPTED the case, and its no-medications-and-no-file path re-renders doctor_prescribe with the patient name, email, date of birth and sex plus the whole order row';
    }
    return null;
  });

  // Fix round 1, adversarial review I2 + this fixer's own sweep. Every video
  // surface that renders the other party's name or email to a DOCTOR is an
  // identity surface on a case, and appointments.doctor_id is bound to
  // orders.doctor_id at booking time — the ASSIGNED doctor, not the accepting
  // one.
  check('(7) every video surface that renders the patient to a doctor asks about acceptance', () => {
    const src = code('src/routes/video.js');
    const ROUTES = [
      "'/portal/doctor/appointments'",
      "'/portal/video/appointment/:id'",
      "'/portal/video/call/:appointmentId'",
      "'/portal/video/ended/:appointmentId'",
    ];
    for (const marker of ROUTES) {
      const i = src.indexOf('router.get(' + marker);
      if (i < 0) return marker + ' is gone from video.js';
      const body = src.slice(i, src.indexOf('\nrouter.', i + 10));
      if (!/doctorHasAcceptedCase|doctorHasAcceptedOrder/.test(body)) {
        return 'GET ' + marker + ' renders the patient to a doctor without asking whether that doctor accepted the case';
      }
    }
    return null;
  });

  check('(7) the case payload gates history and medications on acceptance (the question alone is the pre-accept brief)', () => {
    const src = code('src/routes/doctor.js');
    const i = src.indexOf("router.get('/portal/doctor/case/:caseId'");
    if (i < 0) return 'the case handler is gone';
    const body = src.slice(i, src.indexOf('\nrouter.', i + 10));
    const m = body.match(/clinicalContext/g) || [];
    if (!m.length) return 'clinicalContext is gone entirely — the ACCEPTING doctor still needs it';
    if (/clinicalContext:\s*\{\s*\n?\s*question:/.test(body)) {
      return 'clinicalContext is built inline in the payload literal — the pre/post-accept split above it is what keeps history out of the offer';
    }
    // Batch A (fix plan 2026-09-15): the pre-accept branch may carry ONLY the
    // question; history and medications must sit in the showFullCase branch.
    if (!/!showFullCase\s*\?\s*\{\s*question:/.test(body.replace(/\n/g, ' ').replace(/\s+/g, ' '))) {
      return 'the pre-accept clinicalContext branch no longer carries exactly the question — the offer brief must show it, and nothing else';
    }
    return null;
  });
})();
