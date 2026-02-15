# TASHKHEESA PRE-LAUNCH FIXES — Claude Code Prompt
## Execute ALL sections in order. Commit after each section.

**Project root:** `/Users/ziadelwahsh/Desktop/tashkheesa-portal`
**Stack:** Node.js / Express / EJS / SQLite (better-sqlite3)
**Static site pages:** `public/index.html`, `public/services.html`, `public/about.html`, `public/doctors.html`, `public/contact.html`
**Portal views:** `src/views/*.ejs`
**Routes:** `src/routes/*.js`
**i18n:** `src/i18n.js` (flat key-value) + `src/locales/en.json` & `src/locales/ar.json` (nested JSON)

---

## SECTION 1: FIX CONTACT INFO — EGYPT, NOT SAUDI ARABIA

### Problem
All public HTML pages show "Riyadh, Saudi Arabia" and "+966 50 000 0000" in the footer. The contact page also shows Saudi info and incorrect business hours ("Sunday-Thursday 9AM-6PM, Friday-Saturday: Closed"). Tashkheesa is based in **Egypt** and operates **24/7**.

### Fix — across ALL 5 HTML files (`public/index.html`, `public/services.html`, `public/about.html`, `public/doctors.html`, `public/contact.html`):

1. **Footer contact section** — find and replace in ALL files:
   - `+966 50 000 0000` → `+20 100 000 0000`
   - `Riyadh, Saudi Arabia` → `Cairo, Egypt`

2. **Contact page (`public/contact.html`) — contact info card specifically:**
   - Phone: `+966 50 000 0000` → `+20 100 000 0000`
   - Location: `Riyadh, Saudi Arabia` → `Cairo, Egypt`
   - Business Hours: Replace the entire hours block:
     ```html
     <!-- OLD -->
     <p>Sunday - Thursday: 9AM - 6PM</p>
     <p>Friday - Saturday: Closed</p>
     <p style="margin-top: 4px; font-size: 13px; color: var(--accent-teal);">Online consultations available 24/7</p>
     <!-- NEW -->
     <p>Available 24/7</p>
     <p style="margin-top: 4px; font-size: 13px; color: var(--accent-teal);">We never close — submit cases or reach support anytime.</p>
     ```

**Verification:** grep across all public HTML files for "Saudi", "Riyadh", "966", "Closed", "9AM" — there should be zero matches after this fix.

---

## SECTION 2: ADD "SIGN IN" LINK TO WEBSITE NAVBAR

### Problem
The website navigation bar has Home, Services, About, Doctors, Contact, and a "Coming Soon" CTA — but no link to the patient portal login page.

### Fix — in ALL 5 HTML files (`public/index.html`, `public/services.html`, `public/about.html`, `public/doctors.html`, `public/contact.html`):

Find the `<div class="nav-links">` section. Add a "Sign In" link **before** the `<div class="nav-cta">`:

```html
<div class="nav-links">
  <a href="/site/">Home</a>
  <a href="/site/services.html">Services</a>
  <a href="/site/about.html">About</a>
  <a href="/site/doctors.html">Doctors</a>
  <a href="/site/contact.html">Contact</a>
  <!-- ADD THIS LINE -->
  <a href="/login" class="nav-signin">Sign In</a>
  <div class="nav-cta">
    <span class="btn btn-coming-soon btn-sm disabled" style="opacity: 0.7; cursor: default; pointer-events: none;">Coming Soon</span>
  </div>
</div>
```

Add this CSS to `public/css/styles.css` (or wherever the site nav styles live — check `public/site/css/styles.css` too):

```css
.nav-signin {
  font-weight: 600;
  color: var(--deep-blue, #1e3a8a);
  border: 2px solid var(--deep-blue, #1e3a8a);
  padding: 6px 16px;
  border-radius: 8px;
  transition: all 0.2s ease;
  font-size: 14px;
}
.nav-signin:hover {
  background: var(--deep-blue, #1e3a8a);
  color: #fff;
}
```

Also ensure the mobile hamburger menu includes the Sign In link.

---

## SECTION 3: FIX LOGO ARABIC TEXT STACKING

### Problem
The Arabic text ("تشخيصة") is rendering BELOW the logo image instead of beside it in both the navbar and footer, making it look broken.

### Fix

Check the logo SVG files:
- `public/assets/brand/tashkheesa-logo-primary.svg` (navbar)
- `public/assets/brand/tashkheesa-logo-white.svg` (footer)

If the Arabic text is baked INTO the SVG, edit the SVG to arrange text beside the icon, not below.

If the Arabic text is rendered via CSS/HTML outside the SVG, fix the CSS:

```css
.nav-logo {
  display: flex;
  align-items: center;
  gap: 8px;
  text-decoration: none;
}
.nav-logo img {
  height: 40px;
  width: auto;
}

.footer-logo {
  height: 36px;
  width: auto;
  margin-bottom: 16px;
}
```

The key issue is likely the SVG itself has a stacked layout internally. Open each SVG file and check if there's a `<text>` element for Arabic — if so, adjust its `x`/`y` coordinates to sit beside the icon, not below. Or if the Arabic is coming from a CSS `::after` or a `<span>`, set the parent to `display: flex; align-items: center; gap: 8px;`.

**Investigate first** — look at the actual SVG source and the CSS that styles `.nav-logo` and `.footer-logo` to understand where the Arabic text is coming from, then fix accordingly.

---

## SECTION 4: REDESIGN SERVICES PAGE WITH SUB-SERVICES

### Problem
The services page (`public/services.html`) shows only 6 flat service cards (Radiology, Pathology, Cardiology, Oncology, Neurology, Orthopedics). This looks sparse and doesn't show the actual sub-services offered.

### Fix — Redesign to expandable service categories with sub-services

Replace the current flat grid with expandable category cards. Each main service should show its sub-services. Use this structure:

```html
<div class="services-categories">

  <!-- RADIOLOGY & IMAGING -->
  <div class="service-category reveal">
    <div class="category-header" onclick="this.parentElement.classList.toggle('expanded')">
      <div class="category-icon-wrap">
        <!-- keep existing SVG icon -->
      </div>
      <div class="category-info">
        <h3>Radiology & Imaging</h3>
        <p>Comprehensive diagnostic imaging review by senior radiologists</p>
      </div>
      <span class="category-toggle">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </span>
    </div>
    <div class="category-services">
      <div class="sub-service">
        <img src="/assets/chest_xray.png" alt="X-Ray Review" class="sub-service-img" />
        <div>
          <h4>X-Ray Review</h4>
          <p>Chest, bone and joint X-ray interpretation</p>
        </div>
      </div>
      <div class="sub-service">
        <img src="/assets/imaging.png" alt="MRI Review" class="sub-service-img" />
        <div>
          <h4>MRI Review</h4>
          <p>Brain, spine, musculoskeletal and abdominal MRI</p>
        </div>
      </div>
      <div class="sub-service">
        <img src="/assets/chest_scan.png" alt="CT Scan Review" class="sub-service-img" />
        <div>
          <h4>CT Scan Review</h4>
          <p>Full-body, chest, abdomen and head CT analysis</p>
        </div>
      </div>
      <div class="sub-service">
        <img src="/assets/ultrasound.png" alt="Ultrasound Review" class="sub-service-img" />
        <div>
          <h4>Ultrasound Review</h4>
          <p>Abdominal, obstetric, vascular and musculoskeletal ultrasound</p>
        </div>
      </div>
    </div>
  </div>

  <!-- PATHOLOGY & LAB -->
  <div class="service-category reveal">
    <div class="category-header" onclick="this.parentElement.classList.toggle('expanded')">
      <div class="category-icon-wrap"><!-- keep existing SVG --></div>
      <div class="category-info">
        <h3>Pathology & Laboratory</h3>
        <p>Expert re-evaluation of lab results and tissue samples</p>
      </div>
      <span class="category-toggle"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></span>
    </div>
    <div class="category-services">
      <div class="sub-service">
        <img src="/assets/histo_report.png" alt="Histopathology" class="sub-service-img" />
        <div>
          <h4>Histopathology Review</h4>
          <p>Biopsy and tissue sample re-evaluation</p>
        </div>
      </div>
      <div class="sub-service">
        <img src="/assets/blood_tests.png" alt="Blood Work" class="sub-service-img" />
        <div>
          <h4>Blood Work Analysis</h4>
          <p>CBC, metabolic panel, hormones, tumor markers</p>
        </div>
      </div>
      <div class="sub-service">
        <img src="/assets/lab_pathology.png" alt="Lab Pathology" class="sub-service-img" />
        <div>
          <h4>Cytology & Special Stains</h4>
          <p>Pap smears, fluid cytology and immunohistochemistry</p>
        </div>
      </div>
    </div>
  </div>

  <!-- CARDIOLOGY -->
  <div class="service-category reveal">
    <div class="category-header" onclick="this.parentElement.classList.toggle('expanded')">
      <div class="category-icon-wrap"><!-- keep existing SVG --></div>
      <div class="category-info">
        <h3>Cardiology</h3>
        <p>Cardiac imaging and diagnostic test review by consultant cardiologists</p>
      </div>
      <span class="category-toggle"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></span>
    </div>
    <div class="category-services">
      <div class="sub-service">
        <img src="/assets/ecg.png" alt="ECG" class="sub-service-img" />
        <div>
          <h4>ECG / EKG Review</h4>
          <p>12-lead ECG interpretation and rhythm analysis</p>
        </div>
      </div>
      <div class="sub-service">
        <div>
          <h4>Echocardiography Review</h4>
          <p>Transthoracic and transesophageal echo analysis</p>
        </div>
      </div>
      <div class="sub-service">
        <div>
          <h4>Stress Test Review</h4>
          <p>Exercise and pharmacological stress test evaluation</p>
        </div>
      </div>
      <div class="sub-service">
        <div>
          <h4>Holter Monitor Review</h4>
          <p>24-48 hour heart rhythm monitoring analysis</p>
        </div>
      </div>
    </div>
  </div>

  <!-- ONCOLOGY -->
  <div class="service-category reveal">
    <div class="category-header" onclick="this.parentElement.classList.toggle('expanded')">
      <div class="category-icon-wrap"><!-- keep existing SVG --></div>
      <div class="category-info">
        <h3>Oncology</h3>
        <p>Cancer diagnosis, staging and multidisciplinary treatment review</p>
      </div>
      <span class="category-toggle"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></span>
    </div>
    <div class="category-services">
      <div class="sub-service">
        <img src="/assets/pet_oncology.png" alt="PET Scan" class="sub-service-img" />
        <div>
          <h4>PET/CT Scan Review</h4>
          <p>Staging, restaging and treatment response assessment</p>
        </div>
      </div>
      <div class="sub-service">
        <div>
          <h4>Tumor Board Second Opinion</h4>
          <p>Multidisciplinary case review for complex cancers</p>
        </div>
      </div>
      <div class="sub-service">
        <div>
          <h4>Treatment Plan Review</h4>
          <p>Chemotherapy, radiation and surgical plan evaluation</p>
        </div>
      </div>
      <div class="sub-service">
        <img src="/assets/genetic_testing.png" alt="Genetic Testing" class="sub-service-img" />
        <div>
          <h4>Genetic Testing Review</h4>
          <p>Hereditary cancer risk and genomic profiling</p>
        </div>
      </div>
    </div>
  </div>

  <!-- NEUROLOGY -->
  <div class="service-category reveal">
    <div class="category-header" onclick="this.parentElement.classList.toggle('expanded')">
      <div class="category-icon-wrap"><!-- keep existing SVG --></div>
      <div class="category-info">
        <h3>Neurology</h3>
        <p>Brain and nervous system diagnostic review by senior neurologists</p>
      </div>
      <span class="category-toggle"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></span>
    </div>
    <div class="category-services">
      <div class="sub-service">
        <div>
          <h4>Brain MRI Review</h4>
          <p>Structural and functional brain imaging analysis</p>
        </div>
      </div>
      <div class="sub-service">
        <img src="/assets/eeg_emg.png" alt="EEG/EMG" class="sub-service-img" />
        <div>
          <h4>EEG / EMG Review</h4>
          <p>Electroencephalography and electromyography interpretation</p>
        </div>
      </div>
      <div class="sub-service">
        <div>
          <h4>Spine & Nerve MRI</h4>
          <p>Spinal cord, nerve root and disc analysis</p>
        </div>
      </div>
    </div>
  </div>

  <!-- ORTHOPEDICS -->
  <div class="service-category reveal">
    <div class="category-header" onclick="this.parentElement.classList.toggle('expanded')">
      <div class="category-icon-wrap"><!-- keep existing SVG --></div>
      <div class="category-info">
        <h3>Orthopedics</h3>
        <p>Bone, joint and spine imaging with specialist interpretation</p>
      </div>
      <span class="category-toggle"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></span>
    </div>
    <div class="category-services">
      <div class="sub-service">
        <div>
          <h4>Joint X-Ray & MRI Review</h4>
          <p>Knee, hip, shoulder and ankle imaging</p>
        </div>
      </div>
      <div class="sub-service">
        <div>
          <h4>Spine Imaging Review</h4>
          <p>Disc herniation, stenosis and deformity analysis</p>
        </div>
      </div>
      <div class="sub-service">
        <div>
          <h4>Fracture Assessment</h4>
          <p>Fracture classification and treatment planning</p>
        </div>
      </div>
      <div class="sub-service">
        <div>
          <h4>Post-Surgical Follow-up</h4>
          <p>Hardware placement, healing and complication review</p>
        </div>
      </div>
    </div>
  </div>

</div>
```

### CSS for the new services layout

Add to the site stylesheet:

```css
.services-categories {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 900px;
  margin: 0 auto;
}
.service-category {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  overflow: hidden;
  transition: box-shadow 0.2s ease;
}
.service-category:hover {
  box-shadow: 0 4px 12px rgba(0,0,0,0.08);
}
.category-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px 24px;
  cursor: pointer;
  user-select: none;
}
.category-icon-wrap {
  width: 48px;
  height: 48px;
  background: #eff6ff;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.category-info {
  flex: 1;
}
.category-info h3 {
  font-size: 18px;
  font-weight: 700;
  color: #1e293b;
  margin: 0 0 4px;
}
.category-info p {
  font-size: 14px;
  color: #64748b;
  margin: 0;
}
.category-toggle {
  transition: transform 0.2s ease;
  color: #94a3b8;
}
.service-category.expanded .category-toggle {
  transform: rotate(180deg);
}
.category-services {
  display: none;
  padding: 0 24px 20px;
  gap: 12px;
}
.service-category.expanded .category-services {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
}
.sub-service {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px;
  background: #f8fafc;
  border-radius: 8px;
  border: 1px solid #f1f5f9;
}
.sub-service-img {
  width: 48px;
  height: 48px;
  border-radius: 8px;
  object-fit: cover;
  flex-shrink: 0;
}
.sub-service h4 {
  font-size: 15px;
  font-weight: 600;
  color: #1e293b;
  margin: 0 0 4px;
}
.sub-service p {
  font-size: 13px;
  color: #64748b;
  margin: 0;
}
@media (max-width: 640px) {
  .service-category.expanded .category-services {
    grid-template-columns: 1fr;
  }
  .category-header {
    padding: 16px;
  }
}
```

### JS for toggle behavior

Add to `site-main.js` or inline in services.html:

```javascript
document.addEventListener('DOMContentLoaded', function() {
  // Auto-expand first category
  var first = document.querySelector('.service-category');
  if (first) first.classList.add('expanded');
});
```

**Remove** the old `services-grid` of 6 flat cards and the SAR pricing. Do NOT show prices on the services page — they will see pricing when they start a case.

---

## SECTION 5: FIX ARABIC TRANSLATION (i18n)

### Problem
Arabic translation doesn't work on any pages. Two i18n systems exist:
1. `src/i18n.js` — flat key-value (`t('auth.login.title')`)
2. `src/locales/ar.json` + `src/locales/en.json` — nested JSON

The portal EJS views use `t()` from `src/i18n.js` but many strings are still hardcoded in English. The static HTML site pages have NO i18n at all.

### Fix — Portal pages (EJS)

**5A. Ensure language detection works in every route:**

Every route handler must call `getLang(req, res)` and pass `lang` and `isAr` to the view. Check all route files (`patient.js`, `doctor.js`, `admin.js`, `superadmin.js`, `appointments.js`, `messaging.js`, `prescriptions.js`, `reviews.js`, `referrals.js`, `medical_records.js`, `onboarding.js`) and verify:
- Each has a local `getLang` function: `function getLang(req, res) { const lang = req.query?.lang || req.user?.lang || 'en'; res.locals.lang = lang; return lang; }`
- Every `res.render()` call includes `lang` and `isAr: lang === 'ar'` in the data object
- The `t` function from `src/i18n.js` is imported and passed to views as `t`

**5B. Ensure the language switcher works:**

In `src/views/partials/header.ejs` (or wherever the portal header is), there should be a language toggle button. When clicked, it should:
1. Set `?lang=ar` or `?lang=en` as a query param
2. OR set a cookie `lang=ar`/`lang=en` that persists across pages
3. The middleware should read this cookie/query on every request

Check `src/middleware.js` — there should be a middleware that reads the `lang` cookie/query and sets `res.locals.lang`. If it doesn't exist, add it:

```javascript
// Language detection middleware
app.use(function(req, res, next) {
  var lang = req.query.lang || req.cookies?.lang || req.user?.lang || 'en';
  if (lang !== 'en' && lang !== 'ar') lang = 'en';
  res.locals.lang = lang;
  res.locals.isAr = lang === 'ar';
  res.locals.dir = lang === 'ar' ? 'rtl' : 'ltr';
  // Set cookie so it persists
  if (req.query.lang) {
    res.cookie('lang', lang, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true });
  }
  next();
});
```

This must run BEFORE any route handlers. Add it in `src/server.js` after cookie-parser but before route mounting.

**5C. Add `dir` attribute to HTML:**

In `src/views/partials/header.ejs`, ensure the `<html>` tag includes:
```html
<html lang="<%= lang || 'en' %>" dir="<%= (lang === 'ar') ? 'rtl' : 'ltr' %>">
```

**5D. Static site pages (HTML) — SKIP for now:**

The static HTML pages (`public/*.html`) are English-only. Arabic translation for these will be a separate task (likely converting them to EJS or adding a JS-based language switcher). Do NOT change the static pages in this section.

---

## SECTION 6: FIX PRESCRIPTIONS FLOW

### Problem
The current `doctor_prescribe.ejs` has a form where doctors type medication names, dosages, etc. This is WRONG. The actual flow is:
- Doctor writes prescription on **Shifa Hospital** letterhead/pad (physical paper)
- Doctor scans or photographs the prescription
- Doctor uploads the scanned file to the patient's case
- Patient receives the uploaded prescription file

### Fix

**6A. Replace the prescription form:**

Rewrite `src/views/doctor_prescribe.ejs` to be a **file upload form** instead of a medication entry form:

```html
<h2><%= isAr ? 'رفع وصفة طبية' : 'Upload Prescription' %></h2>
<p class="text-muted"><%= isAr ? 'اكتب الوصفة على ورق المستشفى ثم ارفع صورة أو ملف PDF' : 'Write the prescription on hospital letterhead, then upload a photo or PDF' %></p>

<form action="/portal/doctor/case/<%= order.id %>/prescribe" method="POST" enctype="multipart/form-data">
  <div class="form-group">
    <label><%= isAr ? 'ملف الوصفة (صورة أو PDF)' : 'Prescription file (image or PDF)' %></label>
    <input type="file" name="prescription_file" accept="image/*,.pdf" required class="form-control" />
    <small class="text-muted"><%= isAr ? 'JPG, PNG, أو PDF — حد أقصى 10 ميجابايت' : 'JPG, PNG, or PDF — max 10MB' %></small>
  </div>

  <div class="form-group">
    <label><%= isAr ? 'ملاحظات للمريض (اختياري)' : 'Notes for patient (optional)' %></label>
    <textarea name="notes" rows="3" class="form-control" placeholder="<%= isAr ? 'أي تعليمات إضافية...' : 'Any additional instructions...' %>"></textarea>
  </div>

  <button type="submit" class="btn btn-primary">
    <%= isAr ? 'رفع الوصفة' : 'Upload Prescription' %>
  </button>
</form>
```

**6B. Update the POST handler in `src/routes/prescriptions.js`:**

The POST handler for `/portal/doctor/case/:caseId/prescribe` should:
1. Accept a `multipart/form-data` upload (use `multer` — it's likely already in the project)
2. Save the file to `uploads/prescriptions/` or `public/prescriptions/`
3. Create a record in the `prescriptions` table with `pdf_url` pointing to the uploaded file
4. Set `medications` to `'[]'` (empty — not used in the upload flow)
5. Optionally save the `notes` field
6. Auto-create a medical record entry for the patient
7. Redirect back to the case detail page

**6C. Patient prescription view:**

Update `src/views/patient_prescription_detail.ejs` to show:
- The uploaded prescription image/PDF (embedded viewer or download link)
- Doctor's notes if any
- Download button
- Date uploaded

Remove any "medication list" table from this view — prescriptions are now just uploaded files.

---

## SECTION 7: FIX MESSAGING FLOW

### Problem
The messaging system has routes (`src/routes/messaging.js`) and an `ensureConversation()` helper, but:
- No conversation is auto-created when a doctor is assigned to a case
- There's no "Message Doctor" button on the patient case detail page
- There's no "Message Patient" button on the doctor case detail page
- The Messages page has no way to start a new chat

### Fix

**7A. Auto-create conversation on case assignment:**

Find everywhere a doctor is assigned to a case. This happens when:
- Admin/superadmin assigns a doctor in `src/routes/admin.js` or `src/routes/superadmin.js`
- Doctor accepts a case in `src/routes/doctor.js`
- Auto-assignment in `src/assign.js`

In EACH of those locations, after the doctor_id is set on the order, call:
```javascript
const { ensureConversation } = require('./messaging'); // or adjust path
ensureConversation(orderId, patientId, doctorId);
```

If `ensureConversation` is not exported from `messaging.js`, export it:
```javascript
module.exports = router;
module.exports.ensureConversation = ensureConversation;
```

**7B. Add "Message Doctor" button on patient case detail:**

In `src/views/patient_order.ejs`, add a "Message Doctor" button that links to the conversation for this case. In the route handler that renders `patient_order.ejs`, query for the conversation:

```javascript
var conversation = safeGet(
  'SELECT id FROM conversations WHERE order_id = ?',
  [orderId], null
);
```

Pass `conversationId: conversation ? conversation.id : null` to the view. In the view:

```html
<% if (conversationId) { %>
  <a href="/portal/messages/<%= conversationId %>" class="btn btn-outline">
    <svg ...message icon...></svg>
    <%= isAr ? 'مراسلة الطبيب' : 'Message Doctor' %>
  </a>
<% } else if (order.doctor_id) { %>
  <span class="text-muted"><%= isAr ? 'جاري تهيئة المحادثة...' : 'Setting up chat...' %></span>
<% } %>
```

**7C. Add "Message Patient" button on doctor case detail:**

Same approach in `src/views/portal_doctor_case.ejs`:

```html
<% if (conversationId) { %>
  <a href="/portal/messages/<%= conversationId %>" class="btn btn-outline">
    <%= isAr ? 'مراسلة المريض' : 'Message Patient' %>
  </a>
<% } %>
```

**7D. Messages page — show conversation list:**

The GET handler for `/portal/messages` should query conversations for the current user (as patient or doctor), joined with orders and users, to show: case reference, other party's name, last message preview, unread count, and last message timestamp. Each item links to `/portal/messages/:conversationId`.

---

## SECTION 8: CURRENCY DETECTION FROM IP

### Problem
`src/geo.js` already has `detectCountry()` and `countryToCurrency()` with a full `COUNTRY_CURRENCY_MAP` including USD. But it's not being used on the order/case creation pages to auto-set currency.

### Fix

**8A. Apply geo detection in the order flow:**

In `src/routes/order_flow.js` (or wherever the new case / order start page is rendered), use geo detection:

```javascript
const { detectCountry, countryToCurrency } = require('../geo');

// In the GET handler for the order start page:
var detectedCountry = detectCountry(req);
var detectedCurrency = countryToCurrency(detectedCountry);
// Pass to view: detectedCountry, detectedCurrency
```

In the view, pre-select the detected currency and allow the user to change it.

**8B. Apply geo detection in patient registration:**

In `src/routes/auth.js`, when rendering the registration page, detect country from IP and pre-fill the country field.

**8C. Ensure Render passes geo headers:**

On Render, the `cf-ipcountry` header won't be available unless you're behind Cloudflare. If not using Cloudflare, add a free IP geolocation lookup. Check if `req.ip` is available and use a lightweight lookup:

```javascript
// In geo.js, add IP-based fallback using a free API or local DB
// For now, the header-based detection + user profile fallback is sufficient
// The user can also manually select their country during registration
```

---

## SECTION 9: VERIFICATION CHECKLIST

After all changes, verify:

**Static site pages:**
- [ ] ALL 5 HTML pages show "Cairo, Egypt" and "+20 100 000 0000" in footer
- [ ] Contact page shows "Available 24/7" — no "Closed" anywhere
- [ ] ALL 5 HTML pages have "Sign In" link in navbar
- [ ] Logo renders properly (Arabic text beside, not below)
- [ ] Services page shows expandable categories with sub-services
- [ ] No "SAR" pricing visible on services page
- [ ] grep for "Saudi|Riyadh|966|Closed|9AM" across public/*.html returns zero

**Portal pages:**
- [ ] Language switcher toggles between EN/AR and persists across pages
- [ ] `<html>` tag has correct `dir="rtl"` when Arabic is selected
- [ ] Key portal pages show Arabic text when `?lang=ar` is appended

**Prescriptions:**
- [ ] Doctor case detail has "Upload Prescription" button
- [ ] Clicking it shows a file upload form (not medication entry)
- [ ] Uploading a file creates a prescription record
- [ ] Patient can see and download the uploaded prescription

**Messaging:**
- [ ] When a doctor is assigned to a case, a conversation is auto-created
- [ ] Patient case detail shows "Message Doctor" button
- [ ] Doctor case detail shows "Message Patient" button
- [ ] Messages page lists active conversations with preview

**Currency:**
- [ ] Order start page detects country and pre-selects currency
- [ ] USD is available as a currency option

---

## COMMIT STRATEGY
1. `fix(contact): Egypt location, 24/7 hours, correct phone number`
2. `feat(nav): add Sign In link to website navbar`
3. `fix(logo): fix Arabic text stacking in logo`
4. `feat(services): redesign with expandable sub-service categories`
5. `fix(i18n): language middleware, cookie persistence, RTL support`
6. `refactor(prescriptions): file upload flow instead of medication form`
7. `feat(messaging): auto-create conversations, message buttons on case detail`
8. `feat(geo): IP-based currency detection on order flow`
