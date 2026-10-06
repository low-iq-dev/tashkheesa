'use strict';

// src/notify/case_label.js
//
// E2E fixes 2026-10-06 — the one place that decides what a case is CALLED in
// a message a patient reads.
//
// WHY THIS FILE EXISTS. A case has two identifiers: orders.id (an internal
// UUID) and orders.reference_id ("TSH-2026-000017", minted at submit — the
// number a patient reads to support or types into a transfer note). About
// twenty-five call sites passed `String(orderId).slice(0, 12).toUpperCase()`
// as `caseReference`, and the email worker, the OpenClaw composer and the Meta
// param builders each fell back to the same slice (or to the raw case id), so
// patients were told about "Case 8F83CD55-A06" — a string that appears nowhere
// in their account and that support cannot look up. Separately, the in-app
// renderer built ONE label, capitalised for the start of a sentence, and used
// it mid-sentence too: "…complete payment for Your case…".
//
// Three small pure functions, no requires, so every surface can share them
// without adding an edge to the notify <-> case_lifecycle cycle:
//
//   resolveCaseReference(payload, orderRow) -> the real reference, or null.
//       REJECTS anything shaped like an id slice, whatever key it arrived in.
//   caseLabel({ ref, lang, position, voice }) -> the noun phrase, cased for
//       where it sits in the sentence.
//   applyCaseReference / cleanMissingReference -> write a resolved reference
//       into a payload; tidy a composed body when there is none.

// Every key a caller has used for "the case reference", most trusted first.
const REFERENCE_KEYS = Object.freeze([
  'reference_id',
  'referenceId',
  'caseReference',
  'case_reference',
  'case_ref',
  'caseRef',
  'reference_code'
]);

// Keys that may carry the order's internal id, used to recognise a slice of it.
const ORDER_ID_KEYS = Object.freeze(['case_id', 'caseId', 'order_id', 'orderId']);

function compact(value) {
  return String(value == null ? '' : value).replace(/[^0-9a-z]/gi, '').toUpperCase();
}

/**
 * Is this string an internal id (or a piece of one) rather than a reference?
 *
 * Shape tests first, because most callers that pass a slice do not also pass
 * the id it was cut from: a full UUID, the leading groups of one
 * ("8F83CD55-A06", "8f83cd55-a06b-4"), or a bare run of 8+ hex digits. A real
 * reference ("TSH-2026-000017") contains letters outside a-f and never matches.
 * Then, when the order id is known, anything that is a prefix of it.
 */
function looksLikeInternalId(value, orderId) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return true;
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{0,4}){0,3}(?:-[0-9a-f]{0,12})?$/i.test(v)) return true;
  if (/^[0-9a-f]{8,32}$/i.test(v)) return true;
  const id = compact(orderId);
  const c = compact(v);
  if (id && c.length >= 6 && id.indexOf(c) === 0) return true;
  return false;
}

function orderIdFrom(payload, orderRow) {
  if (orderRow && orderRow.id) return orderRow.id;
  const p = (payload && typeof payload === 'object') ? payload : {};
  for (const k of ORDER_ID_KEYS) {
    if (p[k]) return p[k];
  }
  return null;
}

/**
 * The case's real reference (orders.reference_id), or null.
 *
 * @param {Object|null} payload   notification payload (any of REFERENCE_KEYS)
 * @param {Object|null} [orderRow] orders row when the caller has one — its
 *                                 reference_id wins over anything in the payload
 * @returns {string|null}
 */
function resolveCaseReference(payload, orderRow) {
  const p = (payload && typeof payload === 'object') ? payload : {};
  const orderId = orderIdFrom(p, orderRow);
  const candidates = [];
  if (orderRow && orderRow.reference_id) candidates.push(orderRow.reference_id);
  for (const k of REFERENCE_KEYS) candidates.push(p[k]);
  for (const cand of candidates) {
    if (cand == null) continue;
    const v = String(cand).trim();
    if (v && !looksLikeInternalId(v, orderId)) return v;
  }
  return null;
}

/**
 * The noun phrase for a case, cased for its place in the sentence.
 *
 *   EN  with ref     start "Case TSH-…"     mid "case TSH-…"
 *       without ref  start "Your case"      mid "your case"       (patient voice)
 *   AR  with ref     "حالة TSH-…"
 *       without ref  "حالتك" (patient voice) / "الحالة" (neutral voice)
 *
 * `voice: 'neutral'` is for doctor / ops copy, where "your case" would tell a
 * doctor the case is theirs personally. In English there is no single neutral
 * fallback ("a case" / "the case" depends on the sentence), so it returns null
 * and the caller supplies its own; Arabic has one ("الحالة").
 *
 * `lam: true` (Arabic) fuses the preposition "ل": "لحالة TSH-…", "لحالتك",
 * and "للحالة" for the neutral form — never the malformed "لالحالة".
 *
 * @param {{ref?: string|null, lang?: string, position?: 'start'|'mid', voice?: 'patient'|'neutral', lam?: boolean}} opts
 * @returns {string|null}
 */
function caseLabel(opts) {
  const o = opts || {};
  const ref = o.ref ? String(o.ref).trim() : '';
  const isAr = String(o.lang || 'en').toLowerCase() === 'ar';
  const neutral = o.voice === 'neutral';
  const atStart = o.position === 'start';

  if (isAr) {
    if (ref) return (o.lam ? 'لحالة ' : 'حالة ') + ref;
    if (neutral) return o.lam ? 'للحالة' : 'الحالة';
    return o.lam ? 'لحالتك' : 'حالتك';
  }

  if (ref) return (atStart ? 'Case ' : 'case ') + ref;
  if (neutral) return null;
  return atStart ? 'Your case' : 'your case';
}

/**
 * Is this template read by a doctor or by ops rather than by a patient?
 *
 * Staff copy keeps its historical behaviour when a case has no reference (an
 * id fragment is still a handle for someone who can search by it); patient
 * copy never prints one. By name, plus the `role` the SLA reminders queue —
 * the same template goes to both sides there.
 */
function isStaffFacingTemplate(template, payload) {
  const p = (payload && typeof payload === 'object') ? payload : {};
  const role = String(p.role || p.recipientRole || '').toLowerCase();
  if (role === 'doctor' || role === 'admin' || role === 'superadmin') return true;
  if (role === 'patient') return false;
  const t = String(template || '');
  return /(?:_doctor$|^doctor_|^admin_|_superadmin$|_admin$|^sla_breach|^new_case_available$|^tashkheesa_new_case_|^tashkheesa_case_auto_assigned$|^video_slot_review_requested$|^order_reassigned_(?:to|from)_doctor$|^patient_reply_info$|^prescription_unlocked_doctor$)/.test(t);
}

/**
 * Copy of `payload` with the reference written under the keys the consumers
 * read (in-app renderer: reference_id; titles, email and WhatsApp:
 * caseReference; doctor broadcast: case_ref).
 *
 * With a reference: every reference key is set to it, which also overwrites a
 * caller's id slice. Without one and `stripFake`: reference keys holding an id
 * slice are removed, so nothing downstream can print them. Returns the same
 * object when nothing changed.
 */
function applyCaseReference(payload, ref, opts) {
  const p = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : null;
  if (!p) return payload;
  const o = opts || {};
  const orderId = o.orderId || orderIdFrom(p, null);
  let out = null;
  const set = (k, v) => { if (!out) out = Object.assign({}, p); out[k] = v; };
  const del = (k) => { if (!out) out = Object.assign({}, p); delete out[k]; };

  if (ref) {
    ['reference_id', 'caseReference'].forEach((k) => { if (p[k] !== ref) set(k, ref); });
    REFERENCE_KEYS.forEach((k) => {
      if (k in p && p[k] !== ref && looksLikeInternalId(p[k], orderId)) set(k, ref);
    });
  } else if (o.stripFake) {
    REFERENCE_KEYS.forEach((k) => {
      if (k in p && p[k] != null && looksLikeInternalId(p[k], orderId)) del(k);
    });
  }
  return out || p;
}

// A private-use code point: cannot occur in copy, survives interpolation.
const NO_REFERENCE_TOKEN = '';

/**
 * Tidy a body that was composed with NO_REFERENCE_TOKEN where the reference
 * would have been. The free-form WhatsApp composers interpolate the reference
 * inline ("your case (X)", "for case X", "لحالة X"); rather than fork ninety
 * composers into with/without variants, they are rendered once with the token
 * and the phrase around it is rewritten here: a parenthetical disappears,
 * "case X" becomes "your case" (capitalised only at a sentence start), and the
 * Arabic "حالة X" becomes "حالتك".
 */
function cleanMissingReference(body, lang) {
  let s = String(body == null ? '' : body);
  if (s.indexOf(NO_REFERENCE_TOKEN) === -1) return s;
  const T = NO_REFERENCE_TOKEN;
  // "(X)" with its leading space.
  s = s.replace(new RegExp('\\s*\\(' + T + '\\)', 'g'), '');
  if (String(lang || 'en').toLowerCase() === 'ar') {
    s = s.replace(new RegExp('حالتك ' + T, 'g'), 'حالتك');
    s = s.replace(new RegExp('الحالة ' + T, 'g'), 'حالتك');
    s = s.replace(new RegExp('حالة ' + T, 'g'), 'حالتك');
  } else {
    s = s.replace(new RegExp('\\b[Yy]our case ' + T, 'g'), (m) => m.slice(0, 9));
    // Sentence start: beginning of the body, or after . ! ? or a line break.
    s = s.replace(new RegExp('(^|[.!?]\\s+|\\n\\s*)[Cc]ase ' + T, 'g'), '$1Your case');
    s = s.replace(new RegExp('\\b[Cc]ase ' + T, 'g'), 'your case');
  }
  // Anything left is a bare reference with no noun to rewrite: drop it.
  s = s.replace(new RegExp('\\s*' + T, 'g'), '');
  return s.replace(/[ \t]{2,}/g, ' ').replace(/ +([.,:;!?])/g, '$1');
}

module.exports = {
  REFERENCE_KEYS,
  NO_REFERENCE_TOKEN,
  looksLikeInternalId,
  resolveCaseReference,
  caseLabel,
  isStaffFacingTemplate,
  applyCaseReference,
  cleanMissingReference
};
