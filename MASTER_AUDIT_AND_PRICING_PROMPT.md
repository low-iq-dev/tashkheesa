# TASHKHEESA — Master Audit, Pricing Update & UI Polish Prompt
## For Claude Code — Execute ALL sections sequentially

---

## CONTEXT
You are working on the Tashkheesa telemedicine portal (Node.js/Express/EJS/SQLite).
- Project root: `/Users/ziadelwahsh/Desktop/tashkheesa-portal`
- Database: `src/db.js` using better-sqlite3
- Views: `src/views/*.ejs`
- Routes: `src/routes/*.js`
- Server: `src/server.js`
- Doctor commission: FIXED at 20% of Tashkheesa price
- Tashkheesa markup: 15% above hospital cost

---

## SECTION 1: DATABASE — Add Regional Pricing Table

### 1.1 Add `service_regional_prices` table in `src/db.js` migrate():

```sql
CREATE TABLE IF NOT EXISTS service_regional_prices (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  country_code TEXT NOT NULL,       -- EG, SA, AE, GB, US
  currency TEXT NOT NULL,           -- EGP, SAR, AED, GBP, USD
  hospital_cost REAL,              -- Base hospital cost (NULL if not available)
  tashkheesa_price REAL,           -- hospital_cost * 1.15 (auto-calculated)
  doctor_commission REAL,          -- tashkheesa_price * 0.20 (auto-calculated)
  status TEXT DEFAULT 'active',    -- active, needs_clarification, not_available, external
  notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(service_id, country_code)
);
```

### 1.2 Seed Egypt (EG) pricing from Shifa Hospital data

Insert the following services with their EG pricing. For each row:
- `tashkheesa_price = CEIL(hospital_cost * 1.15)`
- `doctor_commission = CEIL(tashkheesa_price * 0.20)`

**RADIOLOGY (prefix: rad_)**
| service_id | hospital_cost | status |
|---|---|---|
| rad_ct_review | 7900 | active |
| rad_mri_review | 7300 | active |
| rad_cxr_review | 550 | active |
| rad_us_review | 1500 | active |
| rad_neuro_imaging | 4550 | active |
| rad_spine_mri | 8100 | active |
| rad_ct_mr_angio | 15200 | active |
| rad_onc_petct_staging | NULL | not_available |
| rad_abd_pelvis_ct_mri | 7000 | active |
| rad_msk_imaging | 1600 | active |
| rad_cardiac_ct | 6900 | active |
| rad_cardiac_mri | 7300 | active |

**CARDIOLOGY (prefix: card_)**
| service_id | hospital_cost | status |
|---|---|---|
| card_ecg_12lead | 500 | active |
| card_rhythm_strip | 500 | active |
| card_echo | 1200 | active |
| card_stress_treadmill | 1350 | active |
| card_stress_echo | 1800 | active |
| card_holter_24_72 | 3000 | active |
| card_event_monitor | NULL | not_available |
| card_ctca | 6900 | active |
| card_calcium_score | 3200 | active |
| card_cmr | 7300 | active |
| card_preop_clearance | NULL | not_available |

**ONCOLOGY (prefix: onc_)**
| service_id | hospital_cost | status |
|---|---|---|
| onc_petct_imaging | NULL | not_available |
| onc_ct_mri_staging | 15200 | active |
| onc_histo_reports | NULL | external |
| onc_cytology_reports | NULL | external |
| onc_heme_onc_blood | NULL | external |
| onc_bone_marrow_biopsy | 10000 | active |
| onc_tumor_markers | NULL | external |
| onc_recist_response | NULL | not_available |
| onc_rt_planning_scan | NULL | not_available |

**NEUROLOGY (prefix: neuro_)**
| service_id | hospital_cost | status |
|---|---|---|
| neuro_brain_mri | 3200 | active |
| neuro_brain_ct | 1350 | active |
| neuro_spine_mri | 8100 | active |
| neuro_eeg | 11500 | active |
| neuro_emg_ncs | 6000 | active |
| neuro_cta | 7900 | active |
| neuro_mra | 5400 | active |
| neuro_neurovascular | NULL | needs_clarification |
| neuro_perfusion | NULL | needs_clarification |
| neuro_epilepsy_imaging | NULL | needs_clarification |
| neuro_stroke_imaging | NULL | needs_clarification |

**LAB & PATHOLOGY (prefix: lab_)**
| service_id | hospital_cost | status |
|---|---|---|
| lab_cbc | 380 | active |
| lab_kidney_urea | 180 | active |
| lab_kidney_creat | 180 | active |
| lab_kidney_uric_acid | 180 | active |
| lab_liver_ast | 180 | active |
| lab_liver_alt | 180 | active |
| lab_liver_ggt | 220 | active |
| lab_liver_alp | 190 | active |
| lab_liver_albumin | 190 | active |
| lab_electrolytes_na | 230 | active |
| lab_electrolytes_k | 230 | active |
| lab_thyroid_panel | 1010 | active |
| lab_lipid_profile | 680 | active |
| lab_diabetes | 620 | active |
| lab_autoimmune_ana | 700 | active |
| lab_autoimmune_anti_dna | 1300 | active |
| lab_autoimmune_asma | 1300 | active |
| lab_autoimmune_anca | 2200 | active |
| lab_autoimmune_c3 | 400 | active |
| lab_autoimmune_c4 | 400 | active |
| lab_coag_pt | 250 | active |
| lab_coag_ptt | 270 | active |
| lab_tumor_cea | 440 | active |
| lab_tumor_ca153 | 600 | active |
| lab_tumor_ca199 | 600 | active |
| lab_tumor_ca125 | 600 | active |
| lab_tumor_psa | 460 | active |
| lab_tumor_afp | 440 | active |
| lab_hormone_dhea | 440 | active |
| lab_hormone_e2 | 330 | active |
| lab_hormone_testo | 680 | active |
| lab_hormone_lh | 300 | active |
| lab_hormone_fsh | 330 | active |
| lab_hormone_prl | 330 | active |
| lab_urinalysis | 160 | active |
| lab_urine_culture | 540 | active |
| lab_stool_analysis | 170 | active |
| lab_stool_culture | 600 | active |
| lab_histo_small | 1450 | active |
| lab_histo_large | 2600 | active |
| lab_histo_organ | 3700 | active |
| lab_cytology | 900 | active |
| lab_micro_urine_cs | 540 | active |
| lab_micro_stool_cs | 600 | active |
| lab_micro_sputum_cs | 6000 | active |
| lab_micro_blood_cs | 830 | active |
| lab_bone_marrow | 10000 | active |
| lab_pap_smear | NULL | needs_clarification |
| lab_body_fluids | NULL | needs_clarification |
| lab_fna | NULL | needs_clarification |
| lab_sensitivity | NULL | needs_clarification |
| lab_genetic_molecular | NULL | needs_clarification |

### 1.3 Add empty regional templates for other currencies

For EACH service_id that has an EG row, also insert placeholder rows for:
- SA (SAR) — status: 'pending_pricing'
- AE (AED) — status: 'pending_pricing'
- GB (GBP) — status: 'pending_pricing'
- US (USD) — status: 'pending_pricing'

All prices NULL, notes = 'Awaiting regional pricing'.

### 1.4 Ensure the `services` table has matching rows

For every service_id in the pricing table above, ensure a row exists in the `services` table. If it doesn't exist, INSERT it with:
- `id` = the service_id
- `specialty_id` = appropriate (create specialties if needed: radiology, cardiology, oncology, neurology, lab_pathology)
- `code` = same as id
- `name` = human-readable English name

---

## SECTION 2: ADMIN UI — Regional Pricing Management Page

### 2.1 Create `src/views/admin_pricing.ejs`

Build a page at `/admin/pricing` that shows:
- **Filter bar**: dropdown to select country/currency (EG/EGP, SA/SAR, AE/AED, GB/GBP, US/USD), dropdown for department
- **Table** showing: Service Name (EN), Service Name (AR), Hospital Cost, Tashkheesa Price (+15%), Doctor Commission (20%), Status, Notes
- **Color coding**: 
  - White rows = active with price
  - Yellow rows = needs_clarification or pending_pricing  
  - Red rows = not_available
  - Blue rows = external
- **Inline edit**: Click price cell to edit hospital_cost → auto-calculates tashkheesa_price and doctor_commission
- **Bulk actions**: "Set all pending to active" once prices are filled
- **Export CSV** button

### 2.2 Add routes in `src/routes/admin.js`:

```javascript
// GET /admin/pricing — show regional pricing grid
// GET /admin/pricing/export — CSV download
// POST /admin/pricing/:id/update — update a single price row
// POST /admin/pricing/bulk-import — import from CSV
```

### 2.3 Add nav link

In `admin.ejs` and `admin_service_form.ejs` header nav pills, add:
```html
<a class="pill" href="/admin/pricing">Pricing</a>
```

Also add to superadmin sidebar in `src/views/layouts/portal.ejs`:
```html
<li><a href="/admin/pricing" class="<%= isActive('pricing') %>"><%= isAr ? 'التسعير' : 'Pricing' %></a></li>
```

---

## SECTION 3: NAVIGATION AUDIT — Missing Links

### 3.1 Patient Sidebar (in `patient_dashboard.ejs`)

**Currently has:**
- Dashboard, New Case, Alerts, Messages, Prescriptions, Medical Records, Referrals, Profile, Logout

**MISSING — Add these:**
- Appointments: `<li><a href="/portal/patient/appointments"><%= isAr ? 'المواعيد' : 'Appointments' %></a></li>`
- Reviews: `<li><a href="/portal/patient/reviews"><%= isAr ? 'التقييمات' : 'Reviews' %></a></li>` (for leaving reviews on completed cases)

Add these links after "Alerts" in the sidebar `<ul>`.

### 3.2 Doctor Sidebar (in `src/views/layouts/portal.ejs`, doctor section)

**Currently has:**
- Dashboard, My Analytics, Alerts, Profile

**MISSING — Add these:**
- Queue: `<li><a href="/portal/doctor/queue" class="<%= isActive('queue') %>"><%= isAr ? 'الحالات' : 'Case Queue' %></a></li>`
- Appointments: `<li><a href="/portal/doctor/appointments" class="<%= isActive('appointments') %>"><%= isAr ? 'المواعيد' : 'Appointments' %></a></li>`
- Messages: `<li><a href="/portal/messages" class="<%= isActive('messages') %>"><%= isAr ? 'الرسائل' : 'Messages' %></a></li>`
- Prescriptions: `<li><a href="/portal/doctor/prescriptions" class="<%= isActive('prescriptions') %>"><%= isAr ? 'الوصفات' : 'Prescriptions' %></a></li>`
- Reviews: `<li><a href="/portal/doctor/reviews" class="<%= isActive('reviews') %>"><%= isAr ? 'التقييمات' : 'Reviews' %></a></li>`

### 3.3 Admin/Superadmin Sidebar (in `src/views/layouts/portal.ejs`, superadmin section)

**Currently has:**
- Dashboard, Doctors, Services, Audit Log, Alerts, Analytics, Profile

**MISSING — Add these:**
- Orders: `<li><a href="/admin/orders" class="<%= isActive('orders') %>"><%= isAr ? 'الطلبات' : 'Orders' %></a></li>`
- Pricing: `<li><a href="/admin/pricing" class="<%= isActive('pricing') %>"><%= isAr ? 'التسعير' : 'Pricing' %></a></li>`
- Reviews: `<li><a href="/admin/reviews" class="<%= isActive('reviews') %>"><%= isAr ? 'المراجعات' : 'Reviews' %></a></li>`
- Referrals: `<li><a href="/admin/referrals" class="<%= isActive('referrals') %>"><%= isAr ? 'الإحالات' : 'Referrals' %></a></li>`
- Campaigns: `<li><a href="/admin/campaigns" class="<%= isActive('campaigns') %>"><%= isAr ? 'الحملات' : 'Campaigns' %></a></li>`
- Error Log: `<li><a href="/admin/errors" class="<%= isActive('errors') %>"><%= isAr ? 'سجل الأخطاء' : 'Error Log' %></a></li>`

### 3.4 Admin Header Pills (used in admin.ejs, admin_doctors.ejs, admin_services.ejs, admin_orders.ejs, etc.)

Each admin page uses a header with pill links. Ensure EVERY admin view has consistent pills. The full pill set should be:
```
Dashboard | Orders | Doctors | Services | Pricing | Analytics | Reviews | Referrals | Campaigns | Errors | Alerts
```

Find all files matching `admin*.ejs` and ensure they all have the same header pill navigation. Currently many are missing pills for Reviews, Referrals, Campaigns, Errors, and Pricing.

---

## SECTION 4: FEATURE INTEGRATION AUDIT

Verify each of these integration points. If broken, fix them:

### 4.1 Ratings/Reviews
- [ ] When a case reaches `status = 'completed'`, patient dashboard should show a "Rate this consultation" prompt/button on that case card
- [ ] Doctor profile/case-detail should show average rating
- [ ] Verify route `/portal/patient/reviews` renders or create the view if missing

### 4.2 Onboarding
- [ ] After patient registration, redirect to `/portal/patient/onboarding` if profile is incomplete
- [ ] Patient dashboard should show a banner/alert if onboarding is not complete
- [ ] Verify `patient_onboarding.ejs` renders without errors

### 4.3 Messaging  
- [ ] When a doctor is assigned to a case (`status = 'assigned'`), auto-create a conversation between doctor and patient for that case
- [ ] Unread message badge should show in sidebar nav for both patient and doctor
- [ ] Verify `/portal/messages` renders `messages.ejs` without errors

### 4.4 Prescriptions
- [ ] Doctor case detail page should have a "Create Prescription" button
- [ ] When a prescription is created, it should auto-import into the patient's medical records
- [ ] Verify patient can view/download prescription PDF

### 4.5 Medical Records
- [ ] When a patient report is generated (PDF), it should auto-import into medical records
- [ ] When a prescription is created, it should auto-import into medical records
- [ ] Verify `/portal/patient/records` renders without errors

### 4.6 Referrals
- [ ] When a patient registers, auto-generate a referral code (TASH-XXXXX)
- [ ] During payment/checkout, allow entering a referral code for discount
- [ ] Verify `/portal/patient/referrals` renders without errors
- [ ] Verify `/admin/referrals` renders without errors

### 4.7 Appointment Reminders
- [ ] Verify cron job for 24h + 1h reminders is registered and running
- [ ] Verify `sent_24h` and `sent_1h` flags are being set on appointments

### 4.8 Email Campaigns
- [ ] Verify `/admin/campaigns` renders campaign list
- [ ] Verify `/admin/campaigns/new` creates a new campaign
- [ ] Verify unsubscribe endpoint works with HMAC validation

### 4.9 Error Tracking
- [ ] Verify global error handler catches errors and logs to `error_logs` table
- [ ] Verify `/admin/errors` shows the error dashboard
- [ ] Verify `uncaughtException` and `unhandledRejection` handlers log to DB

---

## SECTION 5: UI CONSISTENCY AUDIT

### 5.1 Design System Check
Ensure ALL portal pages use the unified design system:
- `portal-variables.css` for colors
- `portal-components.css` for buttons, cards, forms
- `portal-global.css` for layout
- `admin-styles.css` for admin-specific styles

### 5.2 Pages to check for broken/missing styles:
- [ ] `patient_onboarding.ejs` — uses design system?
- [ ] `messages.ejs` — uses portal layout and sidebar?
- [ ] `patient_prescriptions.ejs` — uses portal layout?
- [ ] `patient_prescription_detail.ejs` — uses portal layout?
- [ ] `patient_records.ejs` — uses portal layout?
- [ ] `patient_referrals.ejs` — uses portal layout?
- [ ] `doctor_prescribe.ejs` — uses portal layout?
- [ ] `doctor_reviews.ejs` — uses portal layout?
- [ ] `admin_reviews.ejs` — uses admin header pills?
- [ ] `admin_referrals.ejs` — uses admin header pills?
- [ ] `admin_campaigns.ejs` — uses admin header pills?
- [ ] `admin_campaign_new.ejs` — uses admin header pills?
- [ ] `admin_campaign_detail.ejs` — uses admin header pills?
- [ ] `admin_errors.ejs` — uses admin header pills?

### 5.3 Patient Dashboard sidebar consistency
The patient sidebar is defined inline in `patient_dashboard.ejs`. Other patient pages (prescriptions, records, referrals, messages) may have their OWN sidebar or none. 

**Fix**: Extract patient sidebar into a partial `src/views/partials/patient_sidebar.ejs` and include it in ALL patient pages. This ensures nav consistency.

### 5.4 Admin header pills consistency  
Similarly, admin pages define their own header pills inline. Extract into `src/views/partials/admin_header.ejs` and include everywhere.

---

## SECTION 6: SERVER STARTUP TEST

After all changes:

```bash
cd /Users/ziadelwahsh/Desktop/tashkheesa-portal
node -e "require('./src/db')" 
# Should complete without errors (tests DB migrations)

node -e "
const files = require('fs').readdirSync('./src/routes');
files.forEach(f => {
  if (f.endsWith('.js')) {
    try { require('./src/routes/' + f); console.log('✅ ' + f); } 
    catch(e) { console.log('❌ ' + f + ': ' + e.message); }
  }
});
"
# All route files should load without syntax errors
```

---

## SECTION 7: COMMIT STRATEGY

Group fixes into these commits:
1. `feat(db): add service_regional_prices table with EG seed data`
2. `feat(admin): add regional pricing management page`
3. `fix(nav): add missing sidebar links for patient, doctor, admin`
4. `fix(nav): extract sidebar/header partials for consistency`
5. `fix(integration): wire missing feature connections (reviews, onboarding, messaging, records)`
6. `fix(ui): ensure all pages use unified design system`

---

## SUMMARY OF WHAT TO REPORT BACK

After running all sections, report:
1. How many services were seeded into `service_regional_prices` for EG
2. How many regional placeholder rows created (SA, AE, GB, US)
3. List of missing navigation links that were added
4. List of integration points that were broken and fixed
5. List of pages that had styling/layout issues and were fixed
6. Any EJS views that crash on render (undefined variables)
7. Any routes that fail to load
