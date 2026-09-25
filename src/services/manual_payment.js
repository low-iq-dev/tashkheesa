'use strict';

// src/services/manual_payment.js
//
// MANUAL PAYMENT PATH (InstaPay / bank transfer) — launch contingency,
// 2026-09-24. Contract: MANUAL_PAY_CONTRACT.md (shared with the mobile app).
//
// ─── THE RULE ───────────────────────────────────────────────────────────────
// A patient's transfer claim is an UNVERIFIED STATEMENT, not money. Nothing in
// this file ever writes orders.payment_status, never changes orders.status,
// never calls the canonical payment boundary, and never triggers auto-assign.
// A claim records what the patient told us and tells staff. The ONLY way an
// order becomes paid through this path is a superadmin — a human who has seen
// the money land — pressing the existing POST /superadmin/orders/:id/mark-paid.
// tests/core/manual-payment-claims.test.js pins this by source-grep AND by a
// recording mock database.
//
// The one write this file makes to `orders` is (a) touching updated_at when a
// claim is submitted — the unpaid-TTL clock (case_lifecycle UNPAID_CASE_TTL)
// measures last activity, and a patient who says "I have paid" is activity —
// and (b) minting orders.reference_id when it is missing, exactly the way
// wizard submit does, so the patient has a human-retypeable reference to put
// in the transfer note.
//
// ─── CONFIG ─────────────────────────────────────────────────────────────────
// Everything is read from process.env PER CALL (like PAYMENT_MODE in
// routes/patient.js) so an env flip on Render takes effect on the next request.
// With every variable at its default the portal behaves exactly as before.

const { randomUUID } = require('crypto');

// Collaborators, resolved lazily (keeps the module cheap to load) and
// overridable in tests via __setTestDeps — so a test can hand in a recording
// database and a payment-lifecycle spy without touching require.cache, which
// the suite runner shares across files.
const DEFAULT_DEPS = Object.freeze({
  pg: () => require('../pg'),
  notify: () => require('../notify'),
  opsPush: () => require('./ops_push'),
  audit: () => require('../audit'),
  reference: () => require('../utils/reference'),
  caseLifecycle: () => require('../case_lifecycle'),
  logger: () => require('../logger')
});
let D = Object.assign({}, DEFAULT_DEPS);
function pg() { return D.pg(); }

/** Test hook: override collaborators; returns a restore function. */
function __setTestDeps(overrides) {
  const prev = D;
  D = Object.assign({}, D, overrides || {});
  return function restore() { D = prev; };
}

const METHODS = Object.freeze(['instapay', 'bank']);
const STATUSES = Object.freeze(['pending', 'confirmed', 'rejected']);
const REFERENCE_MIN = 3;
const REFERENCE_MAX = 80;
const SENDER_MAX = 80;
const REJECTION_REASON_MAX = 500;

const DEFAULT_CONFIRM_NOTE_EN = 'We confirm transfers during working hours. Your case starts as soon as we confirm.';
const DEFAULT_CONFIRM_NOTE_AR = 'نؤكد التحويلات خلال ساعات العمل. تبدأ مراجعة حالتك فور تأكيد التحويل.';

function envFlag(raw, dflt) {
  if (raw == null) return dflt;
  const s = String(raw).trim().toLowerCase();
  if (s === '') return dflt;
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return dflt;
}

function envStr(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

/** CARD_PAYMENT_ENABLED — default TRUE. Only an explicit false-y value hides the card path. */
function isCardPaymentEnabled() {
  return envFlag(process.env.CARD_PAYMENT_ENABLED, true);
}

/**
 * The manual-payment configuration as of THIS request.
 *
 * `enabled` is true only when MANUAL_PAYMENT_ENABLED is on AND at least one
 * destination (InstaPay or bank) is configured — never an empty block.
 */
function readManualPaymentConfig() {
  const flag = envFlag(process.env.MANUAL_PAYMENT_ENABLED, false);

  const handle = envStr(process.env.MANUAL_PAYMENT_INSTAPAY_HANDLE);
  let link = envStr(process.env.MANUAL_PAYMENT_INSTAPAY_LINK);
  // Only ever render an https link — this string lands in an href.
  if (link && !/^https:\/\//i.test(link)) link = null;
  const instapay = (handle || link) ? { handle: handle, link: link } : null;

  const bankName = envStr(process.env.MANUAL_PAYMENT_BANK_NAME);
  const accountName = envStr(process.env.MANUAL_PAYMENT_ACCOUNT_NAME);
  const accountNumber = envStr(process.env.MANUAL_PAYMENT_ACCOUNT_NUMBER);
  const iban = envStr(process.env.MANUAL_PAYMENT_IBAN);
  const bank = (accountName && (accountNumber || iban))
    ? { bankName: bankName, accountName: accountName, accountNumber: accountNumber, iban: iban }
    : null;

  return {
    enabled: !!(flag && (instapay || bank)),
    flag: flag,
    instapay: instapay,
    bank: bank,
    relationshipNote: {
      en: envStr(process.env.MANUAL_PAYMENT_RELATIONSHIP_NOTE_EN),
      ar: envStr(process.env.MANUAL_PAYMENT_RELATIONSHIP_NOTE_AR)
    },
    confirmNote: {
      en: envStr(process.env.MANUAL_PAYMENT_CONFIRM_NOTE_EN) || DEFAULT_CONFIRM_NOTE_EN,
      ar: envStr(process.env.MANUAL_PAYMENT_CONFIRM_NOTE_AR) || DEFAULT_CONFIRM_NOTE_AR
    }
  };
}

function isManualPaymentEnabled() {
  return readManualPaymentConfig().enabled;
}

/** Pick the localized note; falls back to the other language rather than to nothing. */
function localizedNote(pair, lang) {
  if (!pair) return null;
  const ar = String(lang || '').toLowerCase() === 'ar';
  return (ar ? (pair.ar || pair.en) : (pair.en || pair.ar)) || null;
}

/**
 * The amount a transfer must be for — EXACTLY what the card flow charges.
 *
 * Not recomputed: it is the same call services/paymob_intention.js makes
 * before minting (owedCentsForOrder over orders.price + the PERSISTED
 * addons_json), and orders.price already carries the VIP/Urgent uplift and any
 * applied referral discount. The currency is the order's charge currency
 * (EGP for every order today, international ones included).
 *
 * @param {{price:any, addons_json:any, currency?:string}} order
 * @returns {{amount:number, amountCents:number, currency:string}}
 */
function transferAmountForOrder(order) {
  const { owedCentsForOrder } = require('./order_pricing');
  const amountCents = owedCentsForOrder({ price: order && order.price, addons_json: (order && order.addons_json) || null });
  return {
    amount: Math.round(amountCents) / 100,
    amountCents: amountCents,
    currency: String((order && order.currency) || 'EGP').toUpperCase()
  };
}

/**
 * orders.reference_id, minted and persisted if missing — the SAME generator
 * and the SAME `COALESCE(reference_id, $1)` write the wizard's step-5 submit
 * uses (routes/patient.js), so a concurrent submit can never be overwritten.
 */
async function ensureOrderReference(order, patientId) {
  if (order && order.reference_id) return String(order.reference_id);
  const { generateReferenceId } = D.reference();
  const fresh = await generateReferenceId();
  const row = await pg().queryOne(
    `UPDATE orders SET reference_id = COALESCE(reference_id, $1)
      WHERE id = $2 AND patient_id = $3
      RETURNING reference_id`,
    [fresh, order.id, patientId]
  );
  return String((row && row.reference_id) || fresh);
}

function toIso(v) {
  if (!v) return null;
  const d = (v instanceof Date) ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** Contract shape of a claim. */
function claimDto(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    status: String(row.status),
    method: String(row.method),
    reference: String(row.reference || ''),
    senderName: row.sender_name ? String(row.sender_name) : null,
    // The latest submission time — a resubmit updates the pending claim.
    submittedAt: toIso(row.updated_at || row.created_at),
    rejectionReason: row.rejection_reason ? String(row.rejection_reason) : null
  };
}

/**
 * The claim to show for an order: the pending one if any, else the newest.
 * Returns null (never throws) when the table is not there yet — a deploy that
 * boots before migration 117 has run must still render the pay page.
 */
async function getCurrentClaim(orderId) {
  try {
    return await pg().queryOne(
      `SELECT id, order_id, patient_id, method, reference, sender_name, status,
              rejection_reason, created_at, updated_at, resolved_at, resolved_by
         FROM payment_claims
        WHERE order_id = $1
        ORDER BY (status = 'pending') DESC, updated_at DESC
        LIMIT 1`,
      [orderId]
    );
  } catch (_) {
    return null;
  }
}

/**
 * Validate a patient's claim input. Pure.
 * @returns {{ok:true, value:{method,reference,senderName}} | {ok:false, field:string, code:string, message:string}}
 */
function validateClaimInput(body, cfg) {
  const b = (body && typeof body === 'object') ? body : {};
  const method = String(b.method == null ? '' : b.method).trim().toLowerCase();
  if (METHODS.indexOf(method) === -1) {
    return { ok: false, field: 'method', code: 'method_invalid', message: "method must be 'instapay' or 'bank'" };
  }
  if (cfg && method === 'instapay' && !cfg.instapay) {
    return { ok: false, field: 'method', code: 'method_unavailable', message: 'InstaPay is not available for this payment' };
  }
  if (cfg && method === 'bank' && !cfg.bank) {
    return { ok: false, field: 'method', code: 'method_unavailable', message: 'Bank transfer is not available for this payment' };
  }
  // Collapse whitespace; strip control characters. A reference is retyped by
  // a human from a banking app — keep it as they typed it otherwise.
  // eslint-disable-next-line no-control-regex
  const reference = String(b.reference == null ? '' : b.reference).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (reference.length < REFERENCE_MIN || reference.length > REFERENCE_MAX) {
    return { ok: false, field: 'reference', code: 'reference_invalid', message: 'reference must be 3-80 characters' };
  }
  const senderRaw = (b.senderName != null ? b.senderName : b.sender_name);
  // eslint-disable-next-line no-control-regex
  const senderName = String(senderRaw == null ? '' : senderRaw).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (senderName.length > SENDER_MAX) {
    return { ok: false, field: 'senderName', code: 'sender_invalid', message: 'senderName must be at most 80 characters' };
  }
  return { ok: true, value: { method: method, reference: reference, senderName: senderName || null } };
}

/**
 * Record (or update) the patient's pending transfer claim.
 *
 * One pending claim per order: a resubmit while pending UPDATES that row (the
 * partial unique index payment_claims_one_pending_per_order backs this against
 * a double-click race). A claim after a rejection starts a new pending row, so
 * the rejected one stays as history.
 *
 * Writes: payment_claims (upsert), orders.updated_at (TTL clock only). Nothing
 * else. Notifies superadmins through the existing ops chain.
 *
 * @param {object} args
 * @param {{id:string, reference_id?:string, price?:any, addons_json?:any, currency?:string}} args.order
 * @param {string} args.patientId
 * @param {string} [args.patientName]
 * @param {{method:string, reference:string, senderName:string|null}} args.claim  validated input
 * @param {string} [args.source]  'web' | 'app'
 * @returns {Promise<{claim:object, created:boolean}>}
 */
async function submitClaim({ order, patientId, patientName, claim, source }) {
  const db = pg();
  const orderId = String(order.id);
  let row = null;
  let created = false;

  const updatePending = () => db.queryOne(
    `UPDATE payment_claims
        SET method = $1, reference = $2, sender_name = $3, patient_id = COALESCE(patient_id, $4),
            updated_at = NOW()
      WHERE order_id = $5 AND status = 'pending'
      RETURNING *`,
    [claim.method, claim.reference, claim.senderName, patientId, orderId]
  );

  row = await updatePending();
  if (!row) {
    try {
      row = await db.queryOne(
        `INSERT INTO payment_claims
           (id, order_id, patient_id, method, reference, sender_name, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW(), NOW())
         RETURNING *`,
        ['pc-' + randomUUID(), orderId, patientId, claim.method, claim.reference, claim.senderName]
      );
      created = true;
    } catch (err) {
      // Lost a race with a concurrent submit: that row is now the pending one.
      if (err && (err.code === '23505' || /payment_claims_one_pending_per_order/.test(String(err.message || '')))) {
        row = await updatePending();
        created = false;
      } else {
        throw err;
      }
    }
  }
  if (!row) throw new Error('payment_claim_upsert_failed');

  // Last activity on the case → restarts the unpaid TTL clock (updated_at).
  // Deliberately the ONLY column touched on orders.
  try {
    await db.execute('UPDATE orders SET updated_at = $1 WHERE id = $2', [new Date().toISOString(), orderId]);
  } catch (e) {
    try { D.logger().logErrorToDb(e, { context: 'manual_payment.touch_updated_at', orderId }); } catch (_) {}
  }

  try {
    const { logOrderEvent } = D.audit();
    logOrderEvent({
      orderId,
      label: created ? 'payment_claim_submitted' : 'payment_claim_updated',
      meta: { claim_id: row.id, method: row.method, reference: row.reference, source: source || null },
      actorUserId: patientId,
      actorRole: 'patient'
    });
  } catch (_) { /* audit must never block the claim */ }

  notifyStaffOfClaim({ order, claimRow: row, patientName, created });

  return { claim: row, created };
}

/**
 * Tell superadmins a transfer needs checking — the same chain a patient refund
 * request uses: notifyAdmins (in-app superadmin queue, one row per active
 * superadmin) + pushOpsEvent (Command app push). Both fire-and-forget; neither
 * can fail the patient's request.
 */
function notifyStaffOfClaim({ order, claimRow, patientName, created }) {
  const orderId = String(order.id);
  const caseReference = order.reference_id || orderId.slice(0, 12).toUpperCase();
  let amountLabel = '';
  let amount = null;
  let currency = 'EGP';
  try {
    const a = transferAmountForOrder(order);
    amount = a.amount; currency = a.currency;
    amountLabel = currency + ' ' + a.amount.toLocaleString('en-US');
  } catch (_) { /* amount is informational in the alert */ }
  // A resubmission is new information for staff: key the dedupe on the
  // submission time so each distinct submission alerts once.
  const stamp = (toIso(claimRow.updated_at) || new Date().toISOString());

  try {
    const { notifyAdmins } = D.notify();
    Promise.resolve(notifyAdmins({
      template: 'admin_payment_claim_received',
      payload: {
        case_id: orderId,
        caseReference: caseReference,
        claim_id: claimRow.id,
        method: claimRow.method,
        transferReference: claimRow.reference,
        senderName: claimRow.sender_name || null,
        amount: amount,
        currency: currency,
        patientName: patientName || '',
        resubmitted: !created
      },
      dedupeKey: 'payment_claim:' + claimRow.id + ':' + stamp + ':sa',
      orderId
    })).catch(function () { /* logged inside notify */ });
  } catch (_) { /* fan-out failure must not block the claim */ }

  // Soft launch 2026-09-25: the in-app row above is only seen by someone who
  // is already looking at the console. The money path is now InstaPay, so a
  // claim is the moment a human has to act — it goes to the superadmins'
  // WhatsApp too, exactly the way dispatchSlaBreach reaches them. Separate
  // dedupe suffix so the two channels never collapse into one row.
  try {
    const { notifyAdmins } = D.notify();
    Promise.resolve(notifyAdmins({
      template: 'admin_payment_claim_received',
      payload: {
        case_id: orderId,
        caseReference: caseReference,
        claim_id: claimRow.id,
        method: claimRow.method,
        transferReference: claimRow.reference,
        senderName: claimRow.sender_name || null,
        amount: amount,
        currency: currency,
        patientName: patientName || '',
        resubmitted: !created
      },
      dedupeKey: 'payment_claim:' + claimRow.id + ':' + stamp + ':sa:wa',
      orderId,
      channel: 'whatsapp'
    })).catch(function () { /* logged inside notify */ });
  } catch (_) { /* fan-out failure must not block the claim */ }

  try {
    const { pushOpsEvent } = D.opsPush();
    Promise.resolve(pushOpsEvent({
      kind: 'payment_claim',
      dedupeKey: claimRow.id + ':' + stamp,
      title: 'Transfer to verify' + (amountLabel ? ' — ' + amountLabel : ''),
      body: (patientName || 'A patient') + ' on case ' + caseReference + ' says they paid by ' +
            (claimRow.method === 'bank' ? 'bank transfer' : 'InstaPay') + ', ref ' + claimRow.reference,
      data: { orderId: orderId, claimId: claimRow.id },
      orderId
    })).catch(function () { /* logged inside ops_push */ });
  } catch (_) { /* push failure must not block the claim */ }
}

/**
 * Superadmin: reject a pending claim. The order is NOT touched — it stays
 * unpaid — and the patient is told (in-app + email, bilingual via the
 * registries) that the transfer could not be matched, with the reason.
 *
 * @returns {Promise<{ok:boolean, code?:string, claim?:object}>}
 */
async function rejectClaim({ orderId, claimId, reason, actorId }) {
  const why = String(reason == null ? '' : reason).replace(/\s+/g, ' ').trim();
  if (!why) return { ok: false, code: 'reason_required' };
  if (why.length > REJECTION_REASON_MAX) return { ok: false, code: 'reason_too_long' };

  const db = pg();
  const row = await db.queryOne(
    `UPDATE payment_claims
        SET status = 'rejected', rejection_reason = $1, resolved_at = NOW(),
            resolved_by = $2, updated_at = NOW()
      WHERE id = $3 AND order_id = $4 AND status = 'pending'
      RETURNING *`,
    [why, actorId || null, claimId, orderId]
  );
  if (!row) return { ok: false, code: 'not_pending' };

  try {
    const { logOrderEvent } = D.audit();
    logOrderEvent({
      orderId,
      label: 'payment_claim_rejected',
      meta: { claim_id: row.id, reason: why.slice(0, 200) },
      actorUserId: actorId || null,
      actorRole: 'superadmin'
    });
  } catch (_) {}

  if (row.patient_id) {
    try {
      const ord = await db.queryOne('SELECT reference_id FROM orders_active WHERE id = $1', [orderId]);
      const caseReference = (ord && ord.reference_id) || String(orderId).slice(0, 12).toUpperCase();
      const { queueMultiChannelNotification } = D.notify();
      Promise.resolve(queueMultiChannelNotification({
        orderId,
        toUserId: row.patient_id,
        channels: ['internal', 'email'],
        template: 'payment_claim_rejected_patient',
        response: {
          case_id: orderId,
          caseReference: caseReference,
          transferReference: row.reference,
          rejectionReason: why,
          reason: why
        },
        dedupe_key: 'payment_claim_rejected:' + row.id + ':patient'
      })).catch(function () {});
    } catch (_) { /* notification failure must not undo the rejection */ }
  }

  return { ok: true, claim: row };
}

/**
 * After the EXISTING superadmin mark-paid has succeeded: close the order's
 * pending claim as confirmed. Called AFTER that route's own writes; it reads
 * nothing from and writes nothing to `orders`, so the mark-paid behaviour is
 * unchanged. Never throws (missing table, no claim → no-op).
 */
async function confirmPendingClaimForOrder(orderId, actorId) {
  try {
    const row = await pg().queryOne(
      `UPDATE payment_claims
          SET status = 'confirmed', resolved_at = NOW(), resolved_by = $1, updated_at = NOW()
        WHERE order_id = $2 AND status = 'pending'
        RETURNING id`,
      [actorId || null, orderId]
    );
    return row ? String(row.id) : null;
  } catch (_) {
    return null;
  }
}

/** Superadmin/Command list of claims (default: pending), oldest first. */
async function listClaims({ status } = {}) {
  const st = STATUSES.indexOf(String(status || 'pending')) >= 0 ? String(status || 'pending') : 'pending';
  const rows = await pg().queryAll(
    `SELECT pc.id, pc.order_id, pc.patient_id, pc.method, pc.reference, pc.sender_name,
            pc.status, pc.rejection_reason, pc.created_at, pc.updated_at, pc.resolved_at, pc.resolved_by,
            o.reference_id, o.price, o.currency, o.addons_json, o.payment_status,
            u.name AS patient_name, u.email AS patient_email, u.phone AS patient_phone
       FROM payment_claims pc
       JOIN orders_active o ON o.id = pc.order_id
       LEFT JOIN users u ON u.id = pc.patient_id
      WHERE pc.status = $1
        -- A pending claim on a case since paid by card is moot: hide it.
        AND ($1 <> 'pending' OR COALESCE(o.payment_status, '') <> 'paid')
      ORDER BY pc.updated_at ASC
      LIMIT 200`,
    [st]
  );
  return (rows || []).map(function (r) {
    const amt = transferAmountForOrder(r);
    return Object.assign(claimDto(r), {
      orderId: String(r.order_id),
      orderReference: r.reference_id || null,
      orderPaymentStatus: r.payment_status || null,
      amount: amt.amount,
      currency: amt.currency,
      createdAt: toIso(r.created_at),
      resolvedAt: toIso(r.resolved_at),
      patient: { name: r.patient_name || null, email: r.patient_email || null, phone: r.patient_phone || null }
    });
  });
}

/** Count of pending claims for dashboards; 0 when the table is not there yet. */
async function countPendingClaims() {
  try {
    const r = await pg().queryOne(
      `SELECT COUNT(*) AS cnt
         FROM payment_claims pc
         JOIN orders_active o ON o.id = pc.order_id
        WHERE pc.status = 'pending'
          AND COALESCE(o.payment_status, '') <> 'paid'`
    );
    return Number((r && r.cnt) || 0);
  } catch (_) {
    return 0;
  }
}

/**
 * The `manual` object of GET /api/v1/cases/:id/payment (contract shape), or
 * null when the flag is off / nothing is configured / the order is paid or
 * not payable. Mints the reference if missing.
 *
 * @param {object} args
 * @param {object} args.order  row with id, status, payment_status, price, currency, addons_json, reference_id
 * @param {string} args.patientId
 * @param {string} args.lang   'en' | 'ar'
 */
async function buildManualInfo({ order, patientId, lang }) {
  const cfg = readManualPaymentConfig();
  if (!cfg.enabled || !order) return null;
  if (String(order.payment_status || '').toLowerCase() === 'paid') return null;
  const { isPayableStatus } = D.caseLifecycle();
  if (!isPayableStatus(order.status)) return null;

  const amt = transferAmountForOrder(order);
  const reference = await ensureOrderReference(order, patientId);
  const claimRow = await getCurrentClaim(order.id);
  return {
    instapay: cfg.instapay ? { handle: cfg.instapay.handle || null, link: cfg.instapay.link || null } : null,
    bank: cfg.bank ? {
      bankName: cfg.bank.bankName || null,
      accountName: cfg.bank.accountName,
      accountNumber: cfg.bank.accountNumber || null,
      iban: cfg.bank.iban || null
    } : null,
    relationshipNote: localizedNote(cfg.relationshipNote, lang),
    confirmNote: localizedNote(cfg.confirmNote, lang),
    amount: amt.amount,
    currency: amt.currency,
    reference: reference,
    claim: claimDto(claimRow)
  };
}

module.exports = {
  METHODS,
  STATUSES,
  REFERENCE_MIN,
  REFERENCE_MAX,
  SENDER_MAX,
  REJECTION_REASON_MAX,
  DEFAULT_CONFIRM_NOTE_EN,
  DEFAULT_CONFIRM_NOTE_AR,
  envFlag,
  isCardPaymentEnabled,
  readManualPaymentConfig,
  isManualPaymentEnabled,
  localizedNote,
  transferAmountForOrder,
  ensureOrderReference,
  claimDto,
  getCurrentClaim,
  validateClaimInput,
  submitClaim,
  notifyStaffOfClaim,
  rejectClaim,
  confirmPendingClaimForOrder,
  listClaims,
  countPendingClaims,
  buildManualInfo,
  __setTestDeps
};
