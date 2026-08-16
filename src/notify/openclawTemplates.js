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
  // Case cancelled (operator-initiated). Refund-timing line sets patient
  // expectation: refunds are operator-completed (Instapay handle entered
  // manually) and typically issue within 3–5 business days.
  case_cancelled_patient: {
    en: (v) => `Case ${v.caseReference} has been cancelled${v.reason ? `. Reason: ${v.reason}` : ''}. If a payment was made, your refund is being processed and will be issued within 3–5 business days. Reply here with any questions.\n— Tashkheesa`,
    ar: (v) => `حالتك (${v.caseReference}) تم إلغاؤها${v.reason ? `. السبب: ${v.reason}` : ''}. لو في دفع تم، الاسترداد قيد المعالجة وهيتم تحويل المبلغ خلال 3–5 أيام عمل. للاستفسار: رد على الرسالة دي.\n— تشخيصة`
  },

  // ── f. Refund lifecycle ────────────────────────────────────────────
  patient_refund_approved: {
    en: (v) => `Your refund for case ${v.caseReference} has been approved. The amount will land in your account within 3–5 business days.\n— Tashkheesa`,
    ar: (v) => `طلب استرداد المبلغ لحالة ${v.caseReference} تم اعتماده. المبلغ هيوصل خلال 3–5 أيام عمل.\n— تشخيصة`
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
    en: (v) => `A refund request has been opened for case ${v.caseReference} on your behalf. We'll get back to you within 1 business day. Details: ${v.link}\n— Tashkheesa`,
    ar: (v) => `تم فتح طلب استرداد لحالة ${v.caseReference} نيابةً عنك. هنرجع بإجابة خلال يوم عمل واحد. التفاصيل: ${v.link}\n— تشخيصة`
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
  },

  // ── i. Theme 14 Phase 5 — case routing updated by ops ──────────────
  // Sent ONLY when the manual-queue approve flow chose a specialty
  // different from the patient's original submission. AR voice is
  // Cairene-dialect and gender-neutral per file conventions.
  case_routing_updated: {
    en: (v) => `We updated your case routing based on the details you provided (${v.caseReference}). Track updates here: ${v.link}\n— Tashkheesa`,
    ar: (v) => `تم تحديث توجيه حالتك بناءً على التفاصيل اللي قدمتها (${v.caseReference}). للمتابعة من هنا: ${v.link}\n— تشخيصة`
  },
  // ══════════════════════════════════════════════════════════════════
  // AUDIT-P0-3 — bodies added for events that were queued over WhatsApp
  // with no OpenClaw template.
  //
  // getOpenClawBody() returned null for every one of these, so
  // notify/whatsapp.js took the `no_openclaw_template` branch and the
  // worker wrote status='skipped' — which /ops deliberately excludes
  // from its failure count. The most damaging case was the doctor
  // broadcast on a newly paid case (tashkheesa_new_case_*): NO doctor
  // was ever notified of a new paid case by WhatsApp, and the ops
  // dashboard showed zero failures the whole time.
  // ══════════════════════════════════════════════════════════════════

  // ── Doctor: new paid case broadcast (notify/broadcast.js TIER_CONFIG) ──
  // vars carry case_ref / specialty / tier / sla_hours; caseReference and
  // slaHours are normalised by the enricher below.
  tashkheesa_new_case_urgent: {
    en: (v) => `URGENT case available (${v.caseReference}) — ${v.slaHours || 4}h SLA. First to accept takes it: ${appUrl()}/portal/doctor/cases\n— Tashkheesa`,
    ar: (v) => `حالة عاجلة متاحة (${v.caseReference}) — مهلة ${v.slaHours || 4} ساعات. أول قبول ياخدها: ${appUrl()}/portal/doctor/cases\n— تشخيصة`
  },
  tashkheesa_new_case_fasttrack: {
    en: (v) => `Fast-track case available (${v.caseReference}) — ${v.slaHours || 18}h SLA. Accept here: ${appUrl()}/portal/doctor/cases\n— Tashkheesa`,
    ar: (v) => `حالة سريعة متاحة (${v.caseReference}) — مهلة ${v.slaHours || 18} ساعة. القبول من هنا: ${appUrl()}/portal/doctor/cases\n— تشخيصة`
  },
  tashkheesa_new_case_standard: {
    en: (v) => `New case available (${v.caseReference}) — ${v.slaHours || 48}h SLA. Accept here: ${appUrl()}/portal/doctor/cases\n— Tashkheesa`,
    ar: (v) => `حالة جديدة متاحة (${v.caseReference}) — مهلة ${v.slaHours || 48} ساعة. القبول من هنا: ${appUrl()}/portal/doctor/cases\n— تشخيصة`
  },

  // ── Doctor: assignment lifecycle ──────────────────────────────────
  tashkheesa_case_assigned: {
    en: (v) => `Case ${v.caseReference} has been assigned to you. Review and accept: ${appUrl()}/portal/doctor/case/${v.orderId}\n— Tashkheesa`,
    ar: (v) => `تم إسناد حالة ${v.caseReference} إليك. للمراجعة والقبول: ${appUrl()}/portal/doctor/case/${v.orderId}\n— تشخيصة`
  },
  tashkheesa_case_auto_assigned: {
    en: (v) => `Case ${v.caseReference} was auto-assigned to you. Please accept it to start the SLA clock: ${appUrl()}/portal/doctor/case/${v.orderId}\n— Tashkheesa`,
    ar: (v) => `تم إسناد حالة ${v.caseReference} إليك تلقائيًا. القبول يبدأ مهلة المراجعة: ${appUrl()}/portal/doctor/case/${v.orderId}\n— تشخيصة`
  },
  order_assigned_doctor: {
    en: (v) => `Case ${v.caseReference} has been assigned to you. Open it here: ${appUrl()}/portal/doctor/case/${v.orderId}\n— Tashkheesa`,
    ar: (v) => `تم إسناد حالة ${v.caseReference} إليك. للفتح من هنا: ${appUrl()}/portal/doctor/case/${v.orderId}\n— تشخيصة`
  },
  order_auto_assigned_doctor: {
    en: (v) => `Case ${v.caseReference} was auto-assigned to you. Please accept it to start the SLA clock: ${appUrl()}/portal/doctor/case/${v.orderId}\n— Tashkheesa`,
    ar: (v) => `تم إسناد حالة ${v.caseReference} إليك تلقائيًا. القبول يبدأ مهلة المراجعة: ${appUrl()}/portal/doctor/case/${v.orderId}\n— تشخيصة`
  },
  order_reassigned_doctor: {
    en: (v) => `Case ${v.caseReference} has been reassigned to you. Open it here: ${appUrl()}/portal/doctor/case/${v.orderId}\n— Tashkheesa`,
    ar: (v) => `تم إعادة إسناد حالة ${v.caseReference} إليك. للفتح من هنا: ${appUrl()}/portal/doctor/case/${v.orderId}\n— تشخيصة`
  },
  patient_uploaded_files_doctor: {
    en: (v) => `New files were uploaded on case ${v.caseReference}. Review them here: ${appUrl()}/portal/doctor/case/${v.orderId}\n— Tashkheesa`,
    ar: (v) => `تم رفع ملفات جديدة على حالة ${v.caseReference}. للمراجعة من هنا: ${appUrl()}/portal/doctor/case/${v.orderId}\n— تشخيصة`
  },
  payment_success_doctor: {
    en: (v) => `Payment confirmed on case ${v.caseReference} — it is ready for review: ${appUrl()}/portal/doctor/case/${v.orderId}\n— Tashkheesa`,
    ar: (v) => `تم تأكيد الدفع لحالة ${v.caseReference} — جاهزة للمراجعة: ${appUrl()}/portal/doctor/case/${v.orderId}\n— تشخيصة`
  },
  sla_breach: {
    en: (v) => `SLA BREACHED on case ${v.caseReference}. Immediate action needed: ${appUrl()}/portal/doctor/case/${v.orderId}\n— Tashkheesa`,
    ar: (v) => `تم تجاوز المهلة على حالة ${v.caseReference}. مطلوب إجراء فوري: ${appUrl()}/portal/doctor/case/${v.orderId}\n— تشخيصة`
  },
  doctor_approved: {
    en: (v) => `Your Tashkheesa specialist account is approved. Sign in to view available cases: ${appUrl()}/portal/doctor\n— Tashkheesa`,
    ar: (v) => `تم اعتماد حسابك كطبيب على تشخيصة. لتسجيل الدخول ومتابعة الحالات المتاحة: ${appUrl()}/portal/doctor\n— تشخيصة`
  },

  // ── Patient: order + prescription ─────────────────────────────────
  order_created_patient: {
    en: (v) => `We received your case (${v.caseReference}). Complete payment to start your specialist review: ${v.link}\n— Tashkheesa`,
    ar: (v) => `استلمنا حالتك (${v.caseReference}). إكمال الدفع يبدأ مراجعة الطبيب: ${v.link}\n— تشخيصة`
  },
  payment_failed_patient: {
    en: (v) => `Your payment for case ${v.caseReference} did not go through. No charge was made — you can try again here: ${v.link}\n— Tashkheesa`,
    ar: (v) => `الدفع لحالة ${v.caseReference} لم يكتمل. لم يتم خصم أي مبلغ — إعادة المحاولة من هنا: ${v.link}\n— تشخيصة`
  },
  prescription_uploaded_patient: {
    en: (v) => `Your prescription for case ${v.caseReference} is ready on the portal: ${v.link}\n— Tashkheesa`,
    ar: (v) => `روشتتك لحالة ${v.caseReference} جاهزة على البورتال: ${v.link}\n— تشخيصة`
  },
  appointment_reminder: {
    en: (v) => `Reminder — your appointment for case ${v.caseReference} is at ${v.appointmentTime}. Details: ${v.link}\n— Tashkheesa`,
    ar: (v) => `تذكير — موعدك لحالة ${v.caseReference} الساعة ${v.appointmentTime}. التفاصيل: ${v.link}\n— تشخيصة`
  },

  // ── Video consultation (routes/video.js, video_scheduler.js) ──────
  video_payment_confirmed: {
    en: (v) => `Your video consultation for case ${v.caseReference} is paid and confirmed. We'll send the time shortly: ${v.link}\n— Tashkheesa`,
    ar: (v) => `تم دفع وتأكيد الاستشارة المرئية لحالة ${v.caseReference}. هنبعت الموعد قريب: ${v.link}\n— تشخيصة`
  },
  video_slot_proposed: {
    en: (v) => `A time has been proposed for your video consultation (${v.caseReference}): ${v.appointmentTime}. Confirm or ask for another: ${v.link}\n— Tashkheesa`,
    ar: (v) => `تم اقتراح موعد لاستشارتك المرئية (${v.caseReference}): ${v.appointmentTime}. للتأكيد أو طلب موعد آخر: ${v.link}\n— تشخيصة`
  },
  video_slot_accepted: {
    en: (v) => `The proposed time for case ${v.caseReference} was accepted: ${v.appointmentTime}. Details: ${v.link}\n— Tashkheesa`,
    ar: (v) => `تم قبول الموعد المقترح لحالة ${v.caseReference}: ${v.appointmentTime}. التفاصيل: ${v.link}\n— تشخيصة`
  },
  video_slot_confirmed: {
    en: (v) => `Your video consultation for case ${v.caseReference} is confirmed for ${v.appointmentTime}. Join from: ${v.link}\n— Tashkheesa`,
    ar: (v) => `تم تأكيد استشارتك المرئية لحالة ${v.caseReference} في ${v.appointmentTime}. للانضمام: ${v.link}\n— تشخيصة`
  },
  video_appointment_reminder: {
    en: (v) => `Reminder — your video consultation (${v.caseReference}) starts at ${v.appointmentTime}. Join from: ${v.link}\n— Tashkheesa`,
    ar: (v) => `تذكير — استشارتك المرئية (${v.caseReference}) تبدأ ${v.appointmentTime}. للانضمام: ${v.link}\n— تشخيصة`
  },
  video_appointment_rescheduled: {
    en: (v) => `Your video consultation for case ${v.caseReference} has moved to ${v.appointmentTime}. Details: ${v.link}\n— Tashkheesa`,
    ar: (v) => `تم نقل استشارتك المرئية لحالة ${v.caseReference} إلى ${v.appointmentTime}. التفاصيل: ${v.link}\n— تشخيصة`
  },
  video_appointment_cancelled: {
    en: (v) => `Your video consultation for case ${v.caseReference} has been cancelled${v.reason ? ` (${v.reason})` : ''}. Details: ${v.link}\n— Tashkheesa`,
    ar: (v) => `تم إلغاء استشارتك المرئية لحالة ${v.caseReference}${v.reason ? ` (${v.reason})` : ''}. التفاصيل: ${v.link}\n— تشخيصة`
  },
  video_slot_auto_cancelled_patient: {
    en: (v) => `The proposed video consultation time for case ${v.caseReference} expired without confirmation, so it was released. Pick a new time: ${v.link}\n— Tashkheesa`,
    ar: (v) => `الموعد المقترح للاستشارة المرئية لحالة ${v.caseReference} انتهت مهلته بدون تأكيد وتم إلغاؤه. لاختيار موعد جديد: ${v.link}\n— تشخيصة`
  },
  video_call_started: {
    en: (v) => `Your video consultation for case ${v.caseReference} has started. Join now: ${v.link}\n— Tashkheesa`,
    ar: (v) => `بدأت استشارتك المرئية لحالة ${v.caseReference}. للانضمام الآن: ${v.link}\n— تشخيصة`
  },
  video_call_ended: {
    en: (v) => `Your video consultation for case ${v.caseReference} has ended. Notes and next steps: ${v.link}\n— Tashkheesa`,
    ar: (v) => `انتهت استشارتك المرئية لحالة ${v.caseReference}. الملاحظات والخطوات التالية: ${v.link}\n— تشخيصة`
  },
  video_no_show_patient: {
    en: (v) => `We couldn't connect for your video consultation (${v.caseReference}). Reschedule here: ${v.link}\n— Tashkheesa`,
    ar: (v) => `تعذّر الاتصال بخصوص استشارتك المرئية (${v.caseReference}). لإعادة تحديد الموعد: ${v.link}\n— تشخيصة`
  },
  video_no_show_doctor: {
    en: (v) => `The patient did not join the video consultation for case ${v.caseReference}. Details: ${appUrl()}/portal/doctor/case/${v.orderId}\n— Tashkheesa`,
    ar: (v) => `المريض لم ينضم للاستشارة المرئية لحالة ${v.caseReference}. التفاصيل: ${appUrl()}/portal/doctor/case/${v.orderId}\n— تشخيصة`
  },
  video_slot_review_requested: {
    en: (v) => `A new video-consultation time needs your review on case ${v.caseReference}: ${appUrl()}/portal/doctor/case/${v.orderId}\n— Tashkheesa`,
    ar: (v) => `مطلوب مراجعتك لموعد استشارة مرئية على حالة ${v.caseReference}: ${appUrl()}/portal/doctor/case/${v.orderId}\n— تشخيصة`
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
    // AUDIT-P0-3: notify/broadcast.js queues `case_ref` (not caseReference)
    // and `sla_hours`; without these aliases the doctor broadcast bodies
    // would render an empty case reference.
    caseReference: vars.caseReference || vars.case_ref || vars.caseRef || (orderId ? String(orderId).slice(0, 12).toUpperCase() : ''),
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
