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

  'common.back_to_dashboard': 'Back to dashboard',

  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.back': 'Back',
  'common.continue': 'Continue',
  'common.view': 'View',
  'common.download': 'Download',
  'common.yes': 'Yes',
  'common.no': 'No',

  'auth.logout': 'Logout',

  'patient.dashboard.title': 'My medical cases',
  'patient.dashboard.subtitle': 'Track your second-opinion cases, status, and reports.',
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

  'common.all': 'All',
  'common.status': 'Status',
  'common.search': 'Search',
  'common.apply': 'Apply',
  'common.reset': 'Reset',
  'common.all_statuses': 'All statuses',
  'common.unpaid': 'Unpaid',

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

  'common.back_to_dashboard': 'العودة إلى لوحة التحكم',

  'common.save': 'حفظ',
  'common.cancel': 'إلغاء',
  'common.back': 'رجوع',
  'common.continue': 'متابعة',
  'common.view': 'عرض',
  'common.download': 'تحميل',
  'common.yes': 'نعم',
  'common.no': 'لا',

  'auth.logout': 'تسجيل الخروج',

  'patient.dashboard.title': 'حالاتي الطبية',
  'patient.dashboard.subtitle': 'تابع حالات طلب الرأي الطبي الثاني، الحالة والتقارير.',
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

  'common.all': 'الكل',
  'common.status': 'الحالة',
  'common.search': 'بحث',
  'common.apply': 'تطبيق',
  'common.reset': 'إعادة ضبط',
  'common.all_statuses': 'كل الحالات',
  'common.unpaid': 'غير مدفوع',

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
  const dict = lang === 'ar' ? ar : en;
  return dict[key] || en[key] || key;
}

module.exports = { t };
