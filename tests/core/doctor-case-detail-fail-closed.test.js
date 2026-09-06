// tests/core/doctor-case-detail-fail-closed.test.js
//
// AUDIT-2026-09-06 (D1) — any doctor could read any abandoned patient's name
// and clinical brief.
//
// The case-detail guard in src/routes/doctor.js sorted a case into three
// buckets — accepted-by-me, unaccepted, assigned-to-another-doctor — and those
// three do not cover the status space. A status in NEITHER list on a case with
// doctor_id IS NULL matched none of them, so no 403 was raised and the payload
// ternary fell to its `else`, shipping the whole orders row to the template.
// Production reaches that state today: `expired_unpaid` and `cancelled` are in
// neither list and carry real patient names, dates of birth and clinical
// questions. The template then printed the name in an <h2> that sat OUTSIDE
// the `if (_canView)` gate starting on the next line.
//
// Two independent regressions are pinned here, because either alone would have
// been enough to leak:
//
//   1. the route is FAIL-CLOSED — full detail requires a positive match, and a
//      status nobody has heard of gets a 403, not the row;
//   2. the template never prints the patient's name unless it was told the
//      viewer may see it — checked by RENDERING the real template, not by
//      grepping it.
//
// No DB and no boot: (1) is a structural read of the source with comments
// stripped, (2) renders portal_doctor_case.ejs with plain locals.

'use strict';

const fs   = require('fs');
const path = require('path');
const ejs  = require('ejs');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🔒 doctor case detail is fail-closed (AUDIT-2026-09-06 D1)\n');

const ROOT   = path.join(__dirname, '..', '..');
const ROUTE  = path.join(ROOT, 'src', 'routes', 'doctor.js');
const VIEW   = path.join(ROOT, 'src', 'views', 'portal_doctor_case.ejs');

// ── 1. The route grants full detail only on a positive match ────────────────
try {
  const src = stripComments(fs.readFileSync(ROUTE, 'utf8'));

  // The one fact everything else hangs off.
  if (!/const\s+showFullCase\s*=\s*!!isAcceptedByThisDoctor\s*;/.test(src)) {
    throw new Error('showFullCase is no longer derived from isAcceptedByThisDoctor — ' +
                    'the case payload must be gated on "this doctor accepted it", ' +
                    'nothing weaker');
  }

  // The payload ternary. `!showFullCase ? redacted : full` means an
  // unrecognised status selects the redacted object; the old
  // `isUnaccepted ? redacted : full` meant it selected the full row.
  if (!/const\s+viewOrder\s*=\s*!showFullCase\s*\n?\s*\?/.test(src)) {
    throw new Error('the case payload is not selected fail-closed: viewOrder must be ' +
                    '`!showFullCase ? <redacted> : <full row>`, so redaction is the ' +
                    'default branch and the full orders row the exception');
  }

  // Template flags follow the same fact.
  if (!/blurred:\s*!showFullCase/.test(src) || !/canViewDetails:\s*showFullCase/.test(src)) {
    throw new Error('blurred / canViewDetails must both be driven by showFullCase');
  }

  t.pass('viewOrder, blurred and canViewDetails all derive from "this doctor accepted it"');
} catch (e) { t.fail('case payload is fail-closed', e); }

// ── 2. A status in neither bucket is refused, not rendered ──────────────────
try {
  const src = stripComments(fs.readFileSync(ROUTE, 'utf8'));

  if (!/const\s+isViewableByThisDoctor\s*=\s*isAcceptedByThisDoctor\s*\|\|\s*isUnaccepted\s*;/.test(src)) {
    throw new Error('isViewableByThisDoctor must name the ONLY two reasons a doctor may ' +
                    'see a case: they accepted it, or it is on offer to them');
  }

  if (!/if\s*\(\s*!isViewableByThisDoctor\s*\)\s*\{[\s\S]{0,300}?renderAccessDenied\(\s*'case_not_available'/.test(src)) {
    throw new Error('a case in an unrecognised status must be refused with a 403 ' +
                    '(renderAccessDenied "case_not_available"), never rendered');
  }

  // The refusal has to happen BEFORE the payload is assembled, or the row is
  // already in memory and one careless edit away from the template.
  const guardAt  = src.indexOf('!isViewableByThisDoctor');
  const payloadAt = src.indexOf('const viewOrder =');
  if (guardAt < 0 || payloadAt < 0 || guardAt > payloadAt) {
    throw new Error('the fail-closed refusal must run before viewOrder is built');
  }

  t.pass('an unrecognised status is 403 case_not_available, refused before the payload is built');
} catch (e) { t.fail('unrecognised status is refused', e); }

// ── 3. The template will not print a name it was not cleared to print ───────
//
// Rendered, not grepped: the previous leak was a single <h2> two lines above
// the gate, which every review of "is there a _canView check on this page?"
// answered yes to.
function renderCase(overrides) {
  const locals = Object.assign({
    tt: function (key, en, ar) { return locals.isAr ? (ar || en || key) : (en || key); },
    isAr: false,
    lang: 'en',
    user: { id: 'doc-1', role: 'doctor' },
    brand: 'Tashkheesa',
    title: 'Case Detail',
    portalFrame: true,
    portalRole: 'doctor',
    portalActive: 'queue',
    cspNonce: '',
    prescriptionsComingSoon: true,
    files: [],
    annotatedFiles: [],
    accessDenied: false,
    activeTab: 'cases',
    nextPath: '/portal/doctor/case/ord-1',
    acceptActionUrl: '/portal/doctor/case/ord-1/accept',
    clinicalContext: { question: '', medicalHistory: '', medications: '' },
    routingFacts: null,
    prescriptionAddon: null,
    rxFlash: null,
    prescriptionRequestUrl: '/portal/doctor/case/ord-1/request-prescription',
    showAcceptButton: false,
    acceptBlockedReason: null,
    isPaid: false,
    caseConversationId: null,
    fileAiChecks: {},
    pendingVideoAppt: null,
    streakCount: 0
  }, overrides);
  return ejs.render(fs.readFileSync(VIEW, 'utf8'), locals, { filename: VIEW });
}

// The exact production shape of the bug: an expired_unpaid row, unassigned,
// carrying a real name — i.e. what the old fail-open branch handed the view.
const LEAKY_ORDER = {
  id: 'ord-1234abcd-5678-90ef',
  status: 'expired_unpaid',
  patient_name: 'Mariam Hassan',
  patient_age: 41,
  patient_gender: 'female',
  service_name: 'MRI review',
  specialty_name: 'Radiology',
  created_at_human: '1 Jan 2026'
};

try {
  const html = renderCase({ order: LEAKY_ORDER, blurred: true, canViewDetails: false });

  if (/Mariam/.test(html) || /Hassan/.test(html)) {
    throw new Error('the case page printed the patient name to a doctor who is not ' +
                    'cleared to see the case — the <h2> title must be inside the ' +
                    '_canView gate, not above it');
  }
  // It still has to be a usable page: the doctor needs SOMETHING to quote to
  // support, so a blank header would be a different bug, not a fix.
  if (!/ORD-1234/i.test(html)) {
    throw new Error('with the name withheld the header must fall back to the case ' +
                    'reference, not to nothing');
  }
  t.pass('canViewDetails=false: patient name withheld, case reference shown instead');
} catch (e) { t.fail('name is withheld pre-accept', e); }

try {
  const html = renderCase({ order: LEAKY_ORDER, blurred: false, canViewDetails: true });
  if (!/Mariam Hassan/.test(html)) {
    throw new Error('the accepting doctor must still see the patient name — this gate ' +
                    'is about permission, not about hiding the name from everyone');
  }
  t.pass('canViewDetails=true: the accepting doctor still sees the patient name');
} catch (e) { t.fail('name is shown post-accept', e); }
