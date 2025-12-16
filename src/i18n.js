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

  'doctor.dashboard.title': 'حالاتي النشطة',
  'superadmin.dashboard.title': 'لوحة المشرف العام'
};

function t(key, lang = 'en') {
  const dict = lang === 'ar' ? ar : en;
  return dict[key] || en[key] || key;
}

module.exports = { t };
