// src/notify/notification_titles.js

function humanizeTemplate(template) {
  const raw = String(template || '').trim();
  if (!raw) return 'Notification';
  const spaced = raw.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return spaced.replace(/\b\w/g, (m) => m.toUpperCase());
}

const TEMPLATE_TITLES = {
  // Required minimum set
  order_assigned_doctor: { en: 'New case assigned', ar: 'تم تعيين حالة جديدة' },
  order_reassigned_doctor: { en: 'Case reassigned', ar: 'تمت إعادة تعيين الحالة' },
  sla_reminder_doctor: { en: 'SLA reminder', ar: 'تنبيه قرب انتهاء مهلة المراجعة' },
  sla_breached_doctor: { en: 'SLA breached', ar: 'تم تجاوز مهلة المراجعة' },
  patient_reply_info: { en: 'Patient sent additional information', ar: 'المريض أرسل معلومات إضافية' },
  additional_files_requested_patient: { en: 'Additional files requested', ar: 'مطلوب ملفات إضافية' },
  patient_uploaded_files_doctor: { en: 'Patient uploaded additional files', ar: 'المريض رفع ملفات إضافية' },
  report_ready_patient: { en: 'Report ready', ar: 'التقرير جاهز' },
  smoke_test: { en: 'Smoke test', ar: 'اختبار تشغيلي' },

  // Common variants + legacy templates
  order_auto_assigned_doctor: { en: 'New case auto-assigned', ar: 'تم تعيين حالة تلقائياً' },
  order_reassigned_to_doctor: { en: 'Case reassigned to you', ar: 'تم إعادة تعيين الحالة لك' },
  order_reassigned_from_doctor: { en: 'Case reassigned from you', ar: 'تمت إعادة تعيين الحالة منك' },
  public_order_assigned_doctor: { en: 'New case assigned', ar: 'تم تعيين حالة جديدة' },
  order_status_accepted_patient: { en: 'Doctor accepted your case', ar: 'وافق الطبيب على حالتك' },
  additional_files_request_approved_patient: { en: 'Additional files requested', ar: 'مطلوب ملفات إضافية' },
  order_created_patient: { en: 'Case created', ar: 'تم إنشاء الحالة' },
  public_order_created_patient: { en: 'Case created', ar: 'تم إنشاء الحالة' },
  public_order_created_superadmin: { en: 'New public order', ar: 'طلب عام جديد' },
  order_reassigned_patient: { en: 'Case reassigned', ar: 'تمت إعادة تعيين الحالة' },
  order_breached_patient: { en: 'Case delayed', ar: 'تأخر إنجاز الحالة' },
  order_sla_pre_breach: { en: 'SLA reminder', ar: 'تنبيه قرب انتهاء مهلة المراجعة' },
  order_breached_superadmin: { en: 'SLA breached', ar: 'تم تجاوز مهلة المراجعة' },
  order_sla_pre_breach_doctor: { en: 'SLA reminder', ar: 'تنبيه قرب انتهاء مهلة المراجعة' },
  order_breached_doctor: { en: 'SLA breached', ar: 'تم تجاوز مهلة المراجعة' },
  payment_success_patient: { en: 'Payment received', ar: 'تم استلام الدفع' },
  payment_success_doctor: { en: 'Payment received', ar: 'تم استلام الدفع' },
  payment_marked_paid_patient: { en: 'Payment confirmed', ar: 'تم تأكيد الدفع' },
  payment_marked_paid: { en: 'Payment confirmed', ar: 'تم تأكيد الدفع' },
  doctor_signup_pending: { en: 'Doctor signup pending', ar: 'تسجيل طبيب قيد المراجعة' },
  doctor_approved: { en: 'Doctor approved', ar: 'تم اعتماد الطبيب' },
  doctor_rejected: { en: 'Doctor rejected', ar: 'تم رفض الطبيب' },
  prescription_uploaded_patient: { en: 'Prescription available', ar: 'الوصفة الطبية متاحة' },
  new_message: { en: 'New message', ar: 'رسالة جديدة' },
  appointment_cancelled: { en: 'Appointment cancelled', ar: 'تم إلغاء الموعد' },
  appointment_rescheduled: { en: 'Appointment rescheduled', ar: 'تم إعادة جدولة الموعد' }
};

function getNotificationTitles(template) {
  const key = String(template || '').trim();
  const entry = TEMPLATE_TITLES[key];
  if (entry) {
    const titleEn = entry.en || humanizeTemplate(key);
    const titleAr = entry.ar || titleEn;
    return { title_en: titleEn, title_ar: titleAr };
  }
  const fallback = humanizeTemplate(key);
  return { title_en: fallback, title_ar: fallback };
}

module.exports = { getNotificationTitles };
