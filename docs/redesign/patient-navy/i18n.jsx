// i18n.jsx — bilingual dictionary (EN + Egyptian Arabic), specialties, sample data.
// Product/checkout Arabic = colloquial Egyptian. Legal surfaces = formal.
// Western Arabic numerals (0–9) kept everywhere for clinical clarity.

const DICT = {
  // ---- generic ----
  brand:            { en: "Tashkheesa", ar: "تشخيصة" },
  backed_by:        { en: "Backed by Shifa Hospital Group", ar: "مدعومة من مجموعة مستشفيات شفاء" },
  shifa:            { en: "Shifa Hospital Group", ar: "مجموعة مستشفيات شفاء" },
  next:             { en: "Next", ar: "التالي" },
  back:             { en: "Back", ar: "رجوع" },
  continue:         { en: "Continue", ar: "كمّل" },
  skip:             { en: "Skip", ar: "تخطّي" },
  done:             { en: "Done", ar: "تمام" },
  cancel:           { en: "Cancel", ar: "إلغاء" },
  confirm:          { en: "Confirm", ar: "أكّد" },
  save:             { en: "Save", ar: "حفظ" },
  edit:             { en: "Edit", ar: "تعديل" },
  close:            { en: "Close", ar: "إغلاق" },
  get_started:      { en: "Get started", ar: "يلا نبدأ" },
  see_all:          { en: "See all", ar: "عرض الكل" },
  optional:         { en: "Optional", ar: "اختياري" },
  required:         { en: "Required", ar: "مطلوب" },

  // ---- onboarding ----
  ob1_title:    { en: "A second opinion you can trust", ar: "رأي تاني تقدر تطمّن له" },
  ob1_body:     { en: "Upload your scans, labs and reports. A vetted Shifa specialist reviews them and writes you a clear opinion.", ar: "ارفع أشعتك وتحاليلك وتقاريرك، واستشاري معتمد من شفاء يراجعها ويكتبلك رأي واضح." },
  ob2_title:    { en: "Written, signed, in both languages", ar: "مكتوب، موقّع، وباللغتين" },
  ob2_body:     { en: "You receive a formal document — the doctor's name, credentials and opinion — in Arabic and English. Yours to keep.", ar: "هتستلم مستند رسمي فيه اسم الدكتور ومؤهلاته ورأيه، بالعربي والإنجليزي، يبقى ملكك." },
  ob3_title:    { en: "On a clear deadline", ar: "في ميعاد واضح" },
  ob3_body:     { en: "Standard opinions arrive in 48–72h. Need it sooner? Choose the urgent tier. Miss the window — your money comes back.", ar: "الرأي العادي بيوصل خلال 48–72 ساعة. مستعجل؟ اختار الباقة العاجلة. ولو فات الميعاد، فلوسك ترجعلك." },
  ob4_title:    { en: "Not a chat. A real opinion.", ar: "مش شات. ده رأي حقيقي." },
  ob4_body:     { en: "This isn't live telehealth. It's a considered, asynchronous opinion from a consultant who studied your full file.", ar: "ده مش كشف أونلاين مباشر. ده رأي مدروس من استشاري ذاكر ملفك كله بهدوء." },

  // ---- auth ----
  auth_welcome:   { en: "Welcome to Tashkheesa", ar: "أهلاً بيك في تشخيصة" },
  auth_sub:       { en: "Sign in to start or track a case.", ar: "سجّل دخولك عشان تبدأ حالة أو تتابعها." },
  tab_phone:      { en: "Phone", ar: "موبايل" },
  tab_email:      { en: "Email", ar: "إيميل" },
  phone_label:    { en: "Mobile number", ar: "رقم الموبايل" },
  email_label:    { en: "Email address", ar: "البريد الإلكتروني" },
  pass_label:     { en: "Password", ar: "كلمة السر" },
  send_code:      { en: "Send code", ar: "ابعت الكود" },
  sign_in:        { en: "Sign in", ar: "تسجيل الدخول" },
  or:             { en: "or", ar: "أو" },
  continue_apple: { en: "Continue with Apple", ar: "كمّل بحساب Apple" },
  continue_google:{ en: "Continue with Google", ar: "كمّل بحساب Google" },
  terms_note:     { en: "By continuing you agree to our Terms and Privacy Policy.", ar: "بكمّلك إنت موافق على الشروط وسياسة الخصوصية." },

  // ---- otp ----
  otp_title:   { en: "Enter the code", ar: "اكتب الكود" },
  otp_sub:     { en: "We sent a 6-digit code to", ar: "بعتنا كود من 6 أرقام على" },
  otp_resend:  { en: "Resend code", ar: "إعادة إرسال الكود" },
  otp_in:      { en: "Resend in", ar: "إعادة الإرسال بعد" },
  otp_verify:  { en: "Verify", ar: "تأكيد" },
  otp_autofill:{ en: "From Messages: 4 8 2 9 0 6", ar: "من الرسائل: 4 8 2 9 0 6" },

  // ---- tabs ----
  tab_home:    { en: "Home", ar: "الرئيسية" },
  tab_cases:   { en: "Cases", ar: "حالاتي" },
  tab_new:     { en: "New case", ar: "حالة جديدة" },
  tab_alerts:  { en: "Alerts", ar: "التنبيهات" },
  tab_account: { en: "Account", ar: "حسابي" },

  // ---- home / dashboard ----
  greeting:        { en: "Hello, Mariam", ar: "أهلاً يا مريم" },
  home_q:          { en: "How can we help today?", ar: "نقدر نساعدك بإيه النهاردة؟" },
  start_new_case:  { en: "Start a new case", ar: "ابدأ حالة جديدة" },
  start_new_sub:   { en: "Upload files, pick a specialty, get an opinion", ar: "ارفع ملفاتك، اختار التخصص، واستلم رأي" },
  active_cases:    { en: "Active cases", ar: "الحالات الجارية" },
  no_active:       { en: "No active cases", ar: "مفيش حالات جارية" },
  no_active_sub:   { en: "When you start a case it'll show up here with a live countdown.", ar: "أول ما تبدأ حالة هتلاقيها هنا مع عدّاد للوقت." },
  recent_reports:  { en: "Your reports", ar: "تقاريرك" },
  for_who:         { en: "For", ar: "لـ" },
  trust_strip:     { en: "Every opinion is written and signed by a consultant vetted by Shifa Hospital Group.", ar: "كل رأي مكتوب وموقّع من استشاري معتمد من مجموعة مستشفيات شفاء." },

  // ---- case status ----
  st_submitted:  { en: "Submitted", ar: "اتبعتت" },
  st_assigned:   { en: "Assigned", ar: "اتخصصت لدكتور" },
  st_in_review:  { en: "In review", ar: "تحت المراجعة" },
  st_ready:      { en: "Report ready", ar: "التقرير جاهز" },
  st_breached:   { en: "Delayed", ar: "اتأخرت" },
  st_followup:   { en: "Follow-up open", ar: "سؤال متابعة" },
  status:        { en: "Status", ar: "الحالة" },
  due_in:        { en: "Report due in", ar: "التقرير خلال" },
  due_passed:    { en: "Overdue by", ar: "متأخر بـ" },
  assigned_to:   { en: "Reviewing specialist", ar: "الاستشاري المراجع" },
  case_id:       { en: "Case", ar: "حالة" },
  view_report:   { en: "View report", ar: "اعرض التقرير" },
  track_case:    { en: "Track case", ar: "تابع الحالة" },
  open_case:     { en: "Open case", ar: "افتح الحالة" },
  timeline:      { en: "Timeline", ar: "المسار" },
  files_n:       { en: "files", ar: "ملفات" },

  // ---- wizard ----
  wiz_specialty: { en: "Specialty", ar: "التخصص" },
  wiz_files:     { en: "Files", ar: "الملفات" },
  wiz_who:       { en: "Patient", ar: "المريض" },
  wiz_urgency:   { en: "Urgency", ar: "السرعة" },
  wiz_review:    { en: "Review", ar: "مراجعة" },
  wiz_pay:       { en: "Payment", ar: "الدفع" },
  pick_specialty:{ en: "Which specialty?", ar: "أنهي تخصص؟" },
  pick_specialty_sub:{ en: "Choose the area your case is about. Not sure? Upload first and we'll suggest one.", ar: "اختار المجال بتاع حالتك. مش متأكد؟ ارفع الملفات الأول وإحنا نقترحلك." },
  ai_suggested:  { en: "Suggested from your files", ar: "مقترح من ملفاتك" },
  ai_why:        { en: "Why this", ar: "ليه ده" },
  ai_reason:     { en: "Your upload “chest_CT_axial.dcm” looks like a thoracic CT — usually read by Radiology.", ar: "الملف اللي رفعته «chest_CT_axial.dcm» شكله أشعة مقطعية على الصدر — غالباً بتتقرى أشعة." },
  use_suggestion:{ en: "Use this", ar: "استخدم ده" },
  upload_title:  { en: "Add your medical files", ar: "ضيف ملفاتك الطبية" },
  upload_sub:    { en: "Scans, lab reports, prescriptions, doctor's notes. The more complete, the better the opinion.", ar: "أشعة، تحاليل، روشتات، تقارير دكاترة. كل ما تكمّل، الرأي يطلع أدق." },
  add_files:     { en: "Add files", ar: "ضيف ملفات" },
  from_profile:  { en: "Add from medical profile", ar: "ضيف من ملفك الطبي" },
  uploading:     { en: "Uploading", ar: "بيترفع" },
  uploaded:      { en: "Uploaded", ar: "اترفع" },
  remove:        { en: "Remove", ar: "شيل" },
  describe_label:{ en: "What would you like the specialist to focus on?", ar: "عايز الاستشاري يركّز على إيه؟" },
  describe_ph:   { en: "e.g. My doctor suspects a nodule. Is surgery really needed?", ar: "مثلاً: الدكتور شاكك في ورم صغير. هل العملية ضرورية فعلاً؟" },
  who_title:     { en: "Who is this case for?", ar: "الحالة دي لمين؟" },
  who_me:        { en: "Myself", ar: "ليا أنا" },
  add_dependent: { en: "Add a family member", ar: "ضيف فرد من العيلة" },
  urgency_title: { en: "How soon do you need it?", ar: "محتاجها بسرعة قد إيه؟" },
  tier_standard: { en: "Standard", ar: "عادي" },
  tier_standard_w:{ en: "48–72 hours", ar: "48–72 ساعة" },
  tier_urgent:   { en: "Urgent", ar: "عاجل" },
  tier_urgent_w: { en: "Within 24 hours", ar: "خلال 24 ساعة" },
  tier_urgent_tag:{ en: "Priority queue", ar: "أولوية في الدور" },
  review_title:  { en: "Review your case", ar: "راجع حالتك" },
  est_delivery:  { en: "Estimated delivery", ar: "موعد الاستلام المتوقع" },
  refund_promise:{ en: "If we miss the deadline, you're refunded in full — automatically.", ar: "لو فات الميعاد، فلوسك بترجع كاملة — أوتوماتيك." },
  pay_title:     { en: "Payment", ar: "الدفع" },
  pay_card:      { en: "Card", ar: "كارت" },
  pay_wallet:    { en: "Mobile wallet", ar: "محفظة الموبايل" },
  pay_fawry:     { en: "Fawry", ar: "فوري" },
  pay_total:     { en: "Total", ar: "الإجمالي" },
  pay_now:       { en: "Pay", ar: "ادفع" },
  pay_secure:    { en: "Encrypted. You're only charged once a specialist accepts.", ar: "مشفّر. مش هنخصم غير لما استشاري يقبل الحالة." },
  submitted_title:{ en: "Case submitted", ar: "الحالة اتبعتت" },
  submitted_sub: { en: "We're matching you with the right specialist. You'll get a notification the moment your case is accepted.", ar: "بندوّر على الاستشاري المناسب. هيوصلك إشعار أول ما الحالة تتقبل." },
  go_dashboard:  { en: "Go to my cases", ar: "روح لحالاتي" },

  // ---- report (green/gold) ----
  report_kicker:  { en: "Specialist second opinion", ar: "رأي طبي ثانٍ" },
  report_for:     { en: "Prepared for", ar: "مُعدّ لـ" },
  report_by:      { en: "Reviewing consultant", ar: "الاستشاري المراجع" },
  report_date:    { en: "Issued", ar: "تاريخ الإصدار" },
  report_summary: { en: "Summary opinion", ar: "خلاصة الرأي" },
  report_findings:{ en: "Findings", ar: "النتائج" },
  report_reco:    { en: "Recommendation", ar: "التوصية" },
  report_signed:  { en: "Electronically signed", ar: "موقّع إلكترونياً" },
  report_lang_en: { en: "English", ar: "إنجليزي" },
  report_lang_ar: { en: "العربية", ar: "العربية" },
  download_pdf:   { en: "Download PDF", ar: "حمّل PDF" },
  share_report:   { en: "Share", ar: "مشاركة" },
  ask_followup:   { en: "Ask one follow-up", ar: "اسأل سؤال متابعة" },
  reg_no:         { en: "Medical syndicate reg.", ar: "قيد نقابة الأطباء" },

  // ---- SLA breach / refund ----
  breach_title:  { en: "We missed your deadline", ar: "إحنا فوّتنا الميعاد" },
  breach_body:   { en: "Your standard opinion didn't arrive within 72 hours. That's on us. Your full payment has been refunded, and your case is now being prioritised at no charge.", ar: "رأيك العادي معدّاش في خلال 72 ساعة. ده تقصير مننا. فلوسك رجعت كاملة، والحالة بقت لها أولوية من غير أي رسوم." },
  refund_status: { en: "Refund", ar: "الاسترداد" },
  refund_done:   { en: "Refunded to your card", ar: "اترجعت على الكارت" },
  refund_eta:    { en: "Back in your account within 5–7 business days.", ar: "هتلاقيها في حسابك خلال 5–7 أيام عمل." },
  keep_waiting:  { en: "Keep my case (free)", ar: "كمّل حالتي (مجاناً)" },
  contact_support:{ en: "Contact support", ar: "كلّم الدعم" },

  // ---- follow-up ----
  followup_title:{ en: "One follow-up question", ar: "سؤال متابعة واحد" },
  followup_sub:  { en: "You can ask Dr. Hossam one clarifying question about this opinion, free, within 7 days. Same specialist answers.", ar: "تقدر تسأل د. حسام سؤال توضيحي واحد عن الرأي ده، مجاناً، خلال 7 أيام. نفس الاستشاري هو اللي يرد." },
  followup_ph:   { en: "e.g. Does your recommendation change if the MRI is clear?", ar: "مثلاً: توصيتك بتتغير لو الرنين طلع سليم؟" },
  followup_left: { en: "follow-up remaining", ar: "سؤال متابعة متبقّي" },
  send_question: { en: "Send question", ar: "ابعت السؤال" },
  followup_sent: { en: "Sent to Dr. Hossam", ar: "اتبعت لـ د. حسام" },

  // ---- notifications ----
  alerts_title:  { en: "Alerts", ar: "التنبيهات" },
  mark_read:     { en: "Mark all read", ar: "علّم الكل مقروء" },
  no_alerts:     { en: "You're all caught up", ar: "مفيش حاجة جديدة" },
  no_alerts_sub: { en: "Case updates and report alerts will appear here.", ar: "تحديثات الحالات وتنبيهات التقارير هتظهر هنا." },

  // ---- account / profile / family ----
  account_title:    { en: "Account", ar: "حسابي" },
  medical_profile:  { en: "Medical profile", ar: "الملف الطبي" },
  medical_profile_sub:{ en: "Saved history & files — so you don't re-upload", ar: "تاريخك وملفاتك محفوظة — عشان متعيدش الرفع" },
  family_profiles:  { en: "Family profiles", ar: "ملفات العيلة" },
  family_sub:       { en: "Manage cases for parents, spouse, children", ar: "اعمل حالات للأهل والزوج والأولاد" },
  payment_methods:  { en: "Payment methods", ar: "طرق الدفع" },
  language_pref:    { en: "Language", ar: "اللغة" },
  help_center:      { en: "Help & contact", ar: "المساعدة والتواصل" },
  how_it_works:     { en: "How it works", ar: "بيشتغل إزاي" },
  our_partnership:  { en: "Our partnership with Shifa", ar: "شراكتنا مع شفاء" },
  refund_policy:    { en: "Refund policy", ar: "سياسة الاسترداد" },
  privacy:          { en: "Privacy & data", ar: "الخصوصية والبيانات" },
  sign_out:         { en: "Sign out", ar: "تسجيل الخروج" },
  add_member:       { en: "Add family member", ar: "ضيف فرد" },
  relationship:     { en: "Relationship", ar: "صلة القرابة" },
  blood_type:       { en: "Blood type", ar: "فصيلة الدم" },
  allergies:        { en: "Allergies", ar: "الحساسية" },
  chronic:          { en: "Chronic conditions", ar: "أمراض مزمنة" },
  saved_files:      { en: "Saved files", ar: "الملفات المحفوظة" },

  // ---- how it works steps ----
  hiw1_t: { en: "Upload your file", ar: "ارفع ملفك" },
  hiw1_b: { en: "Scans, labs, prescriptions, notes. Encrypted end-to-end.", ar: "أشعة، تحاليل، روشتات، تقارير — مشفّرة بالكامل." },
  hiw2_t: { en: "We match a specialist", ar: "بنختارلك استشاري" },
  hiw2_b: { en: "A consultant in the right specialty, vetted by Shifa.", ar: "استشاري في التخصص المناسب، معتمد من شفاء." },
  hiw3_t: { en: "They review and write", ar: "بيراجع ويكتب" },
  hiw3_b: { en: "A considered, written opinion — not a rushed chat.", ar: "رأي مكتوب ومدروس — مش رد سريع." },
  hiw4_t: { en: "You get a signed report", ar: "تستلم تقرير موقّع" },
  hiw4_b: { en: "Bilingual, formal, downloadable. Within your SLA.", ar: "باللغتين، رسمي، وتقدر تحمّله — في ميعاده." },

  // ---- partnership ----
  partner_body:  { en: "Tashkheesa is built and backed by Shifa Hospital Group, operating from its Tagamoa and Sherouk branches. Every specialist on the platform is credentialed through Shifa's medical board.", ar: "تشخيصة مبنية ومدعومة من مجموعة مستشفيات شفاء، وبتشتغل من فرعي التجمّع والشروق. كل استشاري على المنصة معتمد من المجلس الطبي لشفاء." },
  branch_tagamoa:{ en: "Shifa — Tagamoa branch", ar: "شفاء — فرع التجمّع" },
  branch_sherouk:{ en: "Shifa — Sherouk branch", ar: "شفاء — فرع الشروق" },

  // ---- common medical/value ----
  encrypted:     { en: "Encrypted in transit and at rest", ar: "مشفّر أثناء النقل والتخزين" },
};

// ---- specialty inventory (real medical platform ordering) ----
const SPECIALTIES = [
  { id:"radiology",    en:"Radiology",        ar:"الأشعة",          icon:"scan-line",   blurb_en:"Scans: CT, MRI, X-ray, ultrasound", blurb_ar:"الأشعة: مقطعية، رنين، عادية، موجات", lead:true },
  { id:"cardiology",   en:"Cardiology",       ar:"القلب",           icon:"heart-pulse", blurb_en:"Heart, ECG, echo, rhythm",          blurb_ar:"القلب، رسم القلب، الإيكو",          lead:true },
  { id:"oncology",     en:"Oncology",         ar:"الأورام",         icon:"ribbon",      blurb_en:"Tumours, biopsy & pathology",       blurb_ar:"الأورام، العيّنات والباثولوجي",     lead:true },
  { id:"pediatrics",   en:"Pediatrics",       ar:"الأطفال",         icon:"baby",        blurb_en:"Children's health",                 blurb_ar:"صحة الأطفال" },
  { id:"neurology",    en:"Neurology",        ar:"المخ والأعصاب",   icon:"brain",       blurb_en:"Brain, nerves, EEG/EMG",            blurb_ar:"المخ، الأعصاب، رسم المخ" },
  { id:"gastro",       en:"Gastroenterology", ar:"الجهاز الهضمي",   icon:"pill",        blurb_en:"Digestive system, liver",           blurb_ar:"الجهاز الهضمي والكبد" },
  { id:"dermatology",  en:"Dermatology",      ar:"الجلدية",         icon:"scan-face",   blurb_en:"Skin, hair, nails",                 blurb_ar:"الجلد والشعر والأظافر" },
  { id:"orthopedics",  en:"Orthopedics",      ar:"العظام",          icon:"bone",        blurb_en:"Bones, joints, spine",              blurb_ar:"العظام والمفاصل والعمود الفقري" },
  { id:"obgyn",        en:"OB/GYN",           ar:"النساء والتوليد",  icon:"venus",       blurb_en:"Women's health, pregnancy",         blurb_ar:"صحة المرأة والحمل" },
];

const PRICING = { standard: 1200, urgent: 2400, currency_en: "EGP", currency_ar: "ج.م" };

// ---- sample data ----
const SAMPLE_DOCTOR = {
  name_en: "Dr. Hossam El-Deeb", name_ar: "د. حسام الديب",
  title_en: "Consultant Radiologist", title_ar: "استشاري الأشعة التشخيصية",
  cred_en: "MD, FRCR — 18 yrs", cred_ar: "دكتوراه، زمالة الكلية الملكية — 18 سنة",
  reg: "EMS-114203",
};

const SAMPLE_CASES = [
  {
    id: "TK-4821", specialty: "radiology", patient_en: "Mariam (you)", patient_ar: "مريم (إنتي)",
    status: "in_review", tier: "standard", filesN: 3, dueHrs: 18.4, createdAr: "النهاردة", createdEn: "Today",
    doctor: SAMPLE_DOCTOR,
  },
  {
    id: "TK-4799", specialty: "cardiology", patient_en: "Father — Samir", patient_ar: "بابا — سمير",
    status: "assigned", tier: "urgent", filesN: 5, dueHrs: 7.1, createdAr: "إمبارح", createdEn: "Yesterday",
    doctor: { name_en:"Dr. Laila Mansour", name_ar:"د. ليلى منصور", title_en:"Consultant Cardiologist", title_ar:"استشاري القلب", cred_en:"MD, FESC — 15 yrs", cred_ar:"دكتوراه، زمالة أوروبية — 15 سنة", reg:"EMS-098712" },
  },
];

const COMPLETED_CASE = {
  id: "TK-4610", specialty: "radiology", patient_en: "Mariam (you)", patient_ar: "مريم (إنتي)",
  status: "ready", tier: "standard", filesN: 4, createdEn: "3 days ago", createdAr: "من 3 أيام",
  doctor: SAMPLE_DOCTOR, followupLeft: 1,
};

const BREACHED_CASE = {
  id: "TK-4502", specialty: "neurology", patient_en: "Mother — Nadia", patient_ar: "ماما — نادية",
  status: "breached", tier: "standard", filesN: 2, overdueHrs: 4.2,
};

const NOTIFS = [
  { id:1, type:"ready",    icon:"file-check-2",  en:"Your report is ready", ar:"تقريرك جاهز", subEn:"Dr. Hossam completed case TK-4610", subAr:"د. حسام خلّص حالة TK-4610", ageEn:"2h", ageAr:"2س", unread:true, accent:"success" },
  { id:2, type:"assigned", icon:"user-check",    en:"A specialist accepted your case", ar:"استشاري قبل حالتك", subEn:"Dr. Hossam is reviewing TK-4821", subAr:"د. حسام بيراجع TK-4821", ageEn:"5h", ageAr:"5س", unread:true, accent:"teal" },
  { id:3, type:"sla",      icon:"clock-alert",   en:"18h left on case TK-4821", ar:"فاضل 18 ساعة على TK-4821", subEn:"Standard opinion — on track", subAr:"رأي عادي — في الميعاد", ageEn:"6h", ageAr:"6س", unread:false, accent:"warn" },
  { id:4, type:"refund",   icon:"banknote",      en:"Refund processed — EGP 1,200", ar:"تم الاسترداد — 1200 ج.م", subEn:"Case TK-4502 exceeded its window", subAr:"حالة TK-4502 عدّت ميعادها", ageEn:"1d", ageAr:"1ي", unread:false, accent:"success" },
];

Object.assign(window, {
  DICT, SPECIALTIES, PRICING, SAMPLE_DOCTOR, SAMPLE_CASES, COMPLETED_CASE, BREACHED_CASE, NOTIFS,
});
