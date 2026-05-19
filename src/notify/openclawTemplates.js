// src/notify/openclawTemplates.js
// Free-form bilingual WhatsApp bodies for the OpenClaw transport.
//
// Unlike Meta's Cloud API (which requires pre-approved HSM templates
// with positional vars — see whatsappTemplateMap.js), OpenClaw sends
// over a personal SIM and accepts arbitrary text bodies. We compose
// EN + AR bodies here, one per internal notification event name.
//
// All Arabic bodies are gender-neutral with respect to BOTH the doctor
// (subject) and the patient (object/imperative target):
//   - Doctor verbs: passive voice ("تم قبولها", "تم رفعه") instead of
//     gendered past tense ("استلم" / "استلمت", "رفعه" / "رفعته").
//   - Patient-facing imperatives: replaced with nominal phrases
//     ("للمتابعة:" / "للرفع:") instead of gendered commands
//     ("تابع/تابعي", "ارفع/ارفعي", "اقرأ/اقرئي").
//   - Team voice ("استلمنا"/"هنبدأ"/"هنرجع") for first-person plural
//     references to Tashkheesa, which is gender-invariant in Arabic.
//
// Each body is ≤ ~200 chars where event semantics permit, includes
// the case reference for traceability, and signs off as Tashkheesa
// (Arabic: تشخيصة, English: Tashkheesa).

function appUrl() {
  return process.env.APP_URL || 'https://tashkheesa.com';
}

function patientOrderUrl(orderId) {
  return orderId ? `${appUrl()}/portal/patient/orders/${orderId}` : appUrl();
}

// All composers receive an enriched `vars` object:
//   {
//     caseReference, doctorName, patientName, amount, currency,
//     reason, appointmentTime, slaHours, link, orderId
//   }
// Missing values render as empty strings; surrounding punctuation is
// trimmed by the notification_titles interpolate() pattern if needed,
// but composers should produce a clean body even with sparse vars.

const OPENCLAW_TEMPLATES = {
  // ── a. Case accepted by doctor ─────────────────────────────────────
  order_status_accepted_patient: {
    en: (v) => `Good news — Dr. ${v.doctorName} accepted your case (${v.caseReference}). Track updates here: ${v.link}\n— Tashkheesa`,
    ar: (v) => `خبر حلو — حالتك (${v.caseReference}) تم قبولها من د. ${v.doctorName}. للمتابعة: ${v.link}\n— تشخيصة`
  },

  // ── b. Report ready / completed ────────────────────────────────────
  report_ready_patient: {
    en: (v) => `Your medical report for case ${v.caseReference} is ready. Dr. ${v.doctorName} uploaded it to the portal. Open it here: ${v.link}\n— Tashkheesa`,
    ar: (v) => `تقرير حالتك (${v.caseReference}) جاهز ومتاح على البورتال من د. ${v.doctorName}. للاطلاع: ${v.link}\n— تشخيصة`
  },

  // ── c. Payment confirmation ────────────────────────────────────────
  payment_success_patient: {
    en: (v) => `Payment of ${v.amount} ${v.currency || 'EGP'} received for case ${v.caseReference}. Review starts now. Updates: ${v.link}\n— Tashkheesa`,
    ar: (v) => `استلمنا دفعتك (${v.amount} ${v.currency || 'ج.م'}) لحالة ${v.caseReference}. هنبدأ المراجعة دلوقتي. للمتابعة: ${v.link}\n— تشخيصة`
  },

  // ── d. Doctor message in chat ──────────────────────────────────────
  new_message: {
    en: (v) => `New message from Dr. ${v.doctorName} on case ${v.caseReference}. Reply here: ${v.link}\n— Tashkheesa`,
    ar: (v) => `وصلتك رسالة جديدة من د. ${v.doctorName} على حالة ${v.caseReference}. للرد: ${v.link}\n— تشخيصة`
  },

  // ── e. Case status changes ─────────────────────────────────────────
  // More info / additional files requested
  additional_files_requested_patient: {
    en: (v) => `Additional files are needed for case ${v.caseReference}${v.reason ? `: ${v.reason}` : ''}. Upload here: ${v.link}\n— Tashkheesa`,
    ar: (v) => `مطلوب ملفات إضافية لحالة ${v.caseReference}${v.reason ? `: ${v.reason}` : ''}. للرفع من هنا: ${v.link}\n— تشخيصة`
  },
  // Case cancelled (operator-initiated)
  case_cancelled_patient: {
    en: (v) => `Case ${v.caseReference} has been cancelled${v.reason ? `. Reason: ${v.reason}` : ''}. If a payment was made, a refund is being processed. Reply here with any questions.\n— Tashkheesa`,
    ar: (v) => `حالتك (${v.caseReference}) تم إلغاؤها${v.reason ? `. السبب: ${v.reason}` : ''}. لو في دفع تم، الاسترداد قيد المعالجة. للاستفسار: رد على الرسالة دي.\n— تشخيصة`
  },

  // ── f. Refund lifecycle ────────────────────────────────────────────
  patient_refund_approved: {
    en: (v) => `Your refund for case ${v.caseReference} has been approved. The amount will land in your account within 3–7 business days.\n— Tashkheesa`,
    ar: (v) => `طلب استرداد المبلغ لحالة ${v.caseReference} تم اعتماده. المبلغ هيوصل خلال 3 لـ 7 أيام عمل.\n— تشخيصة`
  },
  patient_refund_paid: {
    en: (v) => `Refund for case ${v.caseReference} has been issued. Details: ${v.link}\n— Tashkheesa`,
    ar: (v) => `تم تحويل الاسترداد لحالة ${v.caseReference}. التفاصيل من هنا: ${v.link}\n— تشخيصة`
  },
  patient_refund_denied: {
    en: (v) => `Your refund request for case ${v.caseReference} was reviewed and could not be approved${v.reason ? `. Reason: ${v.reason}` : ''}. Reply here to discuss.\n— Tashkheesa`,
    ar: (v) => `طلب استرداد حالة ${v.caseReference} تمت مراجعته ولم يتم اعتماده${v.reason ? `. السبب: ${v.reason}` : ''}. للاستفسار: رد على الرسالة دي.\n— تشخيصة`
  },
  patient_refund_opened_by_operator: {
    en: (v) => `A refund request has been opened for case ${v.caseReference} on your behalf. We'll get back to you within 48 hours. Details: ${v.link}\n— Tashkheesa`,
    ar: (v) => `تم فتح طلب استرداد لحالة ${v.caseReference} نيابةً عنك. هنرجع بإجابة خلال 48 ساعة. التفاصيل: ${v.link}\n— تشخيصة`
  },

  // ── g. Add-on purchases ────────────────────────────────────────────
  addon_purchased_video: {
    en: (v) => `Video consultation booked for case ${v.caseReference}. Time: ${v.appointmentTime || 'TBD'}. The call will be on WhatsApp with Dr. ${v.doctorName}. Details: ${v.link}\n— Tashkheesa`,
    ar: (v) => `استشارة فيديو تم حجزها لحالة ${v.caseReference}. الميعاد: ${v.appointmentTime || 'هيتم التأكيد'}. الاتصال هيكون على واتساب مع د. ${v.doctorName}. التفاصيل: ${v.link}\n— تشخيصة`
  },
  addon_purchased_urgency: {
    en: (v) => `Case ${v.caseReference} has been upgraded to urgent. New deadline: ${v.slaHours}h. Review starts ASAP.\n— Tashkheesa`,
    ar: (v) => `حالة ${v.caseReference} تم ترقيتها لعاجلة. الميعاد الجديد: ${v.slaHours} ساعة. هنبدأ المراجعة بأسرع وقت.\n— تشخيصة`
  },
  addon_purchased_prescription: {
    en: (v) => `Prescription add-on confirmed for case ${v.caseReference}. It will be issued with your report by Dr. ${v.doctorName}. Track: ${v.link}\n— Tashkheesa`,
    ar: (v) => `روشتة إضافية تمت إضافتها لحالة ${v.caseReference}. هتيجي مع التقرير من د. ${v.doctorName}. للمتابعة: ${v.link}\n— تشخيصة`
  },

  // ── h. Payment reminders for unpaid cases (#66) ────────────────────
  // Queued by case_lifecycle.dispatchUnpaidCaseReminders at 30m / 6h /
  // 24h elapsed from order creation. The 24h variant is registered for
  // completeness; the lifecycle hard-stop at 24h currently expires the
  // case before the reminder loop reaches that threshold. AR voice is
  // gender-neutral per file conventions (team 1pl, nominal phrases
  // instead of gendered imperatives). The `link` field is the payment
  // URL (rewritten in notification_worker for payment_reminder_*).
  payment_reminder_30m: {
    en: (v) => `Quick reminder — your case (${v.caseReference}) is held with us waiting for payment. Whenever you're ready: ${v.link}\n— Tashkheesa`,
    ar: (v) => `تذكير سريع — حالتك (${v.caseReference}) محفوظة في انتظار الدفع. وقت ما يناسب: ${v.link}\n— تشخيصة`
  },
  payment_reminder_6h: {
    en: (v) => `Your case (${v.caseReference}) is still waiting for payment. Complete it here and your specialist review starts right away: ${v.link}\n— Tashkheesa`,
    ar: (v) => `حالتك (${v.caseReference}) لسة في انتظار الدفع. الإكمال من هنا وهنبدأ المراجعة مع الطبيب على طول: ${v.link}\n— تشخيصة`
  },
  payment_reminder_24h: {
    en: (v) => `Heads-up about case ${v.caseReference}: it's been held 24 hours. We hold cases for a final ${v.hoursRemaining || '24'} hours before the spot is released. You can still pay here: ${v.link}\n— Tashkheesa`,
    ar: (v) => `تنبيه عن حالة ${v.caseReference}: عدّت 24 ساعة وهي محفوظة. الحالات بتفضل ${v.hoursRemaining || '24'} ساعة كمان قبل ما المكان يتفتح. ممكن الدفع من هنا: ${v.link}\n— تشخيصة`
  }
};

/**
 * Compose an OpenClaw WhatsApp body for a given internal event.
 * Returns null when the event has no OpenClaw template — caller should
 * skip the send (the worker will mark the row as 'skipped').
 *
 * @param {string} eventName Internal notification template name
 * @param {string} lang 'ar' | 'en' (anything else falls back to 'en')
 * @param {Object} rawVars Raw response payload from the notifications row
 * @param {Object} [opts] Optional { orderId } for link enrichment
 * @returns {string|null}
 */
function getOpenClawBody(eventName, lang, rawVars, opts) {
  const entry = OPENCLAW_TEMPLATES[eventName];
  if (!entry) return null;

  const vars = rawVars && typeof rawVars === 'object' ? rawVars : {};
  const orderId = (opts && opts.orderId) || vars.order_id || vars.orderId || null;

  const enriched = {
    caseReference: vars.caseReference || (orderId ? String(orderId).slice(0, 12).toUpperCase() : ''),
    doctorName: stripDr(vars.doctorName || vars.doctor_name || ''),
    patientName: vars.patientName || vars.patient_name || '',
    amount: vars.amount != null ? vars.amount : '',
    currency: vars.currency || '',
    reason: vars.reason || '',
    appointmentTime: vars.appointmentTime || vars.appointment_time || '',
    slaHours: vars.slaHours || vars.sla_hours || '',
    // #66: hoursRemaining is set by case_lifecycle for payment-reminder
    // events (48h hard-stop minus elapsed). Falls back to '' for any
    // composer that reads it but wasn't queued with the field.
    hoursRemaining: vars.hoursRemaining || vars.hours_remaining || '',
    link: vars.link || patientOrderUrl(orderId),
    orderId: orderId || ''
  };

  const composer = lang === 'ar' ? entry.ar : entry.en;
  if (typeof composer !== 'function') return null;

  return composer(enriched);
}

// Mirror notification_worker's stripDrPrefix — doctor names are stored
// already-prefixed ("Dr. Ahmed Hassan"), and templates here prepend
// "Dr. " / "د. " explicitly. Without stripping, recipients see
// "Dr. Dr. Ahmed Hassan" / "د. د. أحمد".
function stripDr(name) {
  return String(name == null ? '' : name).replace(/^\s*(?:Dr\.?|د\.?)\s+/i, '').trim();
}

module.exports = { getOpenClawBody, OPENCLAW_TEMPLATES };
