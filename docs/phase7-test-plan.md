# Phase 7 — Patient Portal v2 QA Test Plan

**Status:** Test plan locked. Walk it line by line. Don't skip rows. Don't run tests against a vague mental checklist.

This document is the QA artifact. Check the boxes as you go. Log every finding in the bug log at the bottom — even small ones. Categorize before triaging.

**Stub-mode test mode:** All payment-flow tests run with `PAYMOB_LIVE_PAYMENTS=false`. Live Paymob verification is Phase F of `docs/launch-checklist.md`, separate from this plan.

**DICOM test file:** Source one chest CT sample from the OsiriX DICOM Image Library (https://www.osirix-viewer.com/resources/dicom-image-library/). The "MAGIX" or "BEAUFIX" sample sets are public-domain chest CTs and ideal. Save to `/tmp/test-dicom.dcm` for the upload tests below. Document the source in your bug log entry if anything DICOM-specific fails.

**Test environment:**
- Local dev (`npm run dev`) with seeded DB and a fresh test patient account, OR
- A production-like staging deployment if available

---

## Test matrix — 17 screens × 4 viewports × 2 directions

For each screen, run the conditions listed. Mark each cell pass/fail. If a cell fails, drop a bug log entry at the bottom.

**Viewports**
- M = mobile 375px (iPhone SE width)
- T = tablet 768px (iPad portrait)
- D = desktop 1366px (most common laptop)

**Directions**
- ltr = English (`/lang/en`)
- rtl = Arabic (`/lang/ar`)

For each screen, the four shots you care about are: M-ltr, M-rtl, D-ltr, D-rtl. Tablet (T) is a tertiary spot-check — only walk it on the dashboard + new-case wizard since those are the most layout-sensitive.

---

### Screen 1 — Dashboard (empty state, no DRAFT)

**Setup:** Test patient with zero orders.

| Check | M-ltr | M-rtl | D-ltr | D-rtl |
|---|---|---|---|---|
| Page renders without console errors | ☐ | ☐ | ☐ | ☐ |
| Serif "Welcome, [name]." topbar | ☐ | ☐ | ☐ | ☐ |
| 3-step empty-state grid renders (Upload / Review / Opinion) | ☐ | ☐ | ☐ | ☐ |
| Stat strip shows: Turnaround / Starting at / Languages / Partner hospital | ☐ | ☐ | ☐ | ☐ |
| "Start my case" CTA goes to `/patient/new-case` | ☐ | ☐ | ☐ | ☐ |
| Sidebar (D) / mobile tabbar (M) shows correct active nav | ☐ | ☐ | ☐ | ☐ |
| No `Documents` link in sidebar | ☐ | ☐ | ☐ | ☐ |
| No `Notifications` link in sidebar | ☐ | ☐ | ☐ | ☐ |
| Bell icon present in topbar | ☐ | ☐ | ☐ | ☐ |
| Trust signals visible in sidebar (D) | n/a | n/a | ☐ | ☐ |

### Screen 2 — Dashboard with DRAFT resume tile

**Setup:** Create a DRAFT order via the wizard Step 1 (just submit Step 1, then visit `/dashboard`).

| Check | M-ltr | M-rtl | D-ltr | D-rtl |
|---|---|---|---|---|
| "Continue your case" tile renders ABOVE the empty hero | ☐ | ☐ | ☐ | ☐ |
| Tile shows the date the draft was started | ☐ | ☐ | ☐ | ☐ |
| Click → resumes wizard at Step 2 (or correct step) | ☐ | ☐ | ☐ | ☐ |
| Backdate the DRAFT row 31+ days → tile is NOT shown | ☐ | ☐ | ☐ | ☐ |

**Backdate SQL:** `UPDATE orders SET updated_at = NOW() - INTERVAL '40 days' WHERE id = '<your-draft-id>';`

### Screen 3 — Dashboard active state

**Setup:** A paid case with `status='ASSIGNED'` or `'IN_REVIEW'` and a doctor assigned.

| Check | M-ltr | M-rtl | D-ltr | D-rtl |
|---|---|---|---|---|
| `dash-hero` with "Your specialist is reviewing..." headline | ☐ | ☐ | ☐ | ☐ |
| **NO "Step 4 of 5" copy anywhere** (Fix 2) | ☐ | ☐ | ☐ | ☐ |
| "Expected by [Day, Date]" rail rendered | ☐ | ☐ | ☐ | ☐ |
| "What's happening now" card renders with hand-written sentence | ☐ | ☐ | ☐ | ☐ |
| Doctor card renders with name + specialty (no rating, no Online dot) | ☐ | ☐ | ☐ | ☐ |
| "Need help?" card has WhatsApp + email, **NO phone CTA** (Fix 5) | ☐ | ☐ | ☐ | ☐ |
| Click "Open case" → `/portal/patient/orders/:id` | ☐ | ☐ | ☐ | ☐ |
| Click "Message Dr. X" → `/portal/patient/orders/:id?tab=messages` | ☐ | ☐ | ☐ | ☐ |

### Screen 4 — Dashboard report-ready state

**Setup:** A completed case with a delivered report.

| Check | M-ltr | M-rtl | D-ltr | D-rtl |
|---|---|---|---|---|
| Teal-gradient hero with "Your opinion is ready." | ☐ | ☐ | ☐ | ☐ |
| **CRITICAL: zero report excerpt** in the hero (Fix 1) | ☐ | ☐ | ☐ | ☐ |
| **CRITICAL: zero quoted lines from the report's findings** | ☐ | ☐ | ☐ | ☐ |
| Doctor name + delivery time renders | ☐ | ☐ | ☐ | ☐ |
| "Read the report" (brass) + "Download PDF" (ghost) buttons | ☐ | ☐ | ☐ | ☐ |

**Privacy verification:** view-source the dashboard. Search for: `diagnosis_text`, `impression_text`, `recommendation_text`, the actual prose of the doctor's report. **All must return zero hits.**

### Screen 5 — New Case Wizard, Step 1 (Condition)

| Check | M-ltr | M-rtl | T-ltr | D-ltr | D-rtl |
|---|---|---|---|---|---|
| Progress track shows Step 1 of 5 active | ☐ | ☐ | ☐ | ☐ | ☐ |
| Required textarea, < 10 chars rejected with inline error | ☐ | ☐ | ☐ | ☐ | ☐ |
| "Add medical history" details collapsed by default | ☐ | ☐ | ☐ | ☐ | ☐ |
| Continue button creates DRAFT row, advances to Step 2 | ☐ | ☐ | ☐ | ☐ | ☐ |
| `?resume=:foreign-patient-id` silently redirects to /dashboard (no leak) | ☐ | ☐ | ☐ | ☐ | ☐ |
| `?resume=:my-draft-id` lands at the right step | ☐ | ☐ | ☐ | ☐ | ☐ |

### Screen 6 — New Case Wizard, Step 2 (Documents)

| Check | M-ltr | M-rtl | T-ltr | D-ltr | D-rtl |
|---|---|---|---|---|---|
| Drag-drop zone renders | ☐ | ☐ | ☐ | ☐ | ☐ |
| Drop a PDF → upload starts | ☐ | ☐ | ☐ | ☐ | ☐ |
| **DICOM upload (`/tmp/test-dicom.dcm`) succeeds** | ☐ | ☐ | ☐ | ☐ | ☐ |
| File appears in list with `is_valid=null` ("Checking…") initially | ☐ | ☐ | ☐ | ☐ | ☐ |
| After AI validation completes, shows "✓ Readable" or warm-yellow flagged | ☐ | ☐ | ☐ | ☐ | ☐ |
| **Corrupted file** (truncated PDF) triggers warm-yellow flagged callout | ☐ | ☐ | ☐ | ☐ | ☐ |
| Polling endpoint `/files.json` updates the tile inline (no full refresh) | ☐ | ☐ | ☐ | ☐ | ☐ |
| Continue with zero files → `?err=needs_files` warning + page back to Step 2 | ☐ | ☐ | ☐ | ☐ | ☐ |
| Continue with ≥1 file → advances to Step 3 | ☐ | ☐ | ☐ | ☐ | ☐ |

### Screen 7 — New Case Wizard, Step 3 (Specialty)

| Check | M-ltr | M-rtl | D-ltr | D-rtl |
|---|---|---|---|---|
| Only specialties with ≥1 active doctor are listed | ☐ | ☐ | ☐ | ☐ |
| Specialties with 1 doctor show "Limited availability" warm-yellow tag | ☐ | ☐ | ☐ | ☐ |
| Specialties with ≥2 doctors show plain count | ☐ | ☐ | ☐ | ☐ |
| Click specialty → service grid filters in place | ☐ | ☐ | ☐ | ☐ |
| Continue disabled until both specialty + service picked | ☐ | ☐ | ☐ | ☐ |
| Continue with valid pair → advances to Step 4 | ☐ | ☐ | ☐ | ☐ |

### Screen 8 — New Case Wizard, Step 4 (Review)

| Check | M-ltr | M-rtl | D-ltr | D-rtl |
|---|---|---|---|---|
| Three summary rows: Condition / Documents / Specialty | ☐ | ☐ | ☐ | ☐ |
| Each row has an "Edit" link to the relevant step | ☐ | ☐ | ☐ | ☐ |
| Edit Step 1 → fix → Continue → returns to Step 4 (NOT step 2) | ☐ | ☐ | ☐ | ☐ |
| SLA selector shows Standard 72h + Priority 24h | ☐ | ☐ | ☐ | ☐ |
| **Neither SLA option is checked by default** | ☐ | ☐ | ☐ | ☐ |
| Continue with no SLA → `?err=needs_sla` warning | ☐ | ☐ | ☐ | ☐ |
| **EGP-region patient sees ONLY EGP price** (no `≈ EGP` secondary line) | ☐ | ☐ | ☐ | ☐ |
| **Non-EGP patient sees local primary + `≈ EGP X,XXX` secondary** | ☐ | ☐ | ☐ | ☐ |
| Priority 24h shows the premium amount in the eyebrow | ☐ | ☐ | ☐ | ☐ |

**Non-EGP test:** simulate a non-EG country code by editing your test patient's IP-derived country, OR `UPDATE users SET country_code='SA' WHERE id='<your-test-id>'` if that column exists.

### Screen 9 — New Case Wizard, Step 5 (Payment, stub mode)

| Check | M-ltr | M-rtl | D-ltr | D-rtl |
|---|---|---|---|---|
| Total displays in correct currency with secondary line if non-EGP | ☐ | ☐ | ☐ | ☐ |
| In stub mode, button reads "Confirm and pay (test mode)" | ☐ | ☐ | ☐ | ☐ |
| Test-mode warning note rendered below the CTA | ☐ | ☐ | ☐ | ☐ |
| Click → redirects to `/portal/patient/orders/:id/payment-success?stub=1` | ☐ | ☐ | ☐ | ☐ |
| `?failed=1` query → warm "Your previous payment didn't go through" banner | ☐ | ☐ | ☐ | ☐ |
| Resuming a Step-4 unpaid draft from dashboard lands on Step 5 | ☐ | ☐ | ☐ | ☐ |

### Screen 10 — Payment Success (paid state)

| Check | M-ltr | M-rtl | D-ltr | D-rtl |
|---|---|---|---|---|
| Serif "Payment received." headline | ☐ | ☐ | ☐ | ☐ |
| "What's happening now" card with matching-specialist copy | ☐ | ☐ | ☐ | ☐ |
| Case summary card: specialty, turnaround, expected-by, paid date | ☐ | ☐ | ☐ | ☐ |
| Status chip says "Awaiting assignment" | ☐ | ☐ | ☐ | ☐ |
| Stub-mode footer note rendered when arrived via `?stub=1` | ☐ | ☐ | ☐ | ☐ |

### Screen 11 — Payment Success (interim webhook-pending state)

**Setup:** Manually set `payment_status='unpaid'` on a paid order's `paid_at` row right after success redirect to simulate webhook delay. Or test with stub mode by NOT setting paid in the stub handler.

| Check | M-ltr | M-rtl | D-ltr | D-rtl |
|---|---|---|---|---|
| "We're confirming your payment" interim screen | ☐ | ☐ | ☐ | ☐ |
| Auto-refresh fires every 4s for the first 30s | ☐ | ☐ | ☐ | ☐ |
| Backoff to 8s after 30s | ☐ | ☐ | ☐ | ☐ |
| Backoff to 15s after 90s | ☐ | ☐ | ☐ | ☐ |
| Polling stops after 180s with "you can safely close this page" copy | ☐ | ☐ | ☐ | ☐ |
| Manual refresh AFTER polling stopped + webhook fired → shows paid state | ☐ | ☐ | ☐ | ☐ |
| WhatsApp escape hatch button always visible | ☐ | ☐ | ☐ | ☐ |

### Screen 12 — Case Detail Overview (limbo)

**Setup:** Order in `payment_status='paid' AND status='PAID' AND doctor_id IS NULL`.

| Check | M-ltr | M-rtl | D-ltr | D-rtl |
|---|---|---|---|---|
| Breadcrumb: `Home › Case TSH-XXXX` (Fix 4) | ☐ | ☐ | ☐ | ☐ |
| 4 tabs visible (Overview / Documents / Messages / Report) | ☐ | ☐ | ☐ | ☐ |
| **Report tab disabled with `Locked` sub-pill** (Fix 6) | ☐ | ☐ | ☐ | ☐ |
| Report tab hover tooltip = "Available once your specialist delivers..." | n/a | n/a | ☐ | ☐ |
| **(a) ETA range copy** "Usually within a few hours during business hours, sometimes longer overnight or on weekends." | ☐ | ☐ | ☐ | ☐ |
| **(a) "Paid X ago" muted text** under the ETA copy | ☐ | ☐ | ☐ | ☐ |
| **(d) Three-line What's-happening card** (current state / behind the scenes / what to expect) | ☐ | ☐ | ☐ | ☐ |
| **"A real person, not an algorithm" trust framing** | ☐ | ☐ | ☐ | ☐ |
| **(b) Read-only documents preview** (first 4 files) | ☐ | ☐ | ☐ | ☐ |
| **NO Cancel affordance anywhere** | ☐ | ☐ | ☐ | ☐ |
| **NO fake countdown / progress bar / "X% complete"** | ☐ | ☐ | ☐ | ☐ |
| Need-help-card with WhatsApp + email | ☐ | ☐ | ☐ | ☐ |

### Screen 13 — Case Detail Overview (active, doctor assigned)

| Check | M-ltr | M-rtl | D-ltr | D-rtl |
|---|---|---|---|---|
| `dash-hero` with status-aware copy (standard, REJECTED_FILES, SLA_BREACH variants) | ☐ | ☐ | ☐ | ☐ |
| Expected-by date in right rail | ☐ | ☐ | ☐ | ☐ |
| Doctor card with name + specialty | ☐ | ☐ | ☐ | ☐ |
| **NO Online dot on doctor card** (Fix 3) | ☐ | ☐ | ☐ | ☐ |
| "Message Dr. X" deep-links to `?tab=messages` | ☐ | ☐ | ☐ | ☐ |
| Documents preview card with "View all" → switches to Documents tab | ☐ | ☐ | ☐ | ☐ |

### Screen 14 — Case Detail Overview (completed)

| Check | M-ltr | M-rtl | D-ltr | D-rtl |
|---|---|---|---|---|
| "Read the report" + "Download PDF" CTAs render | ☐ | ☐ | ☐ | ☐ |
| Doctor card present | ☐ | ☐ | ☐ | ☐ |

### Screen 15 — Case Detail Documents tab

| Check | M-ltr | M-rtl | D-ltr | D-rtl |
|---|---|---|---|---|
| All files (initial + additional) listed | ☐ | ☐ | ☐ | ☐ |
| **No upload affordance** in this tab | ☐ | ☐ | ☐ | ☐ |
| **No delete affordance** | ☐ | ☐ | ☐ | ☐ |
| Each file has a "Download" affordance via `/files/:id` | ☐ | ☐ | ☐ | ☐ |
| Tab URL shows `?tab=documents` | ☐ | ☐ | ☐ | ☐ |
| Browser back/forward traverses tabs | ☐ | ☐ | ☐ | ☐ |

### Screen 16 — Case Detail Messages tab (mid-conversation)

| Check | M-ltr | M-rtl | D-ltr | D-rtl |
|---|---|---|---|---|
| Doctor header with name + "Typically responds within 2 hours" copy | ☐ | ☐ | ☐ | ☐ |
| **NO green Online dot anywhere** (Fix 3) | ☐ | ☐ | ☐ | ☐ |
| Date separator between message groups (e.g., "Tuesday 19 April") | ☐ | ☐ | ☐ | ☐ |
| Patient bubbles right-aligned (LTR) / left-aligned (RTL) | ☐ | ☐ | ☐ | ☐ |
| Doctor bubbles opposite alignment | ☐ | ☐ | ☐ | ☐ |
| Send a text message → form submits → reload → new bubble visible | ☐ | ☐ | ☐ | ☐ |
| **Send a text + file attachment → file tile renders in bubble** | ☐ | ☐ | ☐ | ☐ |
| Attached file ALSO appears in `order_additional_files` (verify via SQL) | n/a | n/a | ☐ | n/a |
| Doctor's reply (sent via doctor portal) eventually shows as bubble after refresh | ☐ | ☐ | ☐ | ☐ |
| Inbound messages auto-marked read on tab open (verify via SQL) | n/a | n/a | ☐ | n/a |
| Off-business-hours: "responds in the morning" copy variant renders | ☐ | ☐ | ☐ | ☐ |

### Screen 17 — Case Detail Messages tab (limbo, no doctor)

| Check | M-ltr | M-rtl | D-ltr | D-rtl |
|---|---|---|---|---|
| Empty-state copy "Messages will open here once your specialist is assigned." | ☐ | ☐ | ☐ | ☐ |
| **No reply input form rendered** | ☐ | ☐ | ☐ | ☐ |
| WhatsApp care-team button visible | ☐ | ☐ | ☐ | ☐ |

### Screen 18 — Case Detail Report tab (delivered)

| Check | M-ltr | M-rtl | D-ltr | D-rtl |
|---|---|---|---|---|
| Header with "Your report is ready" eyebrow + serif title | ☐ | ☐ | ☐ | ☐ |
| Letterhead: brass "ت" tile + "Medical Second Opinion" + reference + date | ☐ | ☐ | ☐ | ☐ |
| Patient + Consulting specialist meta block | ☐ | ☐ | ☐ | ☐ |
| Sections render: Clinical question / Findings / Impression / Recommendation | ☐ | ☐ | ☐ | ☐ |
| Empty sections silently skipped (no empty headings) | ☐ | ☐ | ☐ | ☐ |
| Italic doctor signature in serif display | ☐ | ☐ | ☐ | ☐ |
| Standing footer: "A written opinion is not treatment" disclaimer | ☐ | ☐ | ☐ | ☐ |
| "Ask a question" button switches to Messages tab | ☐ | ☐ | ☐ | ☐ |
| **Click Print → print preview shows ONLY the report (no chrome)** | ☐ | ☐ | ☐ | ☐ |
| Click Download PDF → file downloads | ☐ | ☐ | ☐ | ☐ |

### Screen 19 — Case Detail Report tab (locked / withdrawn)

| Check | M-ltr | M-rtl | D-ltr | D-rtl |
|---|---|---|---|---|
| "Available once your specialist delivers your opinion." locked copy | ☐ | ☐ | ☐ | ☐ |
| **For withdrawn case: identical lock copy, NO "withdrawn" surface** | ☐ | ☐ | ☐ | ☐ |

**Withdrawn test:** start with a completed case, then `UPDATE orders SET status='IN_REVIEW' WHERE id='<test-id>';` and refresh. The Report tab should render the locked state, byte-identical to the never-delivered state.

### Screen 20 — Patient-themed 404

**Setup:** as a logged-in patient, navigate to `/portal/patient/this-route-does-not-exist`.

| Check | M-ltr | M-rtl | D-ltr | D-rtl |
|---|---|---|---|---|
| V2 chrome (sidebar / topbar) renders | n/a | n/a | ☐ | ☐ |
| Serif "That page wasn't found." | ☐ | ☐ | ☐ | ☐ |
| "Back to dashboard" + "WhatsApp us" CTAs | ☐ | ☐ | ☐ | ☐ |
| As anonymous (logged out): page renders without sidebar | ☐ | ☐ | ☐ | ☐ |

### Screen 21 — Patient-themed 500

**Setup:** induce a 500 by editing a route to throw, OR by hitting a known broken endpoint with NODE_ENV=production. **Don't deploy this — local test only.**

| Check | M-ltr | M-rtl | D-ltr | D-rtl |
|---|---|---|---|---|
| Serif "Something went wrong on our end." | ☐ | ☐ | ☐ | ☐ |
| Warm body copy mentions "Your data is safe — this isn't your fault." | ☐ | ☐ | ☐ | ☐ |
| "Try again" + "WhatsApp us" CTAs | ☐ | ☐ | ☐ | ☐ |
| Error reference code rendered in mono font | ☐ | ☐ | ☐ | ☐ |
| **Production mode: NO stack trace, NO err.message, NO route names visible** | ☐ | ☐ | ☐ | ☐ |
| **Production mode: search rendered HTML for `at /Users/`, `pg`, `INSERT INTO`, `UPDATE`, `SELECT` — zero hits** | ☐ | ☐ | ☐ | ☐ |
| Dev mode (`NODE_ENV=development`): inline `<pre>` block shows the underlying error message | ☐ | ☐ | ☐ | ☐ |

---

## Cross-cutting verification

These checks span every screen — run them ONCE on a representative state, not per screen.

### Notifications bell (every patient page)

- [ ] Bell icon renders in topbar on dashboard, case detail, wizard, payment-success, 404, 500
- [ ] Initial unread fetch fires on page load (check Network tab — `/portal/patient/alerts.json`)
- [ ] Dot appears when there are unread items
- [ ] No numeric count for 1–8 unread (just the dot)
- [ ] `9+` pill for ≥ 9 unread
- [ ] Click bell → skeleton renders for ≥ 150ms → real list replaces it
- [ ] Mark-all-read fires on close, NOT on open (verify via Network tab)
- [ ] "View all" link goes to `/portal/patient/alerts`
- [ ] Empty state: "You're all caught up." with WhatsApp escape hatch
- [ ] Network failure: shows the inline error banner with retry button
- [ ] Click outside → dropdown closes
- [ ] Press Escape → dropdown closes

### Language toggle persistence

- [ ] Click language toggle to switch to Arabic
- [ ] `req.session.lang` updates (next pageload renders RTL)
- [ ] **`users.lang` updates in DB** (`SELECT lang FROM users WHERE id = '<test-id>'` returns 'ar')
- [ ] Trigger a notification (e.g., have doctor send a message). Notification body renders in Arabic.

### Privacy invariant

- [ ] Open every screen in an authenticated session, view-source, search for `diagnosis_text`, `impression_text`, `recommendation_text`
- [ ] **All return zero hits EXCEPT Screen 18 (Report tab delivered)**
- [ ] On the dashboard ready state, verify ZERO actual report prose — just the doctor name + delivery time + CTA buttons

### WhatsApp links work

- [ ] Click any "WhatsApp us" link on mobile (real device) — opens WhatsApp app, not browser
- [ ] Phone number in link = `+201102009886`
- [ ] No `tel:` links anywhere on patient pages (rendered HTML grep)

### "Patient I've never met" smoke test

This is the most valuable test in this document. **Don't skip it.**

- [ ] Recruit one person (friend, family, neighbor) who has NEVER seen Tashkheesa
- [ ] Sit them in front of a real device (phone preferred)
- [ ] Give them this prompt: "Imagine you have a recent CT scan that worries you. You want a second opinion from a specialist. Submit your case."
- [ ] **Don't help. Don't explain. Take notes.**
- [ ] Note every moment they:
  - hesitate (which screen, what choice)
  - ask a clarifying question (write down the exact words)
  - look confused (their face will tell you)
  - hit a back button or close a tab
  - misclick (took action they didn't intend)
  - pause for > 5 seconds on any screen
- [ ] After they finish (or quit): debrief for 5 minutes. "What was confusing? What were you looking for? What did you expect to happen here that didn't?"
- [ ] Log everything below.

If this can't happen pre-launch, do it in week 1 post-launch with the first real patient who consents.

---

## Bug log

Categorize each finding as one of:
- 🚫 **launch-blocker** — would harm patient trust, leak privacy, or break a critical flow. Must fix before launch.
- ⚠️ **should-fix** — visible bug or rough edge that erodes quality but isn't critical. Should fix this week.
- 💡 **polish** — nit, improvement opportunity, or future-iteration item. Backlog.

```
[ ] 🚫 / ⚠️ / 💡 — short title
   Screen: [screen number]
   Viewport: M-ltr / M-rtl / D-ltr / D-rtl
   Steps: 1. ... 2. ...
   Expected: ...
   Actual: ...
   Fix sketch: ...
```

(Add entries below as you find them. Date-stamp each session if QA spans multiple days.)

---

## Sign-off

Once every box above is checked AND every 🚫 launch-blocker is fixed:

- [ ] Walk `docs/launch-checklist.md` Phase A end-to-end (data integrity)
- [ ] Walk `docs/launch-checklist.md` Phase E.1 (deploy with `WIZARD_AVAILABLE_FROM` set to a future timestamp)
- [ ] Run `docs/launch-checklist.md` Phase D.1 (24-step real-patient smoke as Ziad/Mr.Maher against the gated production deploy)
- [ ] Flip `WIZARD_AVAILABLE_FROM` to past — wizard live for everyone
- [ ] Watch logs for the first hour
- [ ] Phase F (live Paymob verification) — separate, runs after sandbox creds arrive

The migration is feature-complete. This document gates the ship.
