// =============================================================================
// Tashkheesa i18n catalog — Theme 10
// -----------------------------------------------------------------------------
// CANONICAL helper: tt(key, enFallback, arFallback) — defined in src/middleware.js.
// Lookup order: this catalog (active locale) → enFallback/arFallback by lang.
//
// AR TONE CONVENTION (Phase 2 fill-in):
//   * Use Egyptian dialect (عامية مصرية), casual / patient-friendly tone.
//   * NOT Modern Standard Arabic (فصحى). NOT formal/professional register.
//   * Read like an Egyptian patient would actually speak — not a contract.
//
// LEGAL SCOPE EXCLUSION:
//   * Privacy, terms, refund_policy, delivery_policy stay EN. They are out of
//     scope for machine translation and the Egyptian-dialect convention above.
//     Legal AR is handled separately under Egyptian Law No. 181/2018 review.
//
// LEGACY HELPERS (`L(en, ar)`, `_t(en, ar)`, inline `isAr ? : `):
//   * Listed as Phase 2 migration debt in
//     docs/audits/THEME_10_VIEW_INVENTORY.md. To be replaced mechanically with
//     `tt(key, enFallback, arFallback)` during the bulk-translation pass.
// =============================================================================

const en = {
  'brand.subtitle': 'Second opinions, done right',
  'brand.footer': 'All rights reserved',

  'nav.home': 'Home',
  'nav.logout': 'Logout',
  'nav.new_case': 'New case',
  'nav.alerts': 'Alerts',
  'nav.profile': 'Profile',
  'nav.dashboard.patient': 'My cases',
  'nav.dashboard.doctor': 'My queue',
  'nav.dashboard.superadmin': 'Superadmin dashboard',

  'auth.login.title': 'Sign in to Tashkheesa',
  'auth.login.subtitle': 'Access your portal securely.',
  'auth.login.tagline': 'Expert medical opinions, in writing',
  'auth.login.email': 'Email',
  'auth.login.password': 'Password',
  'auth.login.submit': 'Sign in',
  'auth.login': 'Sign in',
  'auth.login.register': 'Create account',
  'auth.login.forgot': 'Forgot password?',
  'auth.login.guest_submit': 'Submit a case as guest',

  // --- Countries (registration / pricing / display) ---
  'country.EG': 'Egypt',
  'country.AE': 'United Arab Emirates',
  'country.UK': 'United Kingdom',

  // --- Doctor UI guardrails ---
  'doctor.unpaid_notice': 'Unpaid — accept will unlock after payment.',
  'doctor.case_limit_notice': 'Case limit reached — complete cases first.',
  'doctor.report_not_available': 'Report not available yet.',

  'auth.register.title': 'Create your account',
  'auth.register': 'Create account',
  'auth.name': 'Full name',
  'auth.email': 'Email',
  'auth.password': 'Password',
  'auth.confirm_password': 'Confirm password',
  'auth.have_account': 'Already have an account?',
  'auth.no_account': "Don't have an account?",
  'auth.sign_in': 'Sign in',
  'auth.sign_up': 'Sign up',

  'auth.forgot.title': 'Forgot your password?',
  'auth.forgot.subtitle': 'Enter your email and we’ll send you a reset link.',
  'auth.forgot.send': 'Send reset link',
  'auth.back_to_login': 'Back to login',

  // --- Auth: errors / info ---
  'auth.error.required': 'Email and password are required.',
  'auth.error.invalid': 'Invalid email or password.',
  'auth.forgot.info': 'If an account exists for this email, you will receive a reset link.',
  'auth.reset.invalid_title': 'Reset link invalid or expired',
  'auth.reset.invalid_body': 'Please request a new reset link.',

  // Aliases used by some routes/templates (keep for backwards/forwards compatibility)
  'auth.errors.email_password_required': 'Email and password are required.',
  'auth.errors.invalid_credentials': 'Invalid email or password.',
  'auth.errors.account_locked': 'Your account is temporarily locked. Please try again later.',
  'auth.errors.access_denied': 'Access denied.',

  'patient.new_case.title': 'New medical case',
  'patient.new_case.subtitle': 'Start a new second-opinion request.',
  'patient.new_case.create': 'Create case',
  'patient.new_case.notes': 'Clinical notes / symptoms (optional)',
  'patient.new_case.specialty': 'Specialty',
  'patient.new_case.files': 'Files (upload later)',
  'patient.new_case.required': 'Required',

  'patient.portal': 'Patient portal',
  'patient.my_orders': 'My orders',

  'patient.new_case.page_title': 'Start a New Review',
  'patient.new_case.choose_specialty': 'Choose a specialty',
  'patient.new_case.service': 'Service',
  'patient.new_case.choose_service': 'Choose a service',
  'patient.new_case.no_services': 'No services available for this specialty',
  'patient.new_case.pricing_note': 'Pricing above is indicative; your payment link will show the exact amount.',
  'patient.new_case.sla': 'SLA',
  'patient.new_case.sla_standard': '72h (Standard)',
  'patient.new_case.sla_priority': '24h (Priority)',
  'patient.new_case.additional_notes': 'Additional notes',
  'patient.new_case.additional_notes_ph': 'Add any notes for the doctor',
  'patient.new_case.medical_history': 'Previous medical / surgical history (operations, chronic illnesses, relevant conditions)',
  'patient.new_case.medical_history_ph': 'Enter prior medical or surgical details',
  'patient.new_case.current_medications': 'Current medications (name, dose, frequency)',
  'patient.new_case.current_medications_ph': 'List medications with dose and frequency',
  'patient.new_case.initial_file_url': 'Initial file URL',
  'patient.new_case.upload_later': 'You can upload more files after submitting.',
  'patient.new_case.submit': 'Submit case',

  // --- Patient: upload additional files ---
  'patient.upload.title': 'Upload additional files',
  'patient.upload.subtitle': 'Attach any missing or updated scans/reports to this case.',
  'patient.upload.back_to_case': 'Back to case',
  'patient.upload.current_files': 'Current files',
  'patient.upload.no_files_yet': 'No files yet.',
  'patient.upload.warning_not_configured_title': 'Warning: uploads are not configured yet',
  'patient.upload.warning_not_configured_body': 'Files cannot be uploaded until UPLOADCARE_PUBLIC_KEY is set in .env and the server is restarted.',
  'patient.upload.drag_drop_hint': 'Drag & drop your file into the box below. (Click-to-select is disabled for now.) The file will upload, then be added to this case.',
  'patient.upload.compress_note': 'Note: Please compress large files, or bundle multiple images into a single ZIP before uploading to speed things up.',
  'patient.upload.drop_here': 'Drop files here',
  'patient.upload.optional_label': 'Optional label',
  'patient.upload.optional_label_ph': 'e.g., MRI image, Lab report',
  'patient.upload.add_file': 'Add file',
  'patient.upload.err_choose_file': 'Please choose a file to upload.',
  'patient.upload.toast_file_uploaded': 'File uploaded. Click "Add file" to save it.',
  'patient.upload.toast_upload_failed': 'Upload failed. Please try again.',
  'patient.upload.err_uploader_not_configured': 'Uploads are not configured yet. Please contact support.',

  'common.back_to_dashboard': 'Back to dashboard',

  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.back': 'Back',
  'common.continue': 'Continue',
  'common.view': 'View',
  'common.download': 'Download',
  'common.yes': 'Yes',
  'common.no': 'No',

  'common.all': 'All',
  'common.status': 'Status',
  'common.service': 'Service',
  'common.specialty': 'Specialty',
  'common.price': 'Price',
  'common.search': 'Search',
  'common.apply': 'Apply',
  'common.reset': 'Reset',
  'common.all_statuses': 'All statuses',
  'common.unpaid': 'Unpaid',

  'auth.logout': 'Logout',

  'patient.dashboard.title': 'My medical cases',
  'patient.dashboard.subtitle': 'Track your second-opinion cases, status, and reports.',
  'patient.dashboard.empty_title': 'No cases yet',
  'patient.dashboard.empty_body': 'Create your first case to start a specialist review.',
  'patient.status.new': 'New',
  'patient.status.accepted': 'Accepted',
  'patient.status.in_review': 'In review',
  'patient.status.completed': 'Completed',
  'patient.status.breached': 'Breached SLA',
  'patient.status.unpaid': 'Unpaid',
  'patient.status.paid': 'Paid',

  // --- Aliases / shared UI strings used by some templates ---
  'patient.my_cases': 'My cases',

  'patient.dashboard.h1': 'My medical cases',
  'patient.dashboard.create_new_case': 'Create new case',
  'patient.dashboard.empty_cta': 'Create your first case',
  'patient.dashboard.view_details': 'View details',
  'patient.dashboard.view': 'View',
  'patient.dashboard.case_id': 'Case ID',
  'patient.dashboard.default_service': 'Diagnostic review',
  'patient.dashboard.all_specialties': 'All specialties',
  'patient.dashboard.search_ph': 'Search by case ID, service, or specialty',

  // --- Patient: payment pages ---
  'patient.payment.title': 'Payment required',
  'patient.payment.body': 'This case has been created but payment has not yet been completed.',
  'patient.payment.proceed': 'Proceed to payment',
  'patient.payment.missing_link': 'Payment link is not available. Please contact support.',
  'patient.payment.back_to_dashboard': 'Back to dashboard',
  'patient.payment.helper_copy': "If the button doesn\'t open, copy and paste the link into your browser.",

  'patient.payment_required.title': 'Payment required',
  'patient.payment_required.body': 'Payment is required before a doctor can start reviewing your case.',
  'patient.payment_required.pay_now': 'Pay now',
  'patient.payment_required.back_to_cases': 'Back to my cases',
  'patient.payment_required.status_value': 'Unpaid',
  'patient.payment_required.cta_pay': 'Pay now',
  'patient.payment_required.copy_link': 'Copy payment link',
  'patient.payment_required.not_configured': 'Payment link is not available. Please contact support.',
  'patient.payment_required.link_hint': 'If the button doesn’t work, copy the link and open it in your browser.',
  'patient.payment_required.toast_link_copied': 'Payment link copied.',
  'patient.payment_required.toast_copy_failed': 'Could not copy the payment link.',

  // --- Alerts status labels ---
  'alerts.status.unread': 'Unread',
  'alerts.status.seen': 'Seen',

  // Status aliases (some templates use status.* instead of patient.status.*)
  'status.new': 'New',
  'status.accepted': 'Accepted',
  'status.submitted': 'Submitted',
  'status.assigned': 'Assigned',
  'status.in_review': 'In review',
  'status.completed': 'Completed',
  'status.sla_breach': 'SLA breach',
  'status.breached': 'Breached SLA',

  'doctor.dashboard.title': 'My active cases',
  'superadmin.dashboard.title': 'Superadmin dashboard',

  // --- Theme 7b Phase 2 — patient refund request flow ---
  'refund.cta_title': 'Need a refund?',
  'refund.cta_button': 'Request refund',
  'refund.cta_subtitle': 'You can request a refund. We\'ll review and update you within one business day.',
  'refund.form_title': 'Request a refund',
  'refund.form_subtitle': 'Tell us why and where to send the payment.',
  'refund.case_label': 'Case',
  'refund.amount_label': 'Refund amount',
  'refund.reason_label': 'Why do you need a refund?',
  'refund.reason_placeholder': 'A short explanation helps us review faster.',
  'refund.reason_hint': 'Up to 1,000 characters.',
  'refund.instapay_label': 'Instapay handle or IBAN',
  'refund.instapay_placeholder': 'e.g. 01012345678 or your bank IBAN',
  'refund.instapay_hint': 'We\'ll use this to send your refund via Instapay.',
  'refund.timeline_hint': 'Approved refunds are paid via Instapay within 3-5 business days.',
  'refund.submit_button': 'Submit refund request',
  'refund.cancel_link': 'Back to case',
  'refund.success_flash': 'Your refund request has been submitted.',
  'refund.cancel_button': 'Cancel refund request',
  'refund.cancelled_flash': 'Refund request cancelled.',
  'refund.cancel_window_hint': 'You can cancel your request within 1 hour of submitting.',
  'refund.error.reason_required': 'Please tell us why you need a refund.',
  'refund.error.instapay_required': 'Please enter your Instapay handle or IBAN.',
  'refund.error.ineligible': 'This case is not eligible for a refund request.',
  'refund.error.duplicate': 'A refund request is already pending on this case.',
  'refund.error.cancel_window_expired': 'Cancel window expired (1 hour from submission).',
  'refund.status.pending': 'Refund request pending review',
  'refund.status.auto_approved': 'Refund auto-approved — Instapay payment is being prepared',
  'refund.status.approved': 'Refund approved — Instapay payment is being prepared',
  'refund.status.paid': 'Refund paid via Instapay',
  'refund.status.denied': 'Refund request denied',

  // --- Theme 7b Phase 3 — superadmin queue ---
  'superadmin.refunds.title': 'Refund queue',
  'superadmin.refunds.subtitle': 'Patient-initiated refund requests awaiting review or payment.',
  'superadmin.refunds.section.pending': 'Pending review',
  'superadmin.refunds.section.awaiting_payment': 'Awaiting payment',
  'superadmin.refunds.section.recent': 'Recent (last 30 days)',
  'superadmin.refunds.empty': 'No refund requests right now.',
  'superadmin.refunds.col.case': 'Case',
  'superadmin.refunds.col.patient': 'Patient',
  'superadmin.refunds.col.instapay': 'Instapay',
  'superadmin.refunds.col.requested': 'Requested',
  'superadmin.refunds.col.approved': 'Approved',
  'superadmin.refunds.col.status': 'Status',
  'superadmin.refunds.col.requested_at': 'Requested',
  'superadmin.refunds.col.actions': 'Actions',
  'superadmin.refunds.action.review': 'Review',
  'superadmin.refunds.action.approve': 'Approve',
  'superadmin.refunds.action.deny': 'Deny',
  'superadmin.refunds.action.mark_paid': 'Mark paid',
  'superadmin.refunds.field.approved_amount': 'Approved amount (EGP)',
  'superadmin.refunds.field.notes': 'Notes (optional)',
  'superadmin.refunds.field.denial_reason': 'Denial reason',
  'superadmin.refunds.field.instapay_reference': 'Instapay transaction reference',
  'superadmin.refunds.flash.approved': 'Refund approved.',
  'superadmin.refunds.flash.denied': 'Refund denied.',
  'superadmin.refunds.flash.paid': 'Refund marked as paid.',
  'superadmin.refunds.flash.error': 'Action failed. Please try again.'
};

const ar = {
  'brand.subtitle': 'رأي طبي تاني… بالطريقة الصح',
  'brand.footer': 'جميع الحقوق محفوظة',

  'nav.home': 'الرئيسية',
  'nav.logout': 'تسجيل الخروج',
  'nav.new_case': 'حالة جديدة',
  'nav.alerts': 'التنبيهات',
  'nav.profile': 'الملف الشخصي',
  'nav.dashboard.patient': 'حالاتي الطبية',
  'nav.dashboard.doctor': 'قائمة الحالات',
  'nav.dashboard.superadmin': 'لوحة التحكم الرئيسية',

  'auth.login.title': 'تسجيل الدخول لتشخيصة',
  'auth.login.subtitle': 'ادخل حسابك بأمان.',
  'auth.login.tagline': 'آراء طبية من متخصصين، مكتوبة',
  'auth.login.email': 'البريد الإلكتروني',
  'auth.login.password': 'كلمة المرور',
  'auth.login.submit': 'تسجيل الدخول',
  'auth.login': 'تسجيل الدخول',
  'auth.login.register': 'اعمل حساب',
  'auth.login.forgot': 'نسيت كلمة المرور؟',
  'auth.login.guest_submit': 'ابعت حالة كضيف',

  // --- Countries (registration / pricing / display) ---
  'country.EG': 'مصر',
  'country.AE': 'الإمارات العربية المتحدة',
  'country.UK': 'المملكة المتحدة',

  // --- Doctor UI guardrails ---
  'doctor.unpaid_notice': 'غير مدفوع — سيتم تفعيل القبول بعد الدفع.',
  'doctor.case_limit_notice': 'تم الوصول لحد الحالات — أكمل حالات أولاً.',
  'doctor.report_not_available': 'التقرير غير متاح بعد.',

  'auth.register.title': 'إنشاء حساب جديد',
  'auth.register': 'إنشاء حساب',
  'auth.name': 'الاسم الكامل',
  'auth.email': 'البريد الإلكتروني',
  'auth.password': 'كلمة المرور',
  'auth.confirm_password': 'تأكيد كلمة المرور',
  'auth.have_account': 'لديك حساب بالفعل؟',
  'auth.no_account': 'ليس لديك حساب؟',
  'auth.sign_in': 'تسجيل الدخول',
  'auth.sign_up': 'إنشاء حساب',

  'auth.forgot.title': 'نسيت كلمة المرور؟',
  'auth.forgot.subtitle': 'دخّل بريدك الإلكتروني وهنبعتلك رابط إعادة التعيين.',
  'auth.forgot.send': 'ابعت رابط إعادة التعيين',
  'auth.back_to_login': 'ارجع لتسجيل الدخول',

  // --- Auth: errors / info ---
  'auth.error.required': 'البريد الإلكتروني وكلمة المرور مطلوبين.',
  'auth.error.invalid': 'البريد الإلكتروني أو كلمة المرور غلط.',
  'auth.forgot.info': 'لو في حساب بالبريد ده، هيوصلك رابط إعادة التعيين.',
  'auth.reset.invalid_title': 'رابط إعادة التعيين مش صالح أو انتهت مدته',
  'auth.reset.invalid_body': 'اطلب رابط جديد لإعادة تعيين كلمة المرور لو سمحت.',

  // Aliases used by some routes/templates (keep for backwards/forwards compatibility)
  'auth.errors.email_password_required': 'البريد الإلكتروني وكلمة المرور مطلوبين.',
  'auth.errors.invalid_credentials': 'البريد الإلكتروني أو كلمة المرور غلط.',
  'auth.errors.account_locked': 'حسابك متقفل مؤقتاً. حاول تاني بعد شوية.',
  'auth.errors.access_denied': 'مش مصرح بالدخول.',

  'patient.new_case.title': 'حالة طبية جديدة',
  'patient.new_case.subtitle': 'ابدأ طلب رأي طبي ثانٍ جديد.',
  'patient.new_case.create': 'إنشاء الحالة',
  'patient.new_case.notes': 'ملاحظات سريرية / الأعراض (اختياري)',
  'patient.new_case.specialty': 'التخصص',
  'patient.new_case.files': 'الملفات (يمكن الرفع لاحقاً)',
  'patient.new_case.required': 'مطلوب',

  'patient.portal': 'بوابة المريض',
  'patient.my_orders': 'طلباتي',

  'patient.new_case.page_title': 'بدء مراجعة جديدة',
  'patient.new_case.choose_specialty': 'اختر التخصص',
  'patient.new_case.service': 'الخدمة',
  'patient.new_case.choose_service': 'اختر الخدمة',
  'patient.new_case.no_services': 'لا توجد خدمات لهذا التخصص',
  'patient.new_case.pricing_note': 'الأسعار أعلاه استرشادية؛ رابط الدفع سيظهر المبلغ النهائي.',
  'patient.new_case.sla': 'زمن الاستجابة',
  'patient.new_case.sla_standard': '72 ساعة (عادي)',
  'patient.new_case.sla_priority': '24 ساعة (أولوية)',
  'patient.new_case.additional_notes': 'ملاحظات إضافية',
  'patient.new_case.additional_notes_ph': 'أضف أي ملاحظات للطبيب',
  'patient.new_case.medical_history': 'التاريخ المرضي / الجراحي السابق (العمليات، الأمراض المزمنة، الحالات ذات الصلة)',
  'patient.new_case.medical_history_ph': 'أدخل التفاصيل الطبية أو الجراحية السابقة',
  'patient.new_case.current_medications': 'الأدوية الحالية (الاسم، الجرعة، عدد المرات)',
  'patient.new_case.current_medications_ph': 'أدخل أسماء الأدوية والجرعات وتكرار الاستخدام',
  'patient.new_case.initial_file_url': 'رابط الملف الأولي',
  'patient.new_case.upload_later': 'يمكنك رفع المزيد من الملفات بعد الإرسال.',
  'patient.new_case.submit': 'إرسال الحالة',

  // --- Patient: upload additional files ---
  'patient.upload.title': 'رفع ملفات إضافية',
  'patient.upload.subtitle': 'أرفق أي ملفات ناقصة أو محدثة (صور/تقارير) لهذه الحالة.',
  'patient.upload.back_to_case': 'العودة إلى الحالة',
  'patient.upload.current_files': 'الملفات الحالية',
  'patient.upload.no_files_yet': 'لا توجد ملفات بعد.',
  'patient.upload.warning_not_configured_title': 'تنبيه: رفع الملفات غير مُفعّل بعد',
  'patient.upload.warning_not_configured_body': 'لا يمكن رفع الملفات حتى يتم إضافة UPLOADCARE_PUBLIC_KEY في ملف .env ثم إعادة تشغيل السيرفر.',
  'patient.upload.drag_drop_hint': 'اسحب وأفلت الملف داخل المربع بالأسفل. (الاختيار بالنقر مُعطّل حالياً.) سيتم رفع الملف ثم إضافته لهذه الحالة.',
  'patient.upload.compress_note': 'ملاحظة: يُفضل ضغط الملفات الكبيرة أو تجميع عدة صور في ملف ZIP واحد قبل الرفع لتسريع العملية.',
  'patient.upload.drop_here': 'أسقط الملفات هنا',
  'patient.upload.optional_label': 'وصف اختياري',
  'patient.upload.optional_label_ph': 'مثال: صورة MRI، تقرير تحاليل',
  'patient.upload.add_file': 'إضافة الملف',
  'patient.upload.err_choose_file': 'من فضلك اختر ملفاً لرفعه.',
  'patient.upload.toast_file_uploaded': 'تم رفع الملف. اضغط "إضافة الملف" لحفظه.',
  'patient.upload.toast_upload_failed': 'فشل رفع الملف. حاول مرة أخرى.',
  'patient.upload.err_uploader_not_configured': 'رفع الملفات غير مُفعّل بعد. يرجى التواصل مع الدعم.',

  'common.back_to_dashboard': 'العودة إلى لوحة التحكم',

  'common.save': 'حفظ',
  'common.cancel': 'إلغاء',
  'common.back': 'رجوع',
  'common.continue': 'متابعة',
  'common.view': 'عرض',
  'common.download': 'تحميل',
  'common.yes': 'نعم',
  'common.no': 'لا',

  'common.all': 'الكل',
  'common.status': 'الحالة',
  'common.service': 'الخدمة',
  'common.specialty': 'التخصص',
  'common.price': 'السعر',
  'common.search': 'بحث',
  'common.apply': 'تطبيق',
  'common.reset': 'إعادة ضبط',
  'common.all_statuses': 'كل الحالات',
  'common.unpaid': 'غير مدفوع',

  'auth.logout': 'تسجيل الخروج',

  'patient.dashboard.title': 'حالاتي الطبية',
  'patient.dashboard.subtitle': 'تابع حالات طلب الرأي الطبي الثاني، الحالة والتقارير.',
  'patient.dashboard.empty_title': 'لا توجد حالات حتى الآن',
  'patient.dashboard.empty_body': 'أنشئ أول حالة لبدء مراجعة اختصاصي.',
  'patient.status.new': 'جديد',
  'patient.status.accepted': 'مقبول',
  'patient.status.in_review': 'قيد المراجعة',
  'patient.status.completed': 'مكتمل',
  'patient.status.breached': 'تجاوز مدة الخدمة',
  'patient.status.unpaid': 'غير مدفوع',
  'patient.status.paid': 'مدفوع',

  // --- Aliases / shared UI strings used by some templates ---
  'patient.my_cases': 'حالاتي الطبية',

  'patient.dashboard.h1': 'حالاتي الطبية',
  'patient.dashboard.create_new_case': 'إنشاء حالة جديدة',
  'patient.dashboard.empty_cta': 'أنشئ أول حالة',
  'patient.dashboard.view_details': 'عرض التفاصيل',
  'patient.dashboard.view': 'عرض',
  'patient.dashboard.case_id': 'رقم الحالة',
  'patient.dashboard.default_service': 'مراجعة تشخيصية',
  'patient.dashboard.all_specialties': 'كل التخصصات',
  'patient.dashboard.search_ph': 'ابحث برقم الحالة أو الخدمة أو التخصص',

  // --- Patient: payment pages ---
  'patient.payment.title': 'الدفع مطلوب',
  'patient.payment.body': 'تم إنشاء هذه الحالة ولكن لم يتم إتمام الدفع بعد.',
  'patient.payment.proceed': 'إكمال الدفع',
  'patient.payment.missing_link': 'رابط الدفع غير متاح حالياً. يرجى التواصل مع الدعم.',
  'patient.payment.back_to_dashboard': 'العودة إلى لوحة التحكم',
  'patient.payment.helper_copy': 'إذا لم يفتح الرابط، انسخه والصقه في المتصفح.',

  'patient.payment_required.title': 'الدفع مطلوب',
  'patient.payment_required.body': 'يجب إتمام الدفع قبل أن يبدأ الطبيب مراجعة حالتك.',
  'patient.payment_required.pay_now': 'ادفع الآن',
  'patient.payment_required.back_to_cases': 'العودة إلى حالاتي',
  'patient.payment_required.status_value': 'غير مدفوع',
  'patient.payment_required.cta_pay': 'ادفع الآن',
  'patient.payment_required.copy_link': 'نسخ رابط الدفع',
  'patient.payment_required.not_configured': 'رابط الدفع غير متاح حالياً. يرجى التواصل مع الدعم.',
  'patient.payment_required.link_hint': 'إذا لم يعمل الزر، انسخ الرابط وافتحه في المتصفح.',
  'patient.payment_required.toast_link_copied': 'تم نسخ رابط الدفع.',
  'patient.payment_required.toast_copy_failed': 'تعذر نسخ رابط الدفع.',

  // --- Alerts status labels ---
  'alerts.status.unread': 'غير مقروء',
  'alerts.status.seen': 'تمت المشاهدة',

  // Status aliases (some templates use status.* instead of patient.status.*)
  'status.new': 'جديد',
  'status.accepted': 'مقبول',
  'status.submitted': 'تم الإرسال',
  'status.assigned': 'تم التعيين',
  'status.in_review': 'قيد المراجعة',
  'status.completed': 'مكتمل',
  'status.sla_breach': 'تجاوز مدة الخدمة',
  'status.breached': 'تجاوز مدة الخدمة',

  'doctor.dashboard.title': 'حالاتي النشطة',
  'superadmin.dashboard.title': 'لوحة المشرف العام',

  // --- Theme 7b Phase 2 — طلب استرداد المبلغ (Egyptian dialect) ---
  'refund.cta_title': 'محتاج استرداد فلوسك؟',
  'refund.cta_button': 'اطلب استرداد المبلغ',
  'refund.cta_subtitle': 'تقدر تطلب استرداد فلوسك. هنراجع طلبك ونرد عليك خلال يوم عمل واحد.',
  'refund.form_title': 'طلب استرداد المبلغ',
  'refund.form_subtitle': 'قول لنا السبب وهنبعت فين الفلوس.',
  'refund.case_label': 'الحالة',
  'refund.amount_label': 'المبلغ المطلوب استرداده',
  'refund.reason_label': 'ليه محتاج استرداد المبلغ؟',
  'refund.reason_placeholder': 'شرح بسيط هيساعدنا نراجع أسرع.',
  'refund.reason_hint': 'حد أقصى 1000 حرف.',
  'refund.instapay_label': 'حساب الإنستاباي أو الـ IBAN',
  'refund.instapay_placeholder': 'مثلاً 01012345678 أو رقم الـ IBAN بتاعك',
  'refund.instapay_hint': 'هنستخدمه عشان نبعتلك الفلوس عبر الإنستاباي.',
  'refund.timeline_hint': 'الطلبات اللي بتتقبل بنحول الفلوس عبر الإنستاباي خلال 3-5 أيام عمل.',
  'refund.submit_button': 'إرسال طلب الاسترداد',
  'refund.cancel_link': 'الرجوع للحالة',
  'refund.success_flash': 'تم إرسال طلب الاسترداد.',
  'refund.cancel_button': 'إلغاء طلب الاسترداد',
  'refund.cancelled_flash': 'تم إلغاء طلب الاسترداد.',
  'refund.cancel_window_hint': 'تقدر تلغي طلبك خلال ساعة من إرساله.',
  'refund.error.reason_required': 'قول لنا السبب من فضلك.',
  'refund.error.instapay_required': 'اكتب حساب الإنستاباي أو رقم الـ IBAN من فضلك.',
  'refund.error.ineligible': 'الحالة دي مش مؤهلة لاسترداد المبلغ.',
  'refund.error.duplicate': 'في طلب استرداد قيد المراجعة على الحالة دي.',
  'refund.error.cancel_window_expired': 'انتهى وقت الإلغاء (ساعة واحدة من وقت الإرسال).',
  'refund.status.pending': 'طلب الاسترداد قيد المراجعة',
  'refund.status.auto_approved': 'تم اعتماد الاسترداد — جارِ تجهيز التحويل عبر الإنستاباي',
  'refund.status.approved': 'تم اعتماد الاسترداد — جارِ تجهيز التحويل عبر الإنستاباي',
  'refund.status.paid': 'تم تحويل المبلغ عبر الإنستاباي',
  'refund.status.denied': 'تم رفض طلب الاسترداد',

  // --- Theme 7b Phase 3 — superadmin queue (Egyptian dialect) ---
  'superadmin.refunds.title': 'قائمة طلبات الاسترداد',
  'superadmin.refunds.subtitle': 'طلبات استرداد المبلغ من المرضى — تحت المراجعة أو في انتظار التحويل.',
  'superadmin.refunds.section.pending': 'تحت المراجعة',
  'superadmin.refunds.section.awaiting_payment': 'في انتظار التحويل',
  'superadmin.refunds.section.recent': 'الأحدث (آخر 30 يوم)',
  'superadmin.refunds.empty': 'مفيش طلبات استرداد دلوقتي.',
  'superadmin.refunds.col.case': 'الحالة',
  'superadmin.refunds.col.patient': 'المريض',
  'superadmin.refunds.col.instapay': 'الإنستاباي',
  'superadmin.refunds.col.requested': 'المطلوب',
  'superadmin.refunds.col.approved': 'المعتمد',
  'superadmin.refunds.col.status': 'الحالة',
  'superadmin.refunds.col.requested_at': 'وقت الطلب',
  'superadmin.refunds.col.actions': 'الإجراءات',
  'superadmin.refunds.action.review': 'مراجعة',
  'superadmin.refunds.action.approve': 'اعتماد',
  'superadmin.refunds.action.deny': 'رفض',
  'superadmin.refunds.action.mark_paid': 'تحويل تم',
  'superadmin.refunds.field.approved_amount': 'المبلغ المعتمد (جنيه)',
  'superadmin.refunds.field.notes': 'ملاحظات (اختياري)',
  'superadmin.refunds.field.denial_reason': 'سبب الرفض',
  'superadmin.refunds.field.instapay_reference': 'رقم تحويل الإنستاباي',
  'superadmin.refunds.flash.approved': 'تم اعتماد الاسترداد.',
  'superadmin.refunds.flash.denied': 'تم رفض الاسترداد.',
  'superadmin.refunds.flash.paid': 'تم تأكيد تحويل المبلغ.',
  'superadmin.refunds.flash.error': 'الإجراء ما تمش. حاول تاني.'
};

function t(key, lang = 'en') {
  const safeKey = (typeof key === 'string' && key.trim()) ? key.trim() : '';
  const safeLang = (lang === 'ar') ? 'ar' : 'en';
  const dict = safeLang === 'ar' ? ar : en;
  if (!safeKey) return '';
  return (dict[safeKey] || en[safeKey] || safeKey);
}

module.exports = { t, en, ar };
