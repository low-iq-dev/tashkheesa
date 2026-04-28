# Claude Code Brief — Phase 2 Round 2: Cleanup + Wire Up + Legacy Migration

**Branch:** create `feat/phase2-round2-cleanup` from `main` AFTER round 1 PR merges.
If round 1 hasn't merged, STOP and tell the user.

**Working file:** `PHASE_2_BACKLOG.md` — log every issue you find here.

---

## Hard constraints

- Stay on the new branch. Don't push.
- Don't delete `.bak` files.
- CSS + EJS first; route changes only when functionally required.
- NO inline event-handler attributes. Use `addEventListener` inside a nonce'd `<script>`.
- Compile-check after every edit.
- Smoke-test after every commit (curl, expect 302 or 200).
- Stop and report after each task. Do not chain.
- Out of scope: admin / superadmin / ops views, payment flow, public marketing pages.

---

## Confirmed product context (do NOT re-decide)

- Only Video Consultation is genuinely SOON. Messages and Earnings are LIVE.
- Admin / superadmin portals are PARKED until launch. Don't touch.
- Paymob integration is OWNED BY USER, not us. Don't look at payment code.
- All current DB data is demo (platform pre-traction).
- **Principle: if a page is a feature we're keeping, it must be reachable from the portal.** Never delete a feature page without confirming it's replaced; never keep a page alive without giving it nav.

---

## Audit decisions to execute (from round 1 Task C audit + user override)

| File | Verdict | Action |
|---|---|---|
| `doctor_analytics.ejs` | **KEEP + redesign + wire** | Add v2 chrome, sidebar nav under Work |
| `doctor_appointments.ejs` | **KEEP + redesign + wire (SOON)** | Add v2 chrome, sidebar nav with SOON badge |
| `doctor_case_intelligence.ejs` | **KEEP + redesign + wire** | Add v2 chrome, link from case detail intelligence card |
| `doctor_reviews.ejs` | DELETE | Profile already shows reviews inline |
| `portal_doctor_dashboard.ejs` | KEEP-AS-IS | This IS Today; rename in a follow-up, no work now |
| `portal_doctor_guide.ejs` | REDESIGN | Topbar help icon links here |
| `doctor_login_v2.ejs` | KEEP-AS-IS | Token-audit pass only |
| `doctor_pending_approval.ejs` | KEEP-AS-IS | Token-audit pass only |
| `doctor_signup.ejs` | REDESIGN | Public, prospective doctors' first impression |
| `doctor_signup_submitted.ejs` | REDESIGN | Pairs with signup |
| `portal_doctor_earnings.ejs` | KEEP-AS-IS | Already v2 stub; product call deferred |
| `portal_doctor_messages.ejs` | KEEP-AS-IS | Already v2 stub; product call deferred |

---

## Task D — Remove misleading SOON badges (5 min, do FIRST)

**The bug:** Sidebar shows SOON on Messages AND Earnings. Both are live features.

**Scope:**
1. Open `src/views/partials/doctor/sidebar.ejs`.
2. Find the Messages `<li>` block. Remove the `<span class="v2-nav-soon">` element. Leave link href and label intact.
3. Find the Earnings `<li>` block. Remove the `<span class="v2-nav-soon">` element. Leave link href and label intact.

**Commit:**
```
fix(doctor): remove SOON badges from Messages + Earnings — both are live

User confirmed only Video Consultation is genuinely SOON. Messages
has full backing tables (conversations, messages, chat_reports) and
the messaging.js route. Earnings has the doctor_earnings table with
real data. The SOON badges in the sidebar were misleading doctors
into not clicking features that work.
```

Stop and report.

---

## Task E — Delete `doctor_reviews.ejs`

**Scope:**
1. Verify `grep -rn "render.*doctor_reviews" src/routes/`. If a route renders it, the route must be removed first or redirected to profile (since profile shows the same content inline).
2. Verify no nav link points at `/portal/doctor/reviews` (or whatever the route is).
3. If route exists: redirect it to `/portal/doctor/profile` instead of deleting (preserves any external bookmarks).
4. `git rm src/views/doctor_reviews.ejs`.

**Commit:**
```
chore(doctor): remove standalone reviews page — replaced by inline reviews block in Profile

The Profile page already renders the doctor's review history inline
in section 09 (reviews block). The standalone doctor_reviews.ejs
duplicated that surface with no additional value. Route at
<route_path> now 302-redirects to /portal/doctor/profile.
```

Stop and report.

---

## Task F — Wire up + redesign Analytics page

**Goal:** make `doctor_analytics.ejs` reachable AND on v2 chrome.

### F.1 — Add nav entry to sidebar

In `src/views/partials/doctor/sidebar.ejs`, add a new `<li>` under the Work section, between Cases and Prescriptions:

```ejs
<li>
  <a class="v2-nav-item <%= _isActive('analytics') %>" href="/portal/doctor/analytics" aria-current="<%= _active === 'analytics' ? 'page' : 'false' %>">
    <svg class="v2-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
    </svg>
    <span><%= _isAr ? 'الأداء' : 'Analytics' %></span>
  </a>
</li>
```

Also add `analytics: 'analytics'` to the alias map.

### F.2 — Verify route exists or add one

Check `src/routes/analytics.js` for a `GET /portal/doctor/analytics` handler. If missing, route must be added — but ASK USER before adding any route. The handler should pass `activeNav: 'analytics'`.

### F.3 — Redesign view to v2 chrome

Currently `doctor_analytics.ejs` is 204 lines, 0 v2 markers. Redesign using:
- `<%- include('partials/header', { layout: 'portal', portalRole: 'doctor', portalActive: 'analytics', ... }) %>`
- `<%- include('partials/doctor/topbar', { ... }) %>`
- Wrap content in `.doctor-analytics-page`
- Use existing v2 primitives (`.v2-card`, `.v2-stat`, `.v2-empty`, etc.) from `public/css/doctor-portal-v2.css`
- If new styles needed, scope them under `body.doctor-theme.portal-v2 .doctor-analytics-page`
- Bilingual EN/AR via `_t()` helper

Backup before editing: `cp src/views/doctor_analytics.ejs src/views/doctor_analytics.ejs.bak`

**Three commits expected:**
1. Add backup + sidebar nav + alias map entry
2. Redesign view to v2 chrome
3. Polish + smoke test

Stop and report.

---

## Task G — Wire up + redesign Appointments page

Same pattern as Analytics, but with **SOON badge** in sidebar.

### G.1 — Add nav entry to sidebar

Add a new `<li>` under Work section, between Prescriptions and the next section:

```ejs
<li>
  <a class="v2-nav-item <%= _isActive('appointments') %>" href="/portal/doctor/appointments" aria-current="<%= _active === 'appointments' ? 'page' : 'false' %>">
    <svg class="v2-nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><polygon points="10,14 15,17 10,20"/>
    </svg>
    <span><%= _isAr ? 'المواعيد' : 'Appointments' %></span>
    <span class="v2-nav-soon"><%= _isAr ? 'قريباً' : 'Soon' %></span>
  </a>
</li>
```

Add `appointments: 'appointments'` to alias map.

### G.2 — Redesign view to v2 chrome

Same approach as Analytics. View is 357 lines, all legacy. Scope on `body.doctor-theme.portal-v2 .doctor-appointments-page`.

**Three commits expected.**

Stop and report.

---

## Task H — Wire up + redesign Case Intelligence page

**Goal:** make `doctor_case_intelligence.ejs` reachable from the case detail's existing intelligence card AND on v2 chrome.

### H.1 — Wire up the link from case detail

In `src/views/portal_doctor_case.ejs` around line 408–419, the "Case intelligence" card currently shows a static stub. Convert the card body to be a clickable link to `/portal/doctor/case/<orderIdEnc>/intelligence`. Keep the Beta chip.

Verify the route handler at `src/routes/doctor.js:1393` accepts the case ID parameter. If route signature doesn't match, ASK USER before changing routes.

### H.2 — Redesign view to v2 chrome

Currently 525 lines, all legacy. The biggest of the three. Use the same v2 chrome pattern. Scope styles on `body.doctor-theme.portal-v2 .doctor-case-intelligence-page`.

The page shows AI-generated case analysis (pattern recognition, similar cases, guideline snippets per the case detail card stub). Preserve all existing locals + behaviour — just retint to v2.

**Four commits expected** (wire + redesign in 3 chunks):
1. Wire up case-detail card → intelligence link
2. Redesign chrome + header
3. Redesign main content area
4. Polish + smoke

Stop and report.

---

## Task I — Polish KEEP-AS-IS pages (token-audit pass only)

For each of these:
- `doctor_login_v2.ejs`
- `doctor_pending_approval.ejs`

Audit for:
- Hardcoded colors → replace with `var(--v2-*)` tokens
- Inline event handlers → move to nonce'd `<script>`
- Missing `_t()` bilingual labels → add EN/AR

One commit per page if changes needed. Skip if file is already clean.

Stop and report.

---

## Task J — Redesign signup pair (PUBLIC surfaces)

**Important:** these are PUBLIC pages — first impression for prospective doctors. Cost of bugs is higher than internal pages.

- `doctor_signup.ejs` (171 lines)
- `doctor_signup_submitted.ejs` (55 lines)

Both currently partial-v2 per the audit. Redesign to full v2 chrome. Match the warm-clinical design language used in patient-facing public pages.

Two commits, one per page.

Stop and report.

---

## Task K — Redesign Guide page

`portal_doctor_guide.ejs` — reached by every doctor via topbar help icon.

Full v2 redesign. One commit.

Stop and report.

---

## Order of execution

1. **D** — remove badges (5 min)
2. **E** — delete reviews (10 min)
3. **F** — Analytics: wire + redesign (60-90 min)
4. **G** — Appointments: wire + redesign (60-90 min)
5. **H** — Case Intelligence: wire + redesign (90-120 min)
6. **I** — KEEP-AS-IS polish (15 min)
7. **J** — Signup pair redesign (60 min)
8. **K** — Guide redesign (45 min)

Total: roughly 6–8 hours of focused work. Stop after each task for user verification.

---

## Verification per task

| Task | What user verifies |
|---|---|
| D | Sidebar shows no SOON badge on Messages or Earnings |
| E | Visiting old reviews URL redirects to profile (or 404s cleanly), profile still shows reviews inline |
| F | Sidebar Analytics item appears, clicks through, page renders in v2 chrome |
| G | Sidebar Appointments item appears with SOON badge, clicks through, page renders in v2 chrome |
| H | Case detail Case Intelligence card is now clickable, lands on intelligence page in v2 chrome |
| I | Login + pending approval pages still work, look polished |
| J | Signup form works end-to-end, looks like the patient-facing public pages |
| K | Topbar help icon click lands on a v2-themed guide page |

Do not declare any task done until the user manually confirms.

---

## When all tasks done

Append a "Phase 2 round 2 DONE" section to `PHASE_2_BACKLOG.md` listing:
- Commit SHAs per task
- One-line summary each
- Any issues discovered during round 2

Then STOP. Do not start round 3.

---

## Stop conditions — ASK USER before coding if

- Any audit decision conflicts with what you find in the code
- A route handler doesn't exist or doesn't match the expected URL pattern
- A view depends on a partial or CSS file that ALSO touches admin/superadmin/ops surfaces
- You find another doctor view that wasn't in the audit and seems important
- The brief asks you to add a route — always ask first

If you find yourself thinking "I bet it's X" before testing, stop and test.
