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
  payment_marked_paid_patient: { en: 'Payment confirmed — case in motion', ar: 'تم تأكيد الدفع — تشخيصة بدأت العمل' },
  payment_marked_paid: { en: 'Payment confirmed', ar: 'تم تأكيد الدفع' },
  payment_failed_patient: { en: "Payment didn't go through — let's try again", ar: 'لم تتم عملية الدفع — لنحاول مرة أخرى' },
  doctor_signup_pending: { en: 'Doctor signup pending', ar: 'تسجيل طبيب قيد المراجعة' },
  doctor_approved: { en: 'Doctor approved', ar: 'تم اعتماد الطبيب' },
  doctor_rejected: { en: 'Doctor rejected', ar: 'تم رفض الطبيب' },
  prescription_uploaded_patient: { en: 'Prescription available', ar: 'الوصفة الطبية متاحة' },
  new_message: { en: 'New message', ar: 'رسالة جديدة' },
  appointment_booked: { en: 'Your appointment is set: {appointmentDate} at {appointmentTime}', ar: 'تم تحديد موعدك: {appointmentDate} في {appointmentTime}' },
  appointment_rescheduled: { en: 'Your appointment is set: {appointmentDate} at {appointmentTime}', ar: 'تم تحديد موعدك: {appointmentDate} في {appointmentTime}' },
  appointment_cancelled: { en: 'Appointment cancelled', ar: 'تم إلغاء الموعد' },
  welcome_patient: { en: 'Welcome to Tashkheesa, {patientName}', ar: 'مرحباً بك في تشخيصة، {patientName}' },

  // Theme 7b Phase 2 — patient-initiated refund flow.
  patient_refund_requested:           { en: 'Refund request received',          ar: 'استلمنا طلب استرداد المبلغ' },
  admin_refund_request_received:      { en: 'New refund request: {caseReference}', ar: 'طلب استرداد جديد: {caseReference}' },
  admin_refund_cancelled_by_patient:  { en: 'Refund request cancelled: {caseReference}', ar: 'تم إلغاء طلب الاسترداد: {caseReference}' }
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
