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

// FIX 13 — shared with notification_worker's email path so the two surfaces
// render the same countdown with the same Arabic number agreement.
const { formatTimeRemaining } = require('./duration');

function appUrl() {
  return process.env.APP_URL || 'https://tashkheesa.com';
}

function patientOrderUrl(orderId) {
  return orderId ? `${appUrl()}/portal/patient/orders/${orderId}` : appUrl();
}

// FIX 4 (regression F4) — the SLA-reminder bodies interpolated
// `/portal/doctor/case/${v.orderId}` directly. queueSlaReminder passed no
// orderId, so the doctor's only call to action was a URL ending in a bare
// slash. The id is now always queued, but a link with a missing segment is a
// dead end either way: fall back to the doctor's queue, which at least lands
// them somewhere they can find the case.
function doctorCaseUrl(orderId) {
  return orderId ? `${appUrl()}/portal/doctor/case/${orderId}` : `${appUrl()}/portal/doctor`;
}

// AUDIT-2026-08-22 (N6) — ops-facing order view, for alerts fanned out to
// superadmins. Same missing-id guard as doctorCaseUrl: fall back to the ops
// order list rather than emit a URL with an empty final segment.
function opsOrderUrl(orderId) {
  return orderId ? `${appUrl()}/superadmin/orders/${orderId}` : `${appUrl()}/superadmin/orders`;
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

  // ── h2. SLA reminder tiers — 24h / 6h / 1h (FIX 4) ─────────────────
  // Queued by case_lifecycle.dispatchSlaReminders on the 'whatsapp' channel
  // to BOTH the assigned doctor and the patient (role is in the payload).
  // Without these three bodies getOpenClawBody returned null, whatsapp.js
  // took the `no_openclaw_template` branch, and every reminder was written
  // straight to 'failed' as a permanent failure — the exact class of silent
  // gap that hid the doctor new-case broadcast.
  //
  // One composer per tier, branching on role: a doctor needs an action and a
  // case link, a patient needs reassurance and explicitly no action. Sending
  // the doctor's "action needed" wording to a patient would read as though
  // the patient were late on something. AR is gender-neutral per the file
  // conventions above (passive voice, nominal phrases, team 1pl).
  //
  // FIX 13 — the countdown is `v.timeRemaining`, a pre-formatted localised
  // phrase (notify/duration.js), not a bare number with a hardcoded unit. The
  // old form interpolated `${v.hoursRemaining || 6} ساعات`, which renders
  // "1 ساعات" whenever the 6h tier fires with an hour or less left on the
  // clock — Arabic uses a different form for 1, 2, 3–10 and 11+. The tier
  // wording ("خلال حوالي") stays approximate, so a fallback per tier is kept
  // for the case where the payload carries no countdown at all.
  sla_reminder_24h: {
    en: (v) => v.role === 'doctor'
      ? `Reminder — case ${v.caseReference} is due in about ${v.timeRemaining || '24 hours'}. Complete your review here: ${doctorCaseUrl(v.orderId)}\n— Tashkheesa`
      : `Update on case ${v.caseReference} — your second opinion is due within about ${v.timeRemaining || '24 hours'}. Nothing needed from you; we'll notify you the moment it's ready. ${v.link}\n— Tashkheesa`,
    ar: (v) => v.role === 'doctor'
      ? `تذكير — موعد تسليم حالة ${v.caseReference} خلال حوالي ${v.timeRemaining || '24 ساعة'}. لإكمال المراجعة: ${doctorCaseUrl(v.orderId)}\n— تشخيصة`
      : `تحديث عن حالة ${v.caseReference} — رأيك الطبي الثاني موعده خلال حوالي ${v.timeRemaining || '24 ساعة'}. مفيش أي إجراء مطلوب منك، وهنبلغك أول ما يجهز. ${v.link}\n— تشخيصة`
  },
  sla_reminder_6h: {
    en: (v) => v.role === 'doctor'
      ? `Case ${v.caseReference} is due in about ${v.timeRemaining || '6 hours'}. Please complete your review: ${doctorCaseUrl(v.orderId)}\n— Tashkheesa`
      : `Case ${v.caseReference} — your second opinion is due in about ${v.timeRemaining || '6 hours'}. Your specialist is working on it; we'll send it as soon as it's ready. ${v.link}\n— Tashkheesa`,
    ar: (v) => v.role === 'doctor'
      ? `موعد تسليم حالة ${v.caseReference} خلال حوالي ${v.timeRemaining || '6 ساعات'}. برجاء إكمال المراجعة: ${doctorCaseUrl(v.orderId)}\n— تشخيصة`
      : `حالة ${v.caseReference} — رأيك الطبي الثاني موعده خلال حوالي ${v.timeRemaining || '6 ساعات'}. الطبيب المختص شغال عليه وهيوصلك أول ما يجهز. ${v.link}\n— تشخيصة`
  },
  sla_reminder_1h: {
    en: (v) => v.role === 'doctor'
      ? `URGENT — case ${v.caseReference} is due within the hour. Submit your review now: ${doctorCaseUrl(v.orderId)}\n— Tashkheesa`
      : `Case ${v.caseReference} — your second opinion is due within the hour. Your specialist is finalising it now. ${v.link}\n— Tashkheesa`,
    ar: (v) => v.role === 'doctor'
      ? `عاجل — موعد تسليم حالة ${v.caseReference} خلال ساعة. لإرسال المراجعة الآن: ${doctorCaseUrl(v.orderId)}\n— تشخيصة`
      : `حالة ${v.caseReference} — رأيك الطبي الثاني موعده خلال ساعة. الطبيب المختص بينهيه دلوقتي. ${v.link}\n— تشخيصة`
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
  // AUDIT-2026-08-22 (N3) — this body was DOCTOR copy on a PATIENT-only event.
  //
  // `tashkheesa_case_assigned` has exactly two call sites repo-wide —
  // routes/admin.js (force-assign) and workers/acceptance_watcher.js
  // (acceptance-timeout auto-assign) — and BOTH queue it to `order.patient_id`.
  // There is no doctor call site: doctors get CASE_AUTO_ASSIGNED /
  // order_assigned_doctor, which have their own doctor bodies below.
  //
  // So the patient was told "Case X has been assigned to YOU. Review and
  // accept:" followed by a /portal/doctor/case/ URL they cannot open — asking
  // them to accept their own case. The bell title for the same template
  // ('Your case has been assigned to a doctor' / 'تم إسناد حالتك إلى طبيب')
  // was already correct patient copy, so the two surfaces contradicted each
  // other on the same event.
  //
  // Fixed by rewriting the BODY to match the (correct) title rather than by
  // renaming the template at the call sites: that repairs both call sites at
  // once — including acceptance_watcher.js, which this agent does not own —
  // and leaves no window where one site is renamed and the other is not.
  tashkheesa_case_assigned: {
    en: (v) => `Your case (${v.caseReference}) has been assigned to ${v.doctorName ? `Dr. ${v.doctorName}` : 'a specialist'}. Track updates here: ${v.link}\n— Tashkheesa`,
    ar: (v) => `تم إسناد حالتك (${v.caseReference}) إلى ${v.doctorName ? `د. ${v.doctorName}` : 'طبيب مختص'}. للمتابعة: ${v.link}\n— تشخيصة`
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
  // DOCTOR-facing breach alert (notify.sendSlaReminder level 'breach' → the
  // assigned doctor). doctorCaseUrl() rather than raw interpolation so a
  // missing orderId lands on the doctor's queue instead of a URL ending in a
  // bare slash — see the helper's note above (AUDIT-2026-08-22, N6).
  sla_breach: {
    en: (v) => `SLA BREACHED on case ${v.caseReference}. Immediate action needed: ${doctorCaseUrl(v.orderId)}\n— Tashkheesa`,
    ar: (v) => `تم تجاوز المهلة على حالة ${v.caseReference}. مطلوب إجراء فوري: ${doctorCaseUrl(v.orderId)}\n— تشخيصة`
  },
  // AUDIT-2026-08-22 (N6) — SUPERADMIN-facing breach escalation
  // (notify.dispatchSlaBreach fans this to every active superadmin).
  //
  // It used to fan `sla_breach` above: doctor-addressed copy ("Immediate
  // action needed") with a /portal/doctor/case/ CTA, sent to operators who
  // cannot write the review and do not use that portal. The ops action on a
  // breach is to chase, reassign or escalate, so the copy says that and the
  // CTA points at the ops order view.
  sla_breach_superadmin: {
    en: (v) => `SLA BREACHED — case ${v.caseReference}${v.doctorName ? ` (Dr. ${v.doctorName})` : ''} is past its deadline and needs escalation or reassignment: ${opsOrderUrl(v.orderId)}\n— Tashkheesa`,
    ar: (v) => `تم تجاوز المهلة — حالة ${v.caseReference}${v.doctorName ? ` (د. ${v.doctorName})` : ''} تجاوزت موعد التسليم وتحتاج تصعيدًا أو إعادة إسناد: ${opsOrderUrl(v.orderId)}\n— تشخيصة`
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
  },

  // ── AUDIT-2026-08-22: three NEW video events (routes/video.js) ────────
  //
  // Added ahead of the emitting code. A queued whatsapp-channel event with no
  // entry in this table is NOT a soft skip: whatsapp.js returns
  // { ok:false, permanent:true, error:'no_openclaw_template' } and the worker
  // files it as a failure on /ops. Registering them here is what keeps three
  // real events off the failure dashboard on day one.
  //
  // Distinct from video_no_show_patient / video_no_show_doctor above, which
  // are the PATIENT-no-show pair (suffix = recipient, not absentee).

  // The DOCTOR failed to join. The patient is fully refunded, so the refund is
  // stated plainly and unconditionally — `refund:'full'` is a constant on this
  // event, so there is nothing to branch on and no reason to hedge the wording.
  // No apology-plus-no-remedy: the rebook link is the remedy.
  video_doctor_no_show_patient: {
    en: (v) => `We're sorry — the specialist could not join your video consultation (${v.caseReference}). You have been refunded in full. To book a new time: ${v.link}\n— Tashkheesa`,
    ar: (v) => `نعتذر — تعذّر انضمام الطبيب إلى استشارتك المرئية (${v.caseReference}). تم رد المبلغ بالكامل. لحجز موعد جديد: ${v.link}\n— تشخيصة`
  },
  // The PATIENT cancelled. The doctor needs to know the slot is free and what
  // happened to the money (refund_status is operational context for them, not
  // a promise to the patient), so it renders only when the payload carries it.
  video_appointment_cancelled_doctor: {
    en: (v) => `The patient cancelled the video consultation for case ${v.caseReference}${v.refundStatus ? ` (refund: ${v.refundStatus})` : ''}. The slot is now free. Details: ${doctorCaseUrl(v.orderId)}\n— Tashkheesa`,
    ar: (v) => `المريض ألغى الاستشارة المرئية لحالة ${v.caseReference}${v.refundStatus ? ` (حالة الاسترداد: ${v.refundStatus})` : ''}. الموعد أصبح متاحًا. التفاصيل: ${doctorCaseUrl(v.orderId)}\n— تشخيصة`
  },
  // The patient ACCEPTED the time the doctor proposed — the doctor's slot is
  // now committed, so the confirmed time is the whole point of the message.
  video_slot_confirmed_doctor: {
    en: (v) => `The patient confirmed the video consultation for case ${v.caseReference}${v.confirmedSlot ? `: ${v.confirmedSlot}` : ''}. Details: ${doctorCaseUrl(v.orderId)}\n— Tashkheesa`,
    ar: (v) => `المريض أكد موعد الاستشارة المرئية لحالة ${v.caseReference}${v.confirmedSlot ? `: ${v.confirmedSlot}` : ''}. التفاصيل: ${doctorCaseUrl(v.orderId)}\n— تشخيصة`
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
    hoursRemaining: vars.hoursRemaining || vars.hours_remaining
      // FIX 4 — case_lifecycle.queueSlaReminder queues `seconds_remaining`
      // and no hours field, so the SLA-reminder composers would otherwise
      // fall back to their hardcoded tier default instead of the real
      // countdown. Floored and clamped at 0 so a late sweep never renders a
      // negative "due in -3h" to a patient.
      || (Number.isFinite(Number(vars.seconds_remaining))
        ? String(Math.max(0, Math.floor(Number(vars.seconds_remaining) / 3600)))
        : '')
      || '',
    // FIX 13 — the localised countdown PHRASE, as opposed to the bare number
    // above. `hoursRemaining` cannot be interpolated safely into Arabic: the
    // unit word depends on the value (1 / 2 / 3–10 / 11+), and it floors to
    // "0" inside the final hour. formatTimeRemaining handles both, and returns
    // '' when there is nothing sensible to say so the composer falls back to
    // its approximate tier wording. Prefers the exact seconds when queued,
    // otherwise reconstructs from an hours field (payment reminders).
    timeRemaining: formatTimeRemaining(
      Number.isFinite(Number(vars.seconds_remaining))
        ? Number(vars.seconds_remaining)
        : Number(vars.hoursRemaining || vars.hours_remaining) * 3600,
      lang
    ),
    // FIX 4 — recipient role. dispatchSlaReminders queues the SAME template
    // to the doctor and to the patient; the composers branch on this to pick
    // action-oriented vs reassurance copy. Defaults to '' (→ patient copy),
    // which is the safe side: a doctor shown the patient wording loses an
    // action prompt, a patient shown the doctor wording is told they are late.
    role: String(vars.role || '').toLowerCase(),
    // AUDIT-2026-08-22: `enriched` is a FIXED key set — it deliberately does
    // not spread `vars`, so a composer can only read what is listed here. The
    // three new video events carry payload fields that had no slot, and a
    // composer reading `v.confirmed_slot` would have rendered `undefined` in a
    // patient-visible body. Mapped explicitly, snake_case first (that is what
    // routes/video.js queues) with a camelCase alias for callers that use it.
    confirmedSlot: vars.confirmed_slot || vars.confirmedSlot || vars.appointmentTime || vars.appointment_time || '',
    refundStatus: vars.refund_status || vars.refundStatus || vars.refund || '',
    cancelledBy: vars.cancelled_by || vars.cancelledBy || '',
    appointmentId: vars.appointment_id || vars.appointmentId || '',
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
