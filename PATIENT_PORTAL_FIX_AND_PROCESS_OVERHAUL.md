# TASHKHEESA — Patient Portal UI Fix + Process Flow Overhaul
## For Claude Code — Execute ALL sections

---

## CONTEXT
Tashkheesa telemedicine portal (Node.js/Express/EJS/SQLite/better-sqlite3).
Project root: `/Users/ziadelwahsh/Desktop/tashkheesa-portal`

Key decisions from product owner:
- Messaging: case-scoped, text-only, available before AND after doctor report, closes 30 days after case completion
- File exchange: NOT through chat — uses existing "request additional files" workflow with admin approval
- Medical records: auto-save completed reports + prescriptions, GDPR-style patient can delete anytime
- Currency: auto-detect from IP + patient profile country
- AI: check uploaded image quality + verify correct body part/scan type
- Doctor commission: fixed 20% of Tashkheesa price
- Tashkheesa markup: 15% above hospital cost

---

## SECTION 1: FIX ALL PATIENT PAGES — CONSISTENT PORTAL LAYOUT

### THE PROBLEM
Only `patient_dashboard.ejs` uses the portal shell with sidebar. ALL other patient pages render without the sidebar/header, making them look like different apps.

### THE FIX
Every patient page must use this structure:

```ejs
<%- include('partials/header', { title: "Page Title", layout: "portal", showNav: false, showFooter: false }) %>
<%
  var isAr = (typeof lang !== 'undefined' && lang === 'ar');
  var brandSafe = typeof brand !== 'undefined' ? brand : 'Tashkheesa';
%>
<div class="portal-shell">
  <div class="portal-header">
    <div class="portal-logo">
      <%= brandSafe %>
      <span><%= isAr ? 'بوابة المريض' : 'Patient Portal' %></span>
    </div>
  </div>
  <div class="portal-grid">
    <%- include('partials/patient_sidebar', { activePage: 'PAGE_KEY', isAr: isAr }) %>
    <main class="portal-content">
      <!-- ACTUAL PAGE CONTENT HERE -->
    </main>
  </div>
</div>
<%- include('partials/footer') %>
```

### Pages to fix (wrap each in the portal shell above):

1. **patient_new_case.ejs** — activePage: 'new_case'
   - Currently has OLD sidebar with only 4 links (My cases, New case, Alerts, Profile)
   - Replace entire sidebar with include of patient_sidebar partial
   - Keep all form content as-is

2. **patient_order_new.ejs** — activePage: 'new_case'
   - Same fix as above

3. **messages.ejs** — activePage: 'messages'
   - Currently renders standalone with NO portal chrome
   - Detect user role: if patient → wrap in patient portal shell with patient_sidebar
   - If doctor → use the existing portal.ejs layout with doctor sidebar
   - Keep the existing two-column messages UI (conversation list + chat area) inside the main content area

4. **patient_prescriptions.ejs** — activePage: 'prescriptions'
   - Currently standalone with just "My Prescriptions" and "← Back"
   - Wrap in portal shell, remove the "← Back" link (sidebar handles navigation)

5. **patient_prescription_detail.ejs** — activePage: 'prescriptions'
   - Same fix

6. **patient_records.ejs** — activePage: 'records'
   - Currently standalone
   - Wrap in portal shell

7. **patient_referrals.ejs** — activePage: 'referrals'
   - Check and fix if missing portal shell

8. **patient_alerts.ejs** — activePage: 'alerts'
   - Check and fix if missing portal shell

9. **patient_onboarding.ejs** — activePage: 'dashboard'
   - Check and fix if missing portal shell

10. **patient_payment.ejs / patient_payment_required.ejs** — activePage: 'dashboard'
    - Check and fix

11. **patient_order.ejs** (case detail view) — activePage: 'dashboard'
    - Check and fix

12. **patient_case_report.ejs** — activePage: 'dashboard'
    - Check and fix

### Profile page overhaul:

13. **The route handler for /patient/profile** currently renders a bare page with "Profile editing will be enabled in a later release."

    Fix this: Make profile EDITABLE. The profile page should include:
    - Name (text input, editable)
    - Email (shown, not editable — or editable with email verification)
    - Phone number (text input, editable)
    - Date of birth (date picker)
    - Gender (select: Male, Female, Other)
    - Country (select dropdown — EG, SA, AE, GB, US, Other)
    - Preferred language (EN / AR toggle)
    - Notification preferences (checkboxes: Email, WhatsApp, SMS)
    - "Save Changes" button that POSTs to /patient/profile/update
    
    Add the POST route handler that updates the users table.
    Wrap in portal shell with activePage: 'profile'.

---

## SECTION 2: FIX BROKEN ROUTES

### 2.1 Patient Appointments — `/portal/patient/appointments`

The sidebar links to `/portal/patient/appointments` but the route is `/portal/appointments`.

**Fix:** In `src/routes/appointments.js`, add:
```javascript
// Redirect convenience URL
router.get('/portal/patient/appointments', requireRole('patient'), (req, res) => {
  res.redirect('/portal/appointments');
});
```

Also ensure `/portal/appointments` (the existing route) renders `patient_appointments_list.ejs` wrapped in the portal shell with patient sidebar (activePage: 'appointments').

### 2.2 Patient Reviews — `/portal/patient/reviews`

This route does NOT exist. Create it.

**In `src/routes/reviews.js`, add:**
```javascript
router.get('/portal/patient/reviews', requireRole('patient'), function(req, res) {
  // 1. Get reviews this patient has submitted
  const submittedReviews = safeAll(
    `SELECT r.*, o.service_id, s.name as service_name, u.name as doctor_name
     FROM reviews r
     JOIN orders o ON r.order_id = o.id
     LEFT JOIN services s ON o.service_id = s.id
     LEFT JOIN users u ON r.doctor_id = u.id
     WHERE r.patient_id = ?
     ORDER BY r.created_at DESC`,
    [req.user.id]
  );

  // 2. Get completed cases NOT yet reviewed
  const pendingReviews = safeAll(
    `SELECT o.id, o.service_id, o.completed_at, s.name as service_name, u.name as doctor_name, o.doctor_id
     FROM orders o
     LEFT JOIN services s ON o.service_id = s.id
     LEFT JOIN users u ON o.doctor_id = u.id
     WHERE o.patient_id = ? AND o.status = 'completed'
     AND o.id NOT IN (SELECT order_id FROM reviews WHERE patient_id = ?)
     ORDER BY o.completed_at DESC`,
    [req.user.id, req.user.id]
  );

  res.render('patient_reviews', {
    submittedReviews,
    pendingReviews,
    lang: res.locals.lang || 'en',
    isAr: res.locals.lang === 'ar',
    user: req.user,
    brand: process.env.BRAND_NAME || 'Tashkheesa',
    activePage: 'reviews'
  });
});
```

**Create `src/views/patient_reviews.ejs`** with portal shell, showing:
- "Pending Reviews" section — cards for each completed case not yet reviewed, with star rating input (1-5 stars clickable), text comment box, and "Submit Review" button that POSTs to the existing `/portal/patient/case/:caseId/review` endpoint
- "My Reviews" section — list of submitted reviews showing doctor name, service, star rating, comment, date

### 2.3 Doctor Prescriptions List — `/portal/doctor/prescriptions`

The doctor sidebar links here but no list route exists. Create it.

**In `src/routes/prescriptions.js`, add:**
```javascript
router.get('/portal/doctor/prescriptions', requireRole('doctor'), function(req, res) {
  const prescriptions = safeAll(
    `SELECT p.*, o.service_id, s.name as service_name, u.name as patient_name
     FROM prescriptions p
     JOIN orders o ON p.order_id = o.id
     LEFT JOIN services s ON o.service_id = s.id
     LEFT JOIN users u ON p.patient_id = u.id
     WHERE p.doctor_id = ?
     ORDER BY p.created_at DESC`,
    [req.user.id]
  );

  res.render('doctor_prescriptions_list', {
    prescriptions,
    lang: res.locals.lang || 'en',
    isAr: res.locals.lang === 'ar',
    user: req.user,
    brand: process.env.BRAND_NAME || 'Tashkheesa',
    portalFrame: true,
    portalRole: 'doctor',
    portalActive: 'prescriptions'
  });
});
```

**Create `src/views/doctor_prescriptions_list.ejs`** using the portal.ejs layout (portalFrame: true), showing a table of all prescriptions the doctor has written.

### 2.4 Doctor Reviews — `/portal/doctor/reviews`

Fix: the current route is `/portal/doctor/:doctorId/reviews`. Add a convenience route:
```javascript
router.get('/portal/doctor/reviews', requireRole('doctor'), function(req, res) {
  // Redirect to the doctor's own reviews page using their user ID
  res.redirect('/portal/doctor/' + req.user.id + '/reviews');
});
```

Also ensure the target page uses portal.ejs layout with portalActive: 'reviews'.

---

## SECTION 3: MESSAGING SYSTEM OVERHAUL

### 3.1 Auto-create conversation on case assignment

In the case lifecycle (wherever `status` changes to `'assigned'` and `doctor_id` is set), auto-create a conversation:

Find the code that assigns a doctor to a case (could be in `src/routes/doctor.js`, `src/routes/admin.js`, `src/routes/superadmin.js`, or `src/case_lifecycle.js`). After the assignment, add:

```javascript
// Auto-create case-scoped conversation
const existingConvo = safeGet(
  'SELECT id FROM conversations WHERE order_id = ?',
  [orderId]
);
if (!existingConvo) {
  const convoId = randomUUID();
  db.prepare(
    `INSERT INTO conversations (id, order_id, patient_id, doctor_id, status, created_at)
     VALUES (?, ?, ?, ?, 'active', datetime('now'))`
  ).run(convoId, orderId, patientId, doctorId);
}
```

### 3.2 Ensure conversations table has order_id

In `src/db.js` migrate(), verify the conversations table has:
```sql
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  patient_id TEXT NOT NULL,
  doctor_id TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  closed_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

If it doesn't have `order_id` or `closed_at`, add them via ALTER TABLE.

### 3.3 Messages page — show case-scoped conversations

Update the `/portal/messages` GET handler to:
- Query conversations joined with orders and users to show: case ID, service name, doctor/patient name, last message preview, unread count
- Each conversation card shows the case context ("Cardiology - Echo - Case #abc123")
- Clicking opens the chat for that specific case

### 3.4 Case detail page — "Message Doctor/Patient" button

In the patient case detail view (`patient_order.ejs` or similar), add a "Message Doctor" button that links to `/portal/messages/:conversationId` for this case's conversation.

In the doctor case detail view (`portal_doctor_case.ejs`), add a "Message Patient" button.

If no conversation exists yet (case not yet assigned), show the button disabled with "Chat available after doctor assignment".

### 3.5 Auto-close conversations after 30 days

Add to the SLA worker or create a new scheduled task:
```javascript
// Close conversations 30 days after case completion
db.prepare(`
  UPDATE conversations SET status = 'closed', closed_at = datetime('now')
  WHERE status = 'active'
  AND order_id IN (
    SELECT id FROM orders 
    WHERE status = 'completed' 
    AND completed_at < datetime('now', '-30 days')
  )
`).run();
```

In the messaging route, if conversation status is 'closed', render the chat as read-only with a banner: "This conversation was closed 30 days after case completion."

---

## SECTION 4: MEDICAL RECORDS — GDPR-STYLE AUTO-SAVE

### 4.1 Auto-save report to medical records on case completion

Find where case status changes to 'completed' (likely in doctor.js when submitting report). After completion, add:

```javascript
// Auto-save case report to medical records
const recordId = randomUUID();
db.prepare(`
  INSERT OR IGNORE INTO medical_records (id, patient_id, record_type, title, description, order_id, doctor_id, created_at)
  VALUES (?, ?, 'case_report', ?, ?, ?, ?, datetime('now'))
`).run(
  recordId,
  order.patient_id,
  'Case Report - ' + (serviceName || 'Medical Review'),
  'Auto-saved from completed case #' + orderId.slice(0, 8),
  orderId,
  order.doctor_id
);
```

### 4.2 Patient can delete records

Ensure a DELETE route exists:
```javascript
router.post('/portal/patient/records/:recordId/delete', requireRole('patient'), function(req, res) {
  // Verify record belongs to this patient
  const record = safeGet('SELECT * FROM medical_records WHERE id = ? AND patient_id = ?', [req.params.recordId, req.user.id]);
  if (!record) return res.redirect('/portal/patient/records');
  
  db.prepare('DELETE FROM medical_records WHERE id = ? AND patient_id = ?').run(req.params.recordId, req.user.id);
  res.redirect('/portal/patient/records');
});
```

Add a "Delete" button (with confirmation modal) on each record card in `patient_records.ejs`.

### 4.3 GDPR notice on Medical Records page

Add a subtle info banner at top of Medical Records page:
"Your medical records are stored securely. Reports from completed cases are auto-saved for your convenience. You can delete any record at any time."

---

## SECTION 5: CURRENCY AUTO-DETECTION

### 5.1 Add country field to users table

If not already present:
```sql
ALTER TABLE users ADD COLUMN country TEXT DEFAULT 'EG';
```

### 5.2 IP-based country detection middleware

Create `src/geo.js`:
```javascript
// Simple IP-to-country using free API (or header-based for Cloudflare/Render)
function detectCountry(req) {
  // Check Cloudflare header first
  const cfCountry = req.headers['cf-ipcountry'];
  if (cfCountry) return cfCountry.toUpperCase();
  
  // Check X-Vercel-IP-Country
  const vercelCountry = req.headers['x-vercel-ip-country'];
  if (vercelCountry) return vercelCountry.toUpperCase();
  
  // Fallback: check user profile
  if (req.user && req.user.country) return req.user.country.toUpperCase();
  
  // Default
  return 'EG';
}

function countryToCurrency(country) {
  const map = { EG: 'EGP', SA: 'SAR', AE: 'AED', GB: 'GBP', US: 'USD' };
  return map[country] || 'EGP';
}

module.exports = { detectCountry, countryToCurrency };
```

### 5.3 Update New Case page pricing

In the route handler for the New Case page, detect the patient's country and fetch prices from `service_regional_prices`:

```javascript
const { detectCountry, countryToCurrency } = require('../geo');

// In the GET handler:
const country = detectCountry(req);
const currency = countryToCurrency(country);

// When rendering services with prices:
const prices = safeAll(
  'SELECT service_id, tashkheesa_price, currency FROM service_regional_prices WHERE country_code = ? AND status = ?',
  [country, 'active']
);
const priceMap = {};
prices.forEach(p => { priceMap[p.service_id] = p; });

// Pass priceMap and currency to the template
res.render('patient_order_new', { ..., priceMap, currency, detectedCountry: country });
```

In the EJS template, show the price next to each service in the dropdown:
```
Echocardiogram (Echo) — EGP 1,380
```

---

## SECTION 6: AI IMAGE QUALITY CHECK

### 6.1 Create `src/ai_image_check.js`

This module uses the Claude API (or OpenAI Vision API) to validate uploaded medical images.

```javascript
// AI-powered medical image validation
// Uses Claude Vision API to check:
// 1. Is this a valid medical image (not a selfie, document, etc)?
// 2. Image quality assessment (too dark, too blurry, too small?)
// 3. Does the body part/scan type match what was requested?

const Anthropic = require('@anthropic-ai/sdk');

async function validateMedicalImage(imageBuffer, mimeType, expectedScanType) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  
  const base64Image = imageBuffer.toString('base64');
  
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mimeType, data: base64Image }
        },
        {
          type: 'text',
          text: `You are a medical image quality checker for a telemedicine platform. Analyze this uploaded image and respond in JSON only:

{
  "is_medical_image": true/false,
  "image_quality": "good" | "acceptable" | "poor",
  "quality_issues": ["list of issues if any, e.g. too dark, blurry, cropped"],
  "detected_scan_type": "what type of scan this appears to be (e.g. MRI brain, CT chest, X-ray chest, ECG, blood test report, etc)",
  "matches_expected": true/false,
  "confidence": 0.0-1.0,
  "recommendation": "brief recommendation for the user"
}

Expected scan type for this case: ${expectedScanType || 'not specified'}

Be strict about quality — blurry or dark images will be useless for diagnosis. But be helpful in your recommendation.`
        }
      ]
    }]
  });

  try {
    const text = response.content[0].text;
    // Strip markdown fences if present
    const clean = text.replace(/```json\n?|```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    return {
      is_medical_image: null,
      image_quality: 'unknown',
      quality_issues: ['AI check failed'],
      detected_scan_type: 'unknown',
      matches_expected: null,
      confidence: 0,
      recommendation: 'Manual review required'
    };
  }
}

module.exports = { validateMedicalImage };
```

### 6.2 Integrate into file upload route

Find the file upload handler (likely in `patient.js` or `order_flow.js` — the POST route for uploading case files). After the file is saved:

```javascript
const { validateMedicalImage } = require('../ai_image_check');

// After file upload is saved to disk:
if (process.env.ANTHROPIC_API_KEY && isImageFile(file.mimetype)) {
  try {
    const imageBuffer = fs.readFileSync(savedFilePath);
    const expectedType = order.service_name || ''; // e.g. "Brain MRI"
    const aiResult = await validateMedicalImage(imageBuffer, file.mimetype, expectedType);
    
    // Store AI result
    db.prepare(`
      INSERT INTO file_ai_checks (id, file_id, order_id, is_medical_image, image_quality, quality_issues, detected_scan_type, matches_expected, confidence, recommendation, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(randomUUID(), fileId, orderId, aiResult.is_medical_image ? 1 : 0, aiResult.image_quality, JSON.stringify(aiResult.quality_issues), aiResult.detected_scan_type, aiResult.matches_expected ? 1 : 0, aiResult.confidence, aiResult.recommendation);
    
    // If poor quality or wrong scan type, show warning to patient
    if (aiResult.image_quality === 'poor' || aiResult.matches_expected === false) {
      // Set a flag so the upload page shows a warning
      warnings.push({
        file: file.originalname,
        quality: aiResult.image_quality,
        issues: aiResult.quality_issues,
        recommendation: aiResult.recommendation
      });
    }
  } catch (aiErr) {
    // AI check is non-blocking — if it fails, continue normally
    console.error('AI image check failed:', aiErr.message);
  }
}
```

### 6.3 Add `file_ai_checks` table

In `src/db.js` migrate():
```sql
CREATE TABLE IF NOT EXISTS file_ai_checks (
  id TEXT PRIMARY KEY,
  file_id TEXT,
  order_id TEXT,
  is_medical_image INTEGER,
  image_quality TEXT,
  quality_issues TEXT,
  detected_scan_type TEXT,
  matches_expected INTEGER,
  confidence REAL,
  recommendation TEXT,
  checked_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

### 6.4 Show AI warnings on upload page

After upload, if AI flagged issues, show a warning banner:
```
⚠️ Image Quality Warning
"brain_mri_scan.jpg" — Quality: Poor
Issues: Image appears blurry, low resolution
Recommendation: Please re-upload a clearer image for accurate diagnosis.
[Re-upload] [Keep anyway]
```

### 6.5 Show AI check results to doctor

In the doctor case detail view, next to each uploaded file, show a small badge:
- ✅ "AI: Good quality, MRI Brain confirmed"
- ⚠️ "AI: Acceptable quality, possible blur"  
- ❌ "AI: Poor quality — may affect diagnosis"

---

## SECTION 7: VERIFICATION CHECKLIST

After all changes, verify by visiting each URL:

**Patient pages (all should show portal shell + sidebar):**
- [ ] /dashboard
- [ ] /portal/patient/orders/new
- [ ] /portal/patient/appointments → redirects to /portal/appointments
- [ ] /portal/messages (as patient)
- [ ] /portal/patient/prescriptions
- [ ] /portal/patient/records
- [ ] /portal/patient/referrals
- [ ] /portal/patient/reviews (NEW — should show pending + submitted reviews)
- [ ] /patient/profile (should be EDITABLE)
- [ ] /portal/patient/alerts
- [ ] /portal/patient/orders/:id (case detail)

**Doctor pages (all should show portal shell + sidebar):**
- [ ] /portal/doctor
- [ ] /portal/doctor/queue
- [ ] /portal/doctor/appointments
- [ ] /portal/messages (as doctor)
- [ ] /portal/doctor/prescriptions (NEW — should show list)
- [ ] /portal/doctor/reviews (should redirect to doctor's reviews)
- [ ] /portal/doctor/analytics
- [ ] /portal/doctor/alerts

**Every page must have:**
- Blue "Tashkheesa PATIENT PORTAL" (or DOCTOR PORTAL) header
- Full sidebar with ALL navigation links
- Correct active state highlighting on the current page's link
- Design system CSS loaded (portal-variables, portal-components, portal-global)

---

## COMMIT STRATEGY
1. `fix(ui): wrap all patient pages in portal shell with sidebar`
2. `fix(routes): add missing patient appointments, reviews, doctor prescriptions routes`
3. `feat(profile): make patient profile editable with country, phone, preferences`
4. `feat(messaging): case-scoped auto-create conversations, 30-day auto-close`
5. `feat(records): GDPR auto-save on completion, patient delete capability`
6. `feat(geo): IP + profile country detection for multi-currency pricing`
7. `feat(ai): image quality + scan type validation on upload`
