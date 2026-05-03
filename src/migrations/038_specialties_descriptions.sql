-- 038_specialties_descriptions.sql
--
-- Adds description + description_ar columns to specialties and seeds
-- conservative factual descriptions for all 22 visible specialties.
--
-- Why all 22 (not just the 12 with services today): when services are
-- eventually added to currently-empty specialties (Anesthesiology,
-- OB/GYN, Pathology, Psychiatry, etc.), descriptions are already in
-- place — no follow-up data work required when the /specialties index
-- starts surfacing them.
--
-- Idempotent: column adds are guarded with IF NOT EXISTS; seed UPDATEs
-- only fire WHERE description IS NULL so post-launch manual edits are
-- never clobbered.
--
-- Tone: educational, factual, no marketing language. Each description
-- is 1-2 sentences listing the conditions / domain the specialty
-- covers. Lay-summary level, suitable for a public marketing page.

-- ── 1. Column adds ──────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'specialties' AND column_name = 'description'
  ) THEN
    ALTER TABLE specialties ADD COLUMN description TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'specialties' AND column_name = 'description_ar'
  ) THEN
    ALTER TABLE specialties ADD COLUMN description_ar TEXT;
  END IF;
END $$;

-- ── 2. Seed descriptions (UPDATE-WHERE-NULL preserves edits) ────────
-- Dollar-quoted strings ($txt$ ... $txt$) avoid having to escape any
-- single-quote apostrophes (e.g. "women's") inside the text.

UPDATE specialties SET
  description    = $txt$Anesthesiology covers perioperative care, including general and regional anesthesia, pain management, and intensive care for critically ill patients.$txt$,
  description_ar = $txt$يختص التخدير بالرعاية المحيطة بالعمليات الجراحية، بما في ذلك التخدير العام والموضعي وعلاج الألم والرعاية المركزة للمرضى في الحالات الحرجة.$txt$
WHERE id = 'spec-anesthesiology' AND description IS NULL;

UPDATE specialties SET
  description    = $txt$Cardiology covers the diagnosis and management of disorders of the heart and blood vessels, including ischemic heart disease, arrhythmias, valvular disease, and heart failure.$txt$,
  description_ar = $txt$تختص أمراض القلب بتشخيص وعلاج اضطرابات القلب والأوعية الدموية، بما في ذلك أمراض القلب الإقفارية واضطرابات النظم وأمراض الصمامات وقصور القلب.$txt$
WHERE id = 'spec-cardiology' AND description IS NULL;

UPDATE specialties SET
  description    = $txt$Cardiothoracic surgery treats surgical conditions of the heart, lungs, and chest cavity, including coronary artery bypass, valve repair and replacement, and lung resection.$txt$,
  description_ar = $txt$تعالج جراحة القلب والصدر الحالات الجراحية للقلب والرئتين وتجويف الصدر، بما في ذلك جراحة الشرايين التاجية وإصلاح واستبدال الصمامات واستئصال الرئة.$txt$
WHERE id = 'spec-cardiothoracic' AND description IS NULL;

UPDATE specialties SET
  description    = $txt$Clinical nutrition addresses the dietary and metabolic management of patients with chronic disease, malnutrition, and conditions requiring specialized nutritional support.$txt$,
  description_ar = $txt$تتناول التغذية العلاجية الإدارة الغذائية والأيضية للمرضى المصابين بالأمراض المزمنة وسوء التغذية والحالات التي تتطلب دعماً غذائياً متخصصاً.$txt$
WHERE id = 'spec-clinical-nutrition' AND description IS NULL;

UPDATE specialties SET
  description    = $txt$Dermatology focuses on the diagnosis and treatment of skin, hair, and nail conditions, including eczema, psoriasis, acne, infections, and skin cancers.$txt$,
  description_ar = $txt$تختص الأمراض الجلدية بتشخيص وعلاج حالات الجلد والشعر والأظافر، بما في ذلك الإكزيما والصدفية وحب الشباب والعدوى وسرطانات الجلد.$txt$
WHERE id = 'spec-dermatology' AND description IS NULL;

UPDATE specialties SET
  description    = $txt$Emergency medicine deals with the immediate evaluation and treatment of acute illness and injury, ranging from minor presentations to life-threatening conditions.$txt$,
  description_ar = $txt$يتعامل طب الطوارئ مع التقييم والعلاج الفوري للأمراض والإصابات الحادة، من الحالات البسيطة إلى الحالات المهددة للحياة.$txt$
WHERE id = 'spec-emergency-medicine' AND description IS NULL;

UPDATE specialties SET
  description    = $txt$Endocrinology covers disorders of hormones and the endocrine glands, including diabetes, thyroid and adrenal disease, PCOS, and metabolic conditions.$txt$,
  description_ar = $txt$تختص الغدد الصماء باضطرابات الهرمونات والغدد الصماء، بما في ذلك السكري وأمراض الغدة الدرقية والكظرية ومتلازمة تكيس المبايض والاضطرابات الأيضية.$txt$
WHERE id = 'spec-endocrinology' AND description IS NULL;

UPDATE specialties SET
  description    = $txt$Gastroenterology covers diseases of the digestive system, including the esophagus, stomach, intestines, liver, gallbladder, and pancreas.$txt$,
  description_ar = $txt$يختص الجهاز الهضمي بأمراض الجهاز الهضمي، بما في ذلك المريء والمعدة والأمعاء والكبد والمرارة والبنكرياس.$txt$
WHERE id = 'spec-gastroenterology' AND description IS NULL;

UPDATE specialties SET
  description    = $txt$Hematology covers diseases of the blood and bone marrow, including anemias, bleeding and clotting disorders, and blood cancers such as leukemia and lymphoma.$txt$,
  description_ar = $txt$تختص أمراض الدم بأمراض الدم ونخاع العظم، بما في ذلك فقر الدم واضطرابات النزيف والتجلط وسرطانات الدم مثل ابيضاض الدم والأورام اللمفاوية.$txt$
WHERE id = 'spec-hematology' AND description IS NULL;

UPDATE specialties SET
  description    = $txt$Nephrology covers diseases of the kidneys, including chronic kidney disease, glomerular disorders, electrolyte abnormalities, hypertension, and dialysis care.$txt$,
  description_ar = $txt$تختص أمراض الكلى بأمراض الكلى، بما في ذلك مرض الكلى المزمن واضطرابات الكبيبات واختلالات الكهارل وارتفاع ضغط الدم وعلاج الغسيل الكلوي.$txt$
WHERE id = 'spec-nephrology' AND description IS NULL;

UPDATE specialties SET
  description    = $txt$Neurology covers disorders of the brain, spinal cord, peripheral nerves, and muscles, including stroke, epilepsy, multiple sclerosis, and movement disorders.$txt$,
  description_ar = $txt$يختص طب المخ والأعصاب باضطرابات الدماغ والحبل الشوكي والأعصاب الطرفية والعضلات، بما في ذلك السكتة الدماغية والصرع والتصلب المتعدد واضطرابات الحركة.$txt$
WHERE id = 'spec-neurology' AND description IS NULL;

UPDATE specialties SET
  description    = $txt$Obstetrics and gynecology covers women's reproductive health across pregnancy, childbirth, fertility, menstrual disorders, and gynecologic conditions.$txt$,
  description_ar = $txt$يغطي طب النساء والتوليد صحة المرأة الإنجابية شاملاً الحمل والولادة والخصوبة واضطرابات الحيض والحالات النسائية.$txt$
WHERE id = 'spec-obgyn' AND description IS NULL;

UPDATE specialties SET
  description    = $txt$Oncology covers the diagnosis, staging, and treatment of cancers across solid tumors and hematologic malignancies, including chemotherapy and supportive care.$txt$,
  description_ar = $txt$تختص الأورام بتشخيص وتحديد مراحل وعلاج السرطانات في الأورام الصلبة والأورام الخبيثة الدموية، بما في ذلك العلاج الكيميائي والرعاية الداعمة.$txt$
WHERE id = 'spec-oncology' AND description IS NULL;

UPDATE specialties SET
  description    = $txt$Ophthalmology covers the medical and surgical care of the eye and visual system, including cataract, glaucoma, retinal disease, and refractive disorders.$txt$,
  description_ar = $txt$يغطي طب العيون الرعاية الطبية والجراحية للعين والجهاز البصري، بما في ذلك المياه البيضاء والمياه الزرقاء وأمراض الشبكية واضطرابات الانكسار.$txt$
WHERE id = 'spec-ophthalmology' AND description IS NULL;

UPDATE specialties SET
  description    = $txt$Orthopedics covers conditions of the musculoskeletal system — bones, joints, ligaments, tendons, and muscles — including fractures, arthritis, and sports injuries.$txt$,
  description_ar = $txt$تختص جراحة العظام بحالات الجهاز العضلي الهيكلي — العظام والمفاصل والأربطة والأوتار والعضلات — بما في ذلك الكسور والتهاب المفاصل والإصابات الرياضية.$txt$
WHERE id = 'spec-orthopedics' AND description IS NULL;

UPDATE specialties SET
  description    = $txt$Pathology examines tissues, cells, and bodily fluids to diagnose disease, including biopsy interpretation, histology, and laboratory medicine.$txt$,
  description_ar = $txt$يفحص علم الأمراض الأنسجة والخلايا وسوائل الجسم لتشخيص الأمراض، بما في ذلك تفسير الخزعات والأنسجة والطب المخبري.$txt$
WHERE id = 'spec-pathology' AND description IS NULL;

UPDATE specialties SET
  description    = $txt$Psychiatry covers the diagnosis and treatment of mental health conditions, including depression, anxiety, bipolar disorder, schizophrenia, and addiction.$txt$,
  description_ar = $txt$يختص الطب النفسي بتشخيص وعلاج حالات الصحة النفسية، بما في ذلك الاكتئاب والقلق والاضطراب ثنائي القطب والفصام والإدمان.$txt$
WHERE id = 'spec-psychiatry' AND description IS NULL;

UPDATE specialties SET
  description    = $txt$Pulmonology covers diseases of the lungs and respiratory system, including asthma, COPD, pulmonary infections, interstitial lung disease, and sleep apnea.$txt$,
  description_ar = $txt$تختص أمراض الصدر بأمراض الرئتين والجهاز التنفسي، بما في ذلك الربو ومرض الانسداد الرئوي المزمن والعدوى الرئوية وأمراض الرئة الخلالية وانقطاع النفس النومي.$txt$
WHERE id = 'spec-pulmonology' AND description IS NULL;

UPDATE specialties SET
  description    = $txt$Radiology uses medical imaging — X-ray, CT, MRI, and ultrasound — to diagnose and guide treatment of disease across all body systems.$txt$,
  description_ar = $txt$تستخدم الأشعة التصوير الطبي — الأشعة السينية والأشعة المقطعية والرنين المغناطيسي والموجات فوق الصوتية — لتشخيص الأمراض وتوجيه علاجها في جميع أجهزة الجسم.$txt$
WHERE id = 'spec-radiology' AND description IS NULL;

UPDATE specialties SET
  description    = $txt$Rheumatology covers inflammatory and autoimmune diseases of the joints and connective tissue, including rheumatoid arthritis, lupus, and gout.$txt$,
  description_ar = $txt$تختص أمراض الروماتيزم بالأمراض الالتهابية والمناعية الذاتية للمفاصل والأنسجة الضامة، بما في ذلك التهاب المفاصل الروماتويدي والذئبة والنقرس.$txt$
WHERE id = 'spec-rheumatology' AND description IS NULL;

UPDATE specialties SET
  description    = $txt$Urology covers diseases of the urinary tract in both sexes and the male reproductive system, including kidney stones, prostate disease, and infections.$txt$,
  description_ar = $txt$تختص المسالك البولية بأمراض الجهاز البولي لدى الجنسين والجهاز التناسلي الذكري، بما في ذلك حصوات الكلى وأمراض البروستاتا والعدوى.$txt$
WHERE id = 'spec-urology' AND description IS NULL;

UPDATE specialties SET
  description    = $txt$Vascular surgery treats diseases of the arteries, veins, and lymphatic system, including aneurysms, peripheral arterial disease, and varicose veins.$txt$,
  description_ar = $txt$تعالج جراحة الأوعية الدموية أمراض الشرايين والأوردة والجهاز اللمفي، بما في ذلك تمدد الأوعية الدموية وأمراض الشرايين الطرفية والدوالي.$txt$
WHERE id = 'spec-vascular-surgery' AND description IS NULL;
