// src/notify/coming_soon.js
//
// Templates + dispatchers for the /coming-soon lead funnel:
//   (A) confirmation send on signup
//   (B) launch blast triggered manually via `npm run leads:notify`
//
// Email transport: emailService.sendMail() (Resend HTTP API under the hood,
// gates only on RESEND_API_KEY). Returns { stub: true } when the key is
// missing, so callers can mark the row as 'failed' without crashing.
//
// SMS transport: raw `twilio.messages.create()`. NOT Twilio Verify — that
// API is OTP-only. We resolve the SDK + creds lazily so that absence of
// TWILIO_* env vars means "no-op + status='failed'", never "module load
// crash". On Render the env will be populated; in dev the email confirms
// and the SMS row stays 'failed' which is harmless.
//
// Dispatch policy:
//   - email: every lead gets ONE attempt regardless of consent — the
//     confirmation is acknowledging the form submission, not marketing.
//     (Compliance bar for transactional acknowledgements is lower than
//     marketing blasts; the consent gate applies only to the launch
//     blast, which has the strict consent=true filter.)
//   - sms:   skipped (status='na') if phone_e164 missing OR consent=false,
//     attempted otherwise. Consent gates SMS even on confirmation because
//     SMS is more intrusive than email.
//   - launch blast: hard-filters consent=true AND launch_notified_at IS NULL
//     before this module is ever called (see scripts/leads_notify.js).

const crypto = require('crypto');
const emailService = require('../services/emailService');

const APP_URL = (process.env.APP_URL || process.env.BASE_URL || 'https://tashkheesa.com')
  .replace(/\/$/, '');

// ── Twilio lazy init ────────────────────────────────────────────────────────
let _twilioClient = null;
let _twilioErrored = false;
function getTwilioClient() {
  if (_twilioClient || _twilioErrored) return _twilioClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  try {
    const twilio = require('twilio');
    _twilioClient = twilio(sid, token);
    return _twilioClient;
  } catch (err) {
    console.error('[coming-soon-notify] twilio init failed:', err.message);
    _twilioErrored = true;
    return null;
  }
}

function resolveSmsFrom() {
  // Messaging Service SID takes precedence over a from-number (Twilio
  // recommends MSID for production traffic — handles A2P routing).
  const msid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const from = process.env.TWILIO_SMS_FROM;
  if (msid) return { messagingServiceSid: msid };
  if (from) return { from };
  return null;
}

// ── Language helpers ────────────────────────────────────────────────────────
// Brief: "default Arabic" when language is empty/'both'. Egyptian Arabic
// matches the homepage tone (informal "هنبعتلك", "بدعم", "أول ما نطلق").
function pickLang(lead) {
  const raw = String((lead && lead.language) || '').toLowerCase().trim();
  if (raw === 'en') return 'en';
  return 'ar'; // ar + both + unknown all fall through to Arabic
}

function unsubscribeUrl(email) {
  const secret = process.env.JWT_SECRET || '';
  // Token is HMAC-SHA256(lower(email), JWT_SECRET) truncated to 32 hex chars.
  // Not cryptographically reversible from the email alone, so an attacker
  // can't enumerate; if JWT_SECRET is missing we still render the link but
  // the /unsubscribe handler will reject the token, which is the safe failure.
  const e = String(email || '').toLowerCase().trim();
  const tok = crypto.createHmac('sha256', secret).update(e).digest('hex').slice(0, 32);
  return APP_URL + '/unsubscribe?email=' + encodeURIComponent(e) + '&token=' + tok;
}

// ── Email templates ─────────────────────────────────────────────────────────
function confirmationEmail(lead) {
  const lang = pickLang(lead);
  const name = String(lead.name || '').trim();
  const unsub = unsubscribeUrl(lead.email);

  if (lang === 'en') {
    const subject = "We've received your interest — Tashkheesa";
    const greet = name ? ('Hi ' + name + ',') : 'Hi there,';
    const text =
      greet + '\n\n' +
      "Thank you — we've recorded your interest in Tashkheesa, the medical second-opinion service backed by Shifa Hospital Group.\n\n" +
      "When we launch, you'll be able to upload your records and receive a written report from a board-certified specialist within 48 hours — or as fast as 4 hours with our Urgent option.\n\n" +
      "We'll email you the moment we open.\n\n" +
      "— The Tashkheesa team\n\n" +
      "If you'd rather not hear from us, unsubscribe here: " + unsub;
    const html =
      '<!doctype html><html><body style="margin:0;padding:0;background:#F9FAFB;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1F2937;">' +
      '<div style="max-width:560px;margin:0 auto;padding:32px 24px;">' +
      '<h1 style="margin:0 0 16px;font-size:22px;color:#0066CC;">Tashkheesa</h1>' +
      '<p style="margin:0 0 16px;font-size:16px;">' + escapeHtml(greet) + '</p>' +
      '<p style="margin:0 0 16px;font-size:15px;line-height:1.6;">' +
      "Thank you — we've recorded your interest in <strong>Tashkheesa</strong>, the medical second-opinion service backed by <strong>Shifa Hospital Group</strong>." +
      '</p>' +
      '<p style="margin:0 0 16px;font-size:15px;line-height:1.6;">' +
      'When we launch, you\'ll be able to upload your records and receive a written report from a board-certified specialist within <strong>48 hours</strong> — or as fast as <strong>4 hours</strong> with our Urgent option.' +
      '</p>' +
      '<p style="margin:0 0 24px;font-size:15px;line-height:1.6;">We\'ll email you the moment we open.</p>' +
      '<p style="margin:0 0 8px;font-size:14px;color:#6B7280;">— The Tashkheesa team</p>' +
      '<hr style="border:none;border-top:1px solid #E5E7EB;margin:24px 0 12px;">' +
      '<p style="margin:0;font-size:12px;color:#6B7280;">If you\'d rather not hear from us, <a href="' + unsub + '" style="color:#0066CC;">unsubscribe</a>.</p>' +
      '</div></body></html>';
    return { subject, text, html };
  }

  // Arabic — default
  const subject = 'وصلنا اهتمامك بتشخيصة';
  const greet = name ? ('أهلاً ' + name + '،') : 'أهلاً بيك،';
  const text =
    greet + '\n\n' +
    'شكراً ليك — سجّلنا اهتمامك بـ تشخيصة، خدمة الرأي الطبي التاني المدعومة من مستشفى الشفاء.\n\n' +
    'أول ما نطلق هتقدر ترفع ملفاتك الطبية وتاخد تقرير مكتوب من دكتور متخصص في 48 ساعة، وحتى 4 ساعات لو اخترت Urgent.\n\n' +
    'هنبعتلك إيميل أول ما نفتح.\n\n' +
    '— فريق تشخيصة\n\n' +
    'لو مش عاوز توصلك إيميلات تانية: ' + unsub;
  const html =
    '<!doctype html><html dir="rtl" lang="ar"><body style="margin:0;padding:0;background:#F9FAFB;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1F2937;direction:rtl;text-align:right;">' +
    '<div style="max-width:560px;margin:0 auto;padding:32px 24px;">' +
    '<h1 style="margin:0 0 16px;font-size:22px;color:#0066CC;">تشخيصة</h1>' +
    '<p style="margin:0 0 16px;font-size:16px;">' + escapeHtml(greet) + '</p>' +
    '<p style="margin:0 0 16px;font-size:15px;line-height:1.7;">' +
    'شكراً ليك — سجّلنا اهتمامك بـ <strong>تشخيصة</strong>، خدمة الرأي الطبي التاني المدعومة من <strong>مستشفى الشفاء</strong>.' +
    '</p>' +
    '<p style="margin:0 0 16px;font-size:15px;line-height:1.7;">' +
    'أول ما نطلق هتقدر ترفع ملفاتك الطبية وتاخد تقرير مكتوب من دكتور متخصص في <strong>48 ساعة</strong>، وحتى <strong>4 ساعات</strong> لو اخترت Urgent.' +
    '</p>' +
    '<p style="margin:0 0 24px;font-size:15px;line-height:1.7;">هنبعتلك إيميل أول ما نفتح.</p>' +
    '<p style="margin:0 0 8px;font-size:14px;color:#6B7280;">— فريق تشخيصة</p>' +
    '<hr style="border:none;border-top:1px solid #E5E7EB;margin:24px 0 12px;">' +
    '<p style="margin:0;font-size:12px;color:#6B7280;">لو مش عاوز توصلك إيميلات تانية: <a href="' + unsub + '" style="color:#0066CC;">إلغاء الاشتراك</a>.</p>' +
    '</div></body></html>';
  return { subject, text, html };
}

function launchEmail(lead) {
  const lang = pickLang(lead);
  const name = String(lead.name || '').trim();
  const unsub = unsubscribeUrl(lead.email);
  const portalUrl = APP_URL + '/?utm_source=launch_email&utm_medium=email&utm_campaign=launch';

  if (lang === 'en') {
    const subject = "We're live — your second opinion starts now (Tashkheesa)";
    const greet = name ? ('Hi ' + name + ',') : 'Hi there,';
    const text =
      greet + '\n\n' +
      "Tashkheesa is officially open. You can now upload your records and receive a written report from a board-certified specialist — 48 hours standard, or as fast as 4 hours with Urgent.\n\n" +
      "Backed by Shifa Hospital Group.\n\n" +
      "Start here: " + portalUrl + "\n\n" +
      "— The Tashkheesa team\n\n" +
      "Unsubscribe: " + unsub;
    const html =
      '<!doctype html><html><body style="margin:0;padding:0;background:#F9FAFB;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1F2937;">' +
      '<div style="max-width:560px;margin:0 auto;padding:32px 24px;">' +
      '<h1 style="margin:0 0 16px;font-size:24px;color:#0066CC;">We\'re live.</h1>' +
      '<p style="margin:0 0 16px;font-size:16px;">' + escapeHtml(greet) + '</p>' +
      '<p style="margin:0 0 16px;font-size:15px;line-height:1.6;">' +
      'Tashkheesa is officially open. You can now upload your records and receive a written report from a board-certified specialist — <strong>48 hours standard</strong>, or as fast as <strong>4 hours with Urgent</strong>.' +
      '</p>' +
      '<p style="margin:0 0 24px;font-size:14px;color:#6B7280;">Backed by Shifa Hospital Group.</p>' +
      '<p style="margin:0 0 24px;"><a href="' + portalUrl + '" style="display:inline-block;background:#0066CC;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Start your case</a></p>' +
      '<p style="margin:0 0 8px;font-size:14px;color:#6B7280;">— The Tashkheesa team</p>' +
      '<hr style="border:none;border-top:1px solid #E5E7EB;margin:24px 0 12px;">' +
      '<p style="margin:0;font-size:12px;color:#6B7280;"><a href="' + unsub + '" style="color:#0066CC;">Unsubscribe</a></p>' +
      '</div></body></html>';
    return { subject, text, html };
  }

  const subject = 'تشخيصة طلقت — رأيك التاني بقى متاح';
  const greet = name ? ('أهلاً ' + name + '،') : 'أهلاً بيك،';
  const text =
    greet + '\n\n' +
    'تشخيصة افتتحت رسمياً. تقدر دلوقتي ترفع ملفاتك وتاخد تقرير مكتوب من دكتور متخصص — 48 ساعة قياسي، وحتى 4 ساعات مع Urgent.\n\n' +
    'بدعم مستشفى الشفاء.\n\n' +
    'إبدأ من هنا: ' + portalUrl + '\n\n' +
    '— فريق تشخيصة\n\n' +
    'إلغاء الاشتراك: ' + unsub;
  const html =
    '<!doctype html><html dir="rtl" lang="ar"><body style="margin:0;padding:0;background:#F9FAFB;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1F2937;direction:rtl;text-align:right;">' +
    '<div style="max-width:560px;margin:0 auto;padding:32px 24px;">' +
    '<h1 style="margin:0 0 16px;font-size:24px;color:#0066CC;">تشخيصة طلقت.</h1>' +
    '<p style="margin:0 0 16px;font-size:16px;">' + escapeHtml(greet) + '</p>' +
    '<p style="margin:0 0 16px;font-size:15px;line-height:1.7;">' +
    'تشخيصة افتتحت رسمياً. تقدر دلوقتي ترفع ملفاتك وتاخد تقرير مكتوب من دكتور متخصص — <strong>48 ساعة قياسي</strong>، وحتى <strong>4 ساعات مع Urgent</strong>.' +
    '</p>' +
    '<p style="margin:0 0 24px;font-size:14px;color:#6B7280;">بدعم مستشفى الشفاء.</p>' +
    '<p style="margin:0 0 24px;"><a href="' + portalUrl + '" style="display:inline-block;background:#0066CC;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">إبدأ حالتك</a></p>' +
    '<p style="margin:0 0 8px;font-size:14px;color:#6B7280;">— فريق تشخيصة</p>' +
    '<hr style="border:none;border-top:1px solid #E5E7EB;margin:24px 0 12px;">' +
    '<p style="margin:0;font-size:12px;color:#6B7280;"><a href="' + unsub + '" style="color:#0066CC;">إلغاء الاشتراك</a></p>' +
    '</div></body></html>';
  return { subject, text, html };
}

// ── SMS templates (≤2 segments each ≈ 320 chars max) ───────────────────────
function confirmationSms(lead) {
  const lang = pickLang(lead);
  if (lang === 'en') {
    return "Tashkheesa: thanks — we got your interest. We'll text you the moment we open. Backed by Shifa Hospital Group.";
  }
  return 'تشخيصة: وصلنا اهتمامك. هنبلغك أول ما نطلق. بدعم مستشفى الشفاء.';
}

function launchSms(lead) {
  const lang = pickLang(lead);
  if (lang === 'en') {
    return "Tashkheesa is live. Upload your records and get a specialist second opinion in 48h (4h Urgent). Start: " + APP_URL;
  }
  return 'تشخيصة طلقت! ارفع ملفاتك واخد رأي طبي في 48 ساعة (4 ساعات Urgent). إبدأ: ' + APP_URL;
}

// ── Public dispatchers ──────────────────────────────────────────────────────

/**
 * Send the confirmation email for a freshly submitted lead.
 * @returns {Promise<{status:'sent'|'failed', reason?:string, messageId?:string}>}
 */
async function sendConfirmationEmail(lead) {
  if (!lead || !lead.email) return { status: 'failed', reason: 'no_email' };
  const tpl = confirmationEmail(lead);
  try {
    const r = await emailService.sendMail({
      to: lead.email,
      subject: tpl.subject,
      text: tpl.text,
      html: tpl.html
    });
    if (r && r.stub) return { status: 'failed', reason: 'resend_not_configured' };
    if (r && r.ok && r.messageId) return { status: 'sent', messageId: r.messageId };
    if (r && r.blocked) return { status: 'failed', reason: 'recipient_blocked' };
    return { status: 'failed', reason: (r && r.error) || 'unknown' };
  } catch (err) {
    return { status: 'failed', reason: err.message || 'send_threw' };
  }
}

/**
 * Send the confirmation SMS — only if phone_e164 AND consent are set.
 * @returns {Promise<{status:'sent'|'failed'|'na', reason?:string, sid?:string}>}
 */
async function sendConfirmationSms(lead) {
  if (!lead) return { status: 'na', reason: 'no_lead' };
  if (!lead.phone_e164) return { status: 'na', reason: 'no_phone' };
  if (!lead.consent) return { status: 'na', reason: 'no_consent' };

  const client = getTwilioClient();
  const fromCfg = resolveSmsFrom();
  if (!client) return { status: 'failed', reason: 'twilio_not_configured' };
  if (!fromCfg) return { status: 'failed', reason: 'twilio_from_not_configured' };

  try {
    const msg = await client.messages.create(Object.assign({
      to: lead.phone_e164,
      body: confirmationSms(lead)
    }, fromCfg));
    return { status: 'sent', sid: msg.sid };
  } catch (err) {
    return { status: 'failed', reason: err.message || 'send_threw' };
  }
}

/**
 * Send the launch-blast email for a previously consented lead.
 */
async function sendLaunchEmail(lead) {
  if (!lead || !lead.email) return { status: 'failed', reason: 'no_email' };
  const tpl = launchEmail(lead);
  try {
    const r = await emailService.sendMail({
      to: lead.email,
      subject: tpl.subject,
      text: tpl.text,
      html: tpl.html
    });
    if (r && r.stub) return { status: 'failed', reason: 'resend_not_configured' };
    if (r && r.ok && r.messageId) return { status: 'sent', messageId: r.messageId };
    if (r && r.blocked) return { status: 'failed', reason: 'recipient_blocked' };
    return { status: 'failed', reason: (r && r.error) || 'unknown' };
  } catch (err) {
    return { status: 'failed', reason: err.message || 'send_threw' };
  }
}

/**
 * Send the launch-blast SMS — only if phone_e164 set (caller has already
 * verified consent=true).
 */
async function sendLaunchSms(lead) {
  if (!lead) return { status: 'na', reason: 'no_lead' };
  if (!lead.phone_e164) return { status: 'na', reason: 'no_phone' };
  if (!lead.consent) return { status: 'na', reason: 'no_consent' };

  const client = getTwilioClient();
  const fromCfg = resolveSmsFrom();
  if (!client) return { status: 'failed', reason: 'twilio_not_configured' };
  if (!fromCfg) return { status: 'failed', reason: 'twilio_from_not_configured' };

  try {
    const msg = await client.messages.create(Object.assign({
      to: lead.phone_e164,
      body: launchSms(lead)
    }, fromCfg));
    return { status: 'sent', sid: msg.sid };
  } catch (err) {
    return { status: 'failed', reason: err.message || 'send_threw' };
  }
}

// ── Utilities ───────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Best-effort E.164 normalization for an Egypt-leaning audience.
 *   "+201112345678" -> "+201112345678"
 *   "01112345678"   -> "+201112345678"  (EG mobile prefix)
 *   "1112345678"    -> "+201112345678"
 *   "0020 111 234"  -> "+20111234"
 *   "+1 (415) 555-2671" -> "+14155552671"
 * Returns null if the result is implausibly short (<8 digits) or empty.
 * Stores the raw value too at the DB layer; this is the "attempt" not a
 * guarantee.
 */
function normalizePhoneE164(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;

  // Strip non-digit/non-plus
  s = s.replace(/[^\d+]/g, '');

  // "00<countrycode>..." → "+<countrycode>..."
  if (s.startsWith('00')) s = '+' + s.slice(2);

  if (s.startsWith('+')) {
    const digits = s.slice(1);
    if (digits.length < 8) return null;
    return '+' + digits;
  }

  // No prefix. Two Egyptian local conventions:
  //   "01XXXXXXXXX" (11 digits, leading 0) → "+20" + last 10
  //   "1XXXXXXXXX"  (10 digits, no zero)   → "+20" + s
  if (/^0\d{10}$/.test(s)) return '+20' + s.slice(1);
  if (/^1\d{9}$/.test(s))  return '+20' + s;

  // Anything else: if it's >=8 digits, prefix '+' so Twilio at least sees E.164-shaped input.
  if (s.length >= 8) return '+' + s;
  return null;
}

module.exports = {
  sendConfirmationEmail,
  sendConfirmationSms,
  sendLaunchEmail,
  sendLaunchSms,
  normalizePhoneE164,
  unsubscribeUrl,
  // Exposed for testing / preview
  _templates: { confirmationEmail, launchEmail, confirmationSms, launchSms }
};
