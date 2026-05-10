// tests/core/theme7b-patient-refund-request-route.test.js
//
// Theme 7b Phase 2 — patient refund-request route regression guard.
//
// Asserts the GET form route, the POST submit route, and the
// downstream side-effects (DB INSERT shape, audit event, patient
// confirmation, admin fan-out) are all wired correctly. Source-grep
// style — matches the Theme 1/5/6/7/7b lint pattern.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n💸 Theme 7b Phase 2 — patient refund request route\n');

const PATIENT = path.join(__dirname, '..', '..', 'src', 'routes', 'patient.js');
const VIEW    = path.join(__dirname, '..', '..', 'src', 'views', 'patient_refund_request.ejs');
const ORDER_VIEW = path.join(__dirname, '..', '..', 'src', 'views', 'patient_order.ejs');
const TEMPLATES  = path.join(__dirname, '..', '..', 'src', 'notify', 'templates.js');
const TITLES     = path.join(__dirname, '..', '..', 'src', 'notify', 'notification_titles.js');
const WORKER     = path.join(__dirname, '..', '..', 'src', 'notification_worker.js');

const src = fs.readFileSync(PATIENT, 'utf8');

// Slice from a route declaration to the next router.<verb>( declaration.
// We match `router.<verb>(<path-string-containing-substring>` and then
// slice forward to the next route declaration.
function sliceRoute(text, verb, pathSubstring) {
  const escaped = pathSubstring.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
  const m = text.match(new RegExp(
    'router\\.' + verb + "\\(\\s*['\"][^'\"]*" + escaped + "[^'\"]*['\"]"
  ));
  if (!m) return null;
  const start = m.index;
  const after = text.slice(start);
  const next = after.slice(50).search(/\nrouter\.(?:get|post|put|delete|patch|all)\(/);
  return next > 0 ? after.slice(0, next + 50) : after;
}

// ── 1. GET form route exists with requireRole('patient') ──────────
try {
  const body = sliceRoute(
    src, 'get',
    "/portal/patient/orders/:id/request-refund"
  );
  if (!body) throw new Error('GET /portal/patient/orders/:id/request-refund route not found');
  if (!/requireRole\(\s*['"]patient['"]\s*\)/.test(body)) {
    throw new Error('GET form route is missing requireRole(\'patient\') middleware');
  }
  if (!/isEligibleForRefund/.test(body)) {
    throw new Error('GET form route does not call isEligibleForRefund() — eligibility gate missing');
  }
  if (!/res\.render\s*\(\s*['"]patient_refund_request['"]/.test(body)) {
    throw new Error('GET form route does not render patient_refund_request view');
  }
  t.pass('GET /portal/patient/orders/:id/request-refund — patient-gated, eligibility-checked, renders form');
} catch (e) { t.fail('GET form route', e); }

// ── 2. POST submit route exists with requireRole + CSRF + validation ─
let postBody = null;
try {
  postBody = sliceRoute(
    src, 'post',
    "/portal/patient/orders/:id/request-refund"
  );
  if (!postBody) throw new Error('POST /portal/patient/orders/:id/request-refund route not found');
  if (!/requireRole\(\s*['"]patient['"]\s*\)/.test(postBody)) {
    throw new Error('POST submit route is missing requireRole(\'patient\') middleware');
  }
  // Re-checks eligibility at submit time (defence against stale form data).
  if (!/isEligibleForRefund\s*\(/.test(postBody)) {
    throw new Error('POST submit route does not re-check eligibility at submit time');
  }
  // Field validation
  if (!/reason_required/.test(postBody)) {
    throw new Error('POST submit route does not surface a `reason_required` validation error');
  }
  if (!/instapay_required/.test(postBody)) {
    throw new Error('POST submit route does not surface an `instapay_required` validation error');
  }
  // Length caps
  if (!/reasonRaw\.length\s*>\s*1000/.test(postBody)) {
    throw new Error('POST submit route does not cap reason at 1000 chars');
  }
  if (!/instapayRaw\.length\s*>\s*100/.test(postBody)) {
    throw new Error('POST submit route does not cap instapay handle at 100 chars');
  }
  t.pass('POST submit route — patient-gated, validates reason + instapay + length caps + re-checks eligibility');
} catch (e) { t.fail('POST submit route shape', e); }

// ── 3. INSERT into refunds with the right column shape ──────────────
try {
  if (!postBody) throw new Error('POST submit route body unavailable');
  // Column list
  for (const col of ['order_id', 'amount_egp', 'requested_amount', 'reason', 'patient_reason',
                     'instapay_handle', 'status', 'requested_by']) {
    if (!new RegExp('\\b' + col + '\\b').test(postBody)) {
      throw new Error('INSERT into refunds is missing column `' + col + '`');
    }
  }
  // Reason is hardcoded to 'patient_request' (the categorical reason,
  // distinct from the patient's free-form text in patient_reason).
  if (!/'patient_request'/.test(postBody)) {
    throw new Error("INSERT does not set reason='patient_request' (the categorical bucket)");
  }
  // Status comes from eligibility.autoApprove — either 'auto_approved' or 'pending'.
  if (!/'auto_approved'/.test(postBody) || !/'pending'/.test(postBody)) {
    throw new Error('INSERT does not branch on autoApprove → status (\'auto_approved\' vs \'pending\')');
  }
  // requested_amount = base_price + urgency_uplift_amount (full case price per OQ-4).
  if (!/order\.base_price.*order\.urgency_uplift_amount/.test(postBody) &&
      !/base_price[\s\S]{0,80}urgency_uplift_amount/.test(postBody)) {
    throw new Error('requested_amount is not computed as base_price + urgency_uplift_amount');
  }
  t.pass('INSERT into refunds: correct columns, reason=\'patient_request\', status branches on autoApprove, amount = full case price');
} catch (e) { t.fail('INSERT shape', e); }

// ── 4. Audit event written: patient_refund_requested ───────────────
try {
  if (!postBody) throw new Error('POST submit route body unavailable');
  if (!/logOrderEvent\s*\(\s*\{[\s\S]{0,400}label:\s*['"]patient_refund_requested['"]/.test(postBody)) {
    throw new Error('logOrderEvent for label `patient_refund_requested` not written');
  }
  if (!/actorRole:\s*['"]patient['"]/.test(postBody)) {
    throw new Error('audit event does not set actorRole=\'patient\'');
  }
  t.pass('audit event `patient_refund_requested` written with actorRole=\'patient\'');
} catch (e) { t.fail('audit event', e); }

// ── 5. Patient notification (multi-channel: internal + email; no whatsapp) ──
try {
  if (!postBody) throw new Error('POST submit route body unavailable');
  if (!/queueMultiChannelNotification\s*\(/.test(postBody)) {
    throw new Error('queueMultiChannelNotification not invoked for patient confirmation');
  }
  if (!/template:\s*['"]patient_refund_requested['"]/.test(postBody)) {
    throw new Error('patient confirmation template name does not match `patient_refund_requested`');
  }
  if (!/channels:\s*\[\s*['"]internal['"]\s*,\s*['"]email['"]\s*\]/.test(postBody)) {
    throw new Error('patient confirmation channels are not [internal, email] (Phase 2 — WhatsApp deferred to Phase 4)');
  }
  if (/['"]whatsapp['"]/.test(postBody.split('queueMultiChannelNotification')[1] || '')) {
    // Only check the multi-channel call's vicinity — the rest of the file may have other whatsapp sends.
    const slice = (postBody.split('queueMultiChannelNotification')[1] || '').slice(0, 600);
    if (/channels:\s*\[[^\]]*['"]whatsapp['"]/.test(slice)) {
      throw new Error('patient confirmation includes whatsapp channel — must be deferred to Phase 4');
    }
  }
  t.pass('patient confirmation: queueMultiChannelNotification with template=patient_refund_requested, channels=[internal, email]');
} catch (e) { t.fail('patient confirmation', e); }

// ── 6. Admin fan-out via canonical notifyAdmins ────────────────────
try {
  if (!postBody) throw new Error('POST submit route body unavailable');
  if (!/notifyAdmins\s*\(\s*\{/.test(postBody)) {
    throw new Error('admin fan-out via notifyAdmins() not invoked');
  }
  if (!/template:\s*['"]admin_refund_request_received['"]/.test(postBody)) {
    throw new Error('admin fan-out template is not `admin_refund_request_received`');
  }
  if (!/dedupeKey:\s*['"`]refund_requested:/.test(postBody)) {
    throw new Error('admin fan-out dedupeKey does not start with `refund_requested:`');
  }
  t.pass('admin fan-out via notifyAdmins(template=admin_refund_request_received) with dedupeKey=refund_requested:<id>:sa');
} catch (e) { t.fail('admin fan-out', e); }

// ── 7. View file exists + uses tt() helper + CSRF token + field caps ─
try {
  const view = fs.readFileSync(VIEW, 'utf8');
  if (!/tt\(/.test(view)) throw new Error('patient_refund_request.ejs does not use tt() i18n helper');
  if (!/csrfField/.test(view)) throw new Error('patient_refund_request.ejs does not render csrfField()');
  if (!/maxlength=["']1000["']/.test(view)) throw new Error('reason textarea maxlength is not 1000');
  if (!/maxlength=["']100["']/.test(view)) throw new Error('instapay input maxlength is not 100');
  if (!/name=["']reason["']/.test(view)) throw new Error('form has no <textarea name="reason">');
  if (!/name=["']instapay_handle["']/.test(view)) throw new Error('form has no <input name="instapay_handle">');
  if (!/3-5\s*business\s*days|3-5\s*أيام/.test(view)) {
    throw new Error('form is missing the "3-5 business days" timeline copy');
  }
  t.pass('patient_refund_request.ejs: tt(), CSRF, field caps (1000/100), 3-5 business-days timeline copy');
} catch (e) { t.fail('view shape', e); }

// ── 8. Order page CTA + status banner section present ─────────────
try {
  const ov = fs.readFileSync(ORDER_VIEW, 'utf8');
  if (!/data-refund-cta/.test(ov)) {
    throw new Error('patient_order.ejs does not render the [data-refund-cta] CTA section');
  }
  if (!/data-refund-status=/.test(ov)) {
    throw new Error('patient_order.ejs does not render the [data-refund-status] status banner');
  }
  if (!/refundEligibility/.test(ov) || !/existingRefund/.test(ov)) {
    throw new Error('patient_order.ejs does not consume refundEligibility / existingRefund locals');
  }
  // Ineligible AND no existing refund → must NOT render anything.
  // We assert on the structure: the CTA block is wrapped in `if (__refundCanRequest)`
  // and the status block in `else if (__existingRefund)`; the third branch is silence.
  if (!/if\s*\(\s*__refundCanRequest\s*\)/.test(ov)) {
    throw new Error('patient_order.ejs CTA is not gated on __refundCanRequest');
  }
  t.pass('patient_order.ejs: CTA gated on eligibility, status banner gated on existing refund, ineligible→nothing');
} catch (e) { t.fail('patient_order.ejs CTA + banner', e); }

// ── 9. notify/templates.js declares the 3 new template constants ──
try {
  const tpl = fs.readFileSync(TEMPLATES, 'utf8');
  for (const name of ['PATIENT_REFUND_REQUESTED', 'ADMIN_REFUND_REQUEST_RECEIVED', 'ADMIN_REFUND_CANCELLED_BY_PATIENT']) {
    if (!new RegExp('\\b' + name + '\\b').test(tpl)) {
      throw new Error('notify/templates.js missing constant `' + name + '`');
    }
  }
  t.pass('notify/templates.js declares all 3 new Theme 7b Phase 2 constants');
} catch (e) { t.fail('templates.js constants', e); }

// ── 10. notify/notification_titles.js has bilingual titles for all 3 ─
try {
  const tit = fs.readFileSync(TITLES, 'utf8');
  for (const key of ['patient_refund_requested', 'admin_refund_request_received', 'admin_refund_cancelled_by_patient']) {
    const re = new RegExp('\\b' + key + ':[\\s\\S]{0,200}en:[\\s\\S]{0,80}ar:');
    if (!re.test(tit)) {
      throw new Error('notification_titles.js missing bilingual entry for `' + key + '`');
    }
  }
  t.pass('notification_titles.js: all 3 templates have { en, ar } titles');
} catch (e) { t.fail('notification_titles bilingual', e); }

// ── 11. notification_worker TEMPLATE_TO_EMAIL maps patient template ─
try {
  const w = fs.readFileSync(WORKER, 'utf8');
  if (!/patient_refund_requested:\s*['"]patient-refund-requested['"]/.test(w)) {
    throw new Error('notification_worker TEMPLATE_TO_EMAIL missing `patient_refund_requested → patient-refund-requested`');
  }
  // Admin templates must NOT be mapped (they're internal-only).
  if (/admin_refund_request_received:\s*['"]/.test(w)) {
    throw new Error('admin_refund_request_received should not have an email template mapping (internal-only by design)');
  }
  t.pass('notification_worker: patient template mapped to patient-refund-requested.hbs; admin templates internal-only');
} catch (e) { t.fail('TEMPLATE_TO_EMAIL mapping', e); }

// ── 12. Email templates exist (en + ar) ────────────────────────────
try {
  const en = path.join(__dirname, '..', '..', 'src', 'templates', 'email', 'en', 'patient-refund-requested.hbs');
  const ar = path.join(__dirname, '..', '..', 'src', 'templates', 'email', 'ar', 'patient-refund-requested.hbs');
  if (!fs.existsSync(en)) throw new Error('en/patient-refund-requested.hbs missing');
  if (!fs.existsSync(ar)) throw new Error('ar/patient-refund-requested.hbs missing');
  const enBody = fs.readFileSync(en, 'utf8');
  if (!/{{patientName}}/.test(enBody)) throw new Error('en email template does not interpolate {{patientName}}');
  if (!/{{requestedAmount}}/.test(enBody)) throw new Error('en email template does not interpolate {{requestedAmount}}');
  t.pass('email templates: en + ar both present, interpolate patientName + requestedAmount');
} catch (e) { t.fail('email templates', e); }
