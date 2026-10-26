'use strict';

// ─── Promo codes (SHIFA25) — the ONE module that knows what a code is ────────
//
// 26 Oct 2026. The printed OPD poster and leaflets at Shifa Hospital advertise
// "SHIFA25 — 25% off". Schema: migration 131.
//
// THE MODEL. A promo lowers orders.price and nothing else:
//
//   price_before_discount = the list price (EGP, tier uplift included)
//   price                 = applyToEgp(list, percentOff).total   (whole EGP)
//   discount_egp          = list - price
//
// orders.price is the charge everywhere — owedCentsForOrder (Kashier session +
// webhook verification), manual_payment.transferAmountForOrder (the InstaPay /
// bank amount and the claim the operator verifies), receipts, refunds — so
// every one of those follows the discount without being told about it, and a
// client can never post a different amount: nothing reads an amount from the
// request. base_price, urgency_uplift_amount and doctor_fee are NOT touched,
// so the doctor's share (doctor_fee + uplift share, earnings_calc) is computed
// from the list price and does not shrink because of a promo.
//
// ONE CODE PER ORDER, NEVER TWICE. Every apply recomputes from the list price
// (COALESCE(price_before_discount, price)), so applying SHIFA25 twice gives the
// same 563 as once, and applying a different code replaces rather than stacks.
// The write is guarded on the list price it was computed from, so two racing
// applies cannot compound either. A referral discount and a promo do not
// combine (refused both ways).
//
// USES. `uses` counts PAID orders only: redeemForPaidOrder runs inside
// case_lifecycle.markCasePaid's transaction — the one boundary every paid path
// crosses (Kashier webhook, stub success, superadmin mark-paid / InstaPay claim
// approval, Command API) — and is idempotent via orders.promo_redeemed_at.
// max_uses is enforced when a code is APPLIED; an order that already carries a
// code is still honoured at payment even if the limit filled meanwhile (the
// patient was quoted that price).

const { queryOne, execute } = require('../pg');

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;

// reason → API error code (E2E_CONTRACT: { success:false, error, code }).
const REASON_CODES = Object.freeze({
  invalid: 'PROMO_INVALID',
  inactive: 'PROMO_EXPIRED',
  not_started: 'PROMO_EXPIRED',
  expired: 'PROMO_EXPIRED',
  exhausted: 'PROMO_EXPIRED',
  not_eligible: 'PROMO_NOT_ELIGIBLE',
  combined: 'PROMO_NOT_ELIGIBLE',
  not_payable: 'PROMO_NOT_ELIGIBLE'
});

// Bilingual patient copy, keyed by reason. Same register as the wizard.
const MESSAGES = Object.freeze({
  invalid: {
    en: 'That code isn’t valid. Check the spelling and try again.',
    ar: 'الكود ده مش صحيح. راجع الكتابة وجرّب تاني.'
  },
  inactive: {
    en: 'That code is no longer active.',
    ar: 'الكود ده لم يعد مفعّلًا.'
  },
  not_started: {
    en: 'That code isn’t active yet.',
    ar: 'الكود ده لسه مش مفعّل.'
  },
  expired: {
    en: 'That code has expired.',
    ar: 'الكود ده انتهت صلاحيته.'
  },
  exhausted: {
    en: 'That code has reached its limit.',
    ar: 'الكود ده وصل للحد الأقصى من الاستخدام.'
  },
  not_eligible: {
    en: 'That code isn’t valid for prices in your country.',
    ar: 'الكود ده مش متاح لأسعار بلدك.'
  },
  combined: {
    en: 'A referral discount is already applied — codes can’t be combined.',
    ar: 'في خصم إحالة مطبّق بالفعل — مينفعش تجمع بين خصمين.'
  },
  not_payable: {
    en: 'A code can only be added before you pay.',
    ar: 'الكود يتضاف قبل الدفع بس.'
  }
});

function messageFor(reason, lang) {
  const m = MESSAGES[reason] || MESSAGES.invalid;
  return String(lang || '').toLowerCase() === 'ar' ? m.ar : m.en;
}

function errorCodeFor(reason) {
  return REASON_CODES[reason] || 'PROMO_INVALID';
}

/**
 * Canonical form of a code typed by a patient or carried in ?promo=.
 * Uppercased, inner whitespace dropped. Returns null for anything that is not
 * a plausible code (so it is never echoed back into a page or a query).
 * @param {*} raw
 * @returns {string|null}
 */
function normaliseCode(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase().replace(/\s+/g, '');
  if (!s || !CODE_RE.test(s)) return null;
  return s;
}

/**
 * Apply a percentage to an EGP amount, rounded to WHOLE EGP (half up).
 * 750 at 25% → { total: 563, discount: 187 }. The discount is whatever the
 * rounding leaves, so total + discount === amount always holds.
 * @param {number} amountEgp
 * @param {number} percentOff 1..90
 * @returns {{ total:number, discount:number }}
 */
function applyToEgp(amountEgp, percentOff) {
  const amount = Number(amountEgp);
  const pct = Math.trunc(Number(percentOff));
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(pct) || pct < 1 || pct > 90) {
    const safe = Number.isFinite(amount) && amount > 0 ? amount : 0;
    return { total: safe, discount: 0 };
  }
  // Integer arithmetic on piastres first so 0.1-style float drift cannot move
  // a .5 boundary: 75000 * 75 / 10000 = 562.5 exactly → 563.
  const cents = Math.round(amount * 100);
  const total = Math.round((cents * (100 - pct)) / 10000);
  const discount = Math.round((cents - total * 100)) / 100;
  return { total, discount };
}

function _asArray(markets) {
  if (markets == null) return null;
  if (Array.isArray(markets)) return markets;
  // node-pg returns text[] as an array; a hand-built row may carry '{EG,AE}'.
  const s = String(markets).replace(/^\{|\}$/g, '').trim();
  return s ? s.split(',').map((x) => x.replace(/"/g, '').trim()) : [];
}

/**
 * Pure: decide whether a promo_codes row is usable right now in a market.
 * @param {Object|null} row promo_codes row
 * @param {{ pricingMarket?: string, now?: Date }} ctx
 * @returns {{ ok:true, code:string, percentOff:number } | { ok:false, reason:string }}
 */
function evaluate(row, ctx) {
  const c = ctx || {};
  const now = c.now instanceof Date ? c.now : new Date();
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.active === false || row.active === 'f' || row.active === 'false') {
    return { ok: false, reason: 'inactive' };
  }
  if (row.starts_at && new Date(row.starts_at).getTime() > now.getTime()) {
    return { ok: false, reason: 'not_started' };
  }
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  if (row.max_uses != null && Number(row.uses || 0) >= Number(row.max_uses)) {
    return { ok: false, reason: 'exhausted' };
  }
  const markets = _asArray(row.markets);
  if (markets && markets.length) {
    const m = String(c.pricingMarket || '').trim().toUpperCase();
    if (!m || markets.map((x) => String(x).toUpperCase()).indexOf(m) === -1) {
      return { ok: false, reason: 'not_eligible' };
    }
  }
  const pct = Math.trunc(Number(row.percent_off));
  if (!Number.isFinite(pct) || pct < 1 || pct > 90) return { ok: false, reason: 'invalid' };
  return { ok: true, code: String(row.code).toUpperCase(), percentOff: pct };
}

/**
 * Validate a code for a pricing market (pricing_market.pricingMarketFor()).
 * @param {string} code
 * @param {{ pricingMarket?: string, now?: Date, queryOneFn?: Function }} opts
 * @returns {Promise<{ ok:boolean, code?:string, percentOff?:number, reason?:string }>}
 */
async function validate(code, opts) {
  const o = opts || {};
  const norm = normaliseCode(code);
  if (!norm) return { ok: false, reason: 'invalid' };
  const q = o.queryOneFn || queryOne;
  const row = await q(
    `SELECT code, percent_off, active, starts_at, expires_at, max_uses, uses, markets
       FROM promo_codes WHERE UPPER(code) = $1`,
    [norm]
  );
  return evaluate(row, o);
}

// The promo state of one order, read from `orders` (not orders_active) so the
// feature does not depend on migration 131's view re-sync having succeeded.
async function _loadOrderMoney(orderId, patientId, q) {
  return q(
    `SELECT id, patient_id, status, payment_status, price, price_before_discount,
            discount_egp, promo_code, referral_discount
       FROM orders
      WHERE id = $1 AND patient_id = $2 AND deleted_at IS NULL`,
    [orderId, patientId]
  );
}

/**
 * The promo summary of an order row, for a page or an API payload.
 * Null when the order carries no promo.
 * @param {Object} row needs price, price_before_discount, discount_egp, promo_code
 */
function summaryFor(row) {
  if (!row || !row.promo_code || row.price_before_discount == null) return null;
  const before = Number(row.price_before_discount);
  const price = Number(row.price);
  const discount = row.discount_egp != null ? Number(row.discount_egp) : Math.round((before - price) * 100) / 100;
  if (!Number.isFinite(before) || !Number.isFinite(price)) return null;
  return {
    code: String(row.promo_code).toUpperCase(),
    priceBeforeDiscount: before,
    discountEgp: discount,
    price: price
  };
}

/**
 * Read an order's promo summary (or null). Never throws.
 */
async function orderPromoSummary(orderId, opts) {
  const o = opts || {};
  const q = o.queryOneFn || queryOne;
  try {
    const row = await q(
      `SELECT price, price_before_discount, discount_egp, promo_code
         FROM orders WHERE id = $1 AND deleted_at IS NULL`,
      [orderId]
    );
    return summaryFor(row);
  } catch (_) {
    return null;
  }
}

/**
 * The part of a LIST-price component (e.g. the urgency uplift) the patient
 * actually paid on a promo order: amount x price / price_before_discount, to
 * 2dp. No promo, or anything unreadable → the amount unchanged. Never throws.
 * Used by sla_breach so a breach refund never returns more than was paid.
 */
function paidShareOf(amountEgp, row) {
  const amount = Number(amountEgp) || 0;
  const before = Number(row && row.price_before_discount);
  const price = Number(row && row.price);
  if (!row || !row.promo_code || !(before > 0) || !Number.isFinite(price) || price >= before) return amount;
  return Math.round(amount * (price / before) * 100) / 100;
}

async function paidShareEgp(orderId, amountEgp, opts) {
  const q = (opts && opts.queryOneFn) || queryOne;
  try {
    const row = await q(
      `SELECT price, price_before_discount, promo_code
         FROM orders WHERE id = $1 AND deleted_at IS NULL`,
      [orderId]
    );
    return paidShareOf(amountEgp, row);
  } catch (_) {
    return Number(amountEgp) || 0;
  }
}

function _isDraft(row) {
  return String((row && row.status) || '').toUpperCase() === 'DRAFT' &&
    String((row && row.payment_status) || '').toLowerCase() !== 'paid';
}

/**
 * Apply (or re-apply) a code to a DRAFT order the patient owns. Validates,
 * recomputes from the list price and writes price / price_before_discount /
 * discount_egp / promo_code in one guarded UPDATE. Nulls the payment intention
 * and link with the price, exactly as persistTierPricing does: a stale link
 * would charge the old amount.
 *
 * @param {{ orderId:string, patientId:string, code:string, pricingMarket:string,
 *           now?:Date, queryOneFn?:Function, executeFn?:Function }} a
 * @returns {Promise<{ ok:true, summary:Object } | { ok:false, reason:string }>}
 */
async function applyToOrder(a) {
  const q = a.queryOneFn || queryOne;
  const ex = a.executeFn || execute;
  const v = await validate(a.code, { pricingMarket: a.pricingMarket, now: a.now, queryOneFn: q });
  if (!v.ok) return v;

  const row = await _loadOrderMoney(a.orderId, a.patientId, q);
  if (!row || !_isDraft(row)) return { ok: false, reason: 'not_payable' };
  if (Number(row.referral_discount) > 0) return { ok: false, reason: 'combined' };

  const list = row.price_before_discount != null ? Number(row.price_before_discount) : Number(row.price);
  if (!Number.isFinite(list) || list <= 0) return { ok: false, reason: 'not_payable' };
  const r = applyToEgp(list, v.percentOff);

  const result = await ex(
    `UPDATE orders
        SET price_before_discount = $1,
            price = $2,
            discount_egp = $3,
            promo_code = $4,
            paymob_intention_id = NULL,
            payment_link = NULL,
            updated_at = NOW()
      WHERE id = $5 AND patient_id = $6 AND deleted_at IS NULL
        AND UPPER(COALESCE(status, '')) = 'DRAFT'
        AND COALESCE(payment_status, '') <> 'paid'
        AND COALESCE(referral_discount, 0) = 0
        AND COALESCE(price_before_discount, price) = $1`,
    [list, r.total, r.discount, v.code, a.orderId, a.patientId]
  );
  if (!result || result.rowCount === 0) return { ok: false, reason: 'not_payable' };
  return {
    ok: true,
    summary: { code: v.code, percentOff: v.percentOff, priceBeforeDiscount: list, discountEgp: r.discount, price: r.total }
  };
}

/**
 * Take the code off a DRAFT order: price goes back to the list price.
 * No-op (ok) when the order carries no code.
 */
async function removeFromOrder(a) {
  const ex = a.executeFn || execute;
  await ex(
    `UPDATE orders
        SET price = price_before_discount,
            price_before_discount = NULL,
            discount_egp = NULL,
            promo_code = NULL,
            paymob_intention_id = NULL,
            payment_link = NULL,
            updated_at = NOW()
      WHERE id = $1 AND patient_id = $2 AND deleted_at IS NULL
        AND UPPER(COALESCE(status, '')) = 'DRAFT'
        AND COALESCE(payment_status, '') <> 'paid'
        AND price_before_discount IS NOT NULL`,
    [a.orderId, a.patientId]
  );
  // A code with no price_before_discount (cleared by a re-price) is dropped too.
  await ex(
    `UPDATE orders SET promo_code = NULL, discount_egp = NULL
      WHERE id = $1 AND patient_id = $2 AND deleted_at IS NULL
        AND UPPER(COALESCE(status, '')) = 'DRAFT'
        AND promo_code IS NOT NULL AND price_before_discount IS NULL`,
    [a.orderId, a.patientId]
  );
  return { ok: true };
}

/**
 * After a writer has put a fresh LIST price on a DRAFT (persistTierPricing
 * clears price_before_discount / discount_egp in the same UPDATE), put the
 * patient's code back on it — re-validated, so a code that expired in the
 * meantime is dropped rather than honoured. Never throws: a failure leaves the
 * order at its (higher) list price with the code removed, never at a stale
 * discount.
 */
async function reapplyToOrder(a) {
  const q = a.queryOneFn || queryOne;
  try {
    const row = await q(
      `SELECT promo_code FROM orders WHERE id = $1 AND patient_id = $2 AND deleted_at IS NULL`,
      [a.orderId, a.patientId]
    );
    if (!row || !row.promo_code) return { ok: true, skipped: 'no_code' };
    const r = await applyToOrder(Object.assign({}, a, { code: row.promo_code }));
    if (!r.ok) await removeFromOrder(a);
    return r;
  } catch (err) {
    try { await removeFromOrder(a); } catch (_) { /* best effort */ }
    return { ok: false, reason: 'invalid', error: err };
  }
}

/**
 * Count the use — ONLY from inside the paid transaction (markCasePaid), on the
 * same client. Idempotent: promo_redeemed_at is stamped once, and the uses
 * increment is driven by that stamp's RETURNING row, so a re-delivered webhook
 * or a second mark-paid cannot count twice.
 *
 * Wrapped in a SAVEPOINT by the caller's contract here: a failure must never
 * abort the payment transaction it rides in.
 *
 * @param {{ query: Function }} client the transaction client
 * @param {string} orderId
 * @returns {Promise<{ redeemed:boolean, code?:string }>}
 */
async function redeemForPaidOrder(client, orderId) {
  if (!client || !orderId) return { redeemed: false };
  const sp = 'promo_redeem';
  await client.query('SAVEPOINT ' + sp);
  try {
    const stamped = await client.query(
      `UPDATE orders SET promo_redeemed_at = NOW()
        WHERE id = $1 AND promo_code IS NOT NULL AND promo_redeemed_at IS NULL
          AND deleted_at IS NULL
        RETURNING promo_code`,
      [orderId]
    );
    const row = stamped && stamped.rows && stamped.rows[0];
    if (!row || !row.promo_code) {
      await client.query('RELEASE SAVEPOINT ' + sp);
      return { redeemed: false };
    }
    await client.query(
      'UPDATE promo_codes SET uses = uses + 1 WHERE UPPER(code) = UPPER($1)',
      [row.promo_code]
    );
    await client.query('RELEASE SAVEPOINT ' + sp);
    return { redeemed: true, code: String(row.promo_code).toUpperCase() };
  } catch (err) {
    try { await client.query('ROLLBACK TO SAVEPOINT ' + sp); } catch (_) { /* gone */ }
    try { await client.query('RELEASE SAVEPOINT ' + sp); } catch (_) { /* gone */ }
    console.error('[promo] redeem failed for order', orderId, err && err.message);
    return { redeemed: false, error: err && err.message };
  }
}

// ── ?promo=CODE carry-over ─────────────────────────────────────────────────
// The poster's QR may carry ?promo=SHIFA25 to /start or the wizard. Between
// that first page and Step 5 sit /register, the wizard's auto-resume redirect
// and four steps, none of which forward a query string — so the code is kept
// in a short first-party cookie and only PRE-FILLS the field. Nothing is
// discounted until the patient presses Apply (server-side, validated).
const PROMO_COOKIE = 'tk_promo';
const PROMO_COOKIE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

/** Remember a valid-looking ?promo= on the response. Returns the code or null. */
function rememberFromQuery(req, res) {
  const code = normaliseCode(req && req.query && req.query.promo);
  if (code && res && typeof res.cookie === 'function') {
    try {
      res.cookie(PROMO_COOKIE, code, { maxAge: PROMO_COOKIE_MAX_AGE_MS, httpOnly: true, sameSite: 'lax' });
    } catch (_) { /* a prefill convenience only */ }
  }
  return code;
}

/** The code to pre-fill: ?promo= first, then the cookie. Null when neither. */
function prefillFromRequest(req) {
  return normaliseCode(req && req.query && req.query.promo) ||
    normaliseCode(req && req.cookies && req.cookies[PROMO_COOKIE]) ||
    null;
}

module.exports = {
  PROMO_COOKIE,
  rememberFromQuery,
  prefillFromRequest,
  normaliseCode,
  applyToEgp,
  evaluate,
  validate,
  applyToOrder,
  removeFromOrder,
  reapplyToOrder,
  redeemForPaidOrder,
  summaryFor,
  orderPromoSummary,
  paidShareOf,
  paidShareEgp,
  messageFor,
  errorCodeFor,
  REASON_CODES,
  CODE_RE
};
