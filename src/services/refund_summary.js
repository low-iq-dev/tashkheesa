/**
 * Refund summary — the ONE sentence every refund surface says about a case.
 *
 * Part C (2026-09-13). The patient request form, the operator queue, the
 * operator create form and the Command API each used to work out "what can
 * this patient get back?" on their own: the form showed a bare amount, the
 * create view recomputed base_price + uplift inline (and so offered 2400 on a
 * case with 600 already paid back), and the queue showed only what the patient
 * typed. This module turns the existing eligibility verdict and ceiling
 * (services/refund_eligibility.js — unchanged, still the policy) into a single
 * description so they cannot disagree.
 *
 * Kinds:
 *   full           — no consultant has started; everything paid comes back (auto-approved).
 *   review         — a consultant is working; a request is allowed but decided by the team.
 *   remainder      — part of the payment was already refunded; the rest may be requested.
 *   surcharge_only — the deadline was missed and the urgency surcharge was refunded
 *                    automatically; nothing further can be requested online.
 *   nothing        — nothing can be requested (delivered, fully refunded, unpaid, …).
 *
 * describeRefund() is pure (tests render the form against it); refundSummaryForOrder()
 * gathers the facts from the database.
 */

'use strict';

const {
  isEligibleForRefund,
  maxRefundableEgp,
  paidRefundedEgp
} = require('./refund_eligibility');
const { owedCentsForOrder } = require('./order_pricing');

const TIER_NAMES = {
  standard: { en: 'Standard', ar: 'القياسية' },
  vip: { en: 'VIP', ar: 'VIP' },
  urgent: { en: 'Urgent', ar: 'العاجلة' }
};

function tierOf(order) {
  const t = String((order && (order.urgency_tier || order.tier)) || 'standard').toLowerCase();
  return TIER_NAMES[t] ? t : 'standard';
}

function round2(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

// Western digits in both languages (B8): money is read, compared and typed
// into InstaPay, so it uses the digits on the patient's keypad.
function fmtEgp(n, lang) {
  const v = round2(n);
  const s = v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return lang === 'ar' ? s + ' جنيه' : 'EGP ' + s;
}

/**
 * @param {Object} f
 * @param {{eligible:boolean, reason:string, autoApprove:boolean}} f.verdict
 * @param {number} f.ceilingEgp        maxRefundableEgp(order) — what was charged (less a consumed add-on)
 * @param {number} f.alreadyRefundedEgp refunds already PAID on the order
 * @param {string} [f.tier]            standard | vip | urgent
 * @param {number} [f.upliftEgp]       the urgency surcharge on the order
 * @param {{amount:number,status:string}|null} [f.breachRefund] the automatic SLA-breach refund row
 */
function describeRefund(f) {
  const verdict = f.verdict || { eligible: false, reason: 'unknown_status', autoApprove: false };
  const ceiling = round2(f.ceilingEgp);
  const already = round2(f.alreadyRefundedEgp);
  const remaining = Math.max(0, round2(ceiling - already));
  const tier = TIER_NAMES[f.tier] ? f.tier : 'standard';
  const uplift = round2(f.upliftEgp);
  const tn = TIER_NAMES[tier];
  const E = (n) => fmtEgp(n, 'en');
  const A = (n) => fmtEgp(n, 'ar');

  let kind;
  let amountEgp = 0;
  const en = [];
  const ar = [];

  if (verdict.eligible && remaining > 0) {
    amountEgp = remaining;
    if (already > 0) {
      kind = 'remainder';
      en.push(`Up to ${E(remaining)} — the rest of what you paid. ${E(already)} has already been refunded on this case.`);
      ar.push(`حتى ${A(remaining)} — المتبقي مما دفعته. تم ردّ ${A(already)} بالفعل على هذه الحالة.`);
      if (!verdict.autoApprove) {
        en.push('Our team decides the amount.');
        ar.push('يحدد فريقنا المبلغ بعد المراجعة.');
      }
    } else if (verdict.autoApprove) {
      kind = 'full';
      en.push(`Full refund: ${E(remaining)}. No consultant has started on your case yet, so everything you paid comes back.`);
      ar.push(`استرداد كامل: ${A(remaining)}. لم يبدأ أي استشاري في مراجعة حالتك بعد، لذلك يُرَدّ إليك كل ما دفعته.`);
    } else {
      kind = 'review';
      en.push(`Up to ${E(remaining)}, after review. A consultant is already working on your case, so a refund is not automatic.`);
      ar.push(`حتى ${A(remaining)} بعد المراجعة. يعمل استشاري بالفعل على حالتك، لذلك لا يكون الاسترداد تلقائيًا.`);
      if (tier === 'standard' || !(uplift > 0)) {
        en.push('Standard has no urgency surcharge, so a missed deadline adds nothing to refund.');
        ar.push('الخدمة القياسية بلا رسوم استعجال، لذلك لا يضيف تأخر التسليم مبلغًا يُرَدّ.');
      } else {
        en.push(`If the ${tn.en} deadline is missed, the ${E(uplift)} urgency surcharge is refunded automatically.`);
        ar.push(`إذا فات موعد التسليم (${tn.ar})، تُرَدّ رسوم الاستعجال ${A(uplift)} تلقائيًا.`);
      }
    }
  } else if (verdict.reason === 'already_refunded_via_breach') {
    kind = 'surcharge_only';
    const b = f.breachRefund || null;
    amountEgp = round2(b && b.amount != null ? b.amount : uplift);
    const paid = b && String(b.status) === 'paid';
    en.push(paid
      ? `Your ${tn.en} urgency surcharge of ${E(amountEgp)} was refunded because the deadline was missed.`
      : `Your ${tn.en} urgency surcharge of ${E(amountEgp)} is being refunded because the deadline was missed.`);
    ar.push(paid
      ? `تم ردّ رسوم الاستعجال (${tn.ar}) بقيمة ${A(amountEgp)} لأن موعد التسليم فات.`
      : `جارٍ ردّ رسوم الاستعجال (${tn.ar}) بقيمة ${A(amountEgp)} لأن موعد التسليم فات.`);
    en.push('Nothing more can be requested here. Your case stays in review until your report is delivered.');
    ar.push('لا يمكن طلب مبلغ آخر من هنا. تبقى حالتك قيد المراجعة حتى تسليم تقريرك.');
  } else {
    kind = 'nothing';
    const r = verdict.eligible ? 'already_refunded_in_full' : verdict.reason;
    if (r === 'case_completed') {
      en.push('Nothing to refund: your report has been delivered. If it does not answer your question, contact us within 7 days of delivery.');
      ar.push('لا يوجد مبلغ للاسترداد: تم تسليم تقريرك. إذا لم يُجب عن سؤالك، تواصل معنا خلال 7 أيام من التسليم.');
    } else if (r === 'already_refunded_in_full' || r === 'already_refunded') {
      en.push('Nothing left to refund: everything you paid on this case has been refunded.');
      ar.push('لا يتبقى مبلغ للاسترداد: تم ردّ كل ما دفعته على هذه الحالة.');
    } else if (r === 'not_paid' || r === 'expired_unpaid') {
      en.push('Nothing to refund: no payment was taken on this case.');
      ar.push('لا يوجد مبلغ للاسترداد: لم يتم تحصيل أي مبلغ على هذه الحالة.');
    } else if (r === 'patient_override_sla_waiver') {
      en.push('Nothing to refund for the deadline: you chose a different specialty from the one recommended, which waives deadline refunds.');
      ar.push('لا يوجد استرداد مرتبط بموعد التسليم: اخترت تخصصًا غير الموصى به، وهذا يُسقط استرداد التأخير.');
    } else {
      en.push('This case cannot be refunded online. Contact us and we will look at it.');
      ar.push('لا يمكن طلب استرداد لهذه الحالة من هنا. تواصل معنا وسنراجعها.');
    }
  }

  return {
    kind,
    reason: verdict.reason,
    canRequest: kind === 'full' || kind === 'review' || kind === 'remainder',
    autoApprove: !!verdict.autoApprove && kind === 'full',
    amountEgp,
    paidEgp: f.paidEgp != null ? round2(f.paidEgp) : ceiling,
    ceilingEgp: ceiling,
    alreadyRefundedEgp: already,
    remainingEgp: remaining,
    tier,
    currency: 'EGP',
    text: { en: en.join(' '), ar: ar.join(' ') }
  };
}

/**
 * Gather the facts for describeRefund from the database.
 * @param {Object} order must carry the columns maxRefundableEgp reads plus
 *   status, payment_status, no_sla_refund_eligibility, urgency_tier/tier.
 * @param {{exec?: Function}} [opts] (sql, params) => rows; defaults to the pool.
 */
async function refundSummaryForOrder(order, opts) {
  const exec = opts && typeof opts.exec === 'function' ? opts.exec : require('../pg').queryAll;
  const verdict = await isEligibleForRefund(order, null, exec);
  let already = 0;
  try { already = await paidRefundedEgp(order && order.id, exec); } catch (_) { already = 0; }
  let breachRefund = null;
  if (verdict && verdict.reason === 'already_refunded_via_breach') {
    try {
      const rows = await exec(
        `SELECT COALESCE(approved_amount, amount_egp, requested_amount) AS amount, status
           FROM refunds WHERE order_id = $1 AND reason = 'sla_breach'
          ORDER BY refunded_at DESC LIMIT 1`,
        [order.id]
      );
      if (rows && rows[0]) breachRefund = { amount: Number(rows[0].amount), status: rows[0].status };
    } catch (_) { breachRefund = null; }
  }
  let paidEgp = null;
  try { paidEgp = owedCentsForOrder(order) / 100; } catch (_) { paidEgp = null; }
  return describeRefund({
    verdict,
    paidEgp: paidEgp > 0 ? paidEgp : null,
    ceilingEgp: maxRefundableEgp(order),
    alreadyRefundedEgp: already,
    tier: tierOf(order),
    upliftEgp: order && order.urgency_uplift_amount,
    breachRefund
  });
}

// ── Part C4/C7 (2026-09-13): per-row figures for the operator queue (web) and
// the Command API, computed identically in both and without a query per row.
// Select the order columns maxRefundableEgp reads plus paidRefundedSql().

// EGP already PAID back on the refund row's order — the same COALESCE chain as
// refund_eligibility.paidRefundedEgp, as a correlated subquery.
function paidRefundedSql(refundAlias) {
  const a = refundAlias || 'r';
  return `(SELECT COALESCE(SUM(COALESCE(px.amount_egp, px.approved_amount, px.requested_amount, 0)), 0)
             FROM refunds px WHERE px.order_id = ${a}.order_id AND px.status = 'paid')`;
}

/**
 * @param {Object} row refunds row + order columns (price, base_price,
 *   urgency_uplift_amount, addons_json, video_consultation_*) + paid_refunded_egp.
 * @returns {{ceilingEgp:number, alreadyRefundedEgp:number, eligibleEgp:number, thisRefundEgp:number, remainderEgp:number}}
 *   eligibleEgp  — what the case can still refund now (charged minus refunds PAID);
 *   remainderEgp — what stays refundable once THIS refund is paid (for a paid or
 *                  denied row it already is: equal to eligibleEgp).
 */
function refundFigures(row) {
  const r = row || {};
  let ceiling = 0;
  try {
    ceiling = maxRefundableEgp({
      id: r.order_id, price: r.price, base_price: r.base_price,
      urgency_uplift_amount: r.urgency_uplift_amount, addons_json: r.addons_json,
      video_consultation_selected: r.video_consultation_selected,
      video_consultation_price: r.video_consultation_price
    });
  } catch (_) { ceiling = 0; }
  const already = round2(r.paid_refunded_egp);
  const thisRefund = round2(r.approved_amount != null ? r.approved_amount : (r.requested_amount != null ? r.requested_amount : r.amount_egp));
  const eligible = Math.max(0, round2(ceiling - already));
  const open = ['pending', 'auto_approved', 'approved'].indexOf(String(r.status || '')) !== -1;
  return {
    ceilingEgp: ceiling,
    alreadyRefundedEgp: already,
    eligibleEgp: eligible,
    thisRefundEgp: thisRefund,
    remainderEgp: open ? Math.max(0, round2(eligible - thisRefund)) : eligible
  };
}

// "+201012345678" → "+20******5678" for API consumers that must not hold the
// whole number (the patient-facing timeline uses maskInstapay's words instead).
function maskNumber(number) {
  const l4 = last4(number);
  if (!l4) return null;
  const s = String(number || '').trim();
  return (s.charAt(0) === '+' ? s.replace(/[^0-9+]/g, '').slice(0, 3) : '') + '******' + l4;
}

// "+201012345678" → "•••• 5678" is exactly the glyph the timeline must not
// show, so the masked form is words: "ending 5678" / "المنتهي بـ 5678".
function last4(number) {
  const d = String(number || '').replace(/[^0-9]/g, '');
  return d.length >= 4 ? d.slice(-4) : '';
}
function maskInstapay(number, lang) {
  const l4 = last4(number);
  if (!l4) return '';
  return lang === 'ar' ? 'المنتهي بـ ' + l4 : 'ending ' + l4;
}

module.exports = {
  describeRefund,
  refundSummaryForOrder,
  fmtEgp,
  tierOf,
  last4,
  maskInstapay,
  maskNumber,
  paidRefundedSql,
  refundFigures,
  TIER_NAMES
};
