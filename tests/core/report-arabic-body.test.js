// tests/core/report-arabic-body.test.js
//
// Migration 117 — the Arabic report body.
//
// The delivered PDF printed Arabic section HEADINGS over an English body; the
// doctor app composes an Arabic version of each section. These tests pin:
//
//   1. report-generator.js renders the Arabic block under each of the three
//      section bodies ONLY when there is Arabic text AND the Arabic face
//      resolved, right-aligned, through the same notesBox pagination as the
//      English body; the legacy fallback path is untouched.
//   2. persistReportText's UPDATE carries the _ar columns only when they were
//      passed (an English-only save never touches the Arabic text), the
//      approval timestamp is set-once / cleared, and buildReportDraftFieldsAr
//      reads '' / false off a row without them.
//   3. submitDoctorReport forwards findingsAr / impressionAr /
//      recommendationsAr into generateMedicalReportPdf, from the stored
//      columns when the caller sent nothing and from the args when it did.
//
// Hermetic: pg helpers are stubbed by assignment on the REAL module object
// BEFORE report_submission is first required (it destructures them at load);
// the PDF generator is stubbed on its real module (read lazily at call time).
'use strict';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'report-arabic-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '../..');
const pg = require(path.join(ROOT, 'src/pg'));

// ── pg stubs, installed before the service loads ──────────────
const ORDER_COLUMNS = [
  'id', 'status', 'doctor_id', 'patient_id', 'updated_at', 'completed_at', 'created_at', 'specialty_id', 'service_id',
  'diagnosis_text', 'impression_text', 'recommendation_text', 'report_url',
  'diagnosis_text_ar', 'impression_text_ar', 'recommendation_text_ar', 'report_ar_approved_at',
];
const state = { columns: ORDER_COLUMNS, executes: [], order: null, executeResult: { rowCount: 1 } };

const realQueryAll = pg.queryAll, realExecute = pg.execute, realQueryOne = pg.queryOne;
pg.queryAll = async (sql) => {
  if (/information_schema\.columns/.test(sql)) return state.columns.map((name) => ({ name }));
  return [];
};
pg.execute = async (sql, params) => { state.executes.push([sql, params]); return state.executeResult; };
pg.queryOne = async (sql) => {
  if (/FROM orders_active WHERE id/.test(sql)) return state.order;
  return null;
};
test.after(() => { pg.queryAll = realQueryAll; pg.execute = realExecute; pg.queryOne = realQueryOne; });

const service = require(path.join(ROOT, 'src/services/report_submission'));
const generator = require(path.join(ROOT, 'src/report-generator'));

// ── 1. the generator ──────────────────────────────────────────
const GEN = fs.readFileSync(path.join(ROOT, 'src/report-generator.js'), 'utf8');

test('the styled generator accepts the Arabic body and renders it under each section body, and only there', () => {
  assert.match(GEN, /findingsAr, impressionAr, recommendationsAr/, 'signature takes the three Arabic fields');
  const unicode = GEN.slice(GEN.indexOf('async function generateStyledReportPdfUnicode'), GEN.indexOf('async function generateStyledReportPdfLegacy'));
  // one arabicBodyBox directly after each of the three English boxes
  assert.match(unicode, /notesBox\(sections\.findings\);\s*\n\s*arabicBodyBox\(arabicBody\.findings\);/);
  assert.match(unicode, /notesBox\(sections\.impression \|\| '—'\);\s*\n\s*arabicBodyBox\(arabicBody\.impression\);/);
  assert.match(unicode, /notesBox\(sections\.recommendations \|\| '—'\);\s*\n\s*arabicBodyBox\(arabicBody\.recommendations\);/);
  assert.equal((unicode.match(/arabicBodyBox\(arabicBody\./g) || []).length, 3, 'the disclaimer and signature get no Arabic body');
  // the legacy renderer knows nothing of it
  const legacy = GEN.slice(GEN.indexOf('async function generateStyledReportPdfLegacy'), GEN.indexOf('async function generateMedicalReportPdf'));
  assert.ok(!/arabicBodyBox|findingsAr/.test(legacy), 'fallback path unchanged');
});

test('arabicBodyBox is a no-op without Arabic text or without the Arabic font, and otherwise a right-aligned notesBox', () => {
  const fn = GEN.slice(GEN.indexOf('function arabicBodyBox('), GEN.indexOf('// Patient\n'));
  assert.match(fn, /if \(!text \|\| !arabicFontPath\) return false;/, 'gate: text present AND font resolved');
  assert.match(fn, /notesBox\(text, \{ rtl: true \}\)/, 'same paginating box renderer, right-to-left');
  // the rtl flag forces right alignment for the Latin lines too, and Arabic
  // lines still get the heading's arabicLabel shaping + the Arabic face.
  const box = GEN.slice(GEN.indexOf('function notesBox(textBody, opts)'), GEN.indexOf('function arabicBodyBox('));
  assert.match(box, /const rtl = !!\(opts && opts\.rtl\);/);
  assert.match(box, /doc\.text\(arabicLabel\(ln\.text\), x0 \+ 10, ty, \{ width: innerW, align: 'right', features: \['rtla'\] \}\)/);
  assert.match(box, /else if \(rtl\) \{\s*\n\s*doc\.text\(ln\.text, x0 \+ 10, ty, \{ width: innerW, align: 'right' \}\);/);
  // the English box's own call has no rtl and is unchanged in behaviour
  assert.match(box, /\} else \{\s*\n\s*doc\.text\(ln\.text, x0 \+ 10, ty, \{ width: innerW \}\);/);
});

test('generateMedicalReportPdf passes the Arabic fields through its normalisation untouched', () => {
  const entry = GEN.slice(GEN.indexOf('async function generateMedicalReportPdf'));
  assert.match(entry, /const normalized = \{\s*\n\s*\.\.\.p,/, 'the payload is spread, so findingsAr et al. reach the styled generator');
});

// ── 2. persistReportText ──────────────────────────────────────
function lastUpdate() {
  const [sql, params] = state.executes[state.executes.length - 1];
  return { sql: sql.replace(/\s+/g, ' '), params };
}

test('persistReportText: an English-only save never mentions an _ar column', async () => {
  state.executes = [];
  const n = await service.persistReportText({ orderId: 'ord-1', diagnosisText: 'F', impressionText: 'I', recommendationsText: 'R' });
  assert.equal(n, 1);
  const { sql, params } = lastUpdate();
  assert.match(sql, /^UPDATE orders SET diagnosis_text = \$1, impression_text = \$2, recommendation_text = \$3, updated_at = \$4 WHERE id = \$5/);
  assert.ok(!/_ar/.test(sql), sql);
  assert.deepEqual(params.slice(0, 3), ['F', 'I', 'R']);
  assert.equal(params[4], 'ord-1');
  assert.match(sql, /NOT IN \('completed', 'done', 'finished', 'cancelled'/, 'the terminal-status guard is the same one');
});

test('persistReportText: only the Arabic fields that were passed join the UPDATE; empty string clears to NULL', async () => {
  state.executes = [];
  await service.persistReportText({ orderId: 'ord-1', diagnosisText: 'F', impressionText: 'I', recommendationsText: 'R', impressionTextAr: ' انطباع ' });
  let u = lastUpdate();
  assert.match(u.sql, /recommendation_text = \$3, impression_text_ar = \$4, updated_at = \$5 WHERE id = \$6/);
  assert.ok(!/diagnosis_text_ar|recommendation_text_ar|report_ar_approved_at/.test(u.sql));
  assert.equal(u.params[3], 'انطباع');

  state.executes = [];
  await service.persistReportText({
    orderId: 'ord-1', diagnosisText: 'F', impressionText: 'I', recommendationsText: 'R',
    diagnosisTextAr: 'نتائج', impressionTextAr: '', recommendationsTextAr: 'توصيات',
  });
  u = lastUpdate();
  assert.match(u.sql, /diagnosis_text_ar = \$4, impression_text_ar = \$5, recommendation_text_ar = \$6, updated_at = \$7 WHERE id = \$8/);
  assert.deepEqual(u.params.slice(3, 6), ['نتائج', null, 'توصيات']);
  assert.equal(u.params[7], 'ord-1');
});

test('persistReportText: arabicApproved true is set-once (COALESCE), false clears, undefined leaves it alone', async () => {
  state.executes = [];
  await service.persistReportText({ orderId: 'ord-1', diagnosisText: 'F', impressionText: 'I', recommendationsText: 'R', arabicApproved: true });
  let u = lastUpdate();
  assert.match(u.sql, /report_ar_approved_at = COALESCE\(report_ar_approved_at, \$4\), updated_at = \$5 WHERE id = \$6/);
  assert.ok(Date.parse(u.params[3]) > 0, 'a timestamp');

  state.executes = [];
  await service.persistReportText({ orderId: 'ord-1', diagnosisText: 'F', impressionText: 'I', recommendationsText: 'R', arabicApproved: false });
  u = lastUpdate();
  assert.match(u.sql, /report_ar_approved_at = NULL, updated_at = \$4 WHERE id = \$5/);
  assert.equal(u.params.length, 5);
});

test('buildReportDraftFieldsAr reads the four fields, trimmed, and is empty / false on a row without them', () => {
  assert.deepEqual(service.buildReportDraftFieldsAr({}), { findings_ar: '', impression_ar: '', recommendation_ar: '', arabic_approved: false });
  assert.deepEqual(service.buildReportDraftFieldsAr(null), { findings_ar: '', impression_ar: '', recommendation_ar: '', arabic_approved: false });
  assert.deepEqual(
    service.buildReportDraftFieldsAr({ diagnosis_text_ar: ' أ ', impression_text_ar: 'ب', recommendation_text_ar: null, report_ar_approved_at: '2026-09-24T10:00:00Z' }),
    { findings_ar: 'أ', impression_ar: 'ب', recommendation_ar: '', arabic_approved: true }
  );
  // the English parser is untouched by the new columns
  assert.deepEqual(
    service.buildReportDraftFields({ diagnosis_text: 'F', impression_text: 'I', recommendation_text: 'R', diagnosis_text_ar: 'أ' }),
    { findings: 'F', impression: 'I', recommendations: 'R' }
  );
});

// ── 3. submitDoctorReport → generateMedicalReportPdf ─────────
test('submitDoctorReport hands the Arabic body to the PDF: stored columns by default, the caller\'s text when sent', async () => {
  const realGen = generator.generateMedicalReportPdf;
  let pdfArgs = null;
  // Capture, then fail: the run stops at report_pdf_failed and nothing after
  // the PDF (transaction, notifications) is reached.
  generator.generateMedicalReportPdf = async (args) => { pdfArgs = args; throw new Error('stop here'); };
  const realLog = require(path.join(ROOT, 'src/logger')).logErrorToDb;
  require(path.join(ROOT, 'src/logger')).logErrorToDb = () => {};
  try {
    state.order = {
      id: 'ord-1', doctor_id: 'doc_1', patient_id: 'pat_1', status: 'in_review', created_at: '2026-09-01T00:00:00Z',
      diagnosis_text: 'F', impression_text: 'I', recommendation_text: 'R',
      diagnosis_text_ar: 'نتائج مخزنة', impression_text_ar: 'انطباع مخزن', recommendation_text_ar: '', report_ar_approved_at: null,
    };

    // nothing Arabic sent -> stored Arabic, and the persist UPDATE is English-only
    state.executes = [];
    let r = await service.submitDoctorReport({ orderId: 'ord-1', doctorId: 'doc_1', diagnosisText: 'F2', impressionText: 'I2', recommendationsText: 'R2' });
    assert.equal(r.ok, false); assert.equal(r.code, 'report_pdf_failed');
    assert.equal(pdfArgs.findingsAr, 'نتائج مخزنة');
    assert.equal(pdfArgs.impressionAr, 'انطباع مخزن');
    assert.equal(pdfArgs.recommendationsAr, '');
    assert.equal(pdfArgs.findings, 'F2');
    assert.ok(!/_ar/.test(state.executes[0][0]), 'English-only submit leaves the Arabic columns alone');

    // Arabic sent -> the caller's text wins, '' clears, and the persist UPDATE carries them
    state.executes = []; pdfArgs = null;
    r = await service.submitDoctorReport({
      orderId: 'ord-1', doctorId: 'doc_1', diagnosisText: 'F2', impressionText: 'I2', recommendationsText: 'R2',
      diagnosisTextAr: ' نتائج جديدة ', impressionTextAr: '', arabicApproved: true,
    });
    assert.equal(r.code, 'report_pdf_failed');
    assert.equal(pdfArgs.findingsAr, 'نتائج جديدة');
    assert.equal(pdfArgs.impressionAr, '', 'an explicit empty string is NOT overridden by the stored draft');
    assert.equal(pdfArgs.recommendationsAr, '', 'omitted -> stored (empty here)');
    const sql = state.executes[0][0].replace(/\s+/g, ' ');
    assert.match(sql, /diagnosis_text_ar = \$4, impression_text_ar = \$5, report_ar_approved_at = COALESCE\(report_ar_approved_at, \$6\)/);
    assert.ok(!/recommendation_text_ar/.test(sql), 'the section that was not sent is not written');
  } finally {
    generator.generateMedicalReportPdf = realGen;
    require(path.join(ROOT, 'src/logger')).logErrorToDb = realLog;
    state.order = null;
  }
});
