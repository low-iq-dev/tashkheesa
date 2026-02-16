# FIX: Remove Arabic from Logo + Rewrite Services Page Patient-Friendly

**Project root:** tashkheesa-portal

---

## FIX 1: Remove Arabic Text from Logo SVG

Replace the ENTIRE contents of `public/assets/brand/tashkheesa-logo-primary.svg` with this English-only version:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 310 56" role="img" aria-labelledby="logo-title">
  <title id="logo-title">Tashkheesa</title>
  <defs>
    <linearGradient id="g" x1="0" y1="2" x2="50" y2="54" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2f8dff"/>
      <stop offset="1" stop-color="#1f62e3"/>
    </linearGradient>
  </defs>
  <!-- Icon -->
  <rect x="2" y="3" width="50" height="50" rx="13" fill="url(#g)"/>
  <path d="M14.5 28.5 l8.5 8.5 l19-19" fill="none" stroke="#fff" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M16.5 37 C16.5 44.5 21.5 48.5 27 48.5 C32.5 48.5 37.5 44.5 37.5 37" fill="none" stroke="#53c7ff" stroke-width="3.2" stroke-linecap="round"/>
  <!-- Wordmark -->
  <text x="64" y="38" fill="#1e3a8a" font-family="Inter, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" font-size="27" font-weight="700" letter-spacing="-0.5">Tashkheesa</text>
</svg>
```

No Arabic text, no divider. Clean icon + English wordmark. viewBox is tight (310x56) so it renders perfectly at height=40px.

Also update the nav logo CSS in `public/css/styles.css`:

```css
.site-nav .nav-logo img {
  height: 38px;
  width: auto;
  max-width: 200px;
}
```

**Do the same for the white version** used in the footer. Replace `public/assets/brand/tashkheesa-logo-white.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 310 56" role="img" aria-labelledby="logo-title-w">
  <title id="logo-title-w">Tashkheesa</title>
  <defs>
    <linearGradient id="gw" x1="0" y1="2" x2="50" y2="54" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#60a5fa"/>
      <stop offset="1" stop-color="#3b82f6"/>
    </linearGradient>
  </defs>
  <rect x="2" y="3" width="50" height="50" rx="13" fill="url(#gw)"/>
  <path d="M14.5 28.5 l8.5 8.5 l19-19" fill="none" stroke="#fff" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M16.5 37 C16.5 44.5 21.5 48.5 27 48.5 C32.5 48.5 37.5 44.5 37.5 37" fill="none" stroke="#93c5fd" stroke-width="3.2" stroke-linecap="round"/>
  <text x="64" y="38" fill="#ffffff" font-family="Inter, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" font-size="27" font-weight="700" letter-spacing="-0.5">Tashkheesa</text>
</svg>
```

---

## FIX 2: Rewrite Services Page — Patient-Friendly Descriptions

Replace the ENTIRE `<main>` section of `public/services.html` (everything between `<main>` and `</main>`) with the content below.

Key changes:
- Hero subtitle speaks to the patient directly
- Every category description tells the patient WHEN they'd need this
- Every sub-service has a patient-friendly description explaining it like you'd explain to your mum
- Arabic translations for all data-en/data-ar attributes
- Bottom CTA updated to remove "50+ specialties" claim

```html
  <main>
    <!-- Page Hero -->
    <section class="page-hero">
      <div class="site-container">
        <h1 data-en="Our Services" data-ar="خدماتنا">Our Services</h1>
        <p data-en="Got test results and not sure what they mean? Upload them and get a clear explanation from a hospital-based specialist — in plain language you can actually understand." data-ar="عندك نتائج فحوصات ومش فاهم معناها؟ ارفعها واحصل على شرح واضح من متخصص في مستشفى — بلغة بسيطة تقدر تفهمها.">Got test results and not sure what they mean? Upload them and get a clear explanation from a hospital-based specialist — in plain language you can actually understand.</p>
      </div>
    </section>

    <!-- Services Categories -->
    <section class="site-section">
      <div class="site-container">
        <div class="services-categories">

          <!-- RADIOLOGY & IMAGING -->
          <div class="service-category expanded reveal">
            <div class="category-header" onclick="this.parentElement.classList.toggle('expanded')">
              <div class="category-icon-wrap">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              </div>
              <div class="category-info">
                <h3 data-en="Scans & Imaging" data-ar="الأشعة والتصوير الطبي">Scans & Imaging</h3>
                <p data-en="Had an X-ray, MRI, CT scan or ultrasound? Get a specialist to review your images and explain what they show." data-ar="عملت أشعة، رنين مغناطيسي، أشعة مقطعية أو سونار؟ خلّي متخصص يراجع الصور ويشرحلك النتائج.">Had an X-ray, MRI, CT scan or ultrasound? Get a specialist to review your images and explain what they show.</p>
              </div>
              <span class="category-toggle">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
              </span>
            </div>
            <div class="category-services">
              <div class="sub-service">
                <div>
                  <h4 data-en="X-Ray Review" data-ar="مراجعة أشعة سينية">X-Ray Review</h4>
                  <p data-en="Had a chest X-ray, bone scan or joint X-ray? Upload it and a senior radiologist will tell you exactly what they see — no medical jargon." data-ar="عملت أشعة صدر أو عظام أو مفاصل؟ ارفعها وطبيب أشعة كبير هيقولك بالظبط إيه اللي باين — بدون كلام طبي معقد.">Had a chest X-ray, bone scan or joint X-ray? Upload it and a senior radiologist will tell you exactly what they see — no medical jargon.</p>
                </div>
              </div>
              <div class="sub-service">
                <div>
                  <h4 data-en="MRI Review" data-ar="مراجعة رنين مغناطيسي">MRI Review</h4>
                  <p data-en="Got an MRI of your brain, back, knee or abdomen? A specialist will review the scan and give you a clear, written second opinion." data-ar="عندك رنين مغناطيسي للمخ أو الظهر أو الركبة أو البطن؟ متخصص هيراجع الأشعة ويديك رأي ثاني واضح ومكتوب.">Got an MRI of your brain, back, knee or abdomen? A specialist will review the scan and give you a clear, written second opinion.</p>
                </div>
              </div>
              <div class="sub-service">
                <div>
                  <h4 data-en="CT Scan Review" data-ar="مراجعة أشعة مقطعية">CT Scan Review</h4>
                  <p data-en="Had a CT scan and the report is confusing? Our radiologists break down what's normal, what needs attention, and what to discuss with your doctor." data-ar="عملت أشعة مقطعية والتقرير مش واضح؟ أطباء الأشعة عندنا هيوضحولك إيه الطبيعي، إيه اللي محتاج متابعة، وإيه تناقشه مع دكتورك.">Had a CT scan and the report is confusing? Our radiologists break down what's normal, what needs attention, and what to discuss with your doctor.</p>
                </div>
              </div>
              <div class="sub-service">
                <div>
                  <h4 data-en="Ultrasound Review" data-ar="مراجعة سونار">Ultrasound Review</h4>
                  <p data-en="Whether it's an abdominal, pregnancy or vascular ultrasound — upload your images and get a specialist's clear interpretation." data-ar="سواء سونار بطن أو حمل أو أوعية دموية — ارفع الصور واحصل على تفسير واضح من متخصص.">Whether it's an abdominal, pregnancy or vascular ultrasound — upload your images and get a specialist's clear interpretation.</p>
                </div>
              </div>
            </div>
          </div>

          <!-- PATHOLOGY & LAB -->
          <div class="service-category reveal">
            <div class="category-header" onclick="this.parentElement.classList.toggle('expanded')">
              <div class="category-icon-wrap">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 10c-.83 0-1.5-.67-1.5-1.5v-5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5z"/><path d="M20.5 10H19V8.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/><path d="M9.5 14c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5S8 21.33 8 20.5v-5c0-.83.67-1.5 1.5-1.5z"/><path d="M3.5 14H5v1.5C5 16.33 4.33 17 3.5 17S2 16.33 2 15.5 2.67 14 3.5 14z"/></svg>
              </div>
              <div class="category-info">
                <h3 data-en="Lab Results & Biopsies" data-ar="نتائج التحاليل والعينات">Lab Results & Biopsies</h3>
                <p data-en="Confused by your blood test results or biopsy report? A specialist will re-examine them and explain everything clearly." data-ar="محتار من نتائج تحاليل الدم أو تقرير العينة؟ متخصص هيراجعهم ويشرحلك كل حاجة بوضوح.">Confused by your blood test results or biopsy report? A specialist will re-examine them and explain everything clearly.</p>
              </div>
              <span class="category-toggle"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></span>
            </div>
            <div class="category-services">
              <div class="sub-service">
                <div>
                  <h4 data-en="Biopsy Second Opinion" data-ar="رأي ثاني للعينة">Biopsy Second Opinion</h4>
                  <p data-en="Had a tissue sample taken? A pathologist will re-examine the slides and give you a second opinion on the diagnosis — especially important before starting treatment." data-ar="أخدوا عينة من نسيج؟ طبيب أمراض هيعيد فحص الشرائح ويديك رأي ثاني في التشخيص — مهم جداً قبل بداية العلاج.">Had a tissue sample taken? A pathologist will re-examine the slides and give you a second opinion on the diagnosis — especially important before starting treatment.</p>
                </div>
              </div>
              <div class="sub-service">
                <div>
                  <h4 data-en="Blood Test Review" data-ar="مراجعة تحاليل الدم">Blood Test Review</h4>
                  <p data-en="Upload your blood work — CBC, thyroid, hormones, tumor markers, metabolic panel — and a specialist will explain what's normal, what's off, and what to do next." data-ar="ارفع تحاليل الدم — صورة دم، غدة درقية، هرمونات، دلالات أورام، وظائف كبد وكلى — ومتخصص هيشرحلك إيه الطبيعي وإيه المحتاج متابعة.">Upload your blood work — CBC, thyroid, hormones, tumor markers, metabolic panel — and a specialist will explain what's normal, what's off, and what to do next.</p>
                </div>
              </div>
              <div class="sub-service">
                <div>
                  <h4 data-en="Pap Smear & Cell Analysis" data-ar="مسحة عنق الرحم وتحليل الخلايا">Pap Smear & Cell Analysis</h4>
                  <p data-en="Got a Pap smear result that's unclear or concerning? A specialist will review the findings and help you understand your next steps." data-ar="نتيجة مسحة عنق الرحم مش واضحة أو مقلقة؟ متخصص هيراجع النتائج ويساعدك تفهم الخطوات الجاية.">Got a Pap smear result that's unclear or concerning? A specialist will review the findings and help you understand your next steps.</p>
                </div>
              </div>
            </div>
          </div>

          <!-- CARDIOLOGY -->
          <div class="service-category reveal">
            <div class="category-header" onclick="this.parentElement.classList.toggle('expanded')">
              <div class="category-icon-wrap">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
              </div>
              <div class="category-info">
                <h3 data-en="Heart & Cardiology" data-ar="القلب وأمراض القلب">Heart & Cardiology</h3>
                <p data-en="Had a heart test done? Upload your ECG, echo or stress test results and get them reviewed by a consultant cardiologist." data-ar="عملت فحص للقلب؟ ارفع نتائج رسم القلب أو الإيكو أو اختبار المجهود واحصل على مراجعة من استشاري قلب.">Had a heart test done? Upload your ECG, echo or stress test results and get them reviewed by a consultant cardiologist.</p>
              </div>
              <span class="category-toggle"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></span>
            </div>
            <div class="category-services">
              <div class="sub-service">
                <div>
                  <h4 data-en="ECG / Heart Rhythm Review" data-ar="مراجعة رسم القلب">ECG / Heart Rhythm Review</h4>
                  <p data-en="Had an ECG (heart tracing) done? A cardiologist will read it and explain whether your heart rhythm is normal or if something needs follow-up." data-ar="عملت رسم قلب؟ طبيب قلب هيقرأه ويوضحلك إذا كان نظم القلب طبيعي أو محتاج متابعة.">Had an ECG (heart tracing) done? A cardiologist will read it and explain whether your heart rhythm is normal or if something needs follow-up.</p>
                </div>
              </div>
              <div class="sub-service">
                <div>
                  <h4 data-en="Heart Ultrasound (Echo) Review" data-ar="مراجعة إيكو القلب">Heart Ultrasound (Echo) Review</h4>
                  <p data-en="Had an echocardiogram? A specialist will review how your heart valves and chambers look, and explain the results in simple terms." data-ar="عملت إيكو للقلب؟ متخصص هيراجع حالة الصمامات وغرف القلب ويشرحلك النتائج ببساطة.">Had an echocardiogram? A specialist will review how your heart valves and chambers look, and explain the results in simple terms.</p>
                </div>
              </div>
              <div class="sub-service">
                <div>
                  <h4 data-en="Stress Test Review" data-ar="مراجعة اختبار المجهود">Stress Test Review</h4>
                  <p data-en="Done a treadmill or stress test? A cardiologist will tell you what the results mean for your heart health and what to watch for." data-ar="عملت اختبار مجهود؟ طبيب قلب هيقولك النتائج معناها إيه لصحة قلبك وإيه اللي لازم تتابعه.">Done a treadmill or stress test? A cardiologist will tell you what the results mean for your heart health and what to watch for.</p>
                </div>
              </div>
              <div class="sub-service">
                <div>
                  <h4 data-en="Holter Monitor Review" data-ar="مراجعة هولتر">Holter Monitor Review</h4>
                  <p data-en="Wore a heart monitor for 24-48 hours? A specialist will analyze the full recording and flag anything that needs attention." data-ar="لبست جهاز مراقبة القلب لمدة ٢٤-٤٨ ساعة؟ متخصص هيحلل التسجيل الكامل ويحددلك أي حاجة محتاجة اهتمام.">Wore a heart monitor for 24-48 hours? A specialist will analyze the full recording and flag anything that needs attention.</p>
                </div>
              </div>
            </div>
          </div>

          <!-- ONCOLOGY -->
          <div class="service-category reveal">
            <div class="category-header" onclick="this.parentElement.classList.toggle('expanded')">
              <div class="category-icon-wrap">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>
              </div>
              <div class="category-info">
                <h3 data-en="Cancer & Oncology" data-ar="السرطان والأورام">Cancer & Oncology</h3>
                <p data-en="Facing a cancer diagnosis or unsure about a treatment plan? Get a second opinion from an oncology specialist before making big decisions." data-ar="عندك تشخيص سرطان أو مش متأكد من خطة العلاج؟ احصل على رأي ثاني من متخصص أورام قبل ما تاخد قرارات كبيرة.">Facing a cancer diagnosis or unsure about a treatment plan? Get a second opinion from an oncology specialist before making big decisions.</p>
              </div>
              <span class="category-toggle"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></span>
            </div>
            <div class="category-services">
              <div class="sub-service">
                <div>
                  <h4 data-en="PET/CT Scan Review" data-ar="مراجعة أشعة PET/CT">PET/CT Scan Review</h4>
                  <p data-en="Had a PET scan to check for cancer spread? A specialist will review it and explain whether the cancer has moved, responded to treatment, or stayed the same." data-ar="عملت أشعة PET لفحص انتشار السرطان؟ متخصص هيراجعها ويوضحلك إذا كان السرطان انتشر أو استجاب للعلاج أو ثابت.">Had a PET scan to check for cancer spread? A specialist will review it and explain whether the cancer has moved, responded to treatment, or stayed the same.</p>
                </div>
              </div>
              <div class="sub-service">
                <div>
                  <h4 data-en="Treatment Plan Second Opinion" data-ar="رأي ثاني في خطة العلاج">Treatment Plan Second Opinion</h4>
                  <p data-en="Been told you need chemo, radiation or surgery? Get an independent specialist to review your case and confirm whether the plan is right for you." data-ar="قالولك محتاج كيماوي أو إشعاع أو جراحة؟ خلّي متخصص مستقل يراجع حالتك ويتأكد إن الخطة مناسبة ليك.">Been told you need chemo, radiation or surgery? Get an independent specialist to review your case and confirm whether the plan is right for you.</p>
                </div>
              </div>
              <div class="sub-service">
                <div>
                  <h4 data-en="Cancer Diagnosis Review" data-ar="مراجعة تشخيص السرطان">Cancer Diagnosis Review</h4>
                  <p data-en="Not sure about a cancer diagnosis? Our oncologists will review your scans, biopsy and lab work to give you a clear, expert second opinion." data-ar="مش متأكد من تشخيص السرطان؟ أطباء الأورام عندنا هيراجعوا الأشعة والعينة والتحاليل ويدوك رأي ثاني واضح ومتخصص.">Not sure about a cancer diagnosis? Our oncologists will review your scans, biopsy and lab work to give you a clear, expert second opinion.</p>
                </div>
              </div>
              <div class="sub-service">
                <div>
                  <h4 data-en="Genetic & Hereditary Cancer Risk" data-ar="الخطر الجيني والوراثي للسرطان">Genetic & Hereditary Cancer Risk</h4>
                  <p data-en="Cancer runs in your family? A specialist can review genetic test results and help you understand your personal risk and screening options." data-ar="السرطان منتشر في عيلتك؟ متخصص يقدر يراجع نتائج الفحوصات الجينية ويساعدك تفهم مستوى الخطر عليك وخيارات الفحص المبكر.">Cancer runs in your family? A specialist can review genetic test results and help you understand your personal risk and screening options.</p>
                </div>
              </div>
            </div>
          </div>

          <!-- NEUROLOGY -->
          <div class="service-category reveal">
            <div class="category-header" onclick="this.parentElement.classList.toggle('expanded')">
              <div class="category-icon-wrap">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 017 7c0 5-7 13-7 13S5 14 5 9a7 7 0 017-7z"/><circle cx="12" cy="9" r="2.5"/></svg>
              </div>
              <div class="category-info">
                <h3 data-en="Brain & Neurology" data-ar="المخ والأعصاب">Brain & Neurology</h3>
                <p data-en="Got a brain scan or nerve test you don't understand? A neurologist will review it and explain what's going on in clear, simple terms." data-ar="عندك أشعة مخ أو فحص أعصاب مش فاهمه؟ طبيب أعصاب هيراجعه ويشرحلك الموضوع بكلام بسيط وواضح.">Got a brain scan or nerve test you don't understand? A neurologist will review it and explain what's going on in clear, simple terms.</p>
              </div>
              <span class="category-toggle"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></span>
            </div>
            <div class="category-services">
              <div class="sub-service">
                <div>
                  <h4 data-en="Brain MRI Review" data-ar="مراجعة رنين المخ">Brain MRI Review</h4>
                  <p data-en="Had a brain MRI and the report is full of terms you don't recognise? A neurologist will explain what's normal and what might need follow-up." data-ar="عملت رنين للمخ والتقرير مليان مصطلحات مش فاهمها؟ طبيب أعصاب هيوضحلك إيه الطبيعي وإيه ممكن يحتاج متابعة.">Had a brain MRI and the report is full of terms you don't recognise? A neurologist will explain what's normal and what might need follow-up.</p>
                </div>
              </div>
              <div class="sub-service">
                <div>
                  <h4 data-en="EEG & Nerve Test Review" data-ar="مراجعة رسم المخ وفحص الأعصاب">EEG & Nerve Test Review</h4>
                  <p data-en="Had an EEG (brain wave test) or EMG (nerve/muscle test)? A specialist will interpret the results and tell you what they mean for your condition." data-ar="عملت رسم مخ أو فحص أعصاب/عضلات؟ متخصص هيقرأ النتائج ويقولك معناها إيه بالنسبة لحالتك.">Had an EEG (brain wave test) or EMG (nerve/muscle test)? A specialist will interpret the results and tell you what they mean for your condition.</p>
                </div>
              </div>
              <div class="sub-service">
                <div>
                  <h4 data-en="Spine & Back MRI Review" data-ar="مراجعة رنين العمود الفقري">Spine & Back MRI Review</h4>
                  <p data-en="Got back pain and an MRI showing disc problems or nerve compression? A specialist will review it and help you understand your treatment options." data-ar="عندك ألم في الظهر ورنين بيبين مشاكل في الديسك أو ضغط على الأعصاب؟ متخصص هيراجعه ويساعدك تفهم خيارات العلاج.">Got back pain and an MRI showing disc problems or nerve compression? A specialist will review it and help you understand your treatment options.</p>
                </div>
              </div>
            </div>
          </div>

          <!-- ORTHOPEDICS -->
          <div class="service-category reveal">
            <div class="category-header" onclick="this.parentElement.classList.toggle('expanded')">
              <div class="category-icon-wrap">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
              </div>
              <div class="category-info">
                <h3 data-en="Bones & Joints" data-ar="العظام والمفاصل">Bones & Joints</h3>
                <p data-en="Got a bone or joint scan? Whether it's a fracture, arthritis or post-surgery check, a specialist will review your images and explain what they see." data-ar="عندك أشعة عظام أو مفاصل؟ سواء كسر أو خشونة أو متابعة بعد عملية، متخصص هيراجع الصور ويشرحلك الموقف.">Got a bone or joint scan? Whether it's a fracture, arthritis or post-surgery check, a specialist will review your images and explain what they see.</p>
              </div>
              <span class="category-toggle"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></span>
            </div>
            <div class="category-services">
              <div class="sub-service">
                <div>
                  <h4 data-en="Joint X-Ray & MRI Review" data-ar="مراجعة أشعة ورنين المفاصل">Joint X-Ray & MRI Review</h4>
                  <p data-en="Knee pain? Shoulder injury? Hip problems? Upload your joint scans and get a specialist's opinion on what's causing the pain and what to do about it." data-ar="ألم في الركبة؟ إصابة في الكتف؟ مشاكل في الفخذ؟ ارفع أشعة المفاصل واحصل على رأي متخصص في سبب الألم وإزاي تتعامل معاه.">Knee pain? Shoulder injury? Hip problems? Upload your joint scans and get a specialist's opinion on what's causing the pain and what to do about it.</p>
                </div>
              </div>
              <div class="sub-service">
                <div>
                  <h4 data-en="Back & Spine Review" data-ar="مراجعة الظهر والعمود الفقري">Back & Spine Review</h4>
                  <p data-en="Slipped disc, spinal stenosis or scoliosis? A specialist will review your spine imaging and explain your condition and options clearly." data-ar="انزلاق غضروفي، ضيق في القناة الشوكية أو اعوجاج في العمود الفقري؟ متخصص هيراجع الأشعة ويشرحلك حالتك وخياراتك بوضوح.">Slipped disc, spinal stenosis or scoliosis? A specialist will review your spine imaging and explain your condition and options clearly.</p>
                </div>
              </div>
              <div class="sub-service">
                <div>
                  <h4 data-en="Fracture Assessment" data-ar="تقييم الكسور">Fracture Assessment</h4>
                  <p data-en="Broken bone? A specialist will review your X-rays, confirm the type of fracture, and advise on whether surgery is needed or it can heal on its own." data-ar="عندك كسر؟ متخصص هيراجع الأشعة ويأكد نوع الكسر وينصحك إذا كان محتاج جراحة أو هيلتئم لوحده.">Broken bone? A specialist will review your X-rays, confirm the type of fracture, and advise on whether surgery is needed or it can heal on its own.</p>
                </div>
              </div>
              <div class="sub-service">
                <div>
                  <h4 data-en="Post-Surgery Check" data-ar="فحص بعد العملية">Post-Surgery Check</h4>
                  <p data-en="Had bone or joint surgery? Upload your follow-up scans and a specialist will check that everything is healing properly and the hardware is in place." data-ar="عملت عملية عظام أو مفاصل؟ ارفع أشعة المتابعة ومتخصص هيتأكد إن كل حاجة بتلتئم صح والشرائح والمسامير في مكانها.">Had bone or joint surgery? Upload your follow-up scans and a specialist will check that everything is healing properly and the hardware is in place.</p>
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </section>

    <!-- CTA -->
    <section class="site-section bg-dark cta-section">
      <div class="site-container">
        <h2 class="reveal" data-en="Don't See Your Specialty?" data-ar="مش لاقي تخصصك؟">Don't See Your Specialty?</h2>
        <p class="reveal" style="color: rgba(255,255,255,0.8);" data-en="We're adding more specialties regularly. If you need a review in a different area, reach out and we'll connect you with the right specialist." data-ar="بنضيف تخصصات جديدة باستمرار. لو محتاج مراجعة في مجال تاني، تواصل معانا وهنوصلك بالمتخصص المناسب.">We're adding more specialties regularly. If you need a review in a different area, reach out and we'll connect you with the right specialist.</p>
        <div style="display:flex; gap:16px; justify-content:center; flex-wrap:wrap;">
          <span class="btn btn-coming-soon disabled reveal" style="opacity:0.6; cursor:default; pointer-events:none; background:#94a3b8; color:#fff; border:none;" data-en="Coming Soon" data-ar="قريباً">Coming Soon</span>
          <a href="/site/contact.html" class="btn-outline reveal" data-en="Contact Us" data-ar="تواصل معنا">Contact Us</a>
        </div>
      </div>
    </section>
  </main>
```

---

## COMMIT

```
fix: remove Arabic from logo SVG, rewrite services page with patient-friendly descriptions
```
