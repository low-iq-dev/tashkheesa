# Tashkheesa — 11 Feature Build: Error Tracking → Marketing Campaigns

## Project Overview
Tashkheesa is a medical second opinion telemedicine platform. Node.js/Express, better-sqlite3 (synchronous), EJS views, bilingual EN/AR. Build these 11 features as separate phases, committing after each.

## ⚠️ CRITICAL: Read Before Touching Anything
- Read `ARCHITECTURE.md` for safe workflow rules
- Run `npm run preflight` before AND after every phase
- One commit per phase. Small commits are rollbackable commits.
- High-risk files (`src/db.js`, `src/server.js`, `src/routes/*`) need extra care
- Never break existing functionality. The portal is live.
- CommonJS only (`require`/`module.exports`). No ES modules.
- `better-sqlite3` synchronous API. NOT async.
- Use existing logger: `const { verbose, fatal, logError } = require('../logger')`
- Safe DB migrations: always check column/table exists before ALTER/CREATE

## Existing Key Files
```
src/db.js                    — DB connection + migrations (better-sqlite3)
src/logger.js                — verbose(), fatal(), logError(), makeId()
src/middleware.js             — helmet, rate limiting, auth, CSRF
src/notify.js                — queueNotification(), queueMultiChannelNotification()
src/services/emailService.js — sendEmail({ to, subject, template, lang, data })
src/notify/whatsapp.js       — sendWhatsApp({ to, template, lang, vars })
src/validators/orders.js     — validateOrderCreation() (basic, needs expansion)
src/routes/patient.js        — 1782 lines, patient dashboard + case views
src/routes/doctor.js         — 2506 lines, doctor dashboard + case management
src/routes/admin.js          — 1871 lines, admin dashboard
src/routes/order_flow.js     — 304 lines, case creation + file upload
src/routes/payments.js       — Paymob payment flow
src/routes/appointments.js   — scheduling
src/routes/analytics.js      — analytics dashboard
src/routes/reports.js        — PDF report generation
src/templates/email/en/      — Handlebars email templates
src/templates/email/ar/      — Arabic email templates
src/views/                   — EJS view files
public/css/                  — portal-variables.css, portal-components.css, admin-styles.css
```

## Design System
- Deep blue: `#1a365d` | Medical blue: `#2b6cb0` | Accent teal: `#38b2ac`
- Success: `#10b981` | Warning: `#f59e0b` | Danger: `#ef4444`
- Cards: white bg, 12px border-radius, subtle shadow
- Use existing CSS variables from `portal-variables.css`

---

## Phase 1: Error Tracking

### 1A: Structured Error Logging
Upgrade `src/logger.js` to capture errors in a structured way:

1. Create `error_logs` table:
```sql
CREATE TABLE IF NOT EXISTS error_logs (
  id TEXT PRIMARY KEY,
  error_id TEXT,
  level TEXT DEFAULT 'error',
  message TEXT,
  stack TEXT,
  context TEXT,
  request_id TEXT,
  user_id TEXT,
  url TEXT,
  method TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

2. Add `logErrorToDb()` function in logger.js that writes to both console AND the `error_logs` table (fire-and-forget, never crash if DB write fails)

3. Create global Express error handler in `src/middleware.js`:
```js
function globalErrorHandler(err, req, res, next) {
  const errorId = logError(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
  // Also persist to DB
  logErrorToDb(err, { requestId: req.requestId, url: req.originalUrl, method: req.method, userId: req.user?.id });
  res.status(err.status || 500).render('error', { message: 'Something went wrong', errorId, status: err.status || 500 });
}
```

4. Add `try/catch` wrappers to critical route handlers that currently don't have them (scan `order_flow.js`, `payments.js`, `appointments.js`)

### 1B: Admin Error Dashboard
Add to `src/routes/admin.js`:
- `GET /portal/admin/errors` — paginated error log viewer with filters (level, date range, user)
- `GET /portal/admin/errors/stats` — error count by day chart, top 10 error messages
- Create `src/views/admin_errors.ejs` — table view with expandable stack traces

### 1C: Unhandled Rejection/Exception Catchers
In `src/server.js`, add:
```js
process.on('uncaughtException', (err) => { logErrorToDb(err, { type: 'uncaughtException' }); });
process.on('unhandledRejection', (reason) => { logErrorToDb(reason, { type: 'unhandledRejection' }); });
```

---

## Phase 2: Input Validation on Order Creation

### 2A: Expand `src/validators/orders.js`
The file exists with basic validation. Expand it to cover:

1. **Patient-facing intake form validation:**
   - `specialty_id` — required, must exist in `specialties` table
   - `service_id` — required, must exist in `services` table
   - `reason_for_review` — required, 10-5000 chars, sanitize HTML
   - `language` — must be 'en' or 'ar'
   - `urgency_flag` — must be 0 or 1
   - `medical_history` — optional, max 10000 chars, sanitize HTML
   - `current_medications` — optional, max 5000 chars, sanitize HTML

2. **File upload validation:**
   - Allowed extensions: `.jpg`, `.jpeg`, `.png`, `.gif`, `.pdf`, `.dcm`, `.doc`, `.docx`
   - Max file size: 50MB per file
   - Max total files: 20 per order
   - Reject executables, scripts, etc.

3. **Create `src/validators/sanitize.js`:**
   - `sanitizeHtml(input)` — strip script tags, event handlers, dangerous attributes
   - `sanitizeString(input, maxLen)` — trim, limit length, strip null bytes
   - `sanitizePhone(input)` — normalize to digits + country code

### 2B: Wire Validators Into Routes
- `src/routes/order_flow.js` — validate on case creation POST
- `src/routes/patient.js` — validate on patient profile update
- Return clear error messages (bilingual) — don't just 400 with "invalid"

### 2C: Request Body Size Limits
In `src/server.js` or `src/middleware.js`:
```js
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
```

---

## Phase 3: Sensitive Data Masking in Logs

### 3A: Create `src/utils/mask.js`
```js
function maskEmail(email) { /* z***@gmail.com */ }
function maskPhone(phone) { /* +20***1234 */ }
function maskToken(token) { /* eyJ***...abc */ }
function maskObject(obj, sensitiveKeys) { /* deep clone, mask values */ }
```
Sensitive keys to mask: `password`, `password_hash`, `token`, `access_token`, `api_key`, `secret`, `authorization`, `cookie`, `credit_card`, `ssn`, `phone`, `email` (in log context only)

### 3B: Apply Masking
- Wrap `logError()` in logger.js to auto-mask `context` object before logging
- Update `accessLogger()` to NOT log query params that contain `token=` or `key=`
- Update WhatsApp service logs to mask phone numbers
- Update email service logs to mask email addresses
- Ensure payment callback logs mask any card data from Paymob responses

### 3C: Audit Log Sanitization
Scan `src/audit.js` and ensure `logOrderEvent()` doesn't store raw sensitive data in `meta` JSON field. Mask where needed.

---

## Phase 4: Patient Ratings & Reviews

### 4A: Database Schema
```sql
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  patient_id TEXT NOT NULL,
  doctor_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
  review_text TEXT,
  is_anonymous INTEGER DEFAULT 0,
  is_visible INTEGER DEFAULT 1,
  admin_flagged INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_reviews_doctor_id ON reviews(doctor_id);
CREATE INDEX IF NOT EXISTS idx_reviews_patient_id ON reviews(patient_id);
CREATE INDEX IF NOT EXISTS idx_reviews_order_id ON reviews(order_id);
```

### 4B: Routes (`src/routes/reviews.js` — NEW)
- `POST /portal/patient/case/:caseId/review` — submit rating (1-5 stars + optional text, anonymous toggle)
  - Only for completed cases, one review per case
  - Validate: rating 1-5, text max 2000 chars, sanitize
- `GET /portal/doctor/:doctorId/reviews` — public doctor review page
- `GET /api/doctors/:doctorId/rating` — JSON: avg rating, count, distribution
- `PUT /portal/patient/review/:reviewId` — edit own review (within 7 days)
- `DELETE /portal/admin/review/:reviewId` — admin can hide/flag reviews

### 4C: UI Integration
- Add "Rate Your Experience" prompt on patient case detail page when case is completed and no review exists
  - Star rating selector (interactive, clickable stars)
  - Optional text area
  - Anonymous checkbox
- Show average rating on doctor profile/cards (star display + count)
- Show reviews list on doctor detail page
- Admin view: all reviews with flag/hide actions

### 4D: Email/WhatsApp Prompt
After case completion, queue notification: "How was your experience with Dr. X? Rate now" with link to review page. Use existing `queueMultiChannelNotification()`.

---

## Phase 5: Patient Onboarding Flow

### 5A: Welcome Flow After Registration
When a new patient registers (in `src/routes/auth.js`):

1. Set `users.onboarding_complete = 0` (add column)
2. Redirect to `/portal/patient/onboarding` instead of dashboard
3. Create `src/views/patient_onboarding.ejs` — multi-step wizard:

**Step 1: Profile Completion**
- Full name (pre-filled if available)
- Phone number (required)
- Date of birth
- Gender
- Preferred language (EN/AR)

**Step 2: Medical History (optional but encouraged)**
- Known conditions (multi-select chips: diabetes, hypertension, heart disease, asthma, etc.)
- Current medications (text area)
- Allergies (text area)
- Previous surgeries (text area)
- Family history (text area)

**Step 3: Welcome Tour**
- Quick visual guide: "Here's how Tashkheesa works"
- 3-4 cards showing: Submit Case → Doctor Reviews → Get Report
- "Start Your First Case" CTA button

4. Mark `onboarding_complete = 1` when wizard finishes
5. Patients can skip → goes to dashboard with a dismissable "Complete your profile" banner

### 5B: Welcome Email
When a new patient registers, queue welcome email using existing notification system:
- Template: `welcome.hbs` (already exists)
- Include: name, how it works steps, link to start first case

### 5C: Profile Completion Reminder
If `onboarding_complete = 0` after 24 hours, queue a reminder notification (email + WhatsApp) saying "Complete your profile to get started."

---

## Phase 6: Patient ↔ Doctor Messaging System

### 6A: Database Schema
```sql
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  patient_id TEXT NOT NULL,
  doctor_id TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_role TEXT NOT NULL,
  content TEXT NOT NULL,
  message_type TEXT DEFAULT 'text',
  file_url TEXT,
  file_name TEXT,
  is_read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_conversations_patient_id ON conversations(patient_id);
CREATE INDEX IF NOT EXISTS idx_conversations_doctor_id ON conversations(doctor_id);
CREATE INDEX IF NOT EXISTS idx_conversations_order_id ON conversations(order_id);
```

### 6B: Routes (`src/routes/messaging.js` — NEW)
- `GET /portal/messages` — conversation list (for both patient and doctor)
- `GET /portal/messages/:conversationId` — single conversation view
- `POST /portal/messages/:conversationId/send` — send text message
- `POST /portal/messages/:conversationId/send-file` — send file (multer upload, max 10MB)
- `POST /portal/messages/:conversationId/read` — mark messages as read
- `GET /api/messages/:conversationId/unread-count` — JSON unread count
- `GET /api/messages/total-unread` — total unread across all conversations

### 6C: Auto-Create Conversations
When a doctor is assigned to a case, auto-create a conversation linked to that order. This happens in the case assignment logic (`src/assign.js` or wherever assignment happens).

### 6D: UI
Create `src/views/messages.ejs`:
- Two-column layout: conversation list (left) + chat area (right)
- Conversation list: name, last message preview, timestamp, unread badge
- Chat area: message bubbles (sent right, received left), timestamps, file attachments
- Input: text box + attach file button + send button
- Auto-scroll to newest message
- Polling for new messages (GET every 5 seconds) or use server-sent events if simple enough
- Mobile: single column, conversation list → tap → chat view

### 6E: Unread Badge
Show unread message count on:
- Patient sidebar/nav: "Messages (3)"
- Doctor sidebar/nav: "Messages (5)"
- Use the `GET /api/messages/total-unread` endpoint

### 6F: Notifications
When a message is sent:
- Queue in-app notification to recipient
- If recipient hasn't read within 10 minutes, queue email notification: "You have a new message from Dr. X / Patient Y"
- Do NOT send WhatsApp for every message (too spammy). Only for first unread after 1 hour.

---

## Phase 7: Prescription Management

### 7A: Database Schema
```sql
CREATE TABLE IF NOT EXISTS prescriptions (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  doctor_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  medications TEXT NOT NULL,
  diagnosis TEXT,
  notes TEXT,
  is_active INTEGER DEFAULT 1,
  valid_until TEXT,
  pdf_url TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_prescriptions_order_id ON prescriptions(order_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_patient_id ON prescriptions(patient_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_doctor_id ON prescriptions(doctor_id);
```

`medications` is a JSON string:
```json
[
  { "name": "Omeprazole", "dosage": "20mg", "frequency": "Once daily", "duration": "4 weeks", "instructions": "Take before breakfast" },
  { "name": "Sertraline", "dosage": "50mg", "frequency": "Once daily", "duration": "8 weeks", "instructions": "Take with food" }
]
```

### 7B: Routes (`src/routes/prescriptions.js` — NEW)
- `GET /portal/doctor/case/:caseId/prescribe` — prescription form
- `POST /portal/doctor/case/:caseId/prescribe` — create prescription
  - Validate: at least 1 medication, each with name + dosage + frequency
  - Generate PDF using PDFKit (similar to report-generator.js)
  - Store PDF URL
- `GET /portal/patient/prescriptions` — list all prescriptions
- `GET /portal/patient/prescription/:prescriptionId` — view single prescription
- `GET /portal/patient/prescription/:prescriptionId/download` — download PDF
- `PUT /portal/doctor/prescription/:prescriptionId` — edit (doctor only, their own)

### 7C: UI
- Doctor prescription form: medication table (add/remove rows), diagnosis field, notes, validity period
- Patient prescription list: date, doctor name, # medications, status (active/expired), download PDF
- Patient prescription detail: full medication list with instructions, download button, print button

### 7D: Prescription PDF
Generate branded PDF similar to existing report-generator.js:
- Header: Tashkheesa logo + "Medical Prescription"
- Patient info, doctor info, date
- Medications table (name, dosage, frequency, duration, instructions)
- Doctor signature block
- Disclaimer
- QR code or verification URL (optional)

---

## Phase 8: Medical Records / EHR Lite

### 8A: Database Schema
```sql
CREATE TABLE IF NOT EXISTS medical_records (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  file_url TEXT,
  file_name TEXT,
  date_of_record TEXT,
  provider TEXT,
  tags TEXT,
  is_shared_with_doctors INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_medical_records_patient_id ON medical_records(patient_id);
```

`record_type` values: `lab_result`, `imaging`, `prescription`, `discharge_summary`, `surgical_report`, `vaccination`, `allergy`, `chronic_condition`, `other`

### 8B: Routes (`src/routes/medical_records.js` — NEW)
- `GET /portal/patient/records` — list all records with filters (type, date range, search)
- `POST /portal/patient/records` — upload new record (file + metadata)
- `GET /portal/patient/records/:recordId` — view record detail
- `PUT /portal/patient/records/:recordId` — edit metadata
- `DELETE /portal/patient/records/:recordId` — soft delete (mark hidden, don't actually delete)
- `POST /portal/patient/records/:recordId/share` — toggle sharing with doctors
- `GET /portal/doctor/case/:caseId/patient-records` — doctor views shared records for their patient

### 8C: Auto-Import
When a case is completed (report generated), auto-create a medical record entry:
- `record_type`: 'discharge_summary' or 'other'
- `title`: "Tashkheesa Report — [specialty]"
- `file_url`: link to the generated PDF
- `is_shared_with_doctors`: 1

When a prescription is created, auto-create a medical record:
- `record_type`: 'prescription'
- `title`: "Prescription — Dr. [name]"
- `file_url`: prescription PDF

### 8D: UI
Create `src/views/patient_records.ejs`:
- Grid of record cards grouped by type
- Each card: icon (by type), title, date, provider, shared badge
- Click → detail view with file preview (if image/PDF)
- Upload button → form with file upload + metadata fields
- Filter bar: type dropdown, date range picker, search box
- "Share with doctors" toggle per record

---

## Phase 9: Referral Program

### 9A: Database Schema
```sql
CREATE TABLE IF NOT EXISTS referral_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  type TEXT DEFAULT 'patient',
  reward_type TEXT DEFAULT 'discount',
  reward_value REAL DEFAULT 10,
  max_uses INTEGER DEFAULT 0,
  times_used INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS referral_redemptions (
  id TEXT PRIMARY KEY,
  referral_code_id TEXT NOT NULL,
  referrer_id TEXT NOT NULL,
  referred_id TEXT NOT NULL,
  order_id TEXT,
  reward_granted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_referral_codes_user_id ON referral_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes(code);
CREATE INDEX IF NOT EXISTS idx_referral_redemptions_referrer_id ON referral_redemptions(referrer_id);
```

### 9B: Referral Code Generation
- When patient registers, auto-generate a unique referral code: `TASH-XXXXX` (5 alphanumeric chars)
- Store in `referral_codes` table
- Show on patient dashboard: "Share your code: TASH-AB12C — Get 10% off for you and your friend!"

### 9C: Routes (`src/routes/referrals.js` — NEW)
- `GET /portal/patient/referrals` — view my referral code, stats (times used, rewards earned)
- `POST /api/referral/validate` — validate a code (used during registration/checkout)
- `GET /portal/admin/referrals` — admin view: all codes, redemptions, rewards granted

### 9D: Integration Points
- Registration form: add optional "Referral Code" field
- Payment flow: if valid referral code, apply discount
- After first paid case by referred patient: mark `reward_granted = 1`, grant reward to referrer (credit or notification)

### 9E: UI
- Patient dashboard: referral card with code, copy button, share via WhatsApp/email buttons
- Registration: optional referral code input
- Admin: referral analytics (total referrals, conversion rate, total rewards)

---

## Phase 10: SMS Appointment Reminders

### 10A: Reminder Scheduler
Create `src/jobs/appointment_reminders.js`:
- Run on a cron (every 15 minutes via node-cron, already installed)
- Query appointments where `scheduled_at` is within the next 24 hours and `reminder_24h_sent = 0`
- Query appointments where `scheduled_at` is within the next 1 hour and `reminder_1h_sent = 0`
- For each, send:
  - Email reminder (use existing emailService)
  - WhatsApp reminder (use existing whatsapp.js)
  - Queue in-app notification

### 10B: Database Columns
Add to `appointments` table (safe migration):
- `reminder_24h_sent INTEGER DEFAULT 0`
- `reminder_1h_sent INTEGER DEFAULT 0`

### 10C: Email + WhatsApp Templates
- Create `src/templates/email/en/appointment-reminder.hbs` (if not already exists)
- Create `src/templates/email/ar/appointment-reminder.hbs`
- Template variables: patientName, doctorName, appointmentDate, appointmentTime, joinUrl

### 10D: Register Cron in Server
In `src/server.js`, add:
```js
const cron = require('node-cron');
const { runAppointmentReminders } = require('./jobs/appointment_reminders');
cron.schedule('*/15 * * * *', () => runAppointmentReminders());
```

---

## Phase 11: Email Marketing Campaigns

### 11A: Database Schema
```sql
CREATE TABLE IF NOT EXISTS email_campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subject_en TEXT NOT NULL,
  subject_ar TEXT,
  template TEXT NOT NULL,
  target_audience TEXT DEFAULT 'all',
  status TEXT DEFAULT 'draft',
  scheduled_at TEXT,
  sent_at TEXT,
  total_recipients INTEGER DEFAULT 0,
  total_sent INTEGER DEFAULT 0,
  total_failed INTEGER DEFAULT 0,
  created_by TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS campaign_recipients (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  sent_at TEXT,
  error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign_id ON campaign_recipients(campaign_id);
```

### 11B: Routes (`src/routes/campaigns.js` — NEW)
- `GET /portal/admin/campaigns` — list all campaigns with status
- `GET /portal/admin/campaigns/new` — create campaign form
- `POST /portal/admin/campaigns` — create campaign
  - Select audience: all patients, all doctors, patients with completed cases, inactive patients (no case in 30 days), custom filter
  - Write subject (EN + AR), select or upload email template
  - Schedule for later or send now
- `GET /portal/admin/campaigns/:id` — campaign detail with delivery stats
- `POST /portal/admin/campaigns/:id/send` — trigger send
- `POST /portal/admin/campaigns/:id/cancel` — cancel scheduled campaign

### 11C: Campaign Worker
Create `src/jobs/campaign_worker.js`:
- Process campaigns with `status = 'scheduled'` and `scheduled_at <= now`
- For each recipient: use `emailService.sendEmail()` with campaign template
- Rate limit: max 5 emails/second to avoid SMTP throttling
- Update `campaign_recipients.status` and `campaign.total_sent/total_failed`
- Set `campaign.status = 'sent'` when complete

### 11D: Unsubscribe
- Add `email_marketing_opt_out INTEGER DEFAULT 0` to users table
- All marketing emails include unsubscribe link
- `GET /unsubscribe/:token` — one-click unsubscribe (token = signed user ID)
- Campaign worker skips users with `email_marketing_opt_out = 1`
- Admin campaign audience filters respect opt-out

### 11E: Admin UI
Create `src/views/admin_campaigns.ejs`:
- Campaign list: name, status badge, audience, scheduled date, sent/total stats
- Campaign detail: delivery progress bar, recipient list with status, error details
- New campaign form: rich text editor (or Handlebars template selector), audience selector, schedule picker

---

## Implementation Order
1. Phase 1 → Error Tracking (foundation for debugging everything else)
2. Phase 2 → Input Validation (security foundation)
3. Phase 3 → Data Masking (security hardening)
4. Phase 4 → Ratings & Reviews (engagement feature, relatively standalone)
5. Phase 5 → Patient Onboarding (improves activation)
6. Phase 6 → Messaging (major feature, depends on stable notification system)
7. Phase 7 → Prescriptions (depends on messaging for delivery)
8. Phase 8 → Medical Records (depends on prescriptions + reports for auto-import)
9. Phase 9 → Referral Program (growth feature, standalone)
10. Phase 10 → SMS Reminders (depends on stable notification + appointment system)
11. Phase 11 → Email Campaigns (admin tool, last because least urgent)

## Definition of Done (per phase)
- [ ] `npm run preflight` passes
- [ ] Feature works end-to-end (create, read, update, delete where applicable)
- [ ] Bilingual support (EN + AR labels on all new views)
- [ ] Access control enforced (patient sees their own, doctor sees their cases, admin sees all)
- [ ] Input validation on all POST endpoints
- [ ] Error handling with `logError()` — no unhandled crashes
- [ ] Database migrations use safe pattern (check exists before CREATE/ALTER)
- [ ] Committed with descriptive message: `feat(phase-N): description`
