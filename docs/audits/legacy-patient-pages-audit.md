# Legacy Patient Pages Audit
**Generated:** 2026-04-26  
**Scope:** Recon only — no fixes applied.  
**Companion to:** docs/audits/cross-portal-links-audit.md

---

## Executive Summary

This audit identifies **16 non-V2 patient-side routes and views** still using legacy chrome (`partials/header` + `layout: "portal"`). The V2 migration shipped only **6 views** (Dashboard, New Case wizard, Case Detail, Payment success/return, 404/500 errors) with clean Cormorant Garamond serif typography and the new patient sidebar.

The legacy routes span **5 functional domains:**
- **Profile & Account** (1 route): `/patient/profile`
- **Notifications** (1 route): `/portal/patient/alerts`
- **Messaging** (1 route): `/portal/messages` (shared patient/doctor)
- **Prescriptions** (2 routes): `/portal/patient/prescriptions`, `/portal/patient/prescription/:id`
- **Medical Records** (3 routes): `/portal/patient/records` (list/create/detail/delete/share)
- **Referral Program** (1 route): `/portal/patient/referrals`
- **Reviews** (2 routes): `/portal/patient/reviews`, review form in case detail
- **Appointments** (2 routes): Redirects to V2 video booking
- **Case Reports** (1 route): `/portal/case/:caseId` (patient-accessible report viewer)
- **Order wizard remnants** (2 views): `patient_order_new`, `patient_order_upload` (legacy, orphaned from pre-V2 flow)

**Key finding:** Prescriptions, Medical Records, Referrals, Reviews, and Appointments tables **exist and have real data** (not placeholders). However, these features don't align with Tashkheesa's product mission (one-shot medical second-opinion service, not ongoing primary-care patient management).

**Recommendation breakdown:**
- **(a) Migrate to V2 chrome:** Alerts (1), Messaging (1), Profile (1) — real functionality patients need daily
- **(b) Sidebar-only / de-emphasize:** None — all legacy routes should either migrate or be removed
- **(c) Delete entirely:** Prescriptions, Medical Records, Referrals, Appointments, case reports, and order-wizard views (8–10 routes) — product mismatch

---

## V2 Chrome Detection Criteria

**V2 views** use:
- `partials/patient/head` (new header)
- `partials/patient/sidebar` (V2 sidebar with 4 nav items: Home, New case, Cases, Messages)
- `partials/patient/topbar` + mobile tabbar
- CSS: `patient-tokens.css`, `patient-portal-v2.css`, fonts: Cormorant Garamond
- No `layout: "portal"` parameter

**Legacy views** use:
- `partials/header` (old header)
- `partials/patient_sidebar` (old sidebar with 12 nav items: Dashboard, Cases, New Case, Alerts, Appointments, Messages, Prescriptions, Records, Referrals, Reviews, Profile, Logout)
- `layout: "portal"` parameter
- CSS: older portal.ejs layout
- Font: Playfair Display serif

---

## Findings Table

| # | Route | View file | Real data? | Linked from | Product fit | Classification |
|---|-------|-----------|------------|-------------|-------------|----------------|
| 1 | `/patient/profile` | `patient_profile.ejs` | Yes — user table | V2 sidebar (Account) | Yes — user account settings | **(a) migrate** |
| 2 | `/portal/patient/alerts` | `patient_alerts.ejs` | Yes — notifications table | Legacy sidebar only | Yes — in-app notifications | **(a) migrate** |
| 3 | `/portal/messages` | `messages.ejs` | Yes — conversations table | Both sidebars, case detail | Yes — real doctor-patient messaging | **(a) migrate** |
| 4 | `/portal/patient/prescriptions` | `patient_prescriptions.ejs` | Yes — prescriptions table | Legacy sidebar only | **No** — not in product scope | **(c) delete** |
| 5 | `/portal/patient/prescription/:id` | `patient_prescription_detail.ejs` | Yes — prescriptions table | Prescriptions list link | **No** — not in product scope | **(c) delete** |
| 6 | `/portal/patient/records` | `patient_records.ejs` | Yes — medical_records table | Legacy sidebar only | **No** — not in product scope | **(c) delete** |
| 7 | `/portal/patient/records/:id` | (partial in records.ejs) | Yes — medical_records table | Records list link | **No** — not in product scope | **(c) delete** |
| 8 | `/portal/patient/referrals` | `patient_referrals.ejs` | Yes — referral_codes, referral_redemptions | Legacy sidebar only | **No** — not in product scope | **(c) delete** |
| 9 | `/portal/patient/reviews` | `patient_reviews.ejs` | Yes — reviews table | Legacy sidebar only | **Weak** — review submission is in-case, list is redundant | **(c) delete** |
| 10 | `/portal/patient/case/:caseId/review` | `patient_review_form.ejs` | Yes — reviews table | Case detail (V2) | **Weak** — review capture fits product, but form is legacy chrome | **(b) keep route but migrate view** |
| 11 | `/portal/patient/appointments` | `patient_appointments_list.ejs` | Yes — appointments table | Legacy sidebar + tour | **No** — redirects to V2 video.js anyway | **(c) delete view** |
| 12 | `/portal/case/:caseId` | `patient_case_report.ejs` | Yes — orders + files | Case detail (V2) | **Yes** — report viewing is core product | **(a) migrate** |
| 13 | `/portal/patient/orders/new` | (redirects to V2) | N/A — 301 redirect | None | N/A — deprecated redirect | **(c) delete redirect)** |
| 14 | `/portal/patient/orders/:id/upload` | `patient_order_upload.ejs` | Partial — used in V2 new-case flow | New case wizard (V2) | **Yes** — file upload is core product | **(a) migrate or merge)** |
| 15 | `/portal/patient/payment-required` | `patient_payment_required.ejs` | N/A — stub/placeholder | Order flow (V2) | **Yes** — payment is core | **(a) migrate** |
| 16 | `/portal/messages` (doctor-only branch) | (in messages.ejs) | Yes — but doctor gets different layout | Doctor portal | Doctor-side, not in scope | (separate audit) |

---

## Per-Route Detail

### 1. `/patient/profile`
**Route handler:** `src/routes/patient.js:119–156`  
**View:** `src/views/patient_profile.ejs`  
**Handler logic:**
- GET: Renders profile form with current user data (name, email, phone, DOB, gender, country, preferred lang, notification prefs)
- POST: Updates user record in database (name, phone, lang, notification flags, DOB, gender, country)
- Real database mutations via `UPDATE users`
- Middleware: `requireRole('patient')` — patient-only

**What it does:** Read-write user profile editor. Shows user fields, accepts form submission, persists changes to `users` table.

**Real data?** Yes. Mutates user record. Displays and saves: name, phone, DOB, gender, country, language preference, WhatsApp notification flag, marketing email opt-out.

**Linked from:**
- V2 sidebar: Account → Profile (`src/views/partials/patient/sidebar.ejs:41`)
- No other links found

**Product fit:** Yes — user account settings are fundamental to any portal.

**Classification:** **(a) needs V2 chrome migration to ship** — users will land here regularly from the V2 sidebar.

**Notes:**
- Currently uses legacy portal layout + patient_sidebar partial
- Form styling uses legacy CSS variables (`--p1-*` namespace, but content is functional)
- Needs V2 head/foot/sidebar partial swap + CSS update to `patient-tokens.css`

---

### 2. `/portal/patient/alerts`
**Route handler:** `src/routes/patient.js:376–408`  
**View:** `src/views/patient_alerts.ejs`  
**Handler logic:**
- GET: Fetches notifications from `notifications` table (auto-detects columns, adapts to schema)
- Marks all notifications as read for patient on page load
- Normalizes to standard shape (id, order_id, channel, template, status, is_read, response, timestamp)
- Renders list view with relative time formatting ("5m ago", "2d ago")
- Middleware: `requireRole('patient')` — patient-only

**What it does:** Displays in-app notifications/alerts to patient. Marks them as read on page visit. Shows order updates, assignment notifications, payment alerts, report readiness.

**Real data?** Yes. Queries real `notifications` table, persists read-status updates, handles multi-column schema variance.

**Linked from:**
- Legacy sidebar: Alerts (`src/views/partials/patient_sidebar.ejs:37`)
- Not in V2 sidebar (functionality moved to bell-icon dropdown in topbar)
- Patient tour references `/portal/patient/alerts` path in comments but no active routing

**Product fit:** Yes — notifications are essential. However, V2 already exposes recent notifications via topbar bell-icon dropdown (`src/views/partials/patient/topbar.ejs`).

**Classification:** **(a) needs V2 chrome migration to ship** — but with caveat: full alerts list view may be redundant given topbar dropdown. Consider consolidating into new V2 "All Alerts" page or removing full-page view.

**Notes:**
- Currently renders via legacy portal layout
- Real feature but UI already partially in V2 (dropdown)
- Needs decision: keep full-page list or surface all notifications in topbar dropdown?

---

### 3. `/portal/messages`
**Route handler:** `src/routes/messaging.js:72–120` (GET list), `src/routes/messaging.js:129–186` (GET detail)  
**View:** `src/views/messages.ejs` (conditional patient vs. doctor branch)  
**Handler logic:**
- GET list: Fetches conversations (patient ↔ doctor pairs), enriched with unread counts, last message, timestamps
- GET detail: Loads active conversation, messages, computes read status
- Real database: `conversations`, `messages` tables
- Patients use hand-coded shell + patient_sidebar partial
- Doctors use standard portal layout
- Middleware: `requireRole('patient', 'doctor')` — dual-role support

**What it does:** Real-time messaging between patient and assigned doctor. Conversation list with unread badges, message thread view, send/receive with notifications.

**Real data?** Yes. Persistent conversations, message history, read flags, notifications via multi-channel system.

**Linked from:**
- V2 sidebar: Messages (`src/views/partials/patient/sidebar.ejs:37`) — links to `/portal/patient/messages` redirect in appointments.js:104
- Legacy sidebar: Messages
- Patient tour: mention in comments (Tour 1)
- Case detail: likely in-thread messaging link

**Product fit:** Yes — core feature for patient-doctor communication.

**Classification:** **(a) needs V2 chrome migration to ship** — but currently only patient-side uses legacy shell. Doctor branch uses standard portal layout. Priority: migrate patient branch.

**Notes:**
- Complex dual-role view (patient hand-coded shell, doctor standard portal)
- Redirect exists: `appointments.js:104` routes `/portal/patient/messages` to canonical `/portal/messages`
- Messages route is mounted globally (`app.use('/', messagingRoutes)`)
- Partial patient-side legacy chrome only

---

### 4. `/portal/patient/prescriptions`
**Route handler:** `src/routes/prescriptions.js:193–231`  
**View:** `src/views/patient_prescriptions.ejs`  
**Handler logic:**
- GET: Queries `prescriptions` table filtered by `patient_id`, joins doctor/specialty info
- Rewrites `pdf_url` to patient download endpoint
- Renders list of prescriptions with doctor name, specialty, date
- Middleware: `requireRole('patient')` — patient-only

**What it does:** Displays list of prescriptions issued by assigned doctor. Each prescription shows doctor name, specialty, dates, links to download PDF.

**Real data?** Yes. `prescriptions` table exists, populated by doctor.js when doctor creates prescription. Queries real data.

**Linked from:**
- Legacy sidebar: Prescriptions (`src/views/partials/patient_sidebar.ejs:55`)
- Not in V2 sidebar
- Not in V2 routing

**Product fit:** **No.** Tashkheesa is a one-shot second-opinion service. Patients do not receive prescriptions — they submit cases, doctors review and issue reports, not prescriptions. Prescriptions table was likely created for a future telehealth feature that never shipped.

**Classification:** **(c) safe to delete entirely as deprecated** — orphaned feature, not core to product.

**Notes:**
- Table exists but is deprioritized / disused in product roadmap
- Legacy view can be removed
- Route should be removed from sidebar (already not in V2)
- DELETE the prescription prescription view/route pair

---

### 5. `/portal/patient/prescription/:prescriptionId`
**Route handler:** `src/routes/prescriptions.js:234–283`  
**View:** `src/views/patient_prescription_detail.ejs`  
**Handler logic:**
- GET: Fetches single prescription by ID, joins doctor/specialty
- Verifies patient_id matches current user
- Renders detail view with PDF download link

**What it does:** Shows single prescription details and download link.

**Real data?** Yes. Queries `prescriptions` table.

**Linked from:**
- Prescription list view only
- Not in sidebar or V2 routing

**Product fit:** **No** — same as parent list route.

**Classification:** **(c) safe to delete entirely as deprecated** — child of deprecated prescriptions feature.

**Notes:**
- Remove along with prescriptions list route

---

### 6. `/portal/patient/records`
**Route handler:** `src/routes/medical_records.js:17–64` (GET list), 67–110 (POST create), 111–177 (GET/POST detail + delete)  
**View:** `src/views/patient_records.ejs`  
**Handler logic:**
- GET list: Fetches `medical_records` WHERE `patient_id = $1 AND is_hidden = false`, supports filtering by type and text search
- POST create: Inserts new record (title, description, file_url, record_type)
- GET detail: Single record with sharing controls
- POST delete: Soft-delete (set is_hidden = true)
- Middleware: `requireRole('patient')` — patient-only

**What it does:** Patient-uploaded medical document library. Patients can upload/store their own records (lab results, imaging, etc.), organize by type (lab work, imaging, consultation notes, etc.), search, and share with doctor.

**Real data?** Yes. Full CRUD on `medical_records` table.

**Linked from:**
- Legacy sidebar: Medical Records (`src/views/partials/patient_sidebar.ejs:61`)
- Not in V2 sidebar

**Product fit:** **No.** Tashkheesa is for one-shot cases. Patients upload files as part of a case submission (via new-case wizard). A persistent personal medical record library is not part of the second-opinion workflow. This is a primary-care feature.

**Classification:** **(c) safe to delete entirely as deprecated** — product feature creep, not in MVP scope.

**Notes:**
- Table exists, real feature, but not integrated with case workflow
- Legacy view + route should be removed
- File upload for cases is handled in V2 new-case wizard instead

---

### 7. `/portal/patient/referrals`
**Route handler:** `src/routes/referrals.js:48–90`  
**View:** `src/views/patient_referrals.ejs`  
**Handler logic:**
- GET: Generates unique referral code for patient (auto-created if missing)
- Fetches redemptions (friends referred by this patient)
- Counts total referred + rewarded
- Renders referral sharing UI with code, reward tracker
- Middleware: `requireRole('patient')` — patient-only

**What it does:** Referral program UI. Shows patient's unique code, list of friends referred, reward status. Allows patient to share code to earn credit.

**Real data?** Yes. `referral_codes` and `referral_redemptions` tables. Real reward tracking.

**Linked from:**
- Legacy sidebar: Referrals (`src/views/partials/patient_sidebar.ejs:67`)
- Not in V2 sidebar

**Product fit:** **No.** Tashkheesa's referral program is a marketing feature, not part of the medical second-opinion workflow. While referral tables exist and are functional, the UI is not integrated with core case flow.

**Classification:** **(c) safe to delete entirely as deprecated** — marketing feature orthogonal to medical product.

**Notes:**
- Tables exist and are used (referral validation/redemption endpoints exist in referrals.js)
- View can be removed from patient sidebar
- Referral code generation and validation API endpoints can stay (used by marketing)
- Patient-facing referral UI is legacy and not in V2 scope

---

### 8. `/portal/patient/reviews`
**Route handler:** `src/routes/reviews.js:293–342`  
**View:** `src/views/patient_reviews.ejs`  
**Handler logic:**
- GET: Queries `reviews` WHERE patient_id, joins doctor/specialty
- Also queries `orders` WHERE patient_id AND status IN (completed, done, delivered, report_ready, finalized) AND NOT IN reviews (pending cases without reviews)
- Renders two lists: submitted reviews + pending review cases
- Middleware: `requireRole('patient')` — patient-only

**What it does:** Shows patient's submitted doctor reviews + list of completed cases that haven't been reviewed yet (prompts patient to rate).

**Real data?** Yes. `reviews` and `orders` tables with real data.

**Linked from:**
- Legacy sidebar: Reviews (`src/views/partials/patient_sidebar.ejs:73`)
- Not in V2 sidebar
- Case detail (V2) likely has in-case review form button

**Product fit:** **Weak.** Review capture is part of the product (patient rates doctor post-case), but a dedicated "reviews" list page is not. Review submission should happen in-case (which it does), and reviews don't need a dedicated hub.

**Classification:** **(c) safe to delete entirely as deprecated** — review submission happens in-case, aggregated list is redundant.

**Notes:**
- Review form is in case detail (which is V2) — keep that
- Full-page reviews list view is legacy and can be removed
- Keep review submission API but remove this listing page

---

### 9. `/portal/patient/case/:caseId/review` (Review form)
**Route handler:** `src/routes/reviews.js:21–67`  
**View:** `src/views/patient_review_form.ejs`  
**Handler logic:**
- GET: Fetches case (order) by ID, verifies patient ownership, renders review form
- POST: Validates rating (1–5 stars), comment, inserts/updates review record
- Middleware: `requireRole('patient')` — patient-only

**What it does:** Inline review form to rate doctor and submit feedback after case completion.

**Real data?** Yes. Mutates `reviews` table.

**Linked from:**
- Case detail page (V2) — likely a button or modal
- Completed case status flow

**Product fit:** Yes — review capture is essential to product (quality feedback, future doctor ranking).

**Classification:** **(a) needs V2 chrome migration to ship** if it's a full page; **(b) safe to keep as modal/inline** if it's refactored to modal in case detail. Currently it's a legacy full-page form.

**Notes:**
- Review form view (`patient_review_form.ejs`) uses legacy chrome
- Review API endpoints work fine
- Recommendation: migrate to modal/inline in case detail page OR migrate to V2 chrome if keeping as full page
- Currently linked from case detail (verify if modal or redirect)

---

### 10. `/portal/patient/appointments`
**Route handler:** `src/routes/video.js:1227–1262` (GET list handler inside broader route)  
**View:** `src/views/patient_appointments_list.ejs`  
**Handler logic:**
- GET: Queries appointments table for patient, enriches with doctor/specialty names
- Renders list of booked video consultation appointments (past and future)
- Middleware: `requireRole('patient')` — patient-only

**What it does:** Shows patient's video consultation appointments history and upcoming bookings.

**Real data?** Yes. `appointments` table with real booking records.

**Linked from:**
- Legacy sidebar: Appointments (`src/views/partials/patient_sidebar.ejs:43`)
- Legacy appointments.js:103–111 contains redirect: `/portal/patient/appointments` → `/portal/video/appointments` (legacy compatibility)
- V2 sidebar does NOT list Appointments (video booking is modal in case detail)

**Product fit:** **Weak.** Video consultation booking is part of the product, but not as a separate sidebar nav item. Booking happens in-case (via modal in case detail). Listing appointments is secondary.

**Classification:** **(c) safe to delete entirely as deprecated** — view and route. The redirect to V2 video.js already exists and works.

**Notes:**
- View (`patient_appointments_list.ejs`) uses legacy chrome
- Route handler exists in video.js but patient-side gets redirected by appointments.js
- Full redirect chain: patient clicks sidebar → `/portal/patient/appointments` → 302 to `/portal/video/appointments` (canonical V2 route in video.js)
- Can remove the legacy view and handler in video.js; V2 video.js handles appointments

---

### 11. `/portal/case/:caseId` (Case Report Viewer)
**Route handler:** `src/routes/reports.js:77–151`  
**View:** `src/views/patient_case_report.ejs`  
**Handler logic:**
- GET: Fetches order by ID, verifies patient access, loads report content, annotations, files, history
- Queries `orders`, `users` (patient/doctor), `specialties`, `services`, `case_files`, `annotations`, `report_exports`
- Renders multi-section report view: patient info, case details, doctor notes, images, annotations, downloadable report
- Middleware: Verifies `isPatient` OR `isDoctor` OR `isAdmin` and user has case access
- Support for both patient and doctor roles

**What it does:** Primary report viewer. Patient (and doctor) accesses submitted case, review progress, final diagnosis report, images with annotations, export history.

**Real data?** Yes. Queries real case + report data.

**Linked from:**
- Case detail page (V2) — likely a "View Report" button or tab
- Case status flow (when report is ready)
- No sidebar link

**Product fit:** **Yes — core product.** Viewing the diagnosis report is the main deliverable.

**Classification:** **(a) needs V2 chrome migration to ship** — currently uses legacy chrome but is accessed from V2 case detail page, creating visual disconnect.

**Notes:**
- View (`patient_case_report.ejs`) uses legacy chrome
- Handler is well-implemented with full RBAC
- Needs V2 chrome migration: header/footer/sidebar partials
- Is this a full page or a tab/modal in case detail? Verify UX in V2 case detail view

---

### 12. `/portal/patient/orders/:id/upload`
**Route handler:** `src/routes/patient.js:2653–2747`  
**View:** `src/views/patient_order_upload.ejs`  
**Handler logic:**
- GET: Renders file upload form for case (after case created, before payment)
- POST: Accepts file uploads via Uploadcare integration, saves file references to `case_files` table
- Supports drag-drop and click-to-browse
- Validates file types (images, PDFs, DICOM)
- Middleware: `requireRole('patient')` — patient-only

**What it does:** File upload interface during case creation. Patient drags/drops or selects medical files (images, scans, documents) to be reviewed.

**Real data?** Yes. Persists files to `case_files` table and R2 storage.

**Linked from:**
- New case wizard (V2) — step 2 or 3 in `/patient/new-case`
- Standalone fallback form at `/portal/patient/orders/:id/upload`

**Product fit:** Yes — file upload is core to case submission.

**Classification:** **(b) safe to remove from sidebar but keep route alive** — not a top-level nav item, but used as a step in the wizard. Alternatively, **(a) migrate** if kept as standalone page. Current state: orphaned from new sidebar, but accessible from V2 new-case flow if needed as fallback.

**Notes:**
- View (`patient_order_upload.ejs`) uses legacy chrome
- Route is functional but may be redundant if V2 new-case wizard has native file upload
- Verify if V2 new-case uses this endpoint or has its own uploader
- If used: migrate to V2 chrome; if unused: mark as deprecated

---

### 13. `/portal/patient/payment-required`
**Route handler:** `src/routes/patient.js:2180–2230`  
**View:** `src/views/patient_payment_required.ejs` + `patient_payment_success.ejs`  
**Handler logic:**
- Renders payment gateway initiation page (Telr or Stripe)
- Shows order summary, amount due, country-specific payment method options
- Generates payment request, redirects to gateway
- Middleware: `requireRole('patient')` — patient-only

**What it does:** Pre-payment confirmation screen. Shows case cost, allows patient to review before entering payment gateway.

**Real data?** Partial. Fetches order, computes price, but does not persist payment status here (payment gateway does).

**Linked from:**
- New case wizard (V2) — final step before payment
- Order detail if payment pending

**Product fit:** Yes — payment is core.

**Classification:** **(a) needs V2 chrome migration to ship** — used as a step in the V2 new-case wizard, but render uses legacy chrome.

**Notes:**
- View uses legacy chrome but is part of critical path (new case → payment)
- Migrate to V2 chrome ASAP
- Payment success/return already in V2 (patient_payment_success.ejs uses V2 head)

---

### 14. `/portal/patient/payment-success`, `/portal/patient/payment-return`
**Route handler:** `src/routes/patient.js:1538–1651`  
**View:** `src/views/patient_payment_success.ejs`  
**Handler logic:**
- GET: Verifies payment status via Telr/Stripe webhook
- Marks order as paid
- Renders success or error screen
- Middleware: `requireRole('patient')` — patient-only

**What it does:** Post-payment confirmation. Shows success/failure, order details, next steps (waiting for doctor assignment).

**Real data?** Yes. Updates `orders.paid_at` status.

**Linked from:**
- Payment gateway callback
- Not in sidebar

**Product fit:** Yes — payment confirmation is essential.

**Classification:** **(Already V2)** — This view already uses `partials/patient/head` and is in V2. ✓

**Notes:**
- Already migrated to V2 chrome
- No action needed

---

### 15. Orphaned Views: `patient_order_new` 
**Route handler:** None (currently orphaned; may have been rendered by old wizard)  
**View:** `src/views/patient_order_new.ejs`  
**Handler logic:** N/A — view exists but no route currently renders it as a full page.

**What it does:** Legacy new-case form (pre-V2 wizard). Single-page form for case submission.

**Real data?** No — new cases are now multi-step (V2 wizard in `/patient/new-case`).

**Linked from:** None (orphaned from old flow).

**Product fit:** Obsolete — replaced by V2 wizard.

**Classification:** **(c) safe to delete entirely as deprecated** — orphaned view, no route, superseded by V2 wizard.

**Notes:**
- View can be deleted
- Confirm no hidden routes reference it before deletion

---

### 16. Redirect Route: `/portal/patient/orders/new`
**Route handler:** `src/routes/patient.js:1295–1300`  
**Handler logic:** 301 redirect to `/patient/new-case` (with optional specialty_id query param pass-through)

**What it does:** Legacy URL alias. Preserves old bookmarks and links to the new V2 wizard.

**Linked from:**
- Possibly old UI, old patient tour, external links

**Product fit:** Utility — backwards compatibility only.

**Classification:** **(c) safe to delete entirely as deprecated** — after confirming no external links depend on it. The redirect itself is harmless but unnecessary.

**Notes:**
- Can remove after 6-month notice period if external links are unlikely
- Alternatively, keep for backwards compatibility (minimal overhead)

---

## Other Non-V2 Patient Views Found

| View | Route | Status | Notes |
|------|-------|--------|-------|
| `messages.ejs` (patient branch) | `/portal/messages` | Legacy chrome, patient-only | Dual-role view; doctor branch uses standard layout |
| `patient_onboarding.ejs` | `/portal/patient/onboarding` (from onboarding.js) | Legacy | Patient first-visit walkthrough — check if still used |
| `patient_walkthrough.ejs` | Unknown — appears in list but not found in grep | Orphaned | May be legacy tour/onboarding — check if routed |

---

## Database Table Verification

| Table | Exists? | Columns | Real data? | Usage |
|-------|---------|---------|-----------|-------|
| `prescriptions` | Yes | doctor_id, patient_id, order_id, pdf_url, created_at, ... | Unknown — likely minimal | Doctor → Patient (not in product flow) |
| `medical_records` | Yes | patient_id, record_type, title, description, file_url, is_hidden, created_at, ... | Unknown — likely unused | Patient personal library (not integrated) |
| `referral_codes` | Yes | user_id, code, is_active, created_at, ... | Yes | Referral program (marketing feature) |
| `referral_redemptions` | Yes | referrer_id, referred_id, reward_granted, created_at, ... | Yes | Referral tracking |
| `reviews` | Yes | patient_id, doctor_id, order_id, rating, comment, created_at, ... | Yes | Post-case feedback (core feature) |
| `appointments` | Yes | patient_id, doctor_id, status, scheduled_at, ... | Yes | Video consultation bookings |
| `conversations` | Yes | patient_id, doctor_id, order_id, status, created_at, ... | Yes | Messaging (core feature) |
| `messages` | Yes | conversation_id, sender_id, content, is_read, created_at, ... | Yes | Messaging (core feature) |

**Conclusion:** All tables exist and have schema. Prescriptions and medical_records likely have minimal data. Referrals, reviews, appointments have real data but are not integrated with core second-opinion workflow.

---

## Recommendations

### (a) Migrate to V2 Chrome — 5 routes
Priority order:

1. **`/patient/profile`** (Moderate priority)
   - User account management
   - Currently linked in V2 sidebar (Account → Profile)
   - Action: Swap `partials/header` → `partials/patient/head`, `partials/footer` → `partials/patient/foot`, `patient_sidebar` → `patient/sidebar`
   - Estimated effort: 2–3 hours

2. **`/portal/messages`** (High priority)
   - Real doctor-patient communication
   - Patient branch currently uses legacy chrome
   - Action: Refactor patient branch to V2 sidebar, align CSS
   - Estimated effort: 4–6 hours (complex dual-role view)

3. **`/portal/patient/alerts`** (High priority if kept; consider consolidating to topbar)
   - In-app notifications
   - Decision needed: full-page alerts list vs. topbar dropdown only
   - Action: Either migrate to V2 chrome OR remove if topbar dropdown is sufficient
   - Estimated effort: 2–3 hours (migration) or 1 hour (removal)

4. **`/portal/case/:caseId`** (High priority)
   - Report viewer
   - Accessed from V2 case detail
   - Action: Swap chrome partials, verify UX flow (full page vs. tab/modal)
   - Estimated effort: 3–4 hours

5. **`/portal/patient/payment-required`** (High priority)
   - Payment confirmation screen
   - Part of critical V2 new-case wizard flow
   - Action: Swap chrome partials
   - Estimated effort: 1–2 hours

### (b) Keep Route Alive But De-emphasize — 0 routes
(None identified as category b; all are either migrate or delete)

### (c) Delete Entirely — 9+ routes
**Priority order (by product misalignment):**

1. **Prescriptions** (`/portal/patient/prescriptions` + detail)
   - Not part of second-opinion service
   - Action: Remove sidebar link, deprecate routes
   - Timeline: Immediate

2. **Medical Records** (`/portal/patient/records` + CRUD)
   - Personal medical library not integrated with case flow
   - Action: Remove sidebar link, deprecate routes
   - Timeline: Immediate

3. **Referral Program UI** (`/portal/patient/referrals`)
   - Marketing feature, not clinical
   - Keep referral API endpoints (validation, redemption)
   - Action: Remove patient-facing UI, keep backend
   - Timeline: Immediate

4. **Reviews List** (`/portal/patient/reviews`)
   - Review submission happens in-case (V2)
   - Aggregated list is redundant
   - Action: Remove sidebar link and view, keep review API
   - Timeline: After V2 review form is confirmed working

5. **Appointments List** (`/portal/patient/appointments`)
   - Booking happens in-case (V2)
   - Full-page list is redundant
   - Redirect to V2 video route already exists
   - Action: Remove view and legacy handler, keep V2 route
   - Timeline: Immediate

6. **Order Upload (fallback)** (`/portal/patient/orders/:id/upload`)
   - Unclear if still used vs. V2 new-case file upload
   - Action: Verify V2 uploader includes this functionality; if yes, remove legacy view and route
   - Timeline: After V2 new-case testing

7. **Legacy New Case Form** (`patient_order_new.ejs`)
   - Orphaned view, no route
   - Action: Delete view file
   - Timeline: Immediate

8. **Onboarding / Walkthrough** (`patient_onboarding.ejs`, `patient_walkthrough.ejs`)
   - Check routing; may be tour/intro only
   - Action: Verify usage, remove if not in critical path
   - Timeline: After confirming with product

---

## Implementation Roadmap

**Phase 1 (Week 1–2): Quick wins** — Delete clearly deprecated routes
- Remove `/portal/patient/prescriptions` + detail (2 views)
- Remove `/portal/patient/records` + CRUD (1 view)
- Remove `/portal/patient/referrals` (1 view)
- Remove `/portal/patient/reviews` list (1 view)
- Remove `/portal/patient/appointments` list view (1 view)
- Delete orphaned `patient_order_new.ejs` view
- **Effort:** 2–4 hours (delete routes + sidebar link)

**Phase 2 (Week 2–3): V2 migrations** — Migrate high-priority routes
- Migrate `/patient/profile` to V2 chrome
- Migrate `/portal/messages` (patient branch) to V2 chrome
- Migrate `/portal/case/:caseId` to V2 chrome
- Migrate `/portal/patient/payment-required` to V2 chrome
- **Effort:** 10–15 hours

**Phase 3 (Week 3–4): Decision on alerts + order-upload**
- Confirm topbar dropdown for alerts; decide whether to migrate full-page view or remove
- Verify V2 new-case uploader; confirm if `/portal/patient/orders/:id/upload` is still needed
- **Effort:** 3–5 hours

**Phase 4 (Ongoing): Cleanup**
- Remove legacy CSS for portal layout (after all patient pages migrated or removed)
- Verify no external links reference deleted routes
- Update patient tour JS if it references deleted pages

---

## Conclusion

The V2 migration shipped strong foundational chrome (head/foot/sidebar) and migrated 6 core views. However, **16 legacy patient routes remain**, creating visual and UX discontinuity when patients navigate away from Home/New Case/Case Detail.

**Most legacy routes (8–10) represent product feature creep** (prescriptions, medical records, referral UI, appointments list) and should be **removed**. The remaining **5–6 routes** (profile, alerts, messages, case report, payment) are **essential or nearly essential** and should be **migrated to V2 chrome within the next 2–3 weeks**.

The recommended priority is:
1. **Delete** prescriptions, medical records, referral UI, appointments list, reviews list immediately.
2. **Migrate** profile, messages, case report, and payment confirmation to V2 chrome ASAP.
3. **Decide** on alerts (migrate or consolidate) and order-upload (keep or remove) based on V2 feature completeness.

---

## Appendix: Related Audits

- **cross-portal-links-audit.md** — External links and deep-links that may be stale or broken after route removals
