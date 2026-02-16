# WEBSITE MUST-HAVE PAGES — Pre-Launch Legal & Commercial Compliance

These 7 items are REQUIRED before launch for Paymob approval and Egyptian e-commerce regulations.

---

## CURRENT STATE

- `/services` → redirects to dead `/site/services.html` (404)
- `/privacy` → redirects to dead `/site/privacy.html` (404)
- `/terms` → redirects to dead `/site/terms.html` (404)
- `/about` → redirects to dead `/site/about.html` (404)
- No `/contact` page exists
- No `/refund-policy` page exists
- No `/delivery-policy` page exists
- EJS views exist for `privacy.ejs`, `terms.ejs`, `services.ejs` but contain "Content coming next" placeholder
- Footer only links to: Services, Privacy, Terms, Portal

## WHAT TO BUILD

### Fix Route Strategy

Remove the dead `/site/*.html` redirects in `server.js` (lines ~963-968). Replace with direct EJS renders:

```javascript
// REMOVE these lines:
// app.get('/services', (req, res) => res.redirect(302, '/site/services.html'));
// app.get('/privacy', (req, res) => res.redirect(302, '/site/privacy.html'));
// app.get('/terms', (req, res) => res.redirect(302, '/site/terms.html'));
// app.get('/about', (req, res) => res.redirect(302, '/site/about.html'));

// ADD these routes (put them BEFORE the catch-all 404):
app.get('/services', (req, res) => {
  const db = require('./db');
  // Get services grouped by specialty, only ones with prices
  const specialties = db.prepare(`
    SELECT DISTINCT s.name as specialty_name, sp.id as specialty_id
    FROM services sv
    JOIN specialties sp ON sv.specialty_id = sp.id
    JOIN specialties s ON sv.specialty_id = s.id
    WHERE sv.is_visible = 1 AND sv.base_price > 0
    ORDER BY s.name
  `).all();
  
  const services = db.prepare(`
    SELECT sv.*, sp.name as specialty_name
    FROM services sv
    LEFT JOIN specialties sp ON sv.specialty_id = sp.id
    WHERE sv.is_visible = 1 AND sv.base_price > 0
    ORDER BY sp.name, sv.base_price ASC
  `).all();
  
  res.render('services', { services, specialties, title: 'Services & Pricing' });
});

app.get('/privacy', (req, res) => res.render('privacy', { title: 'Privacy Policy' }));
app.get('/terms', (req, res) => res.render('terms', { title: 'Terms of Service' }));
app.get('/about', (req, res) => res.render('about', { title: 'About Us' }));
app.get('/contact', (req, res) => res.render('contact', { title: 'Contact Us' }));
app.get('/refund-policy', (req, res) => res.render('refund_policy', { title: 'Refund & Cancellation Policy' }));
app.get('/delivery-policy', (req, res) => res.render('delivery_policy', { title: 'Delivery & Service Policy' }));
```

---

## PAGE 1: Services & Pricing (`services.ejs`)

**CRITICAL**: Must show real products with real EGP prices. Pull from DB but present in a curated, categorized layout.

The DB has ~160 services but many have no price. Only show services where `base_price > 0`. Group by specialty.

### Structure:

```
Hero: "Our Medical Services" + subtitle
Filter tabs: All | Radiology | Cardiology | Neurology | Lab & Pathology | Oncology | ...

Service Cards Grid (3 columns):
┌─────────────────────────┐
│ 🩻 X-Ray Review         │
│ Radiology               │
│                         │
│ A board-certified       │
│ radiologist reviews     │
│ your X-ray images...    │
│                         │
│ EGP 500                 │
│ 72-hour turnaround      │
│                         │
│ [Get Started →]         │
└─────────────────────────┘

Bottom section: 
"Need something not listed? Contact us for a custom consultation."

Price note:
"All prices are in Egyptian Pounds (EGP). Prices include the specialist review and written report. 
Video consultations are available as an add-on. 24-hour express delivery available for select services."
```

Each service card shows:
- Service name
- Specialty category tag
- Brief description (generate from service name — e.g. "X-Ray Review" → "A board-certified radiologist reviews your X-ray images and provides a detailed written second opinion with findings and recommendations.")
- Price in EGP (bold)
- SLA turnaround ("72-hour turnaround" or "24-hour express available")
- CTA button linking to `/portal/patient/orders/new?service=<id>` (or login if not authenticated)

### Static Descriptions Map

Since the DB doesn't have descriptions, create a static descriptions object in the route handler:

```javascript
const SERVICE_DESCRIPTIONS = {
  'X-Ray Review': 'A board-certified radiologist reviews your X-ray images and provides a detailed written report with findings and recommendations.',
  'MRI Review': 'Expert analysis of your MRI scan by a specialist radiologist, with a comprehensive written report covering all findings.',
  'CT Scan Review': 'Detailed review of your CT scan images by a specialist, including a written report with diagnosis and recommendations.',
  'Ultrasound Review': 'Professional review of your ultrasound images by an experienced specialist with a written findings report.',
  'Brain MRI Review': 'Neuroimaging specialist reviews your brain MRI and provides detailed findings, differential diagnosis, and recommendations.',
  'Echocardiogram Review': 'A cardiologist reviews your echocardiogram and provides a detailed assessment of cardiac structure and function.',
  'ECG Review': 'Expert interpretation of your 12-lead ECG by a cardiologist, including rhythm analysis and clinical recommendations.',
  'Blood Work Review': 'Comprehensive analysis of your blood test results by an internal medicine specialist with clinical interpretation.',
  'Chest X-Ray Review': 'Specialist radiologist reviews your chest X-ray and provides a written report covering all thoracic findings.',
  'Mammogram Review': 'Expert breast imaging review by a radiologist, including BI-RADS classification and follow-up recommendations.',
  'Biopsy / Histopathology Review': 'A pathologist reviews your biopsy slides and provides a detailed histopathological assessment.',
  'Oncology Case Review': 'Comprehensive cancer case review by an oncologist, including staging assessment and treatment recommendations.',
  'PET Scan Review': 'Nuclear medicine specialist reviews your PET-CT scan with detailed metabolic activity assessment.',
  'Cardiac Catheterization Review': 'Interventional cardiologist reviews your catheterization findings and provides treatment recommendations.',
  'Holter Monitor Review': 'Cardiologist reviews your Holter monitor recording and provides rhythm analysis over the monitoring period.',
  'General Second Opinion': 'A specialist in the relevant field reviews your medical records and provides an independent second opinion.',
  // ... add more as needed
};

// Fallback for services without a custom description
function getDescription(serviceName) {
  if (SERVICE_DESCRIPTIONS[serviceName]) return SERVICE_DESCRIPTIONS[serviceName];
  return `Expert specialist review with a detailed written report covering findings and clinical recommendations.`;
}
```

---

## PAGE 2: About Us (`about.ejs`) — NEW FILE

```
Hero: "About Tashkheesa"
Subtitle: "Making specialist medical opinions accessible to every Egyptian patient."

### Our Mission
Tashkheesa was founded to bridge the gap between patients and specialist medical expertise. 
We believe every patient deserves access to a qualified second opinion, regardless of where they live.

### How It Works
Our platform connects you with board-certified specialists from leading Egyptian hospitals. 
Upload your medical files — scans, lab results, or clinical reports — and receive a detailed 
written second opinion within 72 hours.

### Our Specialists
Every doctor on Tashkheesa is:
- Board-certified in their specialty
- Practicing at accredited Egyptian hospitals  
- Verified and credentialed by our medical team

### Our Standards
- All consultations are confidential and HIPAA-compliant
- Medical files are encrypted in transit and at rest
- Each report is reviewed for quality before delivery
- We guarantee delivery within the committed timeframe or your money back

### Contact
[PLACEHOLDER_EMAIL]
[PLACEHOLDER_PHONE]
[PLACEHOLDER_ADDRESS — Cairo, Egypt]
```

---

## PAGE 3: Contact Us (`contact.ejs`) — NEW FILE

```
"Contact Us"
"We're here to help. Reach out with any questions about our services."

Contact Info Cards:
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ 📧 Email     │  │ 📞 Phone     │  │ 📍 Address   │
│              │  │              │  │              │
│ PLACEHOLDER  │  │ PLACEHOLDER  │  │ Cairo,       │
│ @tashkheesa  │  │ +20 XXX XXX  │  │ Egypt        │
│ .com         │  │              │  │              │
└──────────────┘  └──────────────┘  └──────────────┘

Contact Form (optional — can be simple):
- Name
- Email  
- Subject (dropdown: General Inquiry, Service Question, Technical Support, Refund Request, Other)
- Message
- Submit button

Note: "We typically respond within 24 hours during business days."

Business Hours:
Sunday – Thursday: 9:00 AM – 5:00 PM (Cairo Time)
Friday – Saturday: Closed

Social Media links (if any): Instagram
```

Use placeholder values wrapped in a comment block at the top so they're easy to find and replace:
```javascript
// ============ REPLACE BEFORE LAUNCH ============
const CONTACT_EMAIL = 'info@tashkheesa.com';  // REPLACE
const CONTACT_PHONE = '+20 XXX XXX XXXX';     // REPLACE  
const CONTACT_ADDRESS = 'Cairo, Egypt';         // REPLACE
// ================================================
```

---

## PAGE 4: Privacy Policy (`privacy.ejs`) — REWRITE

Full privacy policy for a medical telemedicine platform in Egypt. Must cover:

```
Last updated: February 2026

1. Information We Collect
- Personal information (name, email, phone number, date of birth)
- Medical information (uploaded scans, lab results, medical history, clinical notes)
- Payment information (processed securely through Paymob — we do not store card details)
- Usage data (pages visited, features used, device information)

2. How We Use Your Information
- To provide medical second opinion services
- To match you with qualified specialists
- To process payments for services
- To communicate about your cases and appointments
- To improve our platform and services
- To comply with legal obligations

3. Medical Data Handling
- All medical files are encrypted in transit (TLS/SSL) and at rest
- Medical data is only shared with the assigned specialist reviewing your case
- We do not sell, rent, or share your medical data with third parties
- Medical records are retained for [X] years as required by Egyptian medical regulations
- You may request deletion of your data at any time

4. Payment Security
- Payments are processed by Paymob, a PCI-DSS compliant payment processor
- We do not store credit card numbers or banking details on our servers
- Payment records are maintained for accounting and refund purposes only

5. Data Sharing
We only share your information with:
- The specialist doctor assigned to review your case
- Payment processors (Paymob) to process transactions
- Legal authorities when required by Egyptian law

We NEVER:
- Sell your personal or medical data
- Share your information with advertisers
- Use your medical data for marketing purposes

6. Your Rights
- Access your personal data at any time through your portal
- Request correction of inaccurate information
- Request deletion of your account and associated data
- Download your medical reports and case history
- Opt out of non-essential communications

7. Cookies
We use essential cookies for authentication and session management.
We do not use tracking cookies or third-party advertising cookies.

8. Children's Privacy
Our services are intended for individuals 18 years and older.
For patients under 18, a parent or legal guardian must create and manage the account.

9. Changes to This Policy
We may update this policy from time to time.
We will notify you of significant changes via email or portal notification.

10. Contact Us
For privacy-related inquiries:
Email: [PLACEHOLDER_EMAIL]
Address: [PLACEHOLDER_ADDRESS]
```

---

## PAGE 5: Terms of Service (`terms.ejs`) — REWRITE

```
Last updated: February 2026

1. Agreement
By using Tashkheesa, you agree to these terms. If you do not agree, please do not use our services.

2. Service Description
Tashkheesa provides specialist medical second opinions. Our service includes:
- Review of uploaded medical files by board-certified specialists
- Written medical reports with findings and recommendations  
- Optional video consultations with assigned specialists
- Secure messaging between patients and doctors

3. Important Medical Disclaimer
- Tashkheesa provides SECOND OPINIONS only, not primary medical care
- Our reports are advisory and should be discussed with your treating physician
- In case of medical emergency, call emergency services immediately
- Our specialists provide independent assessments based on the files you upload
- The quality of the review depends on the quality and completeness of uploaded files

4. Account Responsibilities
- You must provide accurate personal and medical information
- You are responsible for maintaining the confidentiality of your account
- You must be 18 years or older (or have parental/guardian consent)
- One account per person — sharing accounts is prohibited

5. Payment Terms
- All prices are listed in Egyptian Pounds (EGP) unless otherwise stated
- Payment is required before a case is assigned to a specialist
- We accept Visa, Mastercard, and supported local payment methods
- Prices may change; the price at the time of order is the price you pay

6. Service Level Agreement (SLA)
- Standard delivery: within 72 hours of payment confirmation
- Express delivery (where available): within 24 hours
- If we fail to deliver within the committed timeframe, you are eligible for a full refund
- Delivery time starts when payment is confirmed and all required files are uploaded

7. Intellectual Property
- Medical reports generated by our specialists remain your property
- The Tashkheesa platform, design, and content are owned by Tashkheesa
- You may not copy, reproduce, or redistribute our platform content

8. Limitation of Liability
- Tashkheesa is not liable for medical decisions made based on our reports
- Our total liability is limited to the amount paid for the specific service
- We are not liable for delays caused by incomplete file uploads

9. Account Termination
- You may close your account at any time through your portal settings
- We may suspend accounts that violate these terms
- Medical records will be retained as required by Egyptian law

10. Governing Law
These terms are governed by the laws of the Arab Republic of Egypt.
Any disputes will be resolved in the courts of Cairo, Egypt.

11. Contact
[PLACEHOLDER_EMAIL]
[PLACEHOLDER_ADDRESS]
```

---

## PAGE 6: Refund & Cancellation Policy (`refund_policy.ejs`) — NEW FILE

```
Last updated: February 2026

Refund & Cancellation Policy

At Tashkheesa, we want you to be completely satisfied with our service. 
This policy explains when and how refunds are processed.

### When You Can Get a Full Refund

1. **Before doctor assignment**: If you cancel your case before a specialist has been assigned, 
   you will receive a full refund within 5-7 business days.

2. **SLA breach**: If we fail to deliver your report within the committed timeframe 
   (72 hours standard / 24 hours express), you are entitled to a full refund.

3. **Technical failure**: If a technical issue on our platform prevents delivery of your report, 
   you will receive a full refund.

### When You Can Get a Partial Refund

4. **Quality concerns**: If you believe the specialist report does not adequately address your 
   clinical question, contact us within 7 days of delivery. We will either:
   - Arrange a re-review by a different specialist at no additional cost, OR
   - Issue a partial refund (50%) at our discretion

### When Refunds Are Not Available

5. **After report delivery**: Once your specialist report has been delivered and downloaded, 
   the service is considered complete. Refunds are generally not available after delivery 
   unless there is a quality concern (see #4 above).

6. **Incomplete uploads**: If you fail to upload complete medical files and the specialist 
   cannot provide a comprehensive review, this does not qualify for a refund. 
   You will be asked to upload additional files.

7. **Disagreement with findings**: A second opinion that differs from your primary doctor's 
   opinion is not grounds for a refund. Second opinions are by nature independent assessments.

### Video Consultation Refunds

8. **Patient no-show**: If you miss a scheduled video appointment without cancelling at least 
   4 hours in advance, the consultation fee is non-refundable.

9. **Doctor no-show**: If the doctor fails to join a scheduled appointment, you will receive 
   a full refund or free rescheduling.

10. **Cancellation**: Video consultations cancelled more than 4 hours before the scheduled 
    time receive a full refund. Cancellations within 4 hours receive a 50% refund.

### How to Request a Refund

- Log into your Tashkheesa portal
- Go to the case or appointment you want to request a refund for
- Click "Request Refund" and provide a brief explanation
- Our team will review your request within 2 business days
- Approved refunds are processed within 5-7 business days to your original payment method

### Contact for Refund Issues
Email: [PLACEHOLDER_EMAIL]
Phone: [PLACEHOLDER_PHONE]
```

---

## PAGE 7: Delivery & Service Policy (`delivery_policy.ejs`) — NEW FILE

```
Last updated: February 2026

Delivery & Service Policy

Tashkheesa is a digital medical second opinion platform. All services are delivered 
electronically through our secure portal. There are no physical products or shipping involved.

### How Your Report Is Delivered

1. **Upload**: You upload your medical files (scans, lab results, documents) through our secure portal
2. **Assignment**: A board-certified specialist in the relevant field is assigned to your case
3. **Review**: The specialist reviews your files and prepares a detailed written report
4. **Delivery**: Your report is delivered to your Tashkheesa portal and you receive a notification
5. **Download**: You can view and download your report as a PDF from your portal at any time

### Delivery Timeframes

| Service Type | Delivery Time | Price Impact |
|---|---|---|
| Standard Review | Within 72 hours | Base price |
| Express Review | Within 24 hours | Additional fee applies |
| Video Consultation | Scheduled appointment | Separate booking |

Delivery time begins when:
- Payment is confirmed, AND
- All required medical files have been uploaded

### What You Receive

Your specialist report includes:
- Patient information summary
- Review of submitted medical files
- Clinical findings and observations
- Assessment and differential diagnosis (where applicable)
- Recommendations for further action
- Specialist's credentials and signature

### Access to Your Reports

- Reports remain accessible in your portal indefinitely
- You can download reports as PDF at any time
- You can share reports with your treating physician
- Reports are confidential and only accessible by you and the reviewing specialist

### Service Availability

- Tashkheesa services are available 24/7 for case submission
- Specialist reviews are processed during business hours (Sun–Thu, 9 AM – 5 PM Cairo Time)
- Cases submitted outside business hours begin processing on the next business day
- Express (24-hour) reviews are subject to specialist availability

### Contact
For delivery questions: [PLACEHOLDER_EMAIL]
```

---

## PAGE 8: Update Footer & Navigation

### Footer (footer.ejs)

Replace the footer links section:
```html
<div class="footer-links">
  <div class="footer-col">
    <h4>Services</h4>
    <a href="/services">Services & Pricing</a>
    <a href="/about">About Us</a>
    <a href="/contact">Contact Us</a>
  </div>
  <div class="footer-col">
    <h4>Legal</h4>
    <a href="/privacy">Privacy Policy</a>
    <a href="/terms">Terms of Service</a>
    <a href="/refund-policy">Refund & Cancellation</a>
    <a href="/delivery-policy">Delivery Policy</a>
  </div>
  <div class="footer-col">
    <h4>Contact</h4>
    <p>📧 info@tashkheesa.com</p>
    <p>📞 +20 XXX XXX XXXX</p>
    <p>📍 Cairo, Egypt</p>
  </div>
</div>
```

### Navigation (header.ejs)

Add links to the main nav:
- Services
- About
- Contact
- Login / Portal

---

## PAGE STYLING

All new pages should use the same structure as the existing `privacy.ejs`:
```html
<%- include('partials/header', { title: "PAGE_TITLE", layout: "public", showNav: true }) %>

<main class="page-shell">
  <div class="page-inner">
    <section class="content-card legal-page">
      <h1>PAGE_TITLE</h1>
      <p class="subtitle">SUBTITLE</p>
      <p class="legal-updated">Last updated: February 2026</p>
      
      <!-- Content here -->
    </section>
  </div>
</main>

<%- include('partials/footer') %>
```

Add CSS for legal pages in the public stylesheet:
```css
.legal-page h2 {
  font-size: 20px;
  font-weight: 700;
  margin: 32px 0 12px;
  color: #0f172a;
}
.legal-page h3 {
  font-size: 16px;
  font-weight: 600;
  margin: 24px 0 8px;
  color: #1e293b;
}
.legal-page p, .legal-page li {
  font-size: 15px;
  line-height: 1.7;
  color: #334155;
  margin-bottom: 12px;
}
.legal-page ul, .legal-page ol {
  padding-left: 24px;
  margin-bottom: 16px;
}
.legal-page .legal-updated {
  font-size: 13px;
  color: #94a3b8;
  margin-bottom: 32px;
}
.legal-page table {
  width: 100%;
  border-collapse: collapse;
  margin: 16px 0 24px;
}
.legal-page th, .legal-page td {
  padding: 10px 14px;
  border: 1px solid #e2e8f0;
  text-align: left;
  font-size: 14px;
}
.legal-page th {
  background: #f8fafc;
  font-weight: 600;
}
```

---

## PLACEHOLDER VALUES

Put all placeholder values in ONE place at the top of server.js (or a config file) so they're easy to find and replace before launch:

```javascript
// ============ REPLACE BEFORE LAUNCH ============
const BUSINESS_INFO = {
  email: 'info@tashkheesa.com',      // REPLACE with real email
  phone: '+20 XXX XXX XXXX',          // REPLACE with real phone
  address: 'Cairo, Egypt',            // REPLACE with full address
  businessHours: 'Sunday – Thursday: 9:00 AM – 5:00 PM (Cairo Time)',
  instagram: 'https://instagram.com/tashkheesa', // REPLACE if different
};
// ================================================
```

Pass `BUSINESS_INFO` to all public page renders so templates use `<%= BUSINESS_INFO.email %>` etc.

---

## SERVICES PAGE SPECIAL NOTE

The database has ~160 services but many without prices. The services page should:
1. Only show services with `base_price > 0` (roughly ~40 services)
2. Group by specialty
3. Show a "From EGP X" if there are multiple price tiers
4. Have filter tabs to browse by specialty
5. Each card links to the patient new case page (or login if not authenticated)

For services WITHOUT a description in the DB, use the static `SERVICE_DESCRIPTIONS` map. For any service not in the map, use a generic description based on the specialty.

---

## FILES TO CREATE
1. `src/views/about.ejs`
2. `src/views/contact.ejs`
3. `src/views/refund_policy.ejs`
4. `src/views/delivery_policy.ejs`

## FILES TO REWRITE
5. `src/views/services.ejs` (complete rewrite with DB-powered cards)
6. `src/views/privacy.ejs` (full policy content)
7. `src/views/terms.ejs` (full terms content)

## FILES TO MODIFY
8. `src/server.js` (fix routes, add BUSINESS_INFO, add new routes)
9. `src/views/partials/footer.ejs` (expanded footer with 3 columns)
10. `src/views/partials/header.ejs` (add About, Contact to nav if missing)

---

## VERIFICATION

After implementation:
- [ ] `/services` shows real services with EGP prices, grouped by specialty
- [ ] `/about` loads with company info
- [ ] `/contact` loads with contact form and info
- [ ] `/privacy` loads with full privacy policy
- [ ] `/terms` loads with full terms of service
- [ ] `/refund-policy` loads with refund/cancellation policy
- [ ] `/delivery-policy` loads with delivery/service policy
- [ ] Footer shows all 7 links plus contact info
- [ ] Nav bar includes Services, About, Contact
- [ ] All pages are mobile responsive
- [ ] PLACEHOLDER values are clearly marked and easy to find/replace
- [ ] No 404s on any footer or nav link

## COMMIT
```
feat: add all required legal & commercial pages for launch

- Services page with real DB-powered pricing, grouped by specialty
- About Us page with mission, standards, and contact info
- Contact Us page with info cards and contact form
- Privacy Policy (full HIPAA-aligned medical data policy)
- Terms of Service (complete with medical disclaimers)
- Refund & Cancellation Policy (clear rules for all scenarios)
- Delivery & Service Policy (digital service delivery explained)
- Expanded footer with 3-column layout (Services, Legal, Contact)
- Fixed dead /site/*.html redirects → live EJS renders
- All placeholder values centralized for easy pre-launch replacement
```
