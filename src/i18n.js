const en = {
  'nav.home': 'Home',
  'nav.logout': 'Logout',
  'nav.dashboard.patient': 'My cases',
  'nav.dashboard.doctor': 'My queue',
  'nav.dashboard.superadmin': 'Superadmin dashboard',

  'auth.login.title': 'Sign in to Tashkheesa',
  'auth.login.email': 'Email',
  'auth.login.password': 'Password',
  'auth.login.submit': 'Sign in',
  'auth.login': 'Sign in',

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
  'patient.dashboard.view_details': 'View details',
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
  'status.in_review': 'In review',
  'status.completed': 'Completed',
  'status.breached': 'Breached SLA',

  'doctor.dashboard.title': 'My active cases',
  'superadmin.dashboard.title': 'Superadmin dashboard'
};

const ar = {
  'nav.home': 'الرئيسية',
  'nav.logout': 'تسجيل الخروج',
  'nav.dashboard.patient': 'حالاتي الطبية',
  'nav.dashboard.doctor': 'قائمة الحالات',
  'nav.dashboard.superadmin': 'لوحة التحكم الرئيسية',

  'auth.login.title': 'تسجيل الدخول إلى تشخيصه',
  'auth.login.email': 'البريد الإلكتروني',
  'auth.login.password': 'كلمة المرور',
  'auth.login.submit': 'تسجيل الدخول',
  'auth.login': 'تسجيل الدخول',

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
  'auth.forgot.subtitle': 'أدخل بريدك الإلكتروني وسنرسل لك رابط إعادة التعيين.',
  'auth.forgot.send': 'إرسال رابط إعادة التعيين',
  'auth.back_to_login': 'العودة لتسجيل الدخول',

  // --- Auth: errors / info ---
  'auth.error.required': 'البريد الإلكتروني وكلمة المرور مطلوبان.',
  'auth.error.invalid': 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
  'auth.forgot.info': 'إذا كان هناك حساب بهذا البريد الإلكتروني، سيتم إرسال رابط إعادة التعيين.',
  'auth.reset.invalid_title': 'رابط إعادة التعيين غير صالح أو منتهي',
  'auth.reset.invalid_body': 'يرجى طلب رابط جديد لإعادة تعيين كلمة المرور.',

  // Aliases used by some routes/templates (keep for backwards/forwards compatibility)
  'auth.errors.email_password_required': 'البريد الإلكتروني وكلمة المرور مطلوبان.',
  'auth.errors.invalid_credentials': 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
  'auth.errors.account_locked': 'تم قفل حسابك مؤقتاً. يرجى المحاولة لاحقاً.',
  'auth.errors.access_denied': 'غير مصرح بالدخول.',

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
  'patient.new_case.sla_standard': '٧٢ ساعة (عادي)',
  'patient.new_case.sla_priority': '٢٤ ساعة (أولوية)',
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
  'patient.dashboard.view_details': 'عرض التفاصيل',
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
  'status.in_review': 'قيد المراجعة',
  'status.completed': 'مكتمل',
  'status.breached': 'تجاوز مدة الخدمة',

  'doctor.dashboard.title': 'حالاتي النشطة',
  'superadmin.dashboard.title': 'لوحة المشرف العام'
};

function t(key, lang = 'en') {
  const safeKey = (typeof key === 'string' && key.trim()) ? key.trim() : '';
  const safeLang = (lang === 'ar') ? 'ar' : 'en';
  const dict = safeLang === 'ar' ? ar : en;
  if (!safeKey) return '';
  return (dict[safeKey] || en[safeKey] || safeKey);
}

module.exports = { t, en, ar };
