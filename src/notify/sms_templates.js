'use strict';

// src/notify/sms_templates.js — the SMS allowlist and its fixed copy
// (patient recovery, Part B, 2 Nov 2026).
//
// SMS is the fallback for a patient WhatsApp cannot reach (the Mac mini down,
// a send that failed). It is never used for anything but the templates below,
// and every body is fixed copy: no AI, the case reference and a link, never a
// diagnosis, a question or a doctor's words. Twilio's Egypt guidance prohibits
// "medicine/drug related" content outright, which is one more reason the
// bodies say "your case" and nothing about what is in it.
//
// Length budget — one segment of GSM-7 in English (160), two UCS-2 segments
// in Arabic (134 = 2 × 67). tests/lint/sms-templates-fit.test.js renders every
// body with the longest real values (a 15-character reference, a 36-character
// order id, the resume token, https://tashkheesa.com) and fails the build when
// one is over, or when an English body leaves GSM-7 (an em dash or a curly
// quote would silently turn the whole message into UCS-2, 70 per segment).
//
// The links are rebuilt here from the order id rather than taken from the
// payload: the payment-reminder payload carried a RELATIVE '/portal/patient/
// pay/<id>' (openclaw gateway log, 14 Oct), and an SMS link must be absolute.
// The draft-resume link is the short alias /r/<token> (routes/draft_resume.js
// redirects it to /portal/patient/resume/<token>): the full path is 45
// characters before the token and does not leave room for the Arabic copy.

const LIMITS = Object.freeze({ en: 160, ar: 134 });

function appUrl() {
  return String(process.env.APP_URL || 'https://tashkheesa.com').replace(/\/+$/, '');
}

function caseUrl(v) { return v.orderId ? appUrl() + '/portal/patient/orders/' + v.orderId : appUrl() + '/dashboard'; }
function payUrl(v) { return v.orderId ? appUrl() + '/portal/patient/pay/' + v.orderId : caseUrl(v); }
function reportUrl(v) { return v.orderId ? appUrl() + '/portal/case/' + v.orderId + '/report' : caseUrl(v); }
function resumeUrl(v) { return v.resumeToken ? appUrl() + '/r/' + v.resumeToken : (v.orderId ? appUrl() + '/patient/new-case?resume=' + v.orderId : appUrl() + '/patient/new-case'); }

// "case TSH-…" / "حالتك TSH-…", or just "your case" / "حالتك" when the case has
// no reference yet (an app draft gets one only at submit).
function refEn(v) { return v.ref ? 'case ' + v.ref : 'your case'; }
function refAr(v) { return v.ref ? 'حالتك ' + v.ref : 'حالتك'; }

const PAYMENT_EN = (v) => `Tashkheesa: ${refEn(v)} is waiting for payment: ${v.link}`;
const PAYMENT_AR = (v) => `تشخيصة: ${refAr(v)} مستنية الدفع: ${v.link}`;

// template → { link(vars) → url, en(vars), ar(vars) }. `vars` is
// { ref, orderId, resumeToken, link } — link is filled from link(vars).
const SMS_TEMPLATES = Object.freeze({
  draft_resume_1h: {
    link: resumeUrl,
    en: (v) => `Tashkheesa: ${refEn(v)} is saved. Finish it in 2 minutes: ${v.link}`,
    ar: (v) => `تشخيصة: ${refAr(v)} محفوظة. أكملها في دقيقتين: ${v.link}`,
  },
  draft_resume_24h: {
    link: resumeUrl,
    en: (v) => `Tashkheesa: ${refEn(v)} is still waiting. A Shifa consultant can review it within 48 hours: ${v.link}`,
    ar: (v) => `تشخيصة: ${refAr(v)} لسه مستنية. استشاري من شفاء يراجعها خلال 48 ساعة: ${v.link}`,
  },
  payment_reminder_30m: { link: payUrl, en: PAYMENT_EN, ar: PAYMENT_AR },
  payment_reminder_6h:  { link: payUrl, en: PAYMENT_EN, ar: PAYMENT_AR },
  payment_reminder_24h: { link: payUrl, en: PAYMENT_EN, ar: PAYMENT_AR },
  report_ready_patient: {
    link: reportUrl,
    en: (v) => `Tashkheesa: the report for ${refEn(v)} is ready: ${v.link}`,
    ar: (v) => `تشخيصة: تقرير ${refAr(v)} جاهز: ${v.link}`,
  },
  patient_refund_approved: {
    link: caseUrl,
    en: (v) => `Tashkheesa: your refund for ${refEn(v)} was approved. Details: ${v.link}`,
    ar: (v) => `تشخيصة: اتوافق على استرداد ${refAr(v)}: ${v.link}`,
  },
  patient_refund_denied: {
    link: caseUrl,
    en: (v) => `Tashkheesa: your refund request for ${refEn(v)} was declined: ${v.link}`,
    ar: (v) => `تشخيصة: اترفض طلب استرداد ${refAr(v)}: ${v.link}`,
  },
  patient_refund_paid: {
    link: caseUrl,
    en: (v) => `Tashkheesa: the refund for ${refEn(v)} has been paid. Details: ${v.link}`,
    ar: (v) => `تشخيصة: استرداد ${refAr(v)} اتحوّل: ${v.link}`,
  },
  additional_files_requested_patient: {
    link: caseUrl,
    en: (v) => `Tashkheesa: more files are needed for ${refEn(v)}: ${v.link}`,
    ar: (v) => `تشخيصة: مطلوب ملفات تانية في ${refAr(v)}: ${v.link}`,
  },
  // Part C — "the specialty you asked about is open". The specialty is not
  // named: the patient knows which one, and the body stays status + link.
  // Part C sends it on the Part A ladder, SMS included.
  coverage_lead_open: {
    link: resumeUrl,
    en: (v) => `Tashkheesa: the specialty you asked about is now open. Continue here: ${v.link}`,
    ar: (v) => `تشخيصة: التخصص اللي سألت عنه فتح. كمّل من هنا: ${v.link}`,
  },
});

const TEMPLATES = SMS_TEMPLATES;

const ALLOWLIST = Object.freeze(Object.keys(TEMPLATES));

function isSmsAllowlisted(template) {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, String(template || ''));
}

/**
 * The SMS body for one notification, or null when the template is not on the
 * allowlist. `vars` is the notification payload; only the reference, the order
 * id and the resume token are read from it.
 * @returns {{ body: string, link: string, lang: 'ar'|'en', limit: number } | null}
 */
function renderSms(template, lang, payload, orderId) {
  if (!isSmsAllowlisted(template)) return null;
  const p = payload && typeof payload === 'object' ? payload : {};
  const l = lang === 'ar' ? 'ar' : 'en';
  const v = {
    ref: String(p.caseReference || p.reference_id || p.referenceId || '').trim() || null,
    orderId: orderId || p.order_id || p.orderId || p.case_id || p.caseId || null,
    resumeToken: p.resume_token || p.resumeToken || null,
  };
  const t = TEMPLATES[template];
  v.link = t.link(v);
  return { body: t[l](v), link: v.link, lang: l, limit: LIMITS[l] };
}

// GSM 03.38 basic character set (no extension table): what keeps an English
// body at 160 characters per segment.
const GSM7_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

function isGsm7(text) {
  const s = String(text == null ? '' : text);
  for (const ch of s) if (GSM7_BASIC.indexOf(ch) === -1) return false;
  return true;
}

module.exports = { ALLOWLIST, LIMITS, isSmsAllowlisted, renderSms, isGsm7, appUrl };
