// src/services/service_descriptions.js
//
// One line per service for the public /services page, EN and Egyptian AR,
// keyed by services.id (15 Oct 2026). It replaces a 16-entry map keyed by
// service NAMES from an older catalogue: almost none of the names on sale
// matched it, so nearly every card fell back to the same generic sentence.
//
// House rules for these lines: say who reads it (a consultant in the
// specialty), what they read, and that they write an opinion. Never promise
// a diagnosis, a cure or a treatment decision — the patient decides with
// their own doctor.
'use strict';

const BY_ID = {
  "entry_read_cardiology": [
    "A cardiology consultant reads one heart report you already have and answers one question about it in writing.",
    "استشاري قلب بيقرا تقرير قلب واحد معاك ويجاوب على سؤال واحد عنه كتابةً."
  ],
  "card_ecg_12lead": [
    "A cardiology consultant reads your 12-lead ECG tracing and writes what it shows about heart rhythm and conduction.",
    "استشاري قلب بيقرا رسم القلب (12 وصلة) ويكتبلك بيوضح إيه عن انتظام النبض وكهربا القلب."
  ],
  "card_rhythm_strip": [
    "A cardiology consultant reads your rhythm strip and writes an opinion on the heart rhythm it records.",
    "استشاري قلب بيقرا شريط نظم القلب ويكتب رأيه في النبض المسجل عليه."
  ],
  "card_calcium_score": [
    "A cardiology consultant reviews your coronary calcium score and explains in writing what it means alongside your history.",
    "استشاري قلب بيراجع قياس الكالسيوم بشرايين القلب ويشرحلك كتابةً معناه مع تاريخك المرضي."
  ],
  "card_cmr": [
    "A cardiology consultant reviews your cardiac MRI report and images and writes an opinion on heart structure and function.",
    "استشاري قلب بيراجع تقرير وصور الرنين على القلب ويكتب رأيه في شكل القلب ووظيفته."
  ],
  "card_echo": [
    "A cardiology consultant reviews your echo report and images and writes an opinion on the valves, chambers and pumping function.",
    "استشاري قلب بيراجع تقرير وصور الإيكو ويكتب رأيه في الصمامات وحجرات القلب وقوة الضخ."
  ],
  "card_event_monitor": [
    "A cardiology consultant reviews your event monitor recordings and the symptoms you logged, and writes an opinion on them.",
    "استشاري قلب بيراجع تسجيلات جهاز نبضات القلب والأعراض اللي سجلتها ويكتب رأيه فيها."
  ],
  "card_holter_24_72": [
    "A cardiology consultant reviews your 24–72 hour Holter recording and writes an opinion on the heart rhythm over that period.",
    "استشاري قلب بيراجع تسجيل الهولتر (24–72 ساعة) ويكتب رأيه في النبض طول الفترة دي."
  ],
  "card_stress_echo": [
    "A cardiology consultant reviews your stress echo and writes an opinion on how the heart responded to effort.",
    "استشاري قلب بيراجع إيكو المجهود ويكتب رأيه في استجابة القلب للمجهود."
  ],
  "card_stress_treadmill": [
    "A cardiology consultant reviews your treadmill stress test and writes an opinion on the ECG changes and your response to exercise.",
    "استشاري قلب بيراجع اختبار المجهود على السير ويكتب رأيه في تغيرات رسم القلب واستجابتك للمجهود."
  ],
  "card_ctca": [
    "A cardiology consultant reviews your CT coronary angiography and writes an opinion on the coronary arteries and any narrowing reported.",
    "استشاري قلب بيراجع الأشعة المقطعية على شرايين القلب ويكتب رأيه في الشرايين وأي ضيق مذكور في التقرير."
  ],
  "card_preop_clearance": [
    "A cardiology consultant reviews your heart tests before surgery and writes an opinion on cardiac readiness for the operation.",
    "استشاري قلب بيراجع فحوصات القلب قبل العملية ويكتب رأيه في جاهزية القلب للعملية."
  ],
  "svc-clinical-nutrition-consultation": [
    "A clinical nutrition consultant reviews your lab results and current diet and writes an opinion on the nutrition that suits your condition.",
    "استشاري تغذية علاجية بيراجع تحاليلك ونظامك الغذائي الحالي ويكتب رأيه في التغذية المناسبة لحالتك."
  ],
  "891c261f-6c63-4341-8644-a75af15c7a59": [
    "A gastroenterology consultant reviews your liver ultrasound report and images and writes an opinion on the findings.",
    "استشاري جهاز هضمي بيراجع تقرير وصور سونار الكبد ويكتب رأيه في النتايج."
  ],
  "9ffc180c-bed2-4305-b71c-2303c12f30b6": [
    "A gastroenterology consultant reviews your FibroScan or elastography results and writes an opinion on the liver stiffness reading.",
    "استشاري جهاز هضمي بيراجع نتيجة الفيبروسكان أو قياس مرونة الكبد ويكتب رأيه في القراءة."
  ],
  "4f3ff7a9-bbf4-41ac-bbf9-e731f62bbad7": [
    "A gastroenterology consultant reviews your hepatitis B and C test results and explains in writing what they show.",
    "استشاري جهاز هضمي بيراجع تحاليل الالتهاب الكبدي B وC ويشرحلك كتابةً بتوضح إيه."
  ],
  "3576c5fe-59a7-4370-ad05-f34e40d8a1e8": [
    "A gastroenterology consultant reviews your liver MRI report and writes an opinion on the findings.",
    "استشاري جهاز هضمي بيراجع تقرير الرنين على الكبد ويكتب رأيه في النتايج."
  ],
  "ccc8556d-089a-4b61-b21c-7fc3bc9cda62": [
    "A gastroenterology consultant reviews your capsule endoscopy report and writes an opinion on the findings.",
    "استشاري جهاز هضمي بيراجع تقرير منظار الكبسولة ويكتب رأيه في النتايج."
  ],
  "0e6c534d-dfab-4c2b-a950-0eda846a1cdb": [
    "A gastroenterology consultant reviews your colonoscopy report and any biopsy results and writes an opinion on the findings.",
    "استشاري جهاز هضمي بيراجع تقرير منظار القولون وأي نتايج عينات ويكتب رأيه فيها."
  ],
  "c1e9624a-78c2-4c8c-b6ca-7b3694719eb8": [
    "A gastroenterology consultant reviews your endoscopy report and any biopsy results and writes an opinion on the findings.",
    "استشاري جهاز هضمي بيراجع تقرير المنظار وأي نتايج عينات ويكتب رأيه فيها."
  ],
  "6193b569-cfe7-40d9-a2a7-ce7b02189395": [
    "A gastroenterology consultant reviews your inflammatory bowel disease tests and reports and writes an opinion on the findings so far.",
    "استشاري جهاز هضمي بيراجع فحوصات وتقارير التهاب الأمعاء المزمن ويكتب رأيه في النتايج لحد دلوقتي."
  ],
  "d8e374d9-0ae0-4c1a-9299-a508752fdf7b": [
    "A gastroenterology consultant reviews your liver biopsy report and writes an opinion on what it shows.",
    "استشاري جهاز هضمي بيراجع تقرير عينة الكبد ويكتب رأيه في اللي بيوضحه."
  ],
  "7fa58485-fe05-49ef-85c7-607abc91c123": [
    "A gastroenterology consultant reviews your MRCP report and writes an opinion on the bile duct and pancreas findings.",
    "استشاري جهاز هضمي بيراجع تقرير رنين القنوات المرارية ويكتب رأيه في نتايج القنوات المرارية والبنكرياس."
  ],
  "entry_read_internal-medicine": [
    "An internal medicine consultant reads one report you already have and answers one question about it in writing.",
    "استشاري باطنة بيقرا تقرير واحد معاك ويجاوب على سؤال واحد عنه كتابةً."
  ],
  "afed4de4-4eee-4e46-97d5-c6544be5dbc8": [
    "An internal medicine consultant reviews your blood count and anemia tests and explains in writing what the results show.",
    "استشاري باطنة بيراجع صورة الدم وتحاليل فقر الدم ويشرحلك كتابةً النتايج بتوضح إيه."
  ],
  "740aaf78-546b-484b-8d01-3e9052b0ccbb": [
    "An internal medicine consultant reviews every medicine you take and writes an opinion on overlaps and interactions to discuss with your doctor.",
    "استشاري باطنة بيراجع كل الأدوية اللي بتاخدها ويكتب رأيه في التكرار والتداخلات عشان تناقشها مع دكتورك."
  ],
  "33d5541f-5a83-41e7-8ac4-ac5561a77688": [
    "An internal medicine consultant reviews your hospital discharge summary and follow-up plan and writes an opinion on it.",
    "استشاري باطنة بيراجع تقرير خروجك من المستشفى وخطة المتابعة ويكتب رأيه فيها."
  ],
  "251d90b7-4658-43a8-8a6d-e519c52e6fc3": [
    "An internal medicine consultant reviews your pre-surgery tests and writes an opinion on your medical readiness for the operation.",
    "استشاري باطنة بيراجع فحوصات ما قبل العملية ويكتب رأيه في جاهزيتك الطبية للعملية."
  ],
  "076a0451-3fc2-415b-ab65-90ee58966d90": [
    "An internal medicine consultant reviews your treatment plan for a long-term condition, such as diabetes or blood pressure, and writes an opinion on it.",
    "استشاري باطنة بيراجع خطة علاج مرض مزمن زي السكر أو الضغط ويكتب رأيه فيها."
  ],
  "c9038ac7-cdf9-4f16-adce-17f74182bb65": [
    "An internal medicine consultant reviews your whole file, tests and reports together, and writes a second opinion on the case.",
    "استشاري باطنة بيراجع ملفك كله، التحاليل والتقارير مع بعض، ويكتب رأي طبي ثانٍ في الحالة."
  ],
  "3896c375-5e86-4b83-b978-6dcd4257bd23": [
    "A nephrology consultant reviews your kidney ultrasound report and images and writes an opinion on the findings.",
    "استشاري كلى بيراجع تقرير وصور سونار الكلى ويكتب رأيه في النتايج."
  ],
  "cd428c90-e144-48a6-ae2d-e7321c47eb62": [
    "A nephrology consultant reviews your kidney function tests, such as creatinine and eGFR, and explains in writing what they show.",
    "استشاري كلى بيراجع تحاليل وظائف الكلى زي الكرياتينين ومعدل الترشيح ويشرحلك كتابةً بتوضح إيه."
  ],
  "90445995-81a2-4dfa-9c33-5b39cb6779ad": [
    "A nephrology consultant reviews your kidney stone CT and writes an opinion on the stones reported.",
    "استشاري كلى بيراجع الأشعة المقطعية على حصوات الكلى ويكتب رأيه في الحصوات المذكورة."
  ],
  "6d7409bb-18a2-4659-a119-e7102ea3c2b0": [
    "A nephrology consultant reviews your dialysis records and lab results and writes an opinion on how well dialysis is working.",
    "استشاري كلى بيراجع سجلات الغسيل الكلوي والتحاليل ويكتب رأيه في كفاءة الغسيل."
  ],
  "442081e7-0abb-490e-9df1-0ef7f0bd0397": [
    "A nephrology consultant reviews your blood pressure readings and tests and writes an opinion on them.",
    "استشاري كلى بيراجع قراءات الضغط والفحوصات ويكتب رأيه فيها."
  ],
  "5318c5cf-9097-47a9-b1a7-a40c1ba68406": [
    "A nephrology consultant reviews your kidney biopsy report and writes an opinion on what it shows.",
    "استشاري كلى بيراجع تقرير عينة الكلى ويكتب رأيه في اللي بيوضحه."
  ],
  "22028c6f-2f3a-427f-bc37-e65e3e518836": [
    "A nephrology consultant reviews your urine protein tests and related results and writes an opinion on them.",
    "استشاري كلى بيراجع تحاليل الزلال في البول والنتايج المرتبطة بيها ويكتب رأيه فيها."
  ],
  "bef26bde-7f2c-4ed9-ac08-6d4ef3075e03": [
    "A nephrology consultant reviews your chronic kidney disease file, stage and treatment plan and writes a full second opinion.",
    "استشاري كلى بيراجع ملف الفشل الكلوي المزمن، المرحلة وخطة العلاج، ويكتب رأي طبي ثانٍ كامل."
  ],
  "entry_read_obgyn": [
    "An obstetrics and gynaecology consultant reads one report you already have and answers one question about it in writing.",
    "استشاري نساء وتوليد بيقرا تقرير واحد معاك ويجاوب على سؤال واحد عنه كتابةً."
  ],
  "c8e6b8e3-eb44-4039-94f7-29d3fe510db2": [
    "An obstetrics and gynaecology consultant reviews your gynaecological ultrasound report and images and writes an opinion on the findings.",
    "استشاري نساء وتوليد بيراجع تقرير وصور سونار أمراض النساء ويكتب رأيه في النتايج."
  ],
  "751a96a3-4491-481e-b15f-85ecce841ab0": [
    "An obstetrics and gynaecology consultant reviews your pregnancy ultrasound report and writes an opinion on the findings.",
    "استشاري نساء وتوليد بيراجع تقرير سونار الحمل ويكتب رأيه في النتايج."
  ],
  "914f690d-e65c-4374-aa77-c6cb5d020ebd": [
    "An obstetrics and gynaecology consultant reviews your Pap smear report and explains in writing what the result means.",
    "استشاري نساء وتوليد بيراجع تقرير مسحة عنق الرحم ويشرحلك كتابةً معنى النتيجة."
  ],
  "804d2c86-e917-4003-bf85-78ae90e4fc46": [
    "An obstetrics and gynaecology consultant reviews your pregnancy blood tests and explains in writing what they show.",
    "استشاري نساء وتوليد بيراجع تحاليل الحمل ويشرحلك كتابةً بتوضح إيه."
  ],
  "226a46c3-c09a-4bb4-9020-1aca84286456": [
    "An obstetrics and gynaecology consultant reviews your fertility hormone tests and writes an opinion on the results.",
    "استشاري نساء وتوليد بيراجع تحاليل هرمونات الخصوبة ويكتب رأيه في النتايج."
  ],
  "8dc26268-ce9f-4abc-b3ee-81e8bfa1bcf7": [
    "An obstetrics and gynaecology consultant reviews your HSG report and writes an opinion on the uterus and fallopian tube findings.",
    "استشاري نساء وتوليد بيراجع تقرير أشعة الصبغة ويكتب رأيه في نتايج الرحم وقنوات فالوب."
  ],
  "86311863-9230-4181-a93a-1c8ad9c3d4b8": [
    "An obstetrics and gynaecology consultant reviews your pelvic MRI report and writes an opinion on the findings.",
    "استشاري نساء وتوليد بيراجع تقرير الرنين على الحوض ويكتب رأيه في النتايج."
  ],
  "c3b25b89-abcb-4351-b784-29fda57e3303": [
    "An obstetrics and gynaecology consultant reviews your fetal echo report and writes an opinion on the baby's heart findings.",
    "استشاري نساء وتوليد بيراجع تقرير إيكو قلب الجنين ويكتب رأيه في نتايج قلب الجنين."
  ],
  "381228d3-9967-45aa-b37b-f5d52833a42e": [
    "An obstetrics and gynaecology consultant reviews your fibroid scans and the treatment options offered to you and writes an opinion on them.",
    "استشاري نساء وتوليد بيراجع أشعة الأورام الليفية وخيارات العلاج اللي اتعرضت عليك ويكتب رأيه فيها."
  ],
  "entry_read_orthopedics": [
    "An orthopaedic consultant reads one report you already have and answers one question about it in writing.",
    "استشاري عظام بيقرا تقرير واحد معاك ويجاوب على سؤال واحد عنه كتابةً."
  ],
  "f7212d50-4ec9-4f75-93c4-38bb2953753f": [
    "An orthopaedic consultant reviews your bone density (DEXA) results and explains in writing what the T-score means.",
    "استشاري عظام بيراجع نتيجة قياس كثافة العظام ويشرحلك كتابةً معنى النتيجة."
  ],
  "8df6ec54-9a42-4377-89af-7ffec238018a": [
    "An orthopaedic consultant reviews your bone or joint X-rays and writes an opinion on the findings.",
    "استشاري عظام بيراجع أشعة العظام أو المفاصل ويكتب رأيه في النتايج."
  ],
  "bd9ae0ea-4516-4b0b-bedd-524847c20005": [
    "An orthopaedic consultant reviews your bone or joint CT and writes an opinion on the findings.",
    "استشاري عظام بيراجع الأشعة المقطعية على العظام أو المفاصل ويكتب رأيه في النتايج."
  ],
  "6f068411-f7fb-461c-8725-5081543f80da": [
    "An orthopaedic consultant reviews your hip MRI and writes an opinion on the joint findings.",
    "استشاري عظام بيراجع الرنين على مفصل الورك ويكتب رأيه في النتايج."
  ],
  "20782c32-9943-4867-abc0-c35d25b925ad": [
    "An orthopaedic consultant reviews your knee MRI and writes an opinion on the ligament, cartilage and meniscus findings.",
    "استشاري عظام بيراجع الرنين على الركبة ويكتب رأيه في نتايج الأربطة والغضاريف."
  ],
  "c48b7386-0877-4cb0-9725-4cafc809b895": [
    "An orthopaedic consultant reviews your MRI of a bone, joint or muscle and writes an opinion on the findings.",
    "استشاري عظام بيراجع رنين العظام أو المفاصل أو العضلات ويكتب رأيه في النتايج."
  ],
  "eb2c20d7-f956-4b0f-a638-aafdd3d1e888": [
    "An orthopaedic consultant reviews your shoulder MRI and writes an opinion on the tendon and joint findings.",
    "استشاري عظام بيراجع الرنين على الكتف ويكتب رأيه في نتايج الأوتار والمفصل."
  ],
  "fcf976a7-d58d-49e3-b072-d2fcdc16d7ad": [
    "An orthopaedic consultant reviews your spine X-ray, CT or MRI and writes an opinion on the findings.",
    "استشاري عظام بيراجع أشعة العمود الفقري (عادية أو مقطعية أو رنين) ويكتب رأيه في النتايج."
  ],
  "57749223-ea3b-43d6-9561-8641d4d4297d": [
    "An orthopaedic consultant reviews your fracture X-rays and the treatment plan offered to you and writes an opinion on it.",
    "استشاري عظام بيراجع أشعة الكسر وخطة العلاج المقترحة ويكتب رأيه فيها."
  ],
  "e52f1bf2-11aa-4941-8100-387ecff881f2": [
    "An orthopaedic consultant reviews your X-rays and reports after an operation and writes an opinion on recovery so far.",
    "استشاري عظام بيراجع أشعة وتقارير ما بعد العملية ويكتب رأيه في التعافي لحد دلوقتي."
  ],
  "95e10e76-4c56-401e-a5ce-b2f75d34fdea": [
    "An orthopaedic consultant reviews your scans and the operation recommended to you and writes a second opinion before you decide.",
    "استشاري عظام بيراجع أشعتك والعملية المقترحة عليك ويكتب رأي طبي ثانٍ قبل ما تقرر."
  ],
  "entry_read_pediatrics": [
    "A paediatrics consultant reads one report about your child and answers one question about it in writing.",
    "استشاري أطفال بيقرا تقرير واحد عن طفلك ويجاوب على سؤال واحد عنه كتابةً."
  ],
  "peds_blood_count": [
    "A paediatrics consultant reviews your child's blood count and anemia tests and explains in writing what they show.",
    "استشاري أطفال بيراجع صورة دم طفلك وتحاليل فقر الدم ويشرحلك كتابةً بتوضح إيه."
  ],
  "peds_growth_vaccination": [
    "A paediatrics consultant reviews your child's growth chart and vaccination record and writes an opinion on both.",
    "استشاري أطفال بيراجع منحنى نمو طفلك وسجل التطعيمات ويكتب رأيه فيهم."
  ],
  "peds_asthma_control": [
    "A paediatrics consultant reviews your child's asthma control plan and medicines and writes an opinion on it.",
    "استشاري أطفال بيراجع خطة السيطرة على الربو وأدوية طفلك ويكتب رأيه فيها."
  ],
  "peds_newborn_screening": [
    "A paediatrics consultant reviews your baby's newborn screening result and explains in writing what it means.",
    "استشاري أطفال بيراجع نتيجة مسح حديثي الولادة ويشرحلك كتابةً معناها."
  ],
  "peds_allergy_eczema": [
    "A paediatrics consultant reviews your child's allergy tests and eczema treatment and writes an opinion on them.",
    "استشاري أطفال بيراجع تحاليل حساسية طفلك وعلاج الإكزيما ويكتب رأيه فيهم."
  ],
  "peds_feeding_nutrition": [
    "A paediatrics consultant reviews your child's feeding, weight and nutrition records and writes an opinion on them.",
    "استشاري أطفال بيراجع أكل طفلك ووزنه وسجلات التغذية ويكتب رأيه فيها."
  ],
  "peds_recurrent_infections": [
    "A paediatrics consultant reviews your child's repeated infections and the antibiotics given and writes an opinion on the pattern.",
    "استشاري أطفال بيراجع العدوى المتكررة عند طفلك والمضادات الحيوية اللي أخدها ويكتب رأيه فيها."
  ],
  "peds_recurrent_fever": [
    "A paediatrics consultant reviews the records of your child's repeated or long fever and writes an opinion on the tests done so far.",
    "استشاري أطفال بيراجع سجلات الحمى المتكررة أو الطويلة عند طفلك ويكتب رأيه في الفحوصات اللي اتعملت."
  ],
  "peds_consanguinity_risk": [
    "A paediatrics consultant reviews your family history and tests and writes an opinion on the chance of a condition recurring in future children.",
    "استشاري أطفال بيراجع تاريخ العيلة والتحاليل ويكتب رأيه في احتمال تكرار المرض في الأطفال الجايين."
  ],
  "peds_developmental": [
    "A paediatrics consultant reviews your child's developmental milestone records and assessments and writes an opinion on them.",
    "استشاري أطفال بيراجع سجلات وتقييمات مراحل نمو طفلك ويكتب رأيه فيها."
  ],
  "peds_general_case": [
    "A paediatrics consultant reviews your child's whole file, tests and reports together, and writes a second opinion.",
    "استشاري أطفال بيراجع ملف طفلك كله، التحاليل والتقارير مع بعض، ويكتب رأي طبي ثانٍ."
  ],
  "peds_genetic_report": [
    "A paediatrics consultant reviews your child's genetic test report and explains in writing what it shows.",
    "استشاري أطفال بيراجع تقرير التحليل الجيني لطفلك ويشرحلك كتابةً بيوضح إيه."
  ],
  "peds_metabolic_inherited": [
    "A paediatrics consultant reviews your child's tests for an inherited metabolic disorder and writes an opinion on them.",
    "استشاري أطفال بيراجع تحاليل طفلك الخاصة بأمراض التمثيل الغذائي الوراثية ويكتب رأيه فيها."
  ],
  "peds_presurgical": [
    "A paediatrics consultant reviews the operation recommended for your child and the tests behind it, and writes a second opinion.",
    "استشاري أطفال بيراجع العملية المقترحة لطفلك والفحوصات اللي اتبنت عليها ويكتب رأي طبي ثانٍ."
  ],
  "peds_nicu_stay": [
    "A paediatrics consultant reviews your baby's NICU stay and discharge summary and writes an opinion on the follow-up plan.",
    "استشاري أطفال بيراجع تقرير إقامة طفلك في الحضانة وملخص الخروج ويكتب رأيه في خطة المتابعة."
  ],
  "entry_read_radiology": [
    "A radiology consultant reads one scan report you already have and answers one question about it in writing.",
    "استشاري أشعة بيقرا تقرير أشعة واحد معاك ويجاوب على سؤال واحد عنه كتابةً."
  ],
  "rad_cxr_review": [
    "A radiology consultant reviews your chest X-ray and writes an opinion on the lung and chest findings.",
    "استشاري أشعة بيراجع أشعة الصدر ويكتب رأيه في نتايج الرئة والصدر."
  ],
  "rad_us_review": [
    "A radiology consultant reviews your ultrasound images and report and writes an opinion on the findings.",
    "استشاري أشعة بيراجع صور وتقرير السونار ويكتب رأيه في النتايج."
  ],
  "rad_abd_pelvis_ct_mri": [
    "A radiology consultant reviews your abdomen or pelvis CT or MRI and writes an opinion on the findings.",
    "استشاري أشعة بيراجع المقطعية أو الرنين على البطن والحوض ويكتب رأيه في النتايج."
  ],
  "rad_cardiac_ct": [
    "A radiology consultant reviews your cardiac CT and writes an opinion on the findings.",
    "استشاري أشعة بيراجع الأشعة المقطعية على القلب ويكتب رأيه في النتايج."
  ],
  "rad_cardiac_mri": [
    "A radiology consultant reviews your cardiac MRI and writes an opinion on the findings.",
    "استشاري أشعة بيراجع الرنين على القلب ويكتب رأيه في النتايج."
  ],
  "rad_ct_review": [
    "A radiology consultant reviews your CT images and report and writes an opinion on the findings.",
    "استشاري أشعة بيراجع صور وتقرير الأشعة المقطعية ويكتب رأيه في النتايج."
  ],
  "rad_mri_review": [
    "A radiology consultant reviews your MRI images and report and writes an opinion on the findings.",
    "استشاري أشعة بيراجع صور وتقرير الرنين المغناطيسي ويكتب رأيه في النتايج."
  ],
  "rad_msk_imaging": [
    "A radiology consultant reviews your bone, joint or muscle imaging and writes an opinion on the findings.",
    "استشاري أشعة بيراجع أشعة العظام والعضلات والمفاصل ويكتب رأيه في النتايج."
  ],
  "rad_neuro_imaging": [
    "A radiology consultant reviews your brain or nerve imaging and writes an opinion on the findings.",
    "استشاري أشعة بيراجع أشعة المخ والأعصاب ويكتب رأيه في النتايج."
  ],
  "rad_spine_mri": [
    "A radiology consultant reviews your spine MRI and writes an opinion on the disc, nerve and vertebra findings.",
    "استشاري أشعة بيراجع الرنين على العمود الفقري ويكتب رأيه في نتايج الغضاريف والأعصاب والفقرات."
  ],
  "rad_ct_mr_angio": [
    "A radiology consultant reviews your CT or MR angiography and writes an opinion on the blood vessel findings.",
    "استشاري أشعة بيراجع أشعة الأوعية الدموية (مقطعية أو رنين) ويكتب رأيه في نتايج الأوعية."
  ],
  "rad_onc_petct_staging": [
    "A radiology consultant reviews your PET-CT and writes an opinion on the staging findings.",
    "استشاري أشعة بيراجع أشعة PET-CT ويكتب رأيه في نتايج تحديد المرحلة."
  ],
  "entry_read_urology": [
    "A urology consultant reads one report you already have and answers one question about it in writing.",
    "استشاري مسالك بولية بيقرا تقرير واحد معاك ويجاوب على سؤال واحد عنه كتابةً."
  ],
  "362481e4-1b61-4f37-9ee3-5c4109816a01": [
    "A urology consultant reviews your bladder ultrasound and writes an opinion on the findings.",
    "استشاري مسالك بولية بيراجع سونار المثانة ويكتب رأيه في النتايج."
  ],
  "ca8cc7e9-80b3-450c-a1b8-793aa1eff45a": [
    "A urology consultant reviews your scrotal ultrasound and writes an opinion on the findings.",
    "استشاري مسالك بولية بيراجع سونار كيس الصفن ويكتب رأيه في النتايج."
  ],
  "efe933ea-e15e-4336-9e22-f1f487ea0762": [
    "A urology consultant reviews your kidney and ureter CT and writes an opinion on the findings.",
    "استشاري مسالك بولية بيراجع الأشعة المقطعية على الكلى والحالب ويكتب رأيه في النتايج."
  ],
  "35242a11-0fad-4d0b-a6a9-be19d7b511fb": [
    "A urology consultant reviews your prostate MRI and writes an opinion on the findings, including the PI-RADS score if reported.",
    "استشاري مسالك بولية بيراجع الرنين على البروستاتا ويكتب رأيه في النتايج ودرجة PI-RADS لو مكتوبة."
  ],
  "43ab445f-68a3-46d1-9af5-0024fce4d0bb": [
    "A urology consultant reviews your PSA and prostate tests and explains in writing what the results show.",
    "استشاري مسالك بولية بيراجع تحليل PSA وفحوصات البروستاتا ويشرحلك كتابةً النتايج بتوضح إيه."
  ],
  "18b1e5a5-3218-49a0-8ac5-fc545746d921": [
    "A urology consultant reviews your cystoscopy report and writes an opinion on the findings.",
    "استشاري مسالك بولية بيراجع تقرير منظار المثانة ويكتب رأيه في النتايج."
  ],
  "96e8adde-dc99-4e60-a1ed-d1ea3cd18c8e": [
    "A urology consultant reviews your full prostate workup, tests, scans and any biopsy, and writes a second opinion.",
    "استشاري مسالك بولية بيراجع كل فحوصات البروستاتا، التحاليل والأشعة وأي عينة، ويكتب رأي طبي ثانٍ."
  ],
  "edb1d583-6dab-49af-af75-abea9bfdc571": [
    "A urology consultant reviews your kidney stone scans and the treatment offered to you and writes an opinion on it.",
    "استشاري مسالك بولية بيراجع أشعة حصوات الكلى والعلاج المقترح عليك ويكتب رأيه فيه."
  ],
  "784adb02-0189-41aa-8f89-724b2de39568": [
    "A urology consultant reviews your urodynamics study and writes an opinion on bladder function.",
    "استشاري مسالك بولية بيراجع دراسة ديناميكية المسالك ويكتب رأيه في وظيفة المثانة."
  ]
};

const GENERIC = [
  'A consultant in the specialty reviews your files and writes a second opinion report.',
  'استشاري في التخصص بيراجع ملفاتك ويكتبلك تقرير رأي طبي ثانٍ مكتوب.'
];

function describe(id) {
  return BY_ID[id] || null;
}

module.exports = { BY_ID, GENERIC, describe };
