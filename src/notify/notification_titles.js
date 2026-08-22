// src/notify/notification_titles.js

function humanizeTemplate(template) {
  const raw = String(template || '').trim();
  if (!raw) return 'Notification';
  const spaced = raw.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return spaced.replace(/\b\w/g, (m) => m.toUpperCase());
}

// P1-NOTIF-4: minimal `{varName}` interpolation for subject lines.
// Missing keys substitute as ''. The post-process pass cleans up the
// common artifacts a missing var leaves behind:
//   - "Dr.  has accepted"      → "Dr. has accepted"      (collapse double space)
//   - "Welcome to Tashkheesa, " → "Welcome to Tashkheesa" (strip trailing comma)
//   - "specialty: "             → "specialty"             (strip trailing colon)
// Happy-path renders (all vars present) are unaffected — they end on words,
// not punctuation, and contain no whitespace runs.
function interpolate(str, vars) {
  if (str == null) return '';
  var out = String(str).replace(/\{(\w+)\}/g, function (_, key) {
    if (!vars) return '';
    var v = vars[key];
    return v == null || v === '' ? '' : String(v);
  });
  out = out.replace(/\s+/g, ' ');                  // collapse whitespace runs
  out = out.replace(/[،,:;\-—–]\s*$/u, '');        // strip trailing punctuation (incl Arabic ، U+060C)
  return out.trim();
}

// P1-NOTIF-4: warmed subject lines for high-impact templates use
// canonical placeholder names matching template variable contract:
//   {doctorName}, {patientName}, {caseReference},
//   {appointmentDate}, {appointmentTime}
// The notification_worker passes its full templateData object as `vars`
// to getNotificationTitles, so any template variable can appear in a
// subject. Templates without placeholders are unchanged.
const TEMPLATE_TITLES = {
  // Required minimum set
  order_assigned_doctor: { en: 'New case in your specialty: {caseReference}', ar: 'حالة جديدة في تخصصك: {caseReference}' },
  order_reassigned_doctor: { en: 'Case reassigned', ar: 'تمت إعادة تعيين الحالة' },
  sla_reminder_doctor: { en: 'Action needed: case approaching deadline', ar: 'إجراء مطلوب: حالة تقترب من الموعد النهائي' },
  sla_breached_doctor: { en: 'SLA breached', ar: 'تم تجاوز مهلة المراجعة' },
  patient_reply_info: { en: 'Patient sent additional information', ar: 'المريض أرسل معلومات إضافية' },
  additional_files_requested_patient: { en: 'Additional files requested', ar: 'مطلوب ملفات إضافية' },
  patient_uploaded_files_doctor: { en: 'Patient uploaded additional files', ar: 'المريض رفع ملفات إضافية' },
  report_ready_patient: { en: 'Your second opinion is ready', ar: 'رأيك الطبي الثاني جاهز' },
  smoke_test: { en: 'Smoke test', ar: 'اختبار تشغيلي' },

  // Common variants + legacy templates
  order_auto_assigned_doctor: { en: 'New case in your specialty: {caseReference}', ar: 'حالة جديدة في تخصصك: {caseReference}' },
  order_reassigned_to_doctor: { en: 'Case reassigned to you', ar: 'تم إعادة تعيين الحالة لك' },
  order_reassigned_from_doctor: { en: 'Case reassigned from you', ar: 'تمت إعادة تعيين الحالة منك' },
  public_order_assigned_doctor: { en: 'New case in your specialty: {caseReference}', ar: 'حالة جديدة في تخصصك: {caseReference}' },
  order_status_accepted_patient: { en: 'Dr. {doctorName} has accepted your case', ar: 'د. {doctorName} قبل حالتك' },
  additional_files_request_approved_patient: { en: 'Additional files requested', ar: 'مطلوب ملفات إضافية' },
  order_created_patient: { en: 'Your case is in our queue', ar: 'حالتك في قائمة الانتظار' },
  public_order_created_patient: { en: 'Your case is in our queue', ar: 'حالتك في قائمة الانتظار' },
  public_order_created_superadmin: { en: 'New public order', ar: 'طلب عام جديد' },
  order_reassigned_patient: { en: 'Case reassigned', ar: 'تمت إعادة تعيين الحالة' },
  order_breached_patient: { en: 'Case delayed', ar: 'تأخر إنجاز الحالة' },
  order_sla_pre_breach: { en: 'Action needed: case approaching deadline', ar: 'إجراء مطلوب: حالة تقترب من الموعد النهائي' },
  order_breached_superadmin: { en: 'SLA breached', ar: 'تم تجاوز مهلة المراجعة' },
  order_sla_pre_breach_doctor: { en: 'Action needed: case approaching deadline', ar: 'إجراء مطلوب: حالة تقترب من الموعد النهائي' },
  order_breached_doctor: { en: 'SLA breached', ar: 'تم تجاوز مهلة المراجعة' },
  case_auto_deleted_unpaid_patient: { en: 'Case removed', ar: 'تم حذف الحالة' },
  payment_success_patient: { en: 'Payment confirmed — case in motion', ar: 'تم تأكيد الدفع — تشخيصة بدأت العمل' },
  payment_success_doctor: { en: 'Payment received', ar: 'تم استلام الدفع' },
  // AUDIT-P1-2: chat-moderation conduct warning (routes/admin.js,
  // routes/superadmin.js). Previously written with a column list the
  // notifications table does not have, so it never reached the bell at all.
  chat_conduct_warning: { en: 'Chat conduct warning', ar: 'تنبيه بخصوص آداب المحادثة' },
  payment_marked_paid_patient: { en: 'Payment confirmed — case in motion', ar: 'تم تأكيد الدفع — تشخيصة بدأت العمل' },
  payment_marked_paid: { en: 'Payment confirmed', ar: 'تم تأكيد الدفع' },
  payment_failed_patient: { en: "Payment didn't go through — let's try again", ar: 'لم تتم عملية الدفع — لنحاول مرة أخرى' },
  doctor_signup_pending: { en: 'Doctor signup pending', ar: 'تسجيل طبيب قيد المراجعة' },
  // Doctor-onboarding subject is bilingual-in-one-line (Ziad-locked) so the
  // inbox preview matches the bilingual email body regardless of user.lang.
  doctor_approved: {
    en: 'أهلاً بك في تشخيصة — حسابك جاهز · Welcome to Tashkheesa — your account is ready',
    ar: 'أهلاً بك في تشخيصة — حسابك جاهز · Welcome to Tashkheesa — your account is ready'
  },
  doctor_rejected: { en: 'Doctor rejected', ar: 'تم رفض الطبيب' },
  prescription_uploaded_patient: { en: 'Prescription available', ar: 'الوصفة الطبية متاحة' },
  new_message: { en: 'New message', ar: 'رسالة جديدة' },
  appointment_booked: { en: 'Your appointment is set: {appointmentDate} at {appointmentTime}', ar: 'تم تحديد موعدك: {appointmentDate} في {appointmentTime}' },
  appointment_rescheduled: { en: 'Your appointment is set: {appointmentDate} at {appointmentTime}', ar: 'تم تحديد موعدك: {appointmentDate} في {appointmentTime}' },
  appointment_cancelled: { en: 'Appointment cancelled', ar: 'تم إلغاء الموعد' },
  welcome_patient: { en: 'Welcome to Tashkheesa, {patientName}', ar: 'مرحباً بك في تشخيصة، {patientName}' },

  // Theme 7b Phase 2 — patient-initiated refund flow.
  patient_refund_requested:           { en: 'Refund request received',          ar: 'استلمنا طلب استرداد المبلغ' },
  patient_refund_opened_by_operator:  { en: 'A refund has been opened on your behalf', ar: 'تم فتح طلب استرداد نيابةً عنك' },
  admin_refund_request_received:      { en: 'New refund request: {caseReference}', ar: 'طلب استرداد جديد: {caseReference}' },
  admin_refund_cancelled_by_patient:  { en: 'Refund request cancelled: {caseReference}', ar: 'تم إلغاء طلب الاسترداد: {caseReference}' },

  // Theme 7b Phase 3 — superadmin actions on refund requests.
  patient_refund_approved:            { en: 'Refund approved',                 ar: 'تم اعتماد طلب استرداد المبلغ' },
  patient_refund_denied:              { en: 'Refund request reviewed',         ar: 'تمت مراجعة طلب استرداد المبلغ' },
  patient_refund_paid:                { en: 'Refund sent via Instapay',        ar: 'تم تحويل المبلغ عبر الإنستاباي' },

  // WhatsApp-via-OpenClaw rollout — case cancellation queue-ified.
  case_cancelled_patient: { en: 'Case cancelled', ar: 'تم إلغاء الحالة' },

  // Add-on purchase confirmations.
  addon_purchased_video:        { en: 'Video consultation booked',  ar: 'تم حجز استشارة الفيديو' },
  addon_purchased_urgency:      { en: 'Case upgraded to urgent',    ar: 'تم ترقية الحالة لعاجلة' },
  addon_purchased_prescription: { en: 'Prescription add-on added',  ar: 'تمت إضافة الروشتة' },

  // #66: payment-reminder series. Subject lines mirror the tone
  // progression of the email bodies — soft (30m), warmer (6h),
  // informational (24h). AR uses gender-neutral phrasing.
  payment_reminder_30m: { en: 'Reminder: complete payment for your case',     ar: 'تذكير: إكمال الدفع لحالتك' },
  payment_reminder_6h:  { en: 'Your case is still waiting for payment',       ar: 'حالتك لسة في انتظار الدفع' },
  payment_reminder_24h: { en: 'A heads-up: your case spot is closing soon',   ar: 'تنبيه: حالتك تقترب من انتهاء فترة الحفظ' },

  // Theme 14 Phase 5 — patient notification on manual-queue approve when
  // the chosen specialty differs from the patient's original submission.
  case_routing_updated: { en: 'We updated your case routing',                 ar: 'تم تحديث توجيه حالتك' },

  // ── AUDIT-PAY-1 (regression F2) — urgent case paid outside the Cairo window
  //
  // case_lifecycle.markCasePaid queues this on the 'internal' channel when an
  // URGENT case is confirmed outside 07:00–19:00 Cairo: the SLA clock is
  // anchored to 07:00 the next morning, so the deadline the patient sees is
  // NOT "now + 4h" as the urgent tier implies. The fix that introduced the
  // queue call never registered the template anywhere, so getNotificationTitles
  // fell through to humanizeTemplate() and the bell literally read "Urgent Case
  // Window Deferred Patient" over an empty body — as the sole explanation to
  // someone who had just paid an urgency premium at 19:02.
  //
  // Deliberately reassuring, not apologetic: the turnaround they paid for is
  // intact, only its start is calendar-anchored. The concrete deadline is in
  // the body (notify.renderNotificationMessage), which can format a timestamp;
  // titles only do flat {var} interpolation.
  urgent_case_window_deferred_patient: {
    en: 'Your urgent review begins at 7 AM Cairo time',
    ar: 'مراجعتك العاجلة هتبدأ 7 الصبح بتوقيت القاهرة'
  },

  // ══════════════════════════════════════════════════════════════════════
  // AUDIT (FIX 3) — 26 events were queued with NO entry here.
  //
  // getNotificationTitles fell through to humanizeTemplate(), so the bell
  // rendered the raw event name title-cased: patients saw "Video Slot Auto
  // Cancelled Patient" and admins saw "Acceptance Timeout Auto Assigned
  // Admin" as the user-visible title of a medical notification.
  //
  // Placeholder policy for this block: most of these call sites queue a
  // payload with no case reference at all (e.g. new_case_assigned_doctor and
  // order_sla_prebreach pass no `response` whatsoever; the video_* events
  // pass appointment_id / slot times), and the bell path interpolates the
  // RAW payload — not the worker's enriched templateData. A `{caseReference}`
  // that resolves to '' would just reproduce the truncated-title bug FIX 2
  // exists to remove, so these titles are self-contained. `{caseReference}`
  // is used only where the queued payload is verified to carry that key.
  // ══════════════════════════════════════════════════════════════════════

  // ── Admin / ops queue ─────────────────────────────────────────────────
  // src/workers/acceptance_watcher.js — doctor never accepted in the
  // acceptance window, so the case was force-assigned. Admin-facing.
  acceptance_timeout_auto_assigned_admin: { en: 'Case auto-assigned after acceptance timeout', ar: 'إسناد تلقائي للحالة بعد انتهاء مهلة القبول' },
  // src/routes/admin.js — receipt to the admin who force-assigned a case.
  admin_force_assigned_confirmation:      { en: 'Case assigned to doctor',                     ar: 'تم إسناد الحالة إلى الطبيب' },
  // src/routes/doctor.js — doctor asked the patient for more files; ops is
  // copied so the request can be chased. Payload carries caseReference.
  admin_additional_files_requested:       { en: 'Doctor requested additional files: {caseReference}', ar: 'الطبيب طلب ملفات إضافية: {caseReference}' },
  // src/routes/payments.js — Paymob callback amount ≠ amount owed. This is a
  // money-integrity alert; the title must say so plainly.
  payment_amount_mismatch:                { en: 'Payment amount mismatch — review required',   ar: 'اختلاف في قيمة الدفع — مطلوب مراجعة' },
  // src/case_sla_worker.js — superadmin pre-breach escalation (no payload).
  order_sla_prebreach:                    { en: 'Case approaching SLA deadline',               ar: 'حالة تقترب من الموعد النهائي' },
  // notify.sendSlaReminder({level:'breach'}) — DOCTOR-facing. Queued to the
  // assigned doctor on the whatsapp channel from case_lifecycle.js on every
  // SLA breach.
  sla_breach:                             { en: 'SLA breached — immediate action needed',      ar: 'تم تجاوز المهلة — مطلوب إجراء فوري' },
  // AUDIT-2026-08-22: dispatchSlaBreach used to fan `sla_breach` — copy
  // addressed to the ASSIGNED DOCTOR, CTA pointing at /portal/doctor/case/ —
  // out to every active superadmin. An operator cannot "complete the review",
  // and the doctor portal is not their surface; the ops action on a breach is
  // to reassign or escalate. Superadmins now get their own template.
  sla_breach_superadmin:                  { en: 'SLA breached — escalation required',          ar: 'تم تجاوز المهلة — مطلوب تصعيد' },

  // ── Doctor / patient assignment ───────────────────────────────────────
  // src/routes/superadmin.js — auto-assign after superadmin marks paid.
  new_case_assigned_doctor:               { en: 'New case assigned to you',                    ar: 'تم إسناد حالة جديدة إليك' },
  // src/routes/api/admin.js — payload carries caseReference + doctorName.
  order_assigned_patient:                 { en: 'Dr. {doctorName} is reviewing your case',     ar: 'د. {doctorName} بيراجع حالتك' },

  // ── Auth / onboarding ─────────────────────────────────────────────────
  // src/routes/auth.js — passwordless sign-in link, queued on the email
  // channel. Deliberately says nothing about the case or the account state.
  magic_login_link:                       { en: 'Your sign-in link',                           ar: 'رابط تسجيل الدخول' },

  // ── Appointments ──────────────────────────────────────────────────────
  // src/jobs/appointment_reminders.js — queued to BOTH patient and doctor at
  // 24h and 1h. Role-neutral wording because one template serves both.
  appointment_reminder:                   { en: 'Appointment reminder',                        ar: 'تذكير بالموعد' },

  // ── Video consultation (routes/video.js, video_scheduler.js) ──────────
  // Patient-facing unless the name ends in _doctor / _admin.
  video_payment_confirmed:                { en: 'Video consultation confirmed',                ar: 'تم تأكيد الاستشارة المرئية' },
  video_slot_proposed:                    { en: 'A time was proposed for your video consultation', ar: 'تم اقتراح موعد لاستشارتك المرئية' },
  video_slot_accepted:                    { en: 'Video consultation time accepted',            ar: 'تم قبول موعد الاستشارة المرئية' },
  video_slot_confirmed:                   { en: 'Your video consultation is confirmed',        ar: 'تم تأكيد استشارتك المرئية' },
  video_appointment_reminder:             { en: 'Your video consultation is coming up',        ar: 'استشارتك المرئية قربت' },
  video_appointment_rescheduled:          { en: 'Your video consultation was rescheduled',     ar: 'تم تغيير موعد استشارتك المرئية' },
  video_appointment_cancelled:            { en: 'Video consultation cancelled',                ar: 'تم إلغاء الاستشارة المرئية' },
  video_call_started:                     { en: 'Your video consultation has started',         ar: 'بدأت استشارتك المرئية' },
  video_call_ended:                       { en: 'Your video consultation has ended',           ar: 'انتهت استشارتك المرئية' },
  // Proposed slot expired without patient confirmation and was released.
  video_slot_auto_cancelled_patient:      { en: 'Video consultation time released — please pick a new one', ar: 'تم إلغاء الموعد المقترح — برجاء اختيار موعد جديد' },
  video_no_show_patient:                  { en: "We couldn't connect for your video consultation", ar: 'تعذّر الاتصال بخصوص استشارتك المرئية' },
  // Doctor-facing.
  video_slot_review_requested:            { en: 'Video consultation time needs your review',   ar: 'مطلوب مراجعتك لموعد استشارة مرئية' },
  video_no_show_doctor:                   { en: 'Patient did not join the video consultation', ar: 'المريض لم ينضم للاستشارة المرئية' },
  // Admin-facing (video_scheduler sweeps).
  video_slot_auto_cancelled_admin:        { en: 'Video slot auto-cancelled — no confirmation', ar: 'إلغاء تلقائي لموعد مرئي — لم يتم التأكيد' },
  video_slot_stale_admin:                 { en: 'Video slot pending too long',                 ar: 'موعد مرئي معلّق منذ فترة طويلة' },

  // ── AUDIT-2026-08-22: three NEW video events (routes/video.js) ────────
  //
  // Registered here AND in openclawTemplates.js before the emitting code
  // ships: an unregistered title falls through to humanizeTemplate() ("Video
  // Doctor No Show Patient"), and a missing OpenClaw body is a HARD failure
  // (whatsapp.js returns { permanent: true }), so the send lands on /ops as
  // undelivered rather than silently degrading.
  //
  // Note the existing video_no_show_patient / video_no_show_doctor pair is the
  // PATIENT-no-show pair — both are about the patient failing to join, and the
  // suffix names the RECIPIENT, not the absentee. These three are distinct
  // events and deliberately do not reuse those names.
  //
  // Doctor no-showed; patient is fully refunded. The refund is the single most
  // important fact for the patient, so it is in the title, not buried in the
  // body — this is the message that decides whether they open a support ticket.
  video_doctor_no_show_patient:           { en: 'Your video consultation was missed — you have been refunded in full', ar: 'لم تتم استشارتك المرئية — تم رد المبلغ بالكامل' },
  // Patient cancelled; the doctor's slot is now free.
  video_appointment_cancelled_doctor:     { en: 'Patient cancelled the video consultation',    ar: 'المريض ألغى الاستشارة المرئية' },
  // Patient accepted the time the doctor proposed.
  video_slot_confirmed_doctor:            { en: 'Patient confirmed the video consultation time', ar: 'المريض أكد موعد الاستشارة المرئية' },

  // ── Doctor broadcast + assignment over WhatsApp (notify/templates.js) ─
  // These are queued as `template: TEMPLATES.X`, i.e. via a constant rather
  // than a string literal, so they do not show up in a grep for
  // `template: '<name>'` — but they are inserted into `notifications` like
  // any other row and hit the same humanizeTemplate fallback
  // ("Tashkheesa New Case Urgent").
  tashkheesa_new_case_urgent:             { en: 'Urgent case available in your specialty',     ar: 'حالة عاجلة متاحة في تخصصك' },
  tashkheesa_new_case_fasttrack:          { en: 'Fast-track case available in your specialty', ar: 'حالة سريعة متاحة في تخصصك' },
  tashkheesa_new_case_standard:           { en: 'New case available in your specialty',        ar: 'حالة جديدة متاحة في تخصصك' },
  tashkheesa_case_assigned:               { en: 'Your case has been assigned to a doctor',     ar: 'تم إسناد حالتك إلى طبيب' },
  tashkheesa_case_auto_assigned:          { en: 'Case auto-assigned to you',                   ar: 'تم إسناد حالة إليك تلقائيًا' },

  // ══════════════════════════════════════════════════════════════════════
  // FIX 4 — SLA reminder tiers (case_lifecycle.dispatchSlaReminders).
  //
  // Queued at 24h / 6h / 1h of REMAINING SLA on the 'whatsapp' and 'email'
  // channels, to BOTH the assigned doctor and the patient. Because one
  // template serves both audiences, the copy has to be true for both: the
  // doctor's action prompt lives in the body (sla-reminder.hbs and the
  // OpenClaw composers branch on `role`), not in the title. A title like
  // "Action needed" would be wrong on the patient's phone.
  // ══════════════════════════════════════════════════════════════════════
  sla_reminder_24h: { en: 'Case due within 24 hours', ar: 'موعد تسليم الحالة خلال 24 ساعة' },
  sla_reminder_6h:  { en: 'Case due within 6 hours',  ar: 'موعد تسليم الحالة خلال 6 ساعات' },
  sla_reminder_1h:  { en: 'Case due within the hour', ar: 'موعد تسليم الحالة خلال ساعة' },

  // ── Dead-path today, registered defensively ───────────────────────────
  // notify.sendSlaReminder maps level '75'/'90' to these two names, but its
  // only live caller (case_lifecycle.js:1700) passes level 'breach' and
  // nothing else — so neither is currently reachable. Copy below is COPIED
  // VERBATIM from the semantically identical, live `order_sla_pre_breach`
  // entry above rather than newly written, so registering them asserts
  // nothing about a flow that does not exist; it only stops the bell
  // rendering "Sla Warning 75" if someone wires those levels on.
  //
  // NOTE: both are still queued on the 'whatsapp' channel by sendSlaReminder
  // and have NO OpenClaw body — see the "Not done" note in the write-up.
  sla_warning_75:     { en: 'Action needed: case approaching deadline', ar: 'إجراء مطلوب: حالة تقترب من الموعد النهائي' },
  sla_warning_urgent: { en: 'Action needed: case approaching deadline', ar: 'إجراء مطلوب: حالة تقترب من الموعد النهائي' }
};

function getNotificationTitles(template, vars) {
  const key = String(template || '').trim();
  const entry = TEMPLATE_TITLES[key];
  if (entry) {
    const titleEn = entry.en || humanizeTemplate(key);
    const titleAr = entry.ar || titleEn;
    return {
      title_en: interpolate(titleEn, vars),
      title_ar: interpolate(titleAr, vars)
    };
  }
  const fallback = humanizeTemplate(key);
  return { title_en: fallback, title_ar: fallback };
}

module.exports = { getNotificationTitles, interpolate };
