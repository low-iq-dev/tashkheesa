# Tashkheesa — Doctor & Patient Portal Migration Audit

_Generated automatically by Phase 2 audit. 43 views inspected._

## Legend

- **v2** — page uses warm-clinical tokens (`--v2-*`). Aligned with the design system.
- **legacy** — page uses the old medical-blue palette. **Needs migration.**
- **mixed** — page loads CSS files from both eras. Visual inconsistency likely.
- **tokens (unprefixed)** — uses CSS variables but neither v2 nor legacy palette.
- **raw** — no CSS variables, hardcoded values.
- **no css linked** — no `/css/` stylesheet found in expanded EJS (may inherit from layout only).

## CSS file inventory

| File | Era |
| --- | --- |
| `admin-styles.css` | legacy |
| `animations.css` | tokens |
| `annotator.css` | raw |
| `app-landing.css` | legacy |
| `doctor-alerts.css` | legacy |
| `doctor-analytics.css` | legacy |
| `doctor-appointments.css` | legacy |
| `doctor-case-detail.css` | legacy |
| `doctor-dashboard.css` | v2 |
| `doctor-guide.css` | legacy |
| `doctor-portal-v2.css` | v2 |
| `doctor-portal.css` | tokens |
| `doctor-prescribe.css` | legacy |
| `doctor-prescriptions.css` | legacy |
| `doctor-profile.css` | legacy |
| `doctor-queue.css` | legacy |
| `doctor-reviews.css` | legacy |
| `fonts.css` | raw |
| `messages.css` | legacy |
| `owner-styles.css` | tokens |
| `patient-portal-v2.css` | tokens |
| `patient-portal.css` | tokens |
| `patient-tokens.css` | tokens |
| `portal-components.css` | legacy |
| `portal-global.css` | legacy |
| `portal-tours.css` | raw |
| `portal-variables.css` | raw |
| `responsive.css` | tokens |
| `styles.css` | legacy |
| `variables.css` | raw |

## Doctor portal pages

| View | Style era | CSS files | Route(s) |
| --- | --- | --- | --- |
| `doctor_alerts.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-alerts.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | ⚠️ _no route found_ |
| `doctor_analytics.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-analytics.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | `src/routes/analytics.js:324` |
| `doctor_appointments.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-appointments.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | `src/routes/video.js:1422` |
| `doctor_case_intelligence.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | `src/routes/doctor.js:1393` |
| `doctor_login_v2.ejs` | ✅ v2 | `doctor-portal-v2.css`<br>`portal-variables.css` | `src/routes/auth.js:638` |
| `doctor_pending_approval.ejs` | ✅ v2 | `doctor-portal-v2.css`<br>`portal-variables.css` | `src/routes/doctor.js:117` |
| `doctor_prescribe.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`doctor-prescribe.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | `src/routes/prescriptions.js:47`<br>`src/routes/prescriptions.js:112` |
| `doctor_prescriptions_list.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`doctor-prescriptions.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | `src/routes/prescriptions.js:412` |
| `doctor_profile.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`doctor-profile.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | ⚠️ _no route found_ |
| `doctor_reviews.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`doctor-reviews.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | `src/routes/reviews.js:194` |
| `doctor_signup.ejs` | ✅ v2 | `doctor-portal-v2.css`<br>`portal-variables.css` | `src/routes/auth.js:662` |
| `doctor_signup_submitted.ejs` | ✅ v2 | `doctor-portal-v2.css`<br>`portal-variables.css` | `src/routes/auth.js:750` |

## Doctor portal pages (portal_*)

| View | Style era | CSS files | Route(s) |
| --- | --- | --- | --- |
| `portal_doctor_case.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | `src/routes/doctor.js:1320` |
| `portal_doctor_cases.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | `src/routes/doctor.js:481`<br>`src/routes/doctor.js:529`<br>`src/routes/doctor.js:588` |
| `portal_doctor_completed.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | ⚠️ _no route found_ |
| `portal_doctor_dashboard.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-dashboard.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | `src/routes/doctor.js:429` |
| `portal_doctor_earnings.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | `src/routes/doctor.js:636` |
| `portal_doctor_guide.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-guide.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | `src/routes/doctor.js:1778` |
| `portal_doctor_messages.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | `src/routes/doctor.js:619` |
| `portal_doctor_profile.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | `src/routes/doctor.js:1864` |
| `portal_doctor_queue.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`doctor-queue.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | ⚠️ _no route found_ |

## Patient portal pages

| View | Style era | CSS files | Route(s) |
| --- | --- | --- | --- |
| `patient_404.ejs` | 🟠 tokens | `fonts.css`<br>`patient-portal-v2.css`<br>`patient-tokens.css` | ⚠️ _no route found_ |
| `patient_500.ejs` | 🟠 tokens | `fonts.css`<br>`patient-portal-v2.css`<br>`patient-tokens.css` | ⚠️ _no route found_ |
| `patient_alerts.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | `src/routes/patient.js:427` |
| `patient_appointments_list.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | `src/routes/video.js:1254` |
| `patient_case_report.ejs` | 🟠 tokens | `fonts.css`<br>`patient-portal-v2.css`<br>`patient-tokens.css` | `src/routes/reports.js:145` |
| `patient_dashboard.ejs` | 🟠 tokens | `fonts.css`<br>`patient-portal-v2.css`<br>`patient-tokens.css` | `src/routes/patient.js:1026` |
| `patient_new_case.ejs` | 🟠 tokens | `fonts.css`<br>`patient-portal-v2.css`<br>`patient-tokens.css` | `src/routes/patient.js:1305`<br>`src/routes/patient.js:1976`<br>`src/routes/patient.js:1997`<br>`src/routes/patient.js:2128` |
| `patient_onboarding.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | `src/routes/onboarding.js:28` |
| `patient_order.ejs` | 🟠 tokens | `fonts.css`<br>`patient-portal-v2.css`<br>`patient-tokens.css` | `src/routes/patient.js:2464` |
| `patient_order_new.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | `src/routes/patient.js:76` |
| `patient_order_upload.ejs` | 🟠 tokens | `fonts.css`<br>`patient-portal-v2.css`<br>`patient-tokens.css` | `src/routes/patient.js:2703` |
| `patient_payment.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | ⚠️ _no route found_ |
| `patient_payment_required.ejs` | 🟠 tokens | `fonts.css`<br>`patient-portal-v2.css`<br>`patient-tokens.css` | `src/routes/patient.js:2225`<br>`src/routes/patient.js:2250` |
| `patient_payment_success.ejs` | 🟠 tokens | `fonts.css`<br>`patient-portal-v2.css`<br>`patient-tokens.css` | `src/routes/patient.js:1681` |
| `patient_prescription_detail.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | `src/routes/prescriptions.js:262` |
| `patient_prescriptions.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | `src/routes/prescriptions.js:215` |
| `patient_profile.ejs` | 🟠 tokens | `fonts.css`<br>`patient-portal-v2.css`<br>`patient-tokens.css` | `src/routes/patient.js:136` |
| `patient_records.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | `src/routes/medical_records.js:46` |
| `patient_referrals.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | `src/routes/referrals.js:70` |
| `patient_review_form.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | `src/routes/reviews.js:49` |
| `patient_reviews.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | `src/routes/reviews.js:325` |
| `patient_walkthrough.ejs` | 🟡 mixed | `admin-styles.css`<br>`annotator.css`<br>`doctor-portal-v2.css`<br>`doctor-portal.css`<br>`owner-styles.css`<br>`patient-portal.css`<br>`portal-components.css`<br>`portal-global.css`<br>`portal-tours.css`<br>`portal-variables.css` | `src/routes/help.js:25`<br>`src/routes/help.js:30` |

## Patient portal pages (portal_*)

| View | Style era | CSS files | Route(s) |
| --- | --- | --- | --- |

## Summary by era

| Era | Count |
| --- | --- |
| mixed (v2 + legacy) | 29 |
| tokens (unprefixed) | 10 |
| v2 | 4 |

## ⚠️ Views with no `res.render` call found

These views exist in `src/views/` but no route appears to render them. Could be: legacy views to delete, partials accidentally placed at top level, or rendered via dynamic name.

- `doctor_alerts.ejs`
- `doctor_profile.ejs`
- `patient_404.ejs`
- `patient_500.ejs`
- `patient_payment.ejs`
- `portal_doctor_completed.ejs`
- `portal_doctor_queue.ejs`

## 🔴 Pages on the legacy palette (highest priority to migrate)

_None._

## 🟡 Pages with mixed CSS (loading both v2 and legacy)

- `doctor_alerts.ejs` — uses: admin-styles.css, annotator.css, doctor-alerts.css, doctor-portal-v2.css, doctor-portal.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `doctor_analytics.ejs` — uses: admin-styles.css, annotator.css, doctor-analytics.css, doctor-portal-v2.css, doctor-portal.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `doctor_appointments.ejs` — uses: admin-styles.css, annotator.css, doctor-appointments.css, doctor-portal-v2.css, doctor-portal.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `doctor_case_intelligence.ejs` — uses: admin-styles.css, annotator.css, doctor-portal-v2.css, doctor-portal.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `doctor_prescribe.ejs` — uses: admin-styles.css, annotator.css, doctor-portal-v2.css, doctor-portal.css, doctor-prescribe.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `doctor_prescriptions_list.ejs` — uses: admin-styles.css, annotator.css, doctor-portal-v2.css, doctor-portal.css, doctor-prescriptions.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `doctor_profile.ejs` — uses: admin-styles.css, annotator.css, doctor-portal-v2.css, doctor-portal.css, doctor-profile.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `doctor_reviews.ejs` — uses: admin-styles.css, annotator.css, doctor-portal-v2.css, doctor-portal.css, doctor-reviews.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `patient_alerts.ejs` — uses: admin-styles.css, annotator.css, doctor-portal-v2.css, doctor-portal.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `patient_appointments_list.ejs` — uses: admin-styles.css, annotator.css, doctor-portal-v2.css, doctor-portal.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `patient_onboarding.ejs` — uses: admin-styles.css, annotator.css, doctor-portal-v2.css, doctor-portal.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `patient_order_new.ejs` — uses: admin-styles.css, annotator.css, doctor-portal-v2.css, doctor-portal.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `patient_payment.ejs` — uses: admin-styles.css, annotator.css, doctor-portal-v2.css, doctor-portal.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `patient_prescription_detail.ejs` — uses: admin-styles.css, annotator.css, doctor-portal-v2.css, doctor-portal.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `patient_prescriptions.ejs` — uses: admin-styles.css, annotator.css, doctor-portal-v2.css, doctor-portal.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `patient_records.ejs` — uses: admin-styles.css, annotator.css, doctor-portal-v2.css, doctor-portal.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `patient_referrals.ejs` — uses: admin-styles.css, annotator.css, doctor-portal-v2.css, doctor-portal.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `patient_review_form.ejs` — uses: admin-styles.css, annotator.css, doctor-portal-v2.css, doctor-portal.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `patient_reviews.ejs` — uses: admin-styles.css, annotator.css, doctor-portal-v2.css, doctor-portal.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `patient_walkthrough.ejs` — uses: admin-styles.css, annotator.css, doctor-portal-v2.css, doctor-portal.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `portal_doctor_case.ejs` — uses: admin-styles.css, annotator.css, doctor-portal-v2.css, doctor-portal.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `portal_doctor_cases.ejs` — uses: admin-styles.css, annotator.css, doctor-portal-v2.css, doctor-portal.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `portal_doctor_completed.ejs` — uses: admin-styles.css, annotator.css, doctor-portal-v2.css, doctor-portal.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `portal_doctor_dashboard.ejs` — uses: admin-styles.css, annotator.css, doctor-dashboard.css, doctor-portal-v2.css, doctor-portal.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `portal_doctor_earnings.ejs` — uses: admin-styles.css, annotator.css, doctor-portal-v2.css, doctor-portal.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `portal_doctor_guide.ejs` — uses: admin-styles.css, annotator.css, doctor-guide.css, doctor-portal-v2.css, doctor-portal.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `portal_doctor_messages.ejs` — uses: admin-styles.css, annotator.css, doctor-portal-v2.css, doctor-portal.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `portal_doctor_profile.ejs` — uses: admin-styles.css, annotator.css, doctor-portal-v2.css, doctor-portal.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
- `portal_doctor_queue.ejs` — uses: admin-styles.css, annotator.css, doctor-portal-v2.css, doctor-portal.css, doctor-queue.css, owner-styles.css, patient-portal.css, portal-components.css, portal-global.css, portal-tours.css, portal-variables.css
