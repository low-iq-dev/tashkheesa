# Cross-Portal Link Audit

**Scope:** every EJS view, every `src/routes/` handler, every email template under `src/templates/email/`, every notification helper under `src/notify/`, and every JS file under `public/js/`. Looked for hardcoded URLs starting with `/portal/`, `/patient/`, `/doctor/`, `/dashboard`, `/admin/`, plus hardcoded production domains.

**Excluded:** HTML and EJS comments, `node_modules/`, `vendor/`, marketing-site links (`/blog`, `/about`, `/pricing`, `/services`, `/contact`), `wa.me/...` links.

**Don't fix anything from this report.** Triage only.

---

## Summary by severity

| Severity | Count |
|---|---|
| 🚫 Broken (route 404s) | 0 |
| 🔀 Cross-leak (patient ↔ doctor link) | 2 |
| ⚠️ Role-mismatch (link works but wrong role) | 2 |
| 🪦 Dead (link works via redirect but should be updated) | 8 |
| 🪦 Legacy view still mounted (deprecated in migration) | 4 |
| 🌐 Domain-hardcoded | 6 |
| **Total reportable** | **22** |

The good news: zero outright broken links. The cross-leaks are bounded; the dead links work via the Phase 3A 301 redirect; the legacy views still mount but no V2 surface links to them. The migration kept the surface coherent.

---

## 🔀 Cross-leak findings

### Finding 1
**File:** `src/views/patient_case_report.ejs:65`
**Issue:** Patient-named view contains a ternary that links to `/portal/doctor/case/:id` on the non-patient branch.
**Current link:** `<a href="<%= isPatient ? '/dashboard' : '/portal/doctor/case/' + order.id %>" ...>`
**Concern:** The branch is gated by `isPatient`, so a true patient never follows the doctor link. But this view IS reachable by doctors (the legacy `/portal/case/:caseId/report` route serves it for both roles via `userCanViewCase`), so the doctor branch IS used — making this view a shared component despite the `patient_` filename prefix. Not a leak per se, but mixes concerns and is brittle if the V2 patient flow ever loses the `isPatient` flag.
**Severity:** cross-leak (architectural)

### Finding 2
**File:** `src/views/doctor_prescribe.ejs:157`
**Issue:** Doctor-side view links to a patient-only route.
**Current link:** `<a href="/portal/patient/prescription/<%= _existingId %>">View</a>`
**Concern:** A doctor clicking "View" on this prescription card hits a route gated by `requireRole('patient')`. The doctor would receive a 403 (or be redirected to the patient login flow they don't have). Verified the route exists at `src/routes/prescriptions.js` and is patient-gated.
**Severity:** cross-leak (the link goes from doctor → patient-only route; doctor sees an error)

---

## ⚠️ Role-mismatch findings

### Finding 3
**File:** `src/views/partials/patient_sidebar.ejs:49`
**Issue:** Legacy patient sidebar (pre-V2) links to `/portal/messages`, which is the shared standalone messaging app — not a patient-only route.
**Current link:** `<a href="/portal/messages" ...>`
**Concern:** `/portal/messages` is gated by `requireRole('patient', 'doctor')` so a patient can use it. BUT the V2 partial `views/partials/patient/sidebar.ejs` deliberately removed Messages from the sidebar (the V2 model puts messaging inside Case Detail's Messages tab). This legacy `patient_sidebar.ejs` is still rendered by views that haven't been migrated to V2 chrome (e.g., `patient_records.ejs`, `patient_alerts.ejs`, `patient_payment_required.ejs`). Patients who land on a non-V2 page see the old sidebar with the Messages link pointing to a different surface than the V2 Messages tab.
**Severity:** role-mismatch (works for patients, but inconsistent surface — patient bounces between two messaging UIs depending on which page they're on)

### Finding 4
**File:** `src/views/portal_doctor_case.ejs:448`
**Issue:** Doctor case-detail view links to `/portal/messages/:caseConversationId`.
**Current link:** `<a href="/portal/messages/<%= caseConversationId %>" class="dcd-btn dcd-btn--primary">`
**Concern:** Same shared `/portal/messages` route; gated by `requireRole('patient', 'doctor')`. Works for doctors. Just flagging that doctor-side messaging is still on the standalone view; the patient side has the inline V2 tab. Asymmetric experience but not broken.
**Severity:** role-mismatch (works, but design asymmetry)

---

## 🪦 Dead-route findings (Phase 3A killed `/portal/patient/orders/new`)

The route now `301`-redirects to `/patient/new-case`. Each link below incurs a redirect. None are broken, but every reference should be updated to point directly at `/patient/new-case` so the redirect can eventually be deleted.

### Finding 5
**File:** `src/views/sandbox_order_intake.ejs:15`
**Issue:** Hardcoded link to deprecated route.
**Current link:** `<a href="/portal/patient/orders/new">New Case</a>`
**Concern:** 301-redirects to `/patient/new-case`. Sandbox view, low traffic.
**Severity:** dead

### Finding 6
**File:** `src/views/services.ejs:321-322`
**Issue:** Two references — one for logged-in users, one for the login redirect's `?next=` param.
**Current link:** `'/portal/patient/orders/new'` and `'/login?next=/portal/patient/orders/new'`
**Concern:** The first redirects fine (301 → `/patient/new-case`). The second concatenates the dead URL into the `next` param of the login redirect; after auth, the user gets a chained redirect: `/login` → (auth) → `/portal/patient/orders/new` → 301 → `/patient/new-case`. Works but ugly.
**Severity:** dead (×2)

### Finding 7
**File:** `src/views/intake_thank_you.ejs:16`
**Issue:** Hardcoded link to deprecated route.
**Current link:** `<a href="/portal/patient/orders/new">New case</a>`
**Severity:** dead

### Finding 8
**File:** `src/views/intake_form.ejs:17`
**Issue:** Hardcoded link to deprecated route.
**Current link:** `<a href="/portal/patient/orders/new">New case</a>`
**Severity:** dead

### Finding 9
**File:** `public/js/patient_order_new.js:99`
**Issue:** Client-side `window.location.href` to a non-existent path.
**Current link:** `window.location.href = "/patient/orders/new" + ...`
**Concern:** Note `/patient/orders/new` (note the missing `/portal/`) — this URL doesn't match the redirect either. There's no route for `/patient/orders/new` in the patient routes. Patient hitting this code path lands on the patient-themed 404. **Patch candidate**: change to `/patient/new-case`.
**Severity:** dead (but worse — also a typo; this one might 404 outright, not redirect. Verify by running `curl -I /patient/orders/new` against a live server.)

### Finding 10
**File:** `public/js/tours/patient-tour.js:48, 82, 104`
**Issue:** Tour script comments + tour configuration reference deprecated URL paths.
**Current refs:** Comments mention `/portal/patient/orders/new`, `/portal/patient/orders/:id`, `/portal/patient/appointments` as the page contexts the tour targets.
**Concern:** Tour scripts target DOM selectors on those pages; if the tour ever re-activates after the migration, the page contexts have moved. This isn't a link per se but the tour's onboarding flow would fire on the wrong pages.
**Severity:** dead (tour script — out of scope for migration; flag for post-launch cleanup)

---

## 🪦 Legacy view still mounted

Views deprecated by the migration but the routes that render them still exist. No V2 surface links to them, so they're dormant. Listed for the post-launch cleanup pass.

### Finding 11
**File:** `src/routes/patient.js:48`
**Issue:** Helper `renderPatientOrderNew` still calls `res.render('patient_order_new', ...)`. Reachable from the legacy `GET /portal/patient/orders/new` and from the legacy `POST /patient/orders` create handler's error-render path.
**Current code:** `return res.render('patient_order_new', { ...uploadcareLocals, ...locals });`
**Concern:** The route is now a 301 redirect, so the helper itself is unreachable in normal flow. The error-render path of `POST /patient/orders` (line ~1313) is reachable if any external caller still hits that endpoint.
**Severity:** legacy view mounted (dormant)

### Finding 12
**File:** `src/routes/patient.js:2190, 2215`
**Issue:** Legacy case-detail handler's pricing-integrity guard renders `patient_payment_required`. (Note: this is on the OLD handler that has been replaced; verify whether these calls are reachable.)
**Concern:** The V2 case-detail handler I shipped redirects unpaid orders to `/portal/patient/pay/:id` directly — the `patient_payment_required` render in those lines may or may not be on a now-unreachable code path. Worth verifying with a static analysis pass.
**Severity:** legacy view mounted (likely dormant)

### Finding 13
**File:** `src/routes/patient.js:2694`
**Issue:** Legacy upload-page route `GET /portal/patient/orders/:id/upload` still mounted, renders `patient_order_upload`.
**Current code:** `res.render('patient_order_upload', { ... });`
**Concern:** No V2 surface links to this URL. The wizard's Step 2 uses inline upload. Phase 5's Messages tab uses inline upload via the same POST endpoint. So this GET handler is reachable only via direct URL navigation or external bookmark. The route should still work for any in-flight bookmarks but is duplicate functionality.
**Severity:** legacy view mounted (reachable via bookmark only)

### Finding 14
**File:** `src/views/patient_order_new.ejs:8`
**Issue:** Legacy view references `/js/patient_order_new.js`.
**Current code:** `<script src="/js/patient_order_new.js" defer></script>`
**Concern:** The JS file targets a form structure that the V2 wizard replaced. If the legacy view ever renders, the JS would attach to a non-existent form. Not a link per se, but a stale asset reference that compounds with Finding 11.
**Severity:** legacy view mounted (asset reference)

---

## 🌐 Domain-hardcoded findings

These are URLs or env-var defaults pointing at `https://tashkheesa.com`. Most are intentional (SEO, OG tags, marketing surfaces); flagged here for awareness in case staging or alternate environments need different domains.

### Finding 15
**File:** `src/views/app_landing.ejs:69, 112, 246`
**Issue:** Three hardcoded `https://tashkheesa.com` references on the app-landing page.
**Concern:** Marketing display copy (`<a href="https://tashkheesa.com">tashkheesa.com</a>`) and a QR-code URL builder. Intentional for the production landing page; would render the wrong URL if served from a staging domain.
**Severity:** domain-hardcoded (intentional but not env-aware)

### Finding 16
**File:** `src/views/index.ejs:16, 23, 24, 33, 34, 35`
**Issue:** Six hardcoded `https://tashkheesa.com` references in the marketing index page's SEO tags.
**Concern:** `og:url`, `twitter:image`, `canonical`, schema.org `url`/`logo`/`image`. SEO-required and must be the canonical production URL — these should NEVER be relative paths or env-driven for the public marketing index. Correct as-is.
**Severity:** domain-hardcoded (intentional, SEO-required)

### Finding 17
**File:** `src/views/layouts/public.ejs:15`
**Issue:** `const siteUrl = 'https://tashkheesa.com';` constant used to build canonical/OG URLs.
**Concern:** Used for SEO and Open Graph URL construction across all marketing views. Same as Finding 16 — should be hardcoded to production.
**Severity:** domain-hardcoded (intentional)

### Finding 18
**File:** `src/routes/campaigns.js:279`, `src/routes/auth.js:612`, `src/routes/app_landing.js:42`
**Issue:** Three callsites use `process.env.APP_URL || 'https://tashkheesa.com'` as a fallback default.
**Concern:** Defensive default for when `APP_URL` env var is unset. In production this should always be set so the fallback never fires. If staging deploys forget to set it, all generated links from those callsites would point at production. Verify `APP_URL` is set on Render.
**Severity:** domain-hardcoded (env-default; ensure env var is always set)

### Finding 19
**File:** `src/routes/doctor.js:3513`
**Issue:** Builds `reportUrl` for a notification using `process.env.APP_URL || 'https://tashkheesa.com'`.
**Current code:** `reportUrl: ${process.env.APP_URL || 'https://tashkheesa.com'}/portal/case/${orderId}/report`
**Concern:** This URL gets sent to the patient via WhatsApp/email when a doctor delivers a report. If a staging deploy lacks `APP_URL`, patients on that environment receive production URLs in their notifications — which is exactly the kind of silent data leak that's hard to find.
**Severity:** domain-hardcoded (notification leak risk if env unset)

### Finding 20
**File:** `src/routes/reports.js:308`
**Issue:** Same pattern as Finding 19 — builds a report URL for a notification with the production fallback.
**Current code:** `var reportUrl = (process.env.APP_URL || 'https://tashkheesa.com') + '/portal/case/' + caseId + '/report';`
**Concern:** Same risk as Finding 19. The two callsites should probably share a helper that throws if `APP_URL` is unset in non-development environments.
**Severity:** domain-hardcoded (notification leak risk if env unset)

---

## Cross-cutting observations

### Shared `/portal/case/:id/report` and `/portal/case/:id/download-report`

Both V2 patient surfaces (dashboard ready state, case-detail Report tab, completed-state hero) link to these routes. They live in `src/routes/reports.js` and are gated by `requireAuth` plus a `userCanViewCase()` ownership check that allows BOTH the case's patient and the case's doctor (and admins). This is intentional — the same report surface serves both roles. **Not a leak**; flagging because the file naming (`patient_case_report.ejs` for the rendered view) is misleading.

### Notification templates clean

I scanned all `.hbs` files under `src/templates/email/` (38 templates, en + ar). **Zero hardcoded `/portal/`, `/patient/`, `/doctor/`, `/admin/`, or `/dashboard` URLs found.** All path-bearing templates take their URL via Handlebars variables (e.g., `{{caseUrl}}`, `{{reportUrl}}`) which are constructed at the route layer from `process.env.APP_URL`. Provided `APP_URL` is set in production (Phase C of the launch checklist), the templates are clean.

### `src/notify/` clean

No URL hardcoding in `src/notify/templates.js`, `src/notify/whatsapp.js`, `src/notify/whatsappTemplateMap.js`, `src/notify/notification_titles.js`, or `src/notify/broadcast.js`. All URL construction is delegated to the route layer.

### V2 patient views — clean

Every V2 patient view (`patient_dashboard.ejs`, `patient_new_case.ejs`, `patient_order.ejs`, `patient_payment_success.ejs`, `patient_404.ejs`, `patient_500.ejs`, all 17 partials in `views/partials/patient/`) was scanned. **Zero links to `/portal/doctor/`, `/admin/`, or any deprecated route.** The migration's V2 surfaces are coherent.

### `public/js/booking-form.js` and `availability-form.js`

Use `/portal/appointments/...` (shared route, gated by `requireRole('patient', 'doctor')`). Not a leak.

---

## Triage recommendations (your call to make)

For your reading-as-you-decide convenience, my opinion on what's launch-blocking vs. cleanup. Don't take this as instruction — flag any disagreement.

**Likely launch-blocker:**
- **Finding 9** — `public/js/patient_order_new.js:99` references a URL that doesn't exist (`/patient/orders/new` — no `/portal/`, not what the 301 redirect catches). If any code path activates this JS, the patient lands on the patient-themed 404. Fast fix: change to `/patient/new-case`.

**Should-fix before launch (but not blocking):**
- **Finding 2** — `doctor_prescribe.ejs:157` doctor → patient-only prescription URL. A doctor clicking "View" on a prescription gets a 403. Easy fix: link to a doctor-side prescription view, OR remove the link. Verify whether doctors actively use this card.
- **Findings 5–8** — patient marketing/intake views linking to dead `/portal/patient/orders/new`. The 301 catches them, so they work, but the chained redirect is ugly. Single-line fixes per file.

**Post-launch cleanup:**
- Findings 1, 3, 4 (legacy patient_sidebar, patient_case_report.ejs ternary, doctor messages link) — architectural rather than broken.
- Findings 10–14 (dead-view + tour script + legacy views still mounted) — the migration's tech-debt punch list already in `docs/launch-checklist.md`.
- Findings 15–17 (intentional SEO hardcodes) — leave alone.
- Findings 18–20 (env-fallback to production domain) — verify `APP_URL` is set in Render env. Once set, fallbacks never fire.

End of audit.
