-- 102_service_names_arabic.sql
--
-- Every service name rendered in ENGLISH on the Arabic site, because
-- services.name_ar did not exist. specialties already had name_ar and
-- description_ar; services never did, so an Arabic-speaking patient browsing
-- /services in Arabic read Arabic chrome wrapped around 183 English medical
-- terms. On an Egypt-first, Arabic-first platform that is the single biggest
-- gap left in the public site.
--
-- Two changes here:
--
--   1. One English fix first. "Pediatric Blood Count & Anaemia Review" was the
--      only British spelling left in a service name, sitting next to
--      "Anemia Workup Review" and "CBC & Anemia Panel Review". Migration 100's
--      guard did not catch it because its pattern list had haemat/gynae/tumour
--      but not anaemia. Renamed before the translations run, so the map below
--      keys on the corrected name and re-running is still a no-op.
--
--   2. name_ar added and populated for all 183 rows (180 distinct names — three
--      names appear under two specialties each, e.g. "Bone Marrow Biopsy Review"
--      in both Hematology and Oncology, and take the same Arabic).
--
-- Translation notes, since these are clinical terms a patient has to recognise:
--   * Egyptian usage over textbook MSA where they differ — سونار not
--     تصوير بالموجات فوق الصوتية, إيكو not مخطط صدى القلب. This is how an
--     Egyptian patient's own doctor says it and how it reads on their report.
--   * Latin abbreviations that Egyptian labs and radiology reports print
--     untranslated stay untranslated — MRCP, PET-CT, OCT, PSA, HSG, DEXA, PSG,
--     V/Q, FNA, ANCA, ASMA, Anti-DNA, RECIST. Translating them would make the
--     name LESS recognisable than the paper the patient is holding.
--   * Every UPDATE is keyed on the exact English name and only fills a blank,
--     so an admin edit made before this deploys is never clobbered and the
--     migration is idempotent.

BEGIN;

-- ─── 1. The last British spelling in a service name. ────────────────
UPDATE services
   SET name = 'Pediatric Blood Count & Anemia Review'
 WHERE name = 'Pediatric Blood Count & Anaemia Review';

-- ─── 2. The column. ────────────────────────────────────────────────
ALTER TABLE services ADD COLUMN IF NOT EXISTS name_ar TEXT;

-- ─── 3. The names. ─────────────────────────────────────────────────
UPDATE services SET name_ar = 'تفسير رسم القلب (12 وصلة)' WHERE name = '12-Lead ECG Interpretation' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة قياس الكالسيوم بشرايين القلب' WHERE name = 'Calcium Score Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الرنين المغناطيسي على القلب' WHERE name = 'Cardiac MR Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الأشعة المقطعية على شرايين القلب' WHERE name = 'CT Coronary Angiography Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الإيكو (الموجات الصوتية على القلب)' WHERE name = 'Echocardiogram Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة جهاز تسجيل نبضات القلب' WHERE name = 'Event Monitor Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة جهاز هولتر (24–72 ساعة)' WHERE name = 'Holter Monitor (24-72h) Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'التصريح القلبي قبل الجراحة' WHERE name = 'Pre-Op Cardiac Clearance' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'تحليل شريط نظم القلب' WHERE name = 'Rhythm Strip Analysis' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة إيكو المجهود' WHERE name = 'Stress Echo Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة اختبار المجهود على السير المتحرك' WHERE name = 'Stress Treadmill Test Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'استشارة جراحة القلب والصدر' WHERE name = 'Cardiothoracic Surgery Consultation' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'استشارة التغذية العلاجية' WHERE name = 'Clinical Nutrition Consultation' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تحاليل أمراض المناعة الذاتية الجلدية' WHERE name = 'Autoimmune Skin Panel Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الجروح المزمنة' WHERE name = 'Chronic Wound Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الصور الإكلينيكية' WHERE name = 'Clinical Photo Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة فحص الجلد بالديرموسكوب' WHERE name = 'Dermoscopy Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة فحوصات تساقط الشعر' WHERE name = 'Hair Loss Workup Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة اختبار الحساسية اللاصق' WHERE name = 'Patch Test Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة خطة علاج الصدفية' WHERE name = 'Psoriasis Management Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تقرير عينة الجلد' WHERE name = 'Skin Biopsy Report Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'استشارة طب الطوارئ' WHERE name = 'Emergency Medicine Consultation' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة فحوصات الغدة الكظرية' WHERE name = 'Adrenal Workup Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة خطة علاج السكري' WHERE name = 'Diabetes Management Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تحاليل الغدة الدرقية الكاملة' WHERE name = 'Full Thyroid Panel Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تحاليل هرمون النمو' WHERE name = 'Growth Hormone Panel Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'إدارة اضطرابات الدهون' WHERE name = 'Lipid Disorder Management' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة السمنة والاضطرابات الأيضية' WHERE name = 'Obesity/Metabolic Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة فحوصات هشاشة العظام' WHERE name = 'Osteoporosis Workup Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تحاليل تكيس المبايض' WHERE name = 'PCOS Panel Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الرنين المغناطيسي على الغدة النخامية' WHERE name = 'Pituitary MRI Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة سونار الغدة الدرقية' WHERE name = 'Thyroid Ultrasound Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة منظار الكبسولة' WHERE name = 'Capsule Endoscopy Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تقرير منظار القولون' WHERE name = 'Colonoscopy Report Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تقرير المنظار' WHERE name = 'Endoscopy Report Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الفيبروسكان وقياس مرونة الكبد' WHERE name = 'FibroScan/Elastography Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تحاليل الالتهاب الكبدي B وC' WHERE name = 'Hepatitis B/C Panel Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة فحوصات التهاب الأمعاء المزمن' WHERE name = 'IBD Investigation Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تقرير عينة الكبد' WHERE name = 'Liver Biopsy Report Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الرنين المغناطيسي على الكبد' WHERE name = 'Liver MRI Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة سونار الكبد' WHERE name = 'Liver Ultrasound Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة رنين القنوات المرارية (MRCP)' WHERE name = 'MRCP Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة فحوصات فقر الدم' WHERE name = 'Anemia Workup Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة عينة نخاع العظم' WHERE name = 'Bone Marrow Biopsy Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تحاليل تجلط الدم' WHERE name = 'Coagulation Panel Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة فحص الفلو سيتومتري' WHERE name = 'Flow Cytometry Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة صورة الدم الكاملة بالتفريق' WHERE name = 'Full CBC with Differential Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الجلوبيولينات المناعية والفصل الكهربي للبروتين' WHERE name = 'Immunoglobulins/SPEP Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تحديد مرحلة الليمفوما' WHERE name = 'Lymphoma Staging Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الأنيميا المنجلية والثلاسيميا' WHERE name = 'Sickle Cell/Thalassemia Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تحاليل الميل للتجلط' WHERE name = 'Thrombophilia Panel Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة صورة الدم وتحاليل فقر الدم' WHERE name = 'CBC & Anemia Panel Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة خطة علاج الأمراض المزمنة' WHERE name = 'Chronic Disease Management Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة حالة باطنة عامة' WHERE name = 'General Internal Medicine Case Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الأدوية وتعدد الوصفات' WHERE name = 'Medication & Polypharmacy Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة خطة ما بعد الخروج من المستشفى' WHERE name = 'Post-Hospital Discharge Plan Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة التصريح الطبي قبل الجراحة' WHERE name = 'Pre-operative Medical Clearance Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مناعة ذاتية — ANCA' WHERE name = 'Autoimmune - ANCA' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مناعة ذاتية — Anti-DNA' WHERE name = 'Autoimmune - Anti-DNA' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مناعة ذاتية — ASMA' WHERE name = 'Autoimmune - ASMA' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تحاليل المناعة الذاتية' WHERE name = 'Autoimmune Panel Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'تحليل سوائل الجسم' WHERE name = 'Body Fluids Analysis' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة سحب نخاع العظم' WHERE name = 'Bone Marrow Aspirate Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تحاليل التجلط والأملاح' WHERE name = 'Coagulation & Electrolytes Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'علم الخلايا (سيتولوجي)' WHERE name = 'Cytology' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'السحب بالإبرة الدقيقة (FNA)' WHERE name = 'Fine Needle Aspiration (FNA)' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'الفحوصات الجينية والجزيئية' WHERE name = 'Genetic/Molecular Testing' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'الباثولوجي — عينة كبيرة' WHERE name = 'Histopathology - Large Biopsy' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'الباثولوجي — عضو أو استئصال' WHERE name = 'Histopathology - Organ/Resection' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'الباثولوجي — عينة صغيرة' WHERE name = 'Histopathology - Small Biopsy' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تحاليل الهرمونات' WHERE name = 'Hormone Panel Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'ميكروبيولوجي — مزرعة البلغم وحساسيتها' WHERE name = 'Microbiology - Sputum C&S' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة المزارع الميكروبية' WHERE name = 'Microbiology Cultures Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مسحة عنق الرحم' WHERE name = 'Pap Smear' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تحاليل الدم الروتينية' WHERE name = 'Routine Bloods Panel Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'اختبار الحساسية للمضادات الحيوية' WHERE name = 'Sensitivity Testing' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة دلالات الأورام' WHERE name = 'Tumor Markers Panel Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تحاليل البول والبراز' WHERE name = 'Urine & Stool Workup Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة مراحل وعلاج الفشل الكلوي المزمن' WHERE name = 'CKD Staging & Management Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة كفاءة الغسيل الكلوي' WHERE name = 'Dialysis Adequacy Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة فحوصات ارتفاع ضغط الدم' WHERE name = 'Hypertension Workup Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تقرير عينة الكلى' WHERE name = 'Kidney Biopsy Report Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تحاليل وظائف الكلى' WHERE name = 'Kidney Function Panel Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الأشعة المقطعية على حصوات الكلى' WHERE name = 'Kidney Stone CT Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة سونار الكلى' WHERE name = 'Kidney Ultrasound Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة فحوصات الزلال في البول' WHERE name = 'Proteinuria Workup Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الأشعة المقطعية على المخ' WHERE name = 'Brain CT Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الرنين المغناطيسي على المخ' WHERE name = 'Brain MRI Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'تفسير رسم المخ' WHERE name = 'EEG Interpretation' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة رسم العصب والعضلات' WHERE name = 'EMG/NCS Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة أشعة الصرع' WHERE name = 'Epilepsy Imaging Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الأشعة المقطعية على شرايين المخ' WHERE name = 'Neuro CTA Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الرنين المغناطيسي على شرايين المخ' WHERE name = 'Neuro MRA Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الرنين المغناطيسي على العمود الفقري' WHERE name = 'Neuro Spine MRI Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة أوعية المخ الدموية' WHERE name = 'Neurovascular Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة أشعة تروية المخ' WHERE name = 'Perfusion Imaging Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة أشعة السكتة الدماغية' WHERE name = 'Stroke Imaging Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تحاليل الخصوبة' WHERE name = 'Fertility Panel Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة إيكو قلب الجنين' WHERE name = 'Fetal Echocardiography Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة علاج الأورام الليفية' WHERE name = 'Fibroid Management Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة سونار أمراض النساء' WHERE name = 'Gynecological Ultrasound Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تقرير أشعة الصبغة على الرحم (HSG)' WHERE name = 'HSG Report Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الرنين المغناطيسي على الحوض' WHERE name = 'MRI Pelvis Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة سونار الحمل' WHERE name = 'Obstetric Ultrasound Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تقرير مسحة عنق الرحم' WHERE name = 'Pap Smear Report Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تحاليل ما قبل الولادة' WHERE name = 'Prenatal Labs Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تحديد مرحلة الورم بالمقطعية أو الرنين' WHERE name = 'CT/MRI Staging Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تقرير السيتولوجي' WHERE name = 'Cytology Report Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تحاليل أورام الدم' WHERE name = 'Hemato-Oncology Blood Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تقرير الباثولوجي' WHERE name = 'Histopathology Report Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة أشعة PET-CT' WHERE name = 'PET-CT Imaging Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'تقييم الاستجابة بمعايير RECIST' WHERE name = 'RECIST Response Assessment' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة أشعة تخطيط العلاج الإشعاعي' WHERE name = 'RT Planning Scan Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة دلالات الأورام' WHERE name = 'Tumor Markers Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة اعتلال الشبكية السكري' WHERE name = 'Diabetic Retinopathy Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة أشعة الصبغة على الشبكية' WHERE name = 'Fluorescein Angiography Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تصوير قاع العين' WHERE name = 'Fundus Photography Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة فحوصات المياه الزرقاء' WHERE name = 'Glaucoma Workup Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الرنين المغناطيسي على محجر العين' WHERE name = 'MRI Orbit Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة فحص OCT للشبكية' WHERE name = 'OCT Scan Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'رأي جراحي قبل العملية' WHERE name = 'Pre-Op Surgical Opinion' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تصوير الشبكية' WHERE name = 'Retinal Imaging Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة اختبار مجال الإبصار' WHERE name = 'Visual Field Test Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة قياس كثافة العظام (DEXA)' WHERE name = 'Bone Density (DEXA) Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الأشعة المقطعية' WHERE name = 'CT Scan Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة علاج الكسور' WHERE name = 'Fracture Management Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الرنين المغناطيسي على مفصل الورك' WHERE name = 'Hip MRI Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الرنين المغناطيسي على الركبة' WHERE name = 'Knee MRI Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الرنين المغناطيسي للعظام' WHERE name = 'Orthopedic MRI Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة ما بعد العملية' WHERE name = 'Post-Operative Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'رأي ما قبل العملية' WHERE name = 'Pre-Operative Opinion' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الرنين المغناطيسي على الكتف' WHERE name = 'Shoulder MRI Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة أشعة العمود الفقري' WHERE name = 'Spine Imaging Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الأشعة السينية' WHERE name = 'X-Ray Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة خطة السيطرة على الربو عند الأطفال' WHERE name = 'Childhood Asthma Control Plan Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة زواج الأقارب واحتمال تكرار المرض' WHERE name = 'Consanguinity & Recurrence Risk Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة سجلات مراحل النمو' WHERE name = 'Developmental Milestones Records Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة حالة أطفال عامة' WHERE name = 'General Pediatric Case Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تقرير التحليل الجيني' WHERE name = 'Genetic Test Report Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة أمراض التمثيل الغذائي الوراثية' WHERE name = 'Inherited Metabolic Disorder Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة نتيجة مسح حديثي الولادة' WHERE name = 'Newborn Screening Result Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تقرير الحضانة وملخص الخروج' WHERE name = 'NICU Stay & Discharge Summary Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة حساسية وإكزيما الأطفال' WHERE name = 'Pediatric Allergy & Eczema Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة صورة الدم وفقر الدم عند الأطفال' WHERE name = 'Pediatric Blood Count & Anemia Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تغذية الأطفال' WHERE name = 'Pediatric Feeding & Nutrition Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة منحنى النمو وسجل التطعيمات' WHERE name = 'Pediatric Growth Chart & Vaccination Record Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'رأي ثانٍ قبل جراحة الأطفال' WHERE name = 'Pediatric Pre-Surgical Second Opinion' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة العدوى المتكررة واستخدام المضادات الحيوية' WHERE name = 'Recurrent Infections & Antibiotic Use Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة سجلات الحمى المتكررة أو المطولة' WHERE name = 'Recurrent or Prolonged Fever Records Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'استشارة الطب النفسي' WHERE name = 'Psychiatry Consultation' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تقرير منظار الشعب الهوائية' WHERE name = 'Bronchoscopy Report Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة أشعة الصدر السينية' WHERE name = 'Chest X-Ray Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الأشعة المقطعية على الصدر' WHERE name = 'CT Chest Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الأشعة المقطعية عالية الدقة على الصدر' WHERE name = 'HRCT Chest Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الرئة بعد كوفيد' WHERE name = 'Post-COVID Lung Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة اختبار وظائف الرئة' WHERE name = 'Pulmonary Function Test Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة دراسة النوم (PSG)' WHERE name = 'Sleep Study (PSG) Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة فحوصات الدرن' WHERE name = 'TB Workup Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة مسح التهوية والتروية (V/Q)' WHERE name = 'V/Q Scan Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة المقطعية أو الرنين على البطن والحوض' WHERE name = 'Abdomen/Pelvis CT/MRI Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الأشعة المقطعية على القلب' WHERE name = 'Cardiac CT Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الرنين المغناطيسي على القلب' WHERE name = 'Cardiac MRI Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة أشعة الأوعية الدموية (مقطعية أو رنين)' WHERE name = 'CT/MR Angiography Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الرنين المغناطيسي' WHERE name = 'MRI Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة أشعة العظام والعضلات' WHERE name = 'Musculoskeletal Imaging Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة أشعة المخ والأعصاب' WHERE name = 'Neuro Imaging Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'تحديد مرحلة الورم بأشعة PET-CT' WHERE name = 'Oncology PET-CT Staging' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الرنين المغناطيسي على العمود الفقري' WHERE name = 'Spine MRI Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة السونار' WHERE name = 'Ultrasound Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'استشارة أمراض الروماتيزم والمفاصل' WHERE name = 'Rheumatology Consultation' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة سونار المثانة' WHERE name = 'Bladder Ultrasound Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تقرير منظار المثانة' WHERE name = 'Cystoscopy Report Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الأشعة المقطعية على الكلى والحالب' WHERE name = 'Kidney/Ureter CT Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة الرنين المغناطيسي على البروستاتا' WHERE name = 'MRI Prostate Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة فحوصات البروستاتا' WHERE name = 'Prostate Workup Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة تحليل PSA وفحوصات البروستاتا' WHERE name = 'PSA & Prostate Panel Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة علاج حصوات الكلى' WHERE name = 'Renal Stone Management Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة سونار كيس الصفن' WHERE name = 'Scrotal Ultrasound Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'مراجعة دراسة ديناميكية المسالك البولية' WHERE name = 'Urodynamics Study Review' AND COALESCE(BTRIM(name_ar), '') = '';
UPDATE services SET name_ar = 'استشارة جراحة الأوعية الدموية' WHERE name = 'Vascular Surgery Consultation' AND COALESCE(BTRIM(name_ar), '') = '';

-- ─── Post-condition guard. ─────────────────────────────────────────
-- WARNS, never EXCEPTS: migrations run on boot, and a copy fix must not be
-- able to boot-loop the app. A straggler is a service added after this file
-- was written — the site falls back to the English name for it, which is the
-- behaviour we had before, not a break.
DO $$
DECLARE
  untranslated INT;
  british INT;
BEGIN
  SELECT COUNT(*) INTO untranslated
    FROM services WHERE COALESCE(BTRIM(name_ar), '') = '';
  IF untranslated > 0 THEN
    RAISE WARNING 'Migration 102: % service(s) still have no name_ar — they will render their English name on the Arabic site', untranslated;
  END IF;

  SELECT COUNT(*) INTO british
    FROM services
   WHERE name ~* '(anaemia|gynae|paediat|orthopaed|anaesth|haemat|tumour|oesoph|foetal)';
  IF british > 0 THEN
    RAISE WARNING 'Migration 102: % service name(s) still carry British spellings', british;
  END IF;
END $$;

COMMIT;
