/* =========================================================================
   public/js/profile-autocomplete-data.js
   Hand-curated typeahead lookups for the doctor profile page chipsets +
   board-cert repeater. Sets a single global on window so the inline
   nonce'd <script> in portal_doctor_profile.ejs can pick them up.

   Format:
     window.__PROFILE_AUTOCOMPLETE_DATA__ = {
       LANGUAGES:            [ { code, en, ar }, ... ],            // ~26 entries
       BOARD_CERTIFICATIONS: [ { en, ar, country }, ... ],         // ~50 entries
       SUB_SPECIALTIES:      { "<specialty name>": [ "...", ... ]  // 16 keys
     }

   Specialty keys match the `name` column of the `specialties` table
   (Cardiology / Dermatology / ... / Urology). 16 keys total — pulled
   from the DB on 2026-04-28. The form's <select name="specialty_id">
   sends the row id; the autocomplete script reads the option's *text*
   to look up the right sub-specialty list.

   ISO 639-1 language codes; Egyptian Board / FRCR / ABR / EFR / MRCP
   et al. for board certifications. Everything is hand-curated — small
   enough to ship inline, easy to edit later when product wants to swap
   in a DB-backed lookup.
   ========================================================================= */
(function() {
  'use strict';

  var LANGUAGES = [
    { code: 'ar',  en: 'Arabic',                ar: 'العربية' },
    { code: 'en',  en: 'English',               ar: 'الإنجليزية' },
    { code: 'fr',  en: 'French',                ar: 'الفرنسية' },
    { code: 'es',  en: 'Spanish',               ar: 'الإسبانية' },
    { code: 'de',  en: 'German',                ar: 'الألمانية' },
    { code: 'it',  en: 'Italian',               ar: 'الإيطالية' },
    { code: 'pt',  en: 'Portuguese',            ar: 'البرتغالية' },
    { code: 'ru',  en: 'Russian',               ar: 'الروسية' },
    { code: 'tr',  en: 'Turkish',               ar: 'التركية' },
    { code: 'fa',  en: 'Persian (Farsi)',       ar: 'الفارسية' },
    { code: 'ur',  en: 'Urdu',                  ar: 'الأردية' },
    { code: 'hi',  en: 'Hindi',                 ar: 'الهندية' },
    { code: 'bn',  en: 'Bengali',               ar: 'البنغالية' },
    { code: 'zh',  en: 'Mandarin Chinese',      ar: 'الصينية' },
    { code: 'ja',  en: 'Japanese',              ar: 'اليابانية' },
    { code: 'ko',  en: 'Korean',                ar: 'الكورية' },
    { code: 'he',  en: 'Hebrew',                ar: 'العبرية' },
    { code: 'el',  en: 'Greek',                 ar: 'اليونانية' },
    { code: 'nl',  en: 'Dutch',                 ar: 'الهولندية' },
    { code: 'sv',  en: 'Swedish',               ar: 'السويدية' },
    { code: 'no',  en: 'Norwegian',             ar: 'النرويجية' },
    { code: 'da',  en: 'Danish',                ar: 'الدنماركية' },
    { code: 'pl',  en: 'Polish',                ar: 'البولندية' },
    { code: 'cs',  en: 'Czech',                 ar: 'التشيكية' },
    { code: 'ro',  en: 'Romanian',              ar: 'الرومانية' },
    { code: 'hu',  en: 'Hungarian',             ar: 'المجرية' }
  ];

  var BOARD_CERTIFICATIONS = [
    // Egyptian Board (16 entries — matches the 16 specialties in the platform)
    { en: 'Egyptian Board of Cardiology',         ar: 'المجلس المصري لطب القلب',          country: 'Egypt' },
    { en: 'Egyptian Board of Dermatology',        ar: 'المجلس المصري للأمراض الجلدية',    country: 'Egypt' },
    { en: 'Egyptian Board of Endocrinology',      ar: 'المجلس المصري للغدد الصماء',       country: 'Egypt' },
    { en: 'Egyptian Board of ENT',                ar: 'المجلس المصري للأنف والأذن والحنجرة', country: 'Egypt' },
    { en: 'Egyptian Board of Gastroenterology',   ar: 'المجلس المصري للجهاز الهضمي',      country: 'Egypt' },
    { en: 'Egyptian Board of General Surgery',    ar: 'المجلس المصري للجراحة العامة',     country: 'Egypt' },
    { en: 'Egyptian Board of Internal Medicine',  ar: 'المجلس المصري للباطنة العامة',     country: 'Egypt' },
    { en: 'Egyptian Board of Pathology',          ar: 'المجلس المصري للباثولوجيا',        country: 'Egypt' },
    { en: 'Egyptian Board of Neurology',          ar: 'المجلس المصري لطب الأعصاب',        country: 'Egypt' },
    { en: 'Egyptian Board of Oncology',           ar: 'المجلس المصري للأورام',            country: 'Egypt' },
    { en: 'Egyptian Board of Ophthalmology',      ar: 'المجلس المصري لطب العيون',         country: 'Egypt' },
    { en: 'Egyptian Board of Orthopedics',        ar: 'المجلس المصري لجراحة العظام',      country: 'Egypt' },
    { en: 'Egyptian Board of Pediatrics',         ar: 'المجلس المصري لطب الأطفال',        country: 'Egypt' },
    { en: 'Egyptian Board of Pulmonology',        ar: 'المجلس المصري لأمراض الصدر',       country: 'Egypt' },
    { en: 'Egyptian Board of Radiology',          ar: 'المجلس المصري للأشعة',             country: 'Egypt' },
    { en: 'Egyptian Board of Urology',            ar: 'المجلس المصري لجراحة المسالك البولية', country: 'Egypt' },

    // UK Royal Colleges
    { en: 'FRCR — Fellow, Royal College of Radiologists',                ar: 'زمالة الكلية الملكية للأشعة',         country: 'UK' },
    { en: 'FRCS — Fellow, Royal College of Surgeons',                    ar: 'زمالة الكلية الملكية للجراحين',        country: 'UK' },
    { en: 'FRCP — Fellow, Royal College of Physicians',                  ar: 'زمالة الكلية الملكية للأطباء',         country: 'UK' },
    { en: 'MRCP — Member, Royal College of Physicians',                  ar: 'عضوية الكلية الملكية للأطباء',         country: 'UK' },
    { en: 'MRCS — Member, Royal College of Surgeons',                    ar: 'عضوية الكلية الملكية للجراحين',        country: 'UK' },
    { en: 'MRCOG — Member, Royal College of Obstetricians & Gynaecologists', ar: 'عضوية الكلية الملكية لطب النساء والتوليد', country: 'UK' },
    { en: 'MRCPCH — Member, Royal College of Paediatrics & Child Health',ar: 'عضوية الكلية الملكية لطب الأطفال',     country: 'UK' },
    { en: 'MRCPsych — Member, Royal College of Psychiatrists',           ar: 'عضوية الكلية الملكية للطب النفسي',     country: 'UK' },

    // American Boards (ABMS)
    { en: 'ABR — American Board of Radiology',              ar: 'المجلس الأمريكي للأشعة',            country: 'USA' },
    { en: 'ABIM — American Board of Internal Medicine',     ar: 'المجلس الأمريكي للباطنة',           country: 'USA' },
    { en: 'ABS — American Board of Surgery',                ar: 'المجلس الأمريكي للجراحة',           country: 'USA' },
    { en: 'ABP — American Board of Pediatrics',             ar: 'المجلس الأمريكي لطب الأطفال',       country: 'USA' },
    { en: 'ABPN — American Board of Psychiatry & Neurology',ar: 'المجلس الأمريكي للطب النفسي والأعصاب', country: 'USA' },
    { en: 'ABFM — American Board of Family Medicine',       ar: 'المجلس الأمريكي لطب الأسرة',         country: 'USA' },
    { en: 'ABO — American Board of Ophthalmology',          ar: 'المجلس الأمريكي لطب العيون',         country: 'USA' },
    { en: 'ABOS — American Board of Orthopaedic Surgery',   ar: 'المجلس الأمريكي لجراحة العظام',      country: 'USA' },
    { en: 'ABU — American Board of Urology',                ar: 'المجلس الأمريكي للمسالك البولية',    country: 'USA' },
    { en: 'ABA — American Board of Anesthesiology',         ar: 'المجلس الأمريكي للتخدير',            country: 'USA' },
    { en: 'ABD — American Board of Dermatology',            ar: 'المجلس الأمريكي للأمراض الجلدية',    country: 'USA' },
    { en: 'ABEM — American Board of Emergency Medicine',    ar: 'المجلس الأمريكي لطب الطوارئ',        country: 'USA' },
    { en: 'ABOG — American Board of Obstetrics & Gynecology', ar: 'المجلس الأمريكي للنساء والتوليد',  country: 'USA' },

    // European
    { en: 'EBR — European Board of Radiology',              ar: 'المجلس الأوروبي للأشعة',            country: 'EU' },
    { en: 'ESC Fellow — European Society of Cardiology',    ar: 'زمالة الجمعية الأوروبية للقلب',     country: 'EU' },
    { en: 'EBNS — European Board of Neurosurgery',          ar: 'المجلس الأوروبي لجراحة الأعصاب',   country: 'EU' },
    { en: 'EDIC — European Diploma in Intensive Care',      ar: 'الدبلومة الأوروبية للعناية المركزة',country: 'EU' },
    { en: 'ESMO Fellow — European Society for Medical Oncology', ar: 'زمالة الجمعية الأوروبية لعلم الأورام', country: 'EU' },

    // Saudi / GCC / Pan-Arab
    { en: 'Saudi Board of Cardiology',         ar: 'البورد السعودي لطب القلب',         country: 'Saudi Arabia' },
    { en: 'Saudi Board of Internal Medicine',  ar: 'البورد السعودي للباطنة',           country: 'Saudi Arabia' },
    { en: 'Saudi Board of Surgery',            ar: 'البورد السعودي للجراحة',           country: 'Saudi Arabia' },
    { en: 'Arab Board of Cardiology',          ar: 'البورد العربي لطب القلب',          country: 'Pan-Arab' },
    { en: 'Arab Board of Internal Medicine',   ar: 'البورد العربي للباطنة',            country: 'Pan-Arab' },
    { en: 'Arab Board of Surgery',             ar: 'البورد العربي للجراحة',            country: 'Pan-Arab' },

    // Generic / common
    { en: 'MD — Doctor of Medicine',                  ar: 'دكتوراه في الطب',                country: 'Various' },
    { en: 'PhD — Doctor of Philosophy (Medical)',     ar: 'دكتوراه فلسفة (طبية)',          country: 'Various' },
    { en: 'DM — Doctorate of Medicine',               ar: 'دكتوراه ماجستير الطب',          country: 'Various' }
  ];

  // Sub-specialty pools, keyed by the specialty `name` column. 16 keys.
  var SUB_SPECIALTIES = {
    'Cardiology': [
      'Echocardiography', 'Interventional Cardiology', 'Electrophysiology',
      'Heart Failure', 'Preventive Cardiology', 'Pediatric Cardiology',
      'Cardiac Imaging', 'Adult Congenital Heart Disease', 'Sports Cardiology',
      'Valvular Heart Disease', 'Cardio-Oncology', 'Vascular Cardiology'
    ],
    'Dermatology': [
      'Cosmetic Dermatology', 'Dermatopathology', 'Pediatric Dermatology',
      'Mohs Surgery', 'Skin Cancer', 'Hair Disorders',
      'Acne & Rosacea', 'Dermatoimmunology', 'Phototherapy',
      'Vitiligo', 'Laser Dermatology'
    ],
    'Endocrinology': [
      'Diabetes', 'Thyroid Disorders', 'Adrenal Disorders',
      'Pituitary Disorders', 'Reproductive Endocrinology', 'Pediatric Endocrinology',
      'Bone & Mineral Metabolism', 'Lipid Disorders', 'Obesity Medicine',
      'Metabolic Bone Disease'
    ],
    'ENT (Ear, Nose & Throat)': [
      'Rhinology', 'Otology', 'Laryngology',
      'Head & Neck Surgery', 'Facial Plastic Surgery', 'Pediatric ENT',
      'Sleep Disorders', 'Allergy & Sinus', 'Audiology',
      'Voice Disorders'
    ],
    'Gastroenterology': [
      'Hepatology', 'Inflammatory Bowel Disease', 'Endoscopy',
      'Pancreatic Diseases', 'Esophageal Disorders', 'Functional GI Disorders',
      'Pediatric Gastroenterology', 'Liver Transplantation', 'Bariatrics',
      'Motility Disorders'
    ],
    'General Surgery': [
      'Laparoscopic Surgery', 'Hernia Repair', 'Trauma Surgery',
      'Colorectal Surgery', 'Breast Surgery', 'Endocrine Surgery',
      'Hepatobiliary Surgery', 'Bariatric Surgery', 'Acute Care Surgery',
      'Vascular Access', 'Pediatric Surgery'
    ],
    'Internal Medicine': [
      'Hospital Medicine', 'Geriatrics', 'Hypertension',
      'Preventive Medicine', 'Travel Medicine', 'Adolescent Medicine',
      'Critical Care', 'Infectious Diseases', 'Rheumatology',
      'Allergy & Immunology', 'Sleep Medicine'
    ],
    'Lab & Pathology': [
      'Surgical Pathology', 'Hematopathology', 'Cytopathology',
      'Molecular Pathology', 'Microbiology', 'Clinical Chemistry',
      'Forensic Pathology', 'Dermatopathology', 'Renal Pathology',
      'Neuropathology', 'Transfusion Medicine'
    ],
    'Neurology': [
      'Stroke', 'Epilepsy', 'Movement Disorders',
      'Multiple Sclerosis', 'Headache Medicine', 'Neuromuscular Disorders',
      'Sleep Disorders', 'Pediatric Neurology', 'Neuro-Oncology',
      'Behavioral Neurology'
    ],
    'Oncology': [
      'Medical Oncology', 'Radiation Oncology', 'Surgical Oncology',
      'Hematologic Malignancies', 'Breast Cancer', 'Lung Cancer',
      'GI Oncology', 'Genitourinary Oncology', 'Pediatric Oncology',
      'Palliative Care', 'Sarcoma', 'Head & Neck Cancer'
    ],
    'Ophthalmology': [
      'Cataract Surgery', 'Glaucoma', 'Retina',
      'Cornea & External Disease', 'Pediatric Ophthalmology', 'Oculoplastics',
      'Neuro-Ophthalmology', 'Refractive Surgery', 'Uveitis',
      'Ocular Oncology'
    ],
    'Orthopedics': [
      'Sports Medicine', 'Joint Replacement', 'Spine Surgery',
      'Hand Surgery', 'Foot & Ankle', 'Pediatric Orthopedics',
      'Trauma', 'Shoulder & Elbow', 'Orthopedic Oncology',
      'Arthroscopy', 'Limb Reconstruction'
    ],
    'Pediatrics': [
      'Neonatology', 'Pediatric Cardiology', 'Pediatric Pulmonology',
      'Pediatric Endocrinology', 'Pediatric Gastroenterology', 'Pediatric Neurology',
      'Pediatric Hematology-Oncology', 'Adolescent Medicine', 'Developmental & Behavioral',
      'Pediatric Critical Care', 'Pediatric Infectious Diseases'
    ],
    'Pulmonology': [
      'Asthma', 'COPD', 'Interstitial Lung Disease',
      'Sleep Medicine', 'Pulmonary Hypertension', 'Bronchoscopy',
      'Lung Cancer', 'Cystic Fibrosis', 'Critical Care',
      'Tuberculosis'
    ],
    'Radiology': [
      'CT', 'MRI', 'Ultrasound',
      'Interventional Radiology', 'Nuclear Medicine', 'Mammography',
      'Pediatric Radiology', 'Neuroradiology', 'Musculoskeletal Imaging',
      'Cardiothoracic Imaging', 'Abdominal Imaging', 'Emergency Radiology'
    ],
    'Urology': [
      'Andrology', 'Endourology', 'Female Urology',
      'Pediatric Urology', 'Urologic Oncology', 'Reconstructive Urology',
      'Stone Disease', 'Transplant', 'Neurourology',
      'Robotic Surgery'
    ]
  };

  if (typeof window !== 'undefined') {
    window.__PROFILE_AUTOCOMPLETE_DATA__ = {
      LANGUAGES: LANGUAGES,
      BOARD_CERTIFICATIONS: BOARD_CERTIFICATIONS,
      SUB_SPECIALTIES: SUB_SPECIALTIES
    };
  }
})();
