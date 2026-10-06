// tests/core/case-label.test.js
//
// E2E 2026-10-06 — what a case is called in a message a patient reads.
//
// Two production defects, both visible only by reading the messages:
//
//   1. "Case 8F83CD55-A06". ~25 call sites pass
//      String(orderId).slice(0, 12).toUpperCase() as `caseReference`, and the
//      email worker, the OpenClaw composer and the Meta param builders fell
//      back to the same slice. The patient's real reference is
//      orders.reference_id ("TSH-2026-000017").
//   2. "…complete payment for Your case…". One label, capitalised for a
//      sentence start, used mid-sentence too.
//
// The assertions that matter are the two sweeps at the bottom: across EVERY
// patient-facing template, on every surface, in both languages, with the worst
// payload a caller can send (an id slice as the reference), no id fragment and
// no "for Your case" comes out.
//
// No database: queueNotification is exercised in a subprocess with src/pg
// stubbed, the same shape as theme8-notification-dropped.

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
function expect(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'mismatch') + ': got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b)); }

console.log('\n🏷️  Case label — real reference only, sentence-aware\n');

const ROOT = path.join(__dirname, '..', '..');
const cl = require(path.join(ROOT, 'src', 'notify', 'case_label.js'));

const ORDER_ID = '8f83cd55-a06b-4c11-9d2e-3a5b7c9d1e2f';
const SLICE = ORDER_ID.slice(0, 12).toUpperCase();          // "8F83CD55-A06"
const REF = 'TSH-2026-000017';
// What must never reach a patient: the leading groups of a UUID, upper-cased.
const ID_FRAGMENT = /\b[0-9A-F]{8}-[0-9A-F]{3}\b/;

// ── 1. resolveCaseReference rejects anything shaped like an id ─────────────
try {
  eq(cl.resolveCaseReference({ caseReference: SLICE }), null, 'a 12-char id slice');
  eq(cl.resolveCaseReference({ caseReference: SLICE, case_id: ORDER_ID }), null, 'a slice of the payload case id');
  eq(cl.resolveCaseReference({ caseReference: ORDER_ID }), null, 'a full uuid');
  eq(cl.resolveCaseReference({ case_ref: ORDER_ID.slice(0, 8) }), null, 'an 8-char uuid prefix');
  eq(cl.resolveCaseReference({ caseReference: ORDER_ID.replace(/-/g, '').slice(0, 16) }), null, 'bare hex');
  eq(cl.resolveCaseReference({ caseReference: 'ORDER-ABC' }, { id: 'order-abcdef-123' }), null,
    'a prefix of a non-uuid order id');
  eq(cl.resolveCaseReference({ caseReference: '' }), null, 'empty');
  eq(cl.resolveCaseReference(null), null, 'null payload');

  eq(cl.resolveCaseReference({ caseReference: REF }), REF, 'a real reference in caseReference');
  eq(cl.resolveCaseReference({ reference_id: REF, caseReference: SLICE }), REF, 'reference_id wins over a slice');
  eq(cl.resolveCaseReference({ caseReference: SLICE, case_ref: REF }), REF, 'skips the slice, finds the real one');
  eq(cl.resolveCaseReference({ caseReference: SLICE }, { id: ORDER_ID, reference_id: REF }), REF,
    'the order row beats the payload');
  eq(cl.resolveCaseReference({}, { id: ORDER_ID, reference_id: null }), null, 'order with no reference yet');
  t.pass('resolveCaseReference: id slices / uuids / hex / order-id prefixes rejected; real reference returned');
} catch (e) { t.fail('resolveCaseReference', e); }

// ── 2. caseLabel is sentence-aware, in both languages ──────────────────────
try {
  eq(cl.caseLabel({ ref: REF, lang: 'en', position: 'start' }), 'Case ' + REF);
  eq(cl.caseLabel({ ref: REF, lang: 'en', position: 'mid' }), 'case ' + REF);
  eq(cl.caseLabel({ ref: REF, lang: 'en' }), 'case ' + REF, 'mid-sentence is the default');
  eq(cl.caseLabel({ ref: null, lang: 'en', position: 'start' }), 'Your case');
  eq(cl.caseLabel({ ref: null, lang: 'en', position: 'mid' }), 'your case');
  eq(cl.caseLabel({ ref: null, lang: 'en', voice: 'neutral' }), null, 'neutral EN has no universal fallback');

  eq(cl.caseLabel({ ref: REF, lang: 'ar' }), 'حالة ' + REF);
  eq(cl.caseLabel({ ref: null, lang: 'ar' }), 'حالتك');
  eq(cl.caseLabel({ ref: null, lang: 'ar', voice: 'neutral' }), 'الحالة');
  // The "ل" proclitic: fused, and never "لالحالة".
  eq(cl.caseLabel({ ref: REF, lang: 'ar', lam: true }), 'لحالة ' + REF);
  eq(cl.caseLabel({ ref: null, lang: 'ar', lam: true }), 'لحالتك');
  eq(cl.caseLabel({ ref: null, lang: 'ar', voice: 'neutral', lam: true }), 'للحالة');
  t.pass('caseLabel: Case/case, Your case/your case, حالة / حالتك / الحالة, ل-prefix forms');
} catch (e) { t.fail('caseLabel', e); }

// ── 3. applyCaseReference writes the keys every consumer reads ─────────────
try {
  const out = cl.applyCaseReference({ case_id: ORDER_ID, caseReference: SLICE, case_ref: SLICE, amount: 5 }, REF, {});
  eq(out.reference_id, REF); eq(out.caseReference, REF); eq(out.case_ref, REF); eq(out.amount, 5);
  const stripped = cl.applyCaseReference({ case_id: ORDER_ID, caseReference: SLICE }, null, { stripFake: true });
  expect(!('caseReference' in stripped) && stripped.case_id === ORDER_ID, 'a fake reference is removed for patient copy');
  const kept = cl.applyCaseReference({ case_id: ORDER_ID, caseReference: SLICE }, null, { stripFake: false });
  eq(kept.caseReference, SLICE, 'staff copy keeps its handle');
  const same = { case_id: ORDER_ID, reference_id: REF, caseReference: REF };
  expect(cl.applyCaseReference(same, REF, {}) === same, 'no change → same object (no needless rewrite)');
  t.pass('applyCaseReference: sets reference_id + caseReference, replaces slices, strips fakes for patients only');
} catch (e) { t.fail('applyCaseReference', e); }

// ── 4. In-app bodies: no id, no "for Your case", right capitalisation ──────
const { renderNotificationMessage } = require(path.join(ROOT, 'src', 'notify.js'));
const { getOpenClawBody, OPENCLAW_TEMPLATES } = require(path.join(ROOT, 'src', 'notify', 'openclawTemplates.js'));
const { whatsappTemplateMap } = require(path.join(ROOT, 'src', 'notify', 'whatsappTemplateMap.js'));
const { TEMPLATE_TITLES } = (function () {
  const m = require(path.join(ROOT, 'src', 'notify', 'notification_titles.js'));
  return { TEMPLATE_TITLES: m.TEMPLATE_TITLES || m.NOTIFICATION_TITLES || {} };
})();

// Every template name we know about, from all three registries.
const ALL_TEMPLATES = Array.from(new Set(
  Object.keys(OPENCLAW_TEMPLATES).concat(Object.keys(whatsappTemplateMap), Object.keys(TEMPLATE_TITLES), [
    'payment_reminder_30m', 'payment_reminder_6h', 'payment_reminder_24h', 'report_ready_patient',
    'payment_success_patient', 'payment_marked_paid_patient', 'additional_files_requested_patient',
    'prescription_uploaded_patient', 'addon_purchased_urgency', 'new_message', 'case_cancelled_patient',
    'case_expired_unpaid_patient', 'case_auto_deleted_unpaid_patient', 'order_created_patient',
    'order_status_accepted_patient', 'order_reassigned_patient', 'order_breached_patient',
    'payment_claim_rejected_patient', 'case_routing_updated', 'sla_reminder_24h', 'sla_reminder_6h', 'sla_reminder_1h'
  ])
));
const PATIENT_TEMPLATES = ALL_TEMPLATES.filter(function (n) { return !cl.isStaffFacingTemplate(n, {}); });

// The worst realistic payloads: a slice as the reference, with and without the id.
const BAD_PAYLOADS = [
  { case_id: ORDER_ID, order_id: ORDER_ID, caseReference: SLICE, case_ref: SLICE, amount: 500, doctorName: 'Dr. Ahmed', hours_remaining: 150, appointmentTime: '5 PM' },
  { caseReference: SLICE, amount: 500 },
  { case_id: ORDER_ID }
];

try {
  expect(PATIENT_TEMPLATES.length > 40, 'expected a real template list; got ' + PATIENT_TEMPLATES.length);
  let checked = 0;
  PATIENT_TEMPLATES.forEach(function (tpl) {
    ['en', 'ar'].forEach(function (lang) {
      BAD_PAYLOADS.forEach(function (payload) {
        const body = renderNotificationMessage(tpl, payload, lang);
        if (body == null) return;
        checked++;
        expect(!ID_FRAGMENT.test(body), tpl + '/' + lang + ' bell prints an internal id: ' + body);
        expect(body.indexOf(ORDER_ID) === -1, tpl + '/' + lang + ' bell prints the order uuid: ' + body);
        expect(!/[a-z,] Your case/.test(body), tpl + '/' + lang + ' capitalises "Your case" mid-sentence: ' + body);
        expect(!/for Your case/.test(body), tpl + '/' + lang + ' says "for Your case": ' + body);
        expect(!/[a-z,] Case TSH/.test(body), tpl + '/' + lang + ' capitalises "Case" mid-sentence: ' + body);
      });
      // With a real reference: "case TSH-…" mid-sentence, "Case TSH-…" at the start.
      const withRef = renderNotificationMessage(tpl, { case_id: ORDER_ID, reference_id: REF, caseReference: SLICE, hours_remaining: 150 }, lang);
      if (withRef != null) {
        expect(!ID_FRAGMENT.test(withRef), tpl + '/' + lang + ' prints the slice despite a real reference: ' + withRef);
        expect(!/(?:[a-z,]|for|about|to) Case TSH/.test(withRef), tpl + '/' + lang + ' mid-sentence "Case": ' + withRef);
        expect(!/^case TSH/.test(withRef), tpl + '/' + lang + ' lower-case at sentence start: ' + withRef);
        expect(withRef.indexOf('tsh-') === -1, tpl + '/' + lang + ' lower-cased the reference: ' + withRef);
      }
    });
  });
  expect(checked > 100, 'sweep rendered too few bodies to mean anything: ' + checked);

  // The exact sentences from the bug report.
  eq(renderNotificationMessage('payment_reminder_30m', { case_id: ORDER_ID }, 'en'),
    'Reminder: complete payment for your case to start your second-opinion review.');
  eq(renderNotificationMessage('payment_reminder_30m', { case_id: ORDER_ID, reference_id: REF }, 'en'),
    'Reminder: complete payment for case ' + REF + ' to start your second-opinion review.');
  eq(renderNotificationMessage('payment_reminder_6h', { case_id: ORDER_ID, reference_id: REF }, 'en'),
    'Case ' + REF + ' is still awaiting payment. Complete it now so a doctor can begin.');
  eq(renderNotificationMessage('payment_reminder_6h', { case_id: ORDER_ID, caseReference: SLICE }, 'en'),
    'Your case is still awaiting payment. Complete it now so a doctor can begin.');
  eq(renderNotificationMessage('report_ready_patient', { case_id: ORDER_ID, caseReference: SLICE }, 'ar'),
    'تقرير الرأي الطبي الثاني لحالتك جاهز للاطلاع.');
  eq(renderNotificationMessage('report_ready_patient', { case_id: ORDER_ID, reference_id: REF }, 'ar'),
    'تقرير الرأي الطبي الثاني لحالة ' + REF + ' جاهز للاطلاع.');
  t.pass('in-app bodies (' + checked + ' renders): no id fragment, no mid-sentence "Your case"/"Case", reference case preserved');
} catch (e) { t.fail('in-app bodies', e); }

// ── 5. WhatsApp (OpenClaw) bodies: same rule, and no leftovers ─────────────
try {
  let checked = 0;
  Object.keys(OPENCLAW_TEMPLATES).filter(function (n) { return !cl.isStaffFacingTemplate(n, {}); }).forEach(function (tpl) {
    ['en', 'ar'].forEach(function (lang) {
      BAD_PAYLOADS.forEach(function (payload) {
        // What the worker hands over for a patient: recipientRole set, and the
        // link is a URL that legitimately contains the (lower-case) order id.
        const vars = Object.assign({ recipientRole: 'patient', role: payload.role }, payload);
        const body = getOpenClawBody(tpl, lang, vars, { orderId: ORDER_ID });
        if (body == null) return;
        checked++;
        expect(!ID_FRAGMENT.test(body), tpl + '/' + lang + ' WhatsApp prints an internal id: ' + body);
        expect(body.indexOf(cl.NO_REFERENCE_TOKEN) === -1, tpl + '/' + lang + ' leaks the placeholder: ' + JSON.stringify(body));
        expect(!/\(\s*\)/.test(body), tpl + '/' + lang + ' leaves an empty parenthetical: ' + body);
        expect(!/\bcase\s*[.,:—]/i.test(body.replace(/your case/gi, '')), tpl + '/' + lang + ' leaves a dangling "case": ' + body);
        expect(!/حالة\s*[.،:—]/.test(body), tpl + '/' + lang + ' leaves a dangling "حالة": ' + body);
        expect(!/for Your case|[a-z,] Your case/.test(body), tpl + '/' + lang + ' mid-sentence "Your case": ' + body);
        expect(!/ {2,}/.test(body), tpl + '/' + lang + ' double space: ' + JSON.stringify(body));
      });
      const withRef = getOpenClawBody(tpl, lang, { reference_id: REF, caseReference: SLICE, amount: 500 }, { orderId: ORDER_ID });
      if (withRef != null && /caseReference/.test(String(OPENCLAW_TEMPLATES[tpl][lang]))) {
        expect(withRef.indexOf(REF) !== -1, tpl + '/' + lang + ' must print the real reference when there is one: ' + withRef);
        expect(!ID_FRAGMENT.test(withRef), tpl + '/' + lang + ' prints the slice despite a real reference');
      }
    });
  });
  expect(checked > 150, 'sweep rendered too few WhatsApp bodies: ' + checked);

  // Staff copy is deliberately unchanged: a doctor keeps a handle.
  expect(getOpenClawBody('order_assigned_doctor', 'en', {}, { orderId: ORDER_ID }).indexOf(SLICE) !== -1,
    'doctor-facing copy keeps the id handle when a case has no reference');
  expect(getOpenClawBody('sla_reminder_6h', 'en', { role: 'doctor' }, { orderId: ORDER_ID }).indexOf(SLICE) !== -1,
    'the doctor side of an SLA reminder keeps the handle');
  expect(!ID_FRAGMENT.test(getOpenClawBody('sla_reminder_6h', 'en', { role: 'patient' }, { orderId: ORDER_ID })),
    'the patient side of the same SLA reminder does not');
  t.pass('OpenClaw bodies (' + checked + ' renders): no id, no placeholder, no empty "()", no dangling "case"');
} catch (e) { t.fail('OpenClaw bodies', e); }

// ── 6. Meta HSM params never carry an internal id ──────────────────────────
try {
  Object.keys(whatsappTemplateMap).forEach(function (tpl) {
    const params = whatsappTemplateMap[tpl].paramBuilder({ case_id: ORDER_ID, order_id: ORDER_ID, caseReference: SLICE });
    if (!('case_ref' in params)) return;
    eq(params.case_ref, '', tpl + ' case_ref with only an id available');
    eq(whatsappTemplateMap[tpl].paramBuilder({ case_id: ORDER_ID, caseReference: REF }).case_ref, REF, tpl + ' case_ref with a real reference');
  });
  t.pass('Meta param builders: case_ref is the real reference or empty — never the case id');
} catch (e) { t.fail('Meta param builders', e); }

// ── 7. queueNotification resolves the reference before rendering/storing ───
// Subprocess with src/pg stubbed: orders lookup returns a reference, and the
// INSERT parameters are captured and printed.
try {
  const script = `
    const path = require('path');
    const root = ${JSON.stringify(ROOT)};
    const pg = require(path.join(root, 'src', 'pg'));
    const inserts = [];
    let orderLookups = 0;
    let failLookup = false;
    pg.queryOne = async function (sql, params) {
      if (/FROM users/i.test(sql)) return { id: params[0], lang: 'en', role: 'patient' };
      if (/SELECT reference_id FROM orders/i.test(sql)) {
        orderLookups++;
        if (failLookup) throw new Error('db down');
        return params[0] === 'no-ref-order' ? { reference_id: null } : { reference_id: ${JSON.stringify(REF)} };
      }
      return null;
    };
    pg.queryAll = async function () { return []; };
    pg.execute = async function (sql, params) {
      if (/INSERT INTO notifications/i.test(sql)) inserts.push(params);
      return { rowCount: 1 };
    };
    const { queueNotification } = require(path.join(root, 'src', 'notify.js'));
    (async function () {
      const O = ${JSON.stringify(ORDER_ID)};
      const S = ${JSON.stringify(SLICE)};
      await queueNotification({ orderId: O, toUserId: 'u1', channel: 'internal', template: 'payment_reminder_30m', response: { case_id: O } });
      await queueNotification({ orderId: O, toUserId: 'u1', channel: 'internal', template: 'payment_success_patient', response: { order_id: O, caseReference: S } });
      await queueNotification({ orderId: 'no-ref-order', toUserId: 'u1', channel: 'internal', template: 'report_ready_patient', response: { case_id: 'no-ref-order', caseReference: 'NO-REF-ORDER' } });
      const before = orderLookups;
      await queueNotification({ orderId: O, toUserId: 'u1', channel: 'internal', template: 'report_ready_patient', response: { case_id: O, reference_id: ${JSON.stringify(REF)} } });
      const skippedLookup = orderLookups === before;
      failLookup = true;
      const r = await queueNotification({ orderId: O, toUserId: 'u1', channel: 'internal', template: 'payment_reminder_6h', response: { case_id: O, caseReference: S } });
      console.log('RESULT ' + JSON.stringify({ skippedLookup: skippedLookup, lastOk: r && r.ok, rows: inserts.map(function (p) { return { response: p[6], title: p[9], message: p[10] }; }) }));
      process.exit(0);
    })().catch(function (e) { console.log('RESULT ' + JSON.stringify({ error: String(e && e.stack || e) })); process.exit(0); });
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 60000,
    // stderr captured, not inherited: the push module's own pool has nothing
    // to connect to here and says so on every call.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://stub:stub@127.0.0.1:1/stub' })
  });
  const line = out.split('\n').filter(function (l) { return l.indexOf('RESULT ') === 0; })[0];
  expect(line, 'subprocess produced no result:\n' + out.slice(-800));
  const res = JSON.parse(line.slice(7));
  expect(!res.error, 'subprocess threw: ' + res.error);
  eq(res.rows.length, 5, 'all five notifications must be inserted');

  const r0 = JSON.parse(res.rows[0].response);
  eq(r0.reference_id, REF, 'reminder payload gets reference_id');
  eq(r0.caseReference, REF, 'reminder payload gets caseReference');
  eq(res.rows[0].message, 'Reminder: complete payment for case ' + REF + ' to start your second-opinion review.',
    'the in-app message is rendered AFTER the lookup');

  const r1 = JSON.parse(res.rows[1].response);
  eq(r1.caseReference, REF, "a caller's id slice is replaced by the real reference");
  expect(!ID_FRAGMENT.test(res.rows[1].response), 'no id slice left in the stored payload');
  expect(res.rows[1].message.indexOf(REF) !== -1, 'payment message names the real reference');

  const r2 = JSON.parse(res.rows[2].response);
  expect(!('caseReference' in r2), 'no reference on the order → the fake one is removed for a patient template');
  eq(res.rows[2].message, 'Your second-opinion report for your case is ready to view.', 'and the message says "your case"');

  expect(res.skippedLookup === true, 'a payload that already has a real reference must not cost a lookup');

  // Lookup failure: never throws, queues what it was given, still prints no id.
  expect(res.lastOk === true, 'a failed lookup must not fail the queue');
  eq(res.rows[4].message, 'Your case is still awaiting payment. Complete it now so a doctor can begin.',
    'with the lookup down the patient still sees "Your case", not the slice');
  t.pass('queueNotification: looks up orders.reference_id once, stores + renders it, survives a failed lookup');
} catch (e) { t.fail('queueNotification reference lookup', e); }

// ── 8. The worker and the reminder payload use the helper ──────────────────
try {
  const fs = require('fs');
  const { stripComments } = require('../_helpers/strip-comments');
  const WORKER = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'notification_worker.js'), 'utf8'));
  eq((WORKER.match(/caseReference: caseReferenceForRecipient\(/g) || []).length, 2,
    'both worker send paths (email, WhatsApp) must resolve the reference through the helper');
  expect(!/caseReference: (?:data|rawVars)\.caseReference\s*\|\|/.test(WORKER),
    'the worker must not fall back from caseReference to an id slice inline');
  const OC = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'notify', 'openclawTemplates.js'), 'utf8'));
  expect(/caseReference: realReference/.test(OC), 'OpenClaw must prefer the resolved reference');
  const MAP = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'notify', 'whatsappTemplateMap.js'), 'utf8'));
  expect(!/data\.caseReference \|\| data\.(?:case_id|order_id)/.test(MAP), 'no Meta param may fall back to a raw id');

  const { buildPaymentReminderPayload } = require(path.join(ROOT, 'src', 'notify.js'));
  const withRef = buildPaymentReminderPayload({ caseId: ORDER_ID, paymentUrl: '/pay', referenceId: REF });
  eq(withRef.reference_id, REF); eq(withRef.caseReference, REF);
  const noRef = buildPaymentReminderPayload({ caseId: ORDER_ID, paymentUrl: '/pay', referenceId: SLICE });
  expect(!('reference_id' in noRef) && !('caseReference' in noRef), 'a slice is not accepted as a reference');
  const LIFE = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'case_lifecycle.js'), 'utf8'));
  expect(/buildPaymentReminderPayload\(\{ caseId, paymentUrl, referenceId \}\)/.test(LIFE),
    'the payment reminder must send the case reference');
  t.pass('worker (both paths), OpenClaw, Meta map and the reminder payload all go through case_label');
} catch (e) { t.fail('helper wiring', e); }
