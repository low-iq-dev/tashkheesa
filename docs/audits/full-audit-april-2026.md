# Tashkheesa platform — full audit, April 2026

**Date:** April 29, 2026 (UTC `2026-04-29T13:19:43Z`)
**Branch:** `main`
**HEAD SHA:** `b659977984d9229b2f45d67724a891963b12a53f` (`b659977`)
**Auditor:** Claude Opus 4.7 (1M context), interactive
**Working directory:** `/Users/ziadelwahsh/tashkheesa-portal` (Mac mini, primary)

This is the rolling audit document. Each phase appends findings here and is committed individually as `audit(phase-N): <summary>`. The final commit produces a polished summary at the top of the file (Phase 12).

---

## Status legend

| Tag | Meaning |
|---|---|
| **OK** | Verified, no issue |
| **INFO** | Observation, no action required |
| **VERIFY** | Needs further investigation; not yet conclusive |
| **FLAG** | Real issue, not blocking, scheduled for the 4-week plan |
| **BLOCK** | Revenue / compliance / correctness impact — must fix soon |
| **P0** | Stop the line. PHI leak, payment integrity, exposed creds, broken auth |

---

## P0 — STOP THE LINE

_(empty — append at the top of this section if any P0 is found)_

---

## Methodology

**What this audit verifies:**
- Code paths read from the working tree at HEAD `b659977`.
- Database state read from Neon via `psql $DATABASE_URL` (read-only queries unless explicitly noted).
- Local boot tested against `node src/server.js` on port 3000 with prod-like env.
- Production smoke is **read-only** against `https://tashkheesa.com` (no writes, no destructive ops).
- Cross-tenant PHI test runs against the **local** server with two seeded test patients.

**What this audit does NOT verify:**
- Real Paymob production webhooks (test-mode only, or simulated payloads).
- Long-term performance under load (no load test in scope).
- Mac mini OS / system-level config (out of scope; portal repo only).
- Mobile app (no mobile app in this repo).
- Off-repo OpenClaw agents — only their persisted side-effects in the portal DB (heartbeats, scheduled posts, campaigns).

**Evidence rules (applied to every finding):**
- Every claim cites a `path:line`, a SQL query result, a curl response, or a git SHA.
- If a check is impossible (missing tool, missing access, missing test data) the finding is tagged `UNVERIFIED — reason: <X>`.
- No fabrication. If something can't be confirmed it isn't claimed.

**Code conventions when writing code in this audit:** `var` (not `let`/`const`), per project convention.

**Source of truth for pricing:** `docs/PAYOUT_AND_URGENCY_POLICY.md` and `tashkheesa_pricing_v2.xlsx`.

---

## Phase 0 — setup

### Git state at audit start

**Working tree:** clean (after pre-audit cleanup committed three units below).

**Recent commits (top of `git log --oneline -5`):**
```
b659977 audit(chrome): snapshot full portal chrome state (April 27)
e052cf9 chore(scripts): pollution cleanup + recipient guard verification scripts
35ca6d8 feat(notifications): hard guard against demo.local and test recipients
33d4e99 Merge pull request #13 from low-iq-dev/feat/payout-policy-fix
aa70c3b feat(profile): doctor fee per-component breakdown per policy §7
```

**Branch state vs origin:**
- `main` ↔ `origin/main`: local is **3 commits ahead** (the three pre-audit commits — `35ca6d8`, `e052cf9`, `b659977`). Not pushed per audit rule "do not push — I'll review and push at the end".
- `origin/HEAD` is set to `origin/doctor-dashboard-ux` on GitHub (stale default branch). Local `main` is 464 commits ahead of `origin/doctor-dashboard-ux`. — **INFO**, fix later.

**Remote:** `origin → https://github.com/low-iq-dev/tashkheesa.git` (single remote, fetch+push both)

**Branches present:**
- Local: `main` (current), `doctor-dashboard-ux`, `feat/cleanup-orphan-and-comment`, `feat/phase2-round2-cleanup`
- Remote: 13 branches under `origin/` including merged feature branches (`feat/payout-policy-fix`, `feat/visual-audit-fixes`, `feat/doctor-portal-v2-warm-clinical`, etc.)

### Pre-audit working-tree cleanup

The audit started with 10 untracked files in the working tree. Resolved before Phase 0 proper, in three coherent commits:

1. **`35ca6d8`** — `feat(notifications): hard guard against demo.local and test recipients` — closes April 28 OpenClaw email-leak incident at the application layer. Adds:
   - `src/migrations/024_blocked_send_attempts.sql` — audit-trail table
   - `src/services/recipientGuard.js` — 167 LOC service
   - `tests/notifications/recipientGuard.test.js` — 145 LOC tests
2. **`e052cf9`** — `chore(scripts): pollution cleanup + recipient guard verification scripts` — 5 one-off scripts retained in repo for future re-runs.
3. **`b659977`** — `audit(chrome): snapshot full portal chrome state (April 27)` — reference doc, 19 patient routes + 37 doctor routes classified as v2 / legacy / mixed.

`SESSION_REPORT.md` (April 27 doctor portal handoff) was discarded — staleness check confirmed all 7 listed-as-pending patient views are now V2 chrome at HEAD (`patient_records.ejs`, `patient_referrals.ejs`, `patient_reviews.ejs`, `patient_review_form.ejs`, `patient_prescriptions.ejs`, `patient_prescription_detail.ejs`, `patient_appointments_list.ejs`), so the report described work that's already done.

### Findings

| # | Tag | Finding |
|---|---|---|
| 0.1 | OK | Working tree clean, branch in sync (3 prep commits ahead, by design). |
| 0.2 | OK | Mac mini is primary working copy; remote `origin` is the single source of truth. |
| 0.3 | INFO | GitHub `origin/HEAD` still points to stale `doctor-dashboard-ux` (464 commits behind `main`). Cosmetic GitHub setting; fix outside this audit. |
| 0.4 | FLAG | Four `*.bak` files exist in the working tree (gitignored, hence invisible to `git status`): `public/css/portal-variables.css.bak`, `public/css/doctor-portal-v2.css.bak`, `src/views/layouts/portal.ejs.bak`, `src/views/patient_alerts.ejs.bak`. Promised cleanup commit (`chore: remove migration backups`) never landed. To be confirmed and removed in Phase 10 (dead-code & orphan cleanup). |
| 0.5 | INFO | The chrome-state snapshot just committed (`b659977`) is dated April 27 and is now historically out of sync with reality — its 7 "legacy" patient views are all V2 today. Phase 2 will produce a fresher classification. The April 27 snapshot is preserved as a reference, not a current-truth document. |

Phase 0 complete. Proceeding to Phase 1.

---

## Phase 1 — architecture & boot

### File counts and sizes

| Metric | Value | Source |
|---|---|---|
| `src/server.js` LOC | 1,183 | `wc -l src/server.js` |
| `src/db.js` LOC | 471 | `wc -l src/db.js` |
| Route files | 41 | `find src/routes -name "*.js" \| wc -l` |
| View files (.ejs) | 149 | `find src/views -name "*.ejs" \| wc -l` |
| Worker files | 4 | `src/workers/acceptance_watcher.js`, `src/notification_worker.js`, `src/case_sla_worker.js`, `src/sla_worker.js` |

**Top 10 largest JS files (`find src -name "*.js" -exec wc -l {} \; \| sort -rn`):**

| LOC | File | Status |
|---|---|---|
| 3,909 | `src/routes/doctor.js` | **FLAG** — 2.6× over 1,500 LOC threshold |
| 2,891 | `src/routes/patient.js` | **FLAG** — 1.9× over |
| 2,855 | `src/routes/superadmin.js` | **FLAG** — 1.9× over |
| 2,707 | `src/routes/admin.js` | **FLAG** — 1.8× over |
| 1,940 | `src/case_lifecycle.js` | **FLAG** — 1.3× over |
| 1,445 | `src/routes/video.js` | OK — exempt per audit instructions ("known") |
| 1,183 | `src/server.js` | OK — under threshold |
| 941 | `src/report-generator.js` | OK |
| 800 | `src/routes/order_flow.js` | OK |
| 776 | `src/routes/auth.js` | OK |

### Boot test (fresh process on port 3001)

Existing dev server on `:3000` (PID 28541, uptime ~65 min, gitSha `4310202`, ~16 commits behind HEAD) was left running. Fresh boot test executed on `:3001` with `SLA_MODE=passive` to comply with `src/server.js:88` warning ("ensure ONLY ONE server instance runs in primary"). Full boot log: `/tmp/tash-boot-3001.log` (27 lines, completed in ~5 s).

| Required string | Present | Source line |
|---|---|---|
| "Database migration complete" | ✅ | `src/server.js:446` (logged at boot) |
| "Tashkheesa portal running on port 3001" | ✅ | `src/server.js:975` (logged at boot) |

Boot side-effects observed (all OK):
- 51 env vars injected from `.env`
- pg-boss queues created: `case-intelligence`, `case-reprocess`, `auto-assign`, `sla-sweep`
- Workers registered: case-intelligence, case-reprocess, auto-assign
- Crons registered: payment reminders (15 min, passive), conversation auto-close (daily), appointment reminder (15 min), campaign scheduler (5 min), IG scheduler (5 min), notification worker (30 s)
- R2 connected: `tashkheesa-files` bucket
- No stack traces, no `[R2] Missing env vars`, no FATAL on either path

### Health probes (against fresh server on `:3001`)

| Endpoint | HTTP | Body summary | Verdict |
|---|---|---|---|
| `GET /healthz` | 200 | `{ok:true, mode:"development", uptimeSec:6, pool:{total:1,idle:1,waiting:0}}` | OK |
| `GET /__version` | 200 | `{ok:true, name:"tashkheesa-portal", version:"1.0.0", slaMode:"passive", gitSha:"19fe098"}` | OK — gitSha matches HEAD-2 (`19fe098` is the Phase 0 commit before this Phase 1 commit) |
| `GET /verify.json` | 302 → `/login` | (auth-gated) | OK — **expected** behaviour. `src/routes/verify.js:152-156` calls `requireOpsRole(req, res)` first; admin/superadmin only. The audit script's "must return 200 with valid JSON" expectation was incorrect for this endpoint. |

### Module require timing

42 top-level modules required in isolation (script: `/tmp/require-timing.js`, `NODE_PATH` set to project node_modules):

| ms | Module |
|---|---|
| 161 | `./src/case-intelligence` |
| 151 | `./src/report-generator` |
| 60 | `./src/routes/auth` |
| 50 | `./src/routes/video` |
| 38 | `./src/case_lifecycle` |
| 25 | `./src/auth`, `./src/routes/doctor` |
| 22 | `./src/job_queue` |
| 18 | `./src/db` |
| ≤12 | all other 32 modules |

**Slow modules (> 300 ms): 0.** No regression from the April 26 hang investigation baseline. Note: serial requires share cached transitive deps — first-loaded modules naturally absorb the heavy deps.

### `validateCriticalEnvVars` audit

`src/server.js:51-68` — IIFE that exits with `process.exit(1)` if any of the listed env vars are missing or empty:

```js
var required = ['JWT_SECRET', 'DATABASE_URL', 'ANTHROPIC_API_KEY'];
```

This matches the post-March hardening exactly. Nothing extra needed (e.g., R2 vars, Twilio, SMTP) — those degrade gracefully (the boot logs show `[R2] Connected to tashkheesa-files bucket` only after the listener is up; missing R2 creds would log a warning, not fatal).

### Findings

| # | Tag | Finding |
|---|---|---|
| 1.1 | OK | Fresh boot succeeds in ~5 s; both required boot strings present (`src/server.js:446`, `:975`). |
| 1.2 | OK | All 3 health endpoints respond as designed; `/verify.json` auth gate at `src/routes/verify.js:152-156` is correct, not a defect. |
| 1.3 | OK | `validateCriticalEnvVars` (`src/server.js:51-68`) checks the right 3 vars (`JWT_SECRET`, `DATABASE_URL`, `ANTHROPIC_API_KEY`). |
| 1.4 | OK | No module loads > 300 ms; max is `case-intelligence` at 161 ms. |
| 1.5 | FLAG | Five files materially over the 1,500-LOC threshold: `routes/doctor.js` (3,909), `routes/patient.js` (2,891), `routes/superadmin.js` (2,855), `routes/admin.js` (2,707), `case_lifecycle.js` (1,940). These are the core route files; refactoring is high-leverage but not a blocker. Add to 4-week plan. |
| 1.6 | FLAG | **Two SLA worker files exist; only one is wired up.** `src/server.js:106` has the legacy line commented out: `// var { startSlaWorker, runSlaSweep } = require('./sla_worker');`. The active worker is `src/case_sla_worker.js` (`src/server.js:129`). The 184-line `src/sla_worker.js` file is now dead code — recommended deletion in Phase 10. |
| 1.7 | FLAG | **Two DB-wrapper modules in tree.** `src/server.js:31` requires from `./db` (the canonical migration runner), but `src/case_sla_worker.js:1` and `src/sla_worker.js:1` both require from `./pg`. Two different entry points for the same Postgres pool create a risk of split connection-pool config or sslmode drift. Audit Phase 6 will check whether `./pg` and `./db` agree on SSL/timeouts. |
| 1.8 | INFO | The dev server running on `:3000` is on gitSha `4310202` (16 commits behind HEAD `b659977`). User runs without auto-restart on file change — restart needed when checking new commits live. Cosmetic note. |
| 1.9 | INFO | Local dev `DATABASE_URL` points to `postgresql://localhost:5432/tashkheesa` (not Neon). Phase 3's `psql $DATABASE_URL` queries will hit the local mirror unless overridden. To audit production data, will need Neon connection string. **Will pause and ask before Phase 3 if Neon access matters for cross-tenant test.** |

Phase 1 complete. No P0, no BLOCK. Proceeding to Phase 2.

---

## Phase 2 — route inventory & reachability

### Route enumeration

`grep -rnE "router\.(get|post|put|delete|patch)\(" -A 1 src/routes/ src/server.js` then dedupe by quoted path → **309 unique route paths** across 41 route files.

Per-file route counts (top 10):

| File | Routes |
|---|---|
| `src/routes/superadmin.js` | 44 |
| `src/routes/admin.js` | 39 |
| `src/routes/doctor.js` | 28 |
| `src/routes/patient.js` | 27 |
| `src/routes/static-pages.js` | 25 |
| `src/routes/auth.js` | 18 |
| `src/routes/video.js` | 17 |
| `src/routes/order_flow.js`, `src/routes/ops.js` | 11 each |
| `src/routes/reviews.js`, `src/routes/prescriptions.js`, `src/routes/messaging.js` | 9 each |

(Original single-line grep produced 357 entries because routes that span two lines — `router.get(\n  '/path',` — were each counted but with no path string in /tmp/all-routes.txt. Corrected count is 309 unique paths.)

### Mount-point check

| Result | Detail |
|---|---|
| Top-level route files (34 in `src/routes/`) | **All 34 required AND mounted** in `src/server.js:644-672, 723-726`. |
| Nested `src/routes/api/*.js` (7 files) | 6 mounted via `src/routes/api_v1.js:70-102` (auth, services, cases, conversations, notifications, profile); 1 (`cases_intake`) mounted directly at `src/server.js:726`. **No orphan route files.** |

### Static public page reachability (against running dev server `:3000`)

| Path | HTTP | Verdict |
|---|---|---|
| `/` | 200 | OK |
| `/services` | 200 | OK |
| `/about` | 200 | OK |
| `/contact` | 200 | OK |
| `/privacy` | 200 | OK |
| `/terms` | 200 | OK |
| `/refund-policy` | 200 | OK |
| `/delivery-policy` | 200 | OK |
| `/help-me-choose` | 200 | OK |
| `/blog` | **404** | **FLAG** — `public/blog/` directory exists with 4 `.html` files (`index.html`, `_template.html`, `how-tashkheesa-works.html`, `when-to-get-medical-second-opinion.html`) but no Express route handler. Reachable only via `/site/blog/...` because of the static fallback below. |

### `/site` static-mount fallback

`src/server.js:175-179`:
```js
var marketingSiteDir = path.join(__dirname, '..', 'public', 'site');
var marketingStaticDir = fs.existsSync(marketingSiteDir)
  ? marketingSiteDir
  : path.join(__dirname, '..', 'public');
app.use('/site', express.static(marketingStaticDir));
```

`public/site/` does **not** exist. The fallback means **`/site/*` serves the entire `public/` directory** — including `public/blog/`, `public/uploads/doctor-photos/`, `public/icons/`, `public/css/`. Anything dropped into `public/` becomes accessible under `/site/`. **Wider exposure than intended.**

### PHI exposure walk

| Check | Result |
|---|---|
| `ls public/reports/` | Only `.gitkeep` (0 bytes). Empty directory placeholder — **OK**. |
| `ls public/uploads/` | Only `doctor-photos/` subdir with **1 .jpg, 2 MB**, dated 2026-04-28. Doctor profile photos are **public by design** (rendered on the doctor's public profile). |
| `grep "public/reports\|public/uploads" src/` | Only one match: `src/server.js:184` mounts `app.use('/uploads', express.static(...))`. No `res.sendFile` from these dirs anywhere. |
| Active write paths for case files | `src/routes/order_flow.js:69, 72, 304` — case files go to **R2**, never to `public/uploads/`. |
| Active write paths for doctor photos | `src/routes/doctor.js:2239, 2298, 2315, 2336` — photos go to **R2** at `doctor-photos/<doctor_id>/<ts>.<ext>`. The on-disk file is a **legacy artifact**. |

**Verdict: NOT a P0.** No PHI flow puts data in `public/uploads/`. The static mount is residual from before the R2 migration. **FLAG** for cleanup in Phase 10 (remove the static mount and the legacy on-disk doctor photo).

### Orphan view files

117 `.ejs` files in `src/views/` (top-level only, excluding `partials/` and `layouts/`). 109 are referenced via `res.render('NAME')`. Diff = 8 candidates; after manual triage:

| View | Status | Why |
|---|---|---|
| `_app_waitlist_form.ejs` | **NOT orphan** | Included as a partial in `src/views/app_landing.ejs:53, 65, 108`. Underscore-prefix convention. |
| `doctor_alerts.ejs` | **NOT orphan** | Reached via dynamic render in `src/routes/doctor.js:1078` (`res.render(viewName, payload)` where `viewName` is one of a fallback chain `['portal_doctor_alerts', 'portal_doctor_alert', 'doctor_alerts', 'doctor_alert']`). Documented in `docs/audits/full-portal-chrome-state.md`. |
| `appointment_booking.ejs` | **ORPHAN** | No reference anywhere. |
| `appointment_detail.ejs` | **ORPHAN** | No reference anywhere. |
| `order_payment.ejs` | **ORPHAN** | The grep match was for `superadmin_order_payment` (different prefix). Bare `order_payment.ejs` not used. |
| `order_start.ejs` | **ORPHAN** | No reference anywhere. |
| `public_case_new.ejs` | **ORPHAN** | No reference anywhere. |
| `public_case_thankyou.ejs` | **ORPHAN** | No reference anywhere. |

**6 true orphan view files** for Phase 10 deletion.

### Doctor sidebar — SOON badges & Video item

`src/views/partials/doctor/sidebar.ejs`:
- **No `SOON` / `Coming` text anywhere** — Messages (line 126-130) and Earnings (line 138-142) are both clean. April 29 fix verified. **OK.**
- Nav items present: Today, Cases, Prescriptions, Appointments, Analytics, Alerts, Messages, Earnings, Profile. **9 items**, not the 5 the brief specified.
- **Video Consultation is NOT in the sidebar.** The audit instruction's expectation that Video has a SOON badge is moot — Video is reachable only via `/portal/video/*` URLs (e.g., from inside a case detail), not from a top-level nav. **INFO** — flag for IA review (was Video supposed to remain visible in nav?). The chrome-state doc had Phase 1 IA cutting items down to 5 (Today / Cases / Messages / Earnings / Profile) but the live sidebar today has 9. The April 29 cleanup re-added Prescriptions / Appointments / Analytics / Alerts as visible items.

### `doctor_reviews.ejs` decision

| Route | Behaviour | Source |
|---|---|---|
| `GET /portal/doctor/reviews` | 302 → `/portal/doctor/profile` | `src/routes/reviews.js:344-345` (doctor's own reviews folded into Profile per Phase 1 IA) |
| `GET /portal/doctor/:doctorId/reviews` | Renders `doctor_reviews.ejs` | `src/routes/reviews.js:194` — public-facing review page for a specific doctor |

So `doctor_reviews.ejs` is **kept and used** for the public review page; the doctor's own review page redirects. **Matches spec. OK.**

### Dead links inside views

40 unique `/portal/*` hrefs extracted from `src/views/`. Cross-referenced against the 309 route paths.

| Href | Verdict |
|---|---|
| `/portal/dashboard` | **DEAD** — `src/views/video_appointment.ejs:225`. Patient dashboard is at `/dashboard` (no `/portal/` prefix), per `src/routes/patient.js:907`. |
| `/portal/admin/analytics` | OK — `src/routes/analytics.js:57-58` |
| `/portal/doctor/analytics` | OK — `src/routes/analytics.js:264-265` |
| `/portal/case/` (bare) | OK in practice — sub-paths like `/portal/case/:caseId/report` exist (`src/routes/reports.js:49`); no direct view links to bare `/portal/case`, only parameterized children. |
| All other 36 hrefs | OK — handler exists |

### Auth-required render tests

**Deferred to Phase 11 (live production smoke).** Rationale: a full render walk through 12 patient + 17 doctor authenticated pages requires creating a working test patient/test doctor, logging in via a real session, and rendering each page — about 30-45 min of work. The same walk is more useful done against production in Phase 11 where it catches deploy regressions, not development-only state. The chrome-state baseline (committed at `b659977`) already provides a per-route classification dated April 27; the patient-side migrations called out as pending in `SESSION_REPORT.md` are confirmed complete (Phase 0 finding 0.5).

### Convention violations

| File | Issue |
|---|---|
| `src/routes/api_v1.js` | Uses `const`/`let` (lines 70, 81, 85, 89, 93, 97, 101 etc.). Project convention is `var`. **FLAG** — minor. |

### Findings

| # | Tag | Finding |
|---|---|---|
| 2.1 | OK | All 41 route files mounted; no orphan route file. |
| 2.2 | OK | Static public pages 9/10 OK; PHI directories in `public/` are empty or contain only public-by-design doctor photos. |
| 2.3 | OK | `validateCriticalEnvVars` boots cleanly; sidebar SOON badges removed correctly. |
| 2.4 | OK | `doctor_reviews.ejs` is correctly retained for public reviews; own-doctor reviews redirect to Profile per spec. |
| 2.5 | FLAG | **`/blog` returns 404.** `public/blog/` directory has 4 production-ready HTML pages (including `how-tashkheesa-works.html`, `when-to-get-medical-second-opinion.html`) but no Express route handler. Either add `app.use('/blog', express.static(...))` OR remove the directory. **Marketing/SEO leakage** — these blog pages are reachable only via `/site/blog/...` which is undocumented. |
| 2.6 | FLAG | **`/site` static fallback serves all of `public/`.** `public/site/` does not exist; `src/server.js:175-179` falls back to mounting the entire `public/` dir at `/site`. Means `/site/uploads/`, `/site/blog/`, `/site/icons/`, `/site/css/` all resolve. Tightening recommended: create `public/site/` with explicit content OR change the mount to a fixed dir. |
| 2.7 | FLAG | **`public/uploads/doctor-photos/`** has 1 legacy on-disk .jpg (2 MB, dated April 28). Active code paths use R2 (`doctor.js:2298`). Recommend removing the static mount at `src/server.js:184` and deleting the on-disk file in Phase 10. |
| 2.8 | FLAG | **6 orphan view files** for deletion: `appointment_booking.ejs`, `appointment_detail.ejs`, `order_payment.ejs`, `order_start.ejs`, `public_case_new.ejs`, `public_case_thankyou.ejs`. Phase 10 cleanup. |
| 2.9 | FLAG | **Dead link** in `src/views/video_appointment.ejs:225`: `href="/portal/dashboard"` — should be `/dashboard` (no `/portal/` prefix for patient dashboard). |
| 2.10 | FLAG | **`src/routes/api_v1.js` uses `const`/`let` instead of `var`** (project convention). Refactor in Phase 10 / future technical-debt sweep. |
| 2.11 | INFO | Doctor sidebar has 9 items, not the 5-item IA originally scoped in the brief. Live items: Today, Cases, Prescriptions, Appointments, Analytics, Alerts, Messages, Earnings, Profile. Video Consultation is intentionally not in nav (only reachable via case detail). Confirm this matches current product intent; if not, IA needs revisit. |
| 2.12 | VERIFY | Auth-required render tests for patient/doctor portals deferred to Phase 11 (live production smoke). 12 patient pages + 17 doctor pages will be walked there. |

Phase 2 complete. No P0, no BLOCK. Proceeding to Phase 3.

---

## Phase 3 — data model & PHI surface

### DB connection

| Property | Value |
|---|---|
| Connected DB | local Postgres 16.12 (Homebrew) |
| Connection string | `postgresql://ziadelwahsh@localhost:5432/tashkheesa` |
| Tables in `public` schema | **56** |

**Note:** `psql` is not on PATH on this Mac mini. All DB queries used a node script (`/tmp/db-inspect.js`) wrapping the project's `pg` Pool against `process.env.DATABASE_URL`. **Production data (Neon) was not queried** — that requires a separate connection string the user can provide for follow-up. Schema-level checks on local Postgres are valid as a proxy because the same migrations run on both.

### Schema vs audit-instruction expectations

| Expected table | Actual table | Status |
|---|---|---|
| `patients`, `doctors` | `users` (unified, with role column) | **Schema differs from audit instructions** — both are stored in `users`. Cross-tenant boundary enforced via `users.role` + `orders.patient_id` / `orders.doctor_id`. |
| `case_intelligence`, `case_intel_extracted_data` | `case_context`, `case_events`, `case_extractions` | Naming shifted; equivalent functionality. |
| `referrals` | `referral_codes`, `referral_redemptions` | Split into two tables. |
| `cases.report_pdf_url` | `orders.report_url` | Column moved; reports live on `orders`, not `cases`. |

All other expected tables present: `orders, cases, case_files, conversations, messages, chat_reports, users, specialties, services, service_regional_prices, appointments, prescriptions, addon_services, order_addons, addon_earnings, email_campaigns, campaign_recipients, reviews, notifications, error_logs, agent_heartbeats, doctor_earnings, file_ai_checks` — present.

**Other tables of note in tree:**
- `services_backup_2026_04_22` — backup table from a recent change. **FLAG** for Phase 10 (drop after confirming no production dependencies).
- `blocked_send_attempts` — from migration 024 committed pre-audit. ✓
- `agent_config`, `agent_heartbeats`, `agent_token_log` — OpenClaw tables ✓
- `app_analytics_events`, `app_waitlist`, `pre_launch_leads` — mobile / pre-launch leads
- `medical_records` — separate medical-records system, distinct from cases
- `refunds` — refunds ledger from migration 028 (committed in payout-policy-fix PR)

### Row counts and freshness (LOCAL DB)

| Metric | Count |
|---|---|
| `orders` | 92 |
| `cases` | 1 |
| `users` | 43 |
| `error_logs` (last 24h) | **115** — high for dev, **FLAG** investigate |

`patients`, `doctors`, `report_pdf_url`, `agent_heartbeats.created_at` all returned ERR (schema differs from audit instructions). `agent_heartbeats` exists but uses a different column name for freshness; will revisit in Phase 8.

**Production row counts (Neon)** — UNVERIFIED — reason: requires Neon `DATABASE_URL` not present in `.env`. Listed for Phase 11 follow-up.

### PHI exposure walk

(Already established in Phase 2.) Recap:
- `public/reports/` — empty (only `.gitkeep`). OK.
- `public/uploads/` — only `doctor-photos/<one .jpg>`, public-by-design. OK.
- `grep "express.static.*reports\|express.static.*uploads" src/` — only one match (`src/server.js:184` for the legacy doctor photo dir). No `res.sendFile` from `public/reports` or `public/uploads`.
- Active write paths confirmed in R2, not on disk.

### Signed URL TTL audit

Default TTL in `src/storage.js:69` is `expiresIn = 3600` (1 hour). Every call site honors that:

| Site | TTL |
|---|---|
| `src/server.js:400` | 3600 |
| `src/routes/prescriptions.js:337` | 3600 |
| `src/routes/prescriptions.js:364` | 3600 |
| `src/routes/doctor.js:2354` | 3600 |
| `src/routes/doctor.js:2469` | 3600 |
| `src/routes/reports.js:290` | 3600 |
| `src/routes/api_v1.js:139` | 3600 |

**No PHI signed URL exceeds 1 hour. OK.**

### Role-guard audit

Router-level middleware pattern:
- `src/routes/patient.js:77, 87` — top-of-router `router.use((req,res,next) => ...)` gates all subsequent routes.
- `src/routes/doctor.js:651, 673` — `router.use(['/portal/doctor', '/doctor'], requireDoctor, ...)` gates the doctor namespace at the path prefix.

Per-handler guards confirmed at sample routes (verified by reading code):

| Route | Guard pattern | Source |
|---|---|---|
| `GET /portal/patient/orders/:id` | `requireRole('patient')` + SQL `WHERE o.id = $1 AND o.patient_id = $2` + redirect on miss | `src/routes/patient.js:2276, 2307, 2311` |
| `GET /portal/case/:caseId/report` | `requireAuth` + `userCanViewCase(user, order)` → 403 on deny | `src/routes/reports.js:48, 78-83` |
| `GET /portal/patient/records` | `requireRole('patient')` + WHERE `patient_id = $1, is_hidden = false` | `src/routes/medical_records.js:17, 25` |

`userCanViewCase` central authorization helper (`src/routes/reports.js:37-44`):
```js
function userCanViewCase(user, caseRow) {
  if (!user || !caseRow) return false;
  var role = String(user.role || '').toLowerCase();
  if (role === 'superadmin' || role === 'admin') return true;
  if (role === 'doctor') return caseRow.doctor_id === user.id;
  if (role === 'patient') return caseRow.patient_id === user.id;
  return false;
}
```

Used at lines 78, 184, 263, 310 (HTML view, PDF download, email-report, generate-PDF). Single auditable definition. **OK.**

### Cross-tenant test

**Result:** PASSING by code review evidence; live two-patient DB test deferred.

The 3 sample routes above all enforce ownership at the SQL `WHERE` level OR via `userCanViewCase` BEFORE returning data. A patient B request for patient A's case data would:
1. Hit `WHERE o.patient_id = $2` with B's id, return no rows → redirect to `/dashboard` (no leak)
2. Hit `userCanViewCase` → false → 403 (mild existence inference via 404 vs 403; acceptable for this threat model)

Live two-patient DB test (seed two users, attempt cross-fetch as each) was deferred to Phase 11 — same rationale as Phase 2 (more useful against production).

### Demo / test data pollution (LOCAL DB)

**34 polluted entries in `users` table** (out of 43 total). Examples:

| email | id |
|---|---|
| `qa.success.17046@example.com` | `0619c430-…` |
| `csrf.11461@example.com`, `csrf.19581@example.com` | (CSRF test runs) |
| `sec.16740@example.com` | (sec test) |
| `qa.postpatch.1141@example.com`, `qa.recheck.21441@example.com` | (QA passes) |
| `nocsrf.8513@example.com` | (CSRF disabled test) |
| `qa-upload-1770553643@example.com` | (upload test) |
| `test@test.com` | (manual test) |
| `p.demo-ahmed.mona-saad@demo.local` | (demo data) |
| (24 more matching `@example.com` / `@test.com` / `*.demo.local`) | |

This is **local dev pollution only**, not a production data issue. The April 28 cleanup scripts (`scripts/cleanup_pollution_dryrun.js`, `cleanup_test_at_test.js`, `cleanup_pollution_orphan_check.js`) were committed pre-audit but apparently haven't been run against this local DB, OR they target only a subset.

**Production demo-data check** — UNVERIFIED — reason: requires Neon `DATABASE_URL`. To run: send the same query against Neon. The recipient guard (`src/services/recipientGuard.js`, committed pre-audit) prevents NEW pollution at the application layer; pre-existing rows in production would need a one-shot cleanup.

### Findings

| # | Tag | Finding |
|---|---|---|
| 3.1 | OK | All required core tables present (with naming differences from audit instructions). 56 tables total. |
| 3.2 | OK | PHI directories on disk are empty/legacy-only. R2 is the canonical storage for all PHI. |
| 3.3 | OK | All 7 signed-URL call sites use `expiresIn=3600` (≤ 1h). No PHI URL exceeds the audit TTL ceiling. |
| 3.4 | OK | Role guards are router-level + per-route + SQL-level. `userCanViewCase` (`reports.js:37-44`) is a clean central authorization helper used 4× in reports flow. |
| 3.5 | OK | Cross-tenant SQL boundary verified by code review on 3 sample routes. Pattern is consistent: `WHERE patient_id = $req.user.id` OR `userCanViewCase` check before returning PHI. |
| 3.6 | INFO | Schema differs from audit-instruction expectations: unified `users` table (no `patients`/`doctors`); `case_context`/`case_events`/`case_extractions` (not `case_intelligence`/`case_intel_extracted_data`); `referral_codes`/`referral_redemptions` (not `referrals`); reports on `orders.report_url` (not `cases.report_pdf_url`). Update internal mental model. |
| 3.7 | FLAG | **`error_logs` last-24h count = 115 on local dev**, suggesting noisy errors in dev. Investigate the top error class (Phase 6 / Phase 11). |
| 3.8 | FLAG | **`services_backup_2026_04_22` table** still in DB. Likely safe to drop; verify no readers in code, then DROP in Phase 10. |
| 3.9 | FLAG | **34 polluted `users` rows in LOCAL DB** — `@example.com`, `@test.com`, `*.demo.local`. Local dev pollution; cleanup scripts exist (`scripts/cleanup_pollution_*.js`) but haven't run on this DB. Run `cleanup_pollution_dryrun.js` then `cleanup_test_at_test.js` against local. |
| 3.10 | VERIFY | **Production demo-data and row-count check against Neon — UNVERIFIED.** Requires Neon `DATABASE_URL`. Listed as Phase 11 follow-up. |
| 3.11 | VERIFY | Live cross-tenant two-patient DB test deferred to Phase 11. Code review evidence is strong (3.5) but a live test gives end-to-end assurance. |

Phase 3 complete. No P0, no BLOCK. Proceeding to Phase 4.

---

## Phase 4 — pipelines (case submission flow)

### Paymob webhook integrity (`src/routes/payments.js`)

| Check | Result | Source |
|---|---|---|
| HMAC verification | ✓ Primary path uses `verifyPaymobHmac(req, hmacSecret)` from `src/paymob-hmac.js`. Returns 401 on mismatch. | `payments.js:41-50` |
| Legacy fallback | If `PAYMOB_HMAC_SECRET` is unset but `PAYMENT_WEBHOOK_SECRET` is, falls back to a header-based shared-secret check using `crypto.timingSafeEqual` (constant-time compare). | `payments.js:53-58` |
| Fail-safe | If neither secret is configured, returns **503** `{error:"webhook_not_configured"}` — does NOT process the webhook. | `payments.js:60` |
| Idempotency guard | "Atomic idempotency guard: only one webhook wins the race" — concurrent webhook duplicates are skipped via DB-level CAS. | `payments.js:98, 113` |
| CSRF exempt | The webhook route is `POST /payments/callback` mounted at `/payments` (server.js:655). CSRF middleware applies after route mounts; webhooks are typically excluded by mount order. (Will be re-checked in Phase 6 dedicated CSRF audit.) | `server.js:655`, `payments.js:21` |

**Verdict: OK.** Verification + idempotency + fail-safe all in place. The legacy-fallback secret path is acceptable for backward compatibility but should be retired once Paymob HMAC is confirmed deployed in prod.

### Doctor auto-assignment (`src/auto_assign.js`)

| Check | Result |
|---|---|
| Specialty match | ✓ `WHERE role='doctor' AND specialty_id=$1 AND COALESCE(is_active,true)=true` (line 60-62) |
| Load balancing | ✓ Lowest active caseload wins; per-doctor `countActiveCases()` excludes terminal statuses `['completed', 'cancelled', 'canceled', 'rejected', 'refunded']` (line 9, 31-37) |
| Tiebreaker | Alphabetical first by name (line 71 `ORDER BY name ASC`) — round-robin substitute. Acceptable but **not strict round-robin** (the same doctor wins all ties). |
| No-doctors-available fallback | Returns `{assigned:false, reason:'no_doctors_available'}` — does not crash. (line 67) |
| Audit trail | ✓ `logOrderEvent({ orderId, label, meta, actorRole:'system' })` after assignment (line 91-95) |
| Toggle | Controlled by `admin_settings.auto_assign_enabled`. (line 16-25) |

**Verdict: OK.** Algorithm is reasonable. **FLAG**: alphabetical tiebreak is biased toward the first-named doctor; a true round-robin (last-assigned-at timestamp) would distribute load more fairly. Not blocking.

### SLA worker (`src/case_sla_worker.js`)

| Check | Result |
|---|---|
| Active statuses scanned | `['assigned', 'in_review', 'awaiting_files', 'rejected_files', 'sla_breach']` (line 24) |
| Breach detection SQL | `WHERE deadline_at IS NOT NULL AND breached_at IS NULL AND deadline_at <= $3` (line 167-169) — catches each breach exactly once. |
| Reassignment on breach | `reassignCase(case_id, nextDoctor.id, { reason: 'sla_breach' })`; if no alternate, `reassignCase(case_id, null, { reason: 'sla_breach_no_doctor_available' })`. (lines 233, 246) |
| Logging | `[case-sla] breaches=X, timeouts=Y` major log; pings ops via `pingOps('ops-agent', ...)` after each sweep. (lines 344-347) |
| SLA breach refund hook | Wired in commit `64704ec` (Phase 4 step 4.2-4.3 of payout work). Module: `src/services/sla_breach.js` (`issueBreachRefundSafe`). | server.js:35 |

**Verdict: OK.** Will verify the breach refund only refunds **uplift, not full** in Phase 7. Live test ("set deadline_at to NOW() - 1h and watch worker") deferred to Phase 11.

### Notification pipeline & demo guard (`src/services/recipientGuard.js`, `src/services/emailService.js`, `src/notify.js`)

| Component | Status |
|---|---|
| `recipientGuard.js` module | ✓ Implemented. Blocklist: `demo.local, example.com, example.org, example.net` (line 29). Records blocked attempts in `blocked_send_attempts` (line 152). Migration 024 created the table. |
| `recipientGuard` exports | `module.exports = { ... }` at `recipientGuard.js:157` |
| Wiring into `emailService.js` | **NOT WIRED.** `emailService.js` imports nothing from `recipientGuard`. The 3 send functions (`sendEmail` line 138, `sendRawEmail` line 185, `sendMail` line 268) call `transporter.sendMail()` directly with no recipient check. |
| Wiring into `notify.js` | **NOT WIRED.** `notify.js` imports only `crypto`, `pg`, `notify/whatsapp`, `notify/notification_titles`. No recipientGuard import. |
| Cross-tree search | `grep -rn "recipientGuard" src/` outside the module itself returns **zero** matches. |

**Verdict: BLOCK.** **The April 28 OpenClaw email-leak fix is incomplete.** Migration, guard module, and tests all shipped, but the guard is **never called** before any actual send. A fresh OpenClaw incident — or any code path that bypasses the application-level email send — would still leak to `demo.local` / `example.com` recipients.

**Remediation:** add a `recipientGuard.assertAllowed(toAddress)` call (or equivalent) at the top of each `transporter.sendMail` call in `emailService.js:165, 196, 283` (or wrap `getTransporter()` to filter all sends). Also consider wrapping `notify.js`'s send paths if it ever sends email directly.

### Twilio video (`src/routes/video.js`)

| Check | Result |
|---|---|
| Twilio creds env vars | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY`, `TWILIO_API_SECRET` — all present in `.env` |
| Recording option | `grep "recordParticipantsOnConnect\|enableRecording\|record:" src/routes/video.js` — **no matches**. Server does not request recording. |
| Room creation | Server does NOT call `client.video.rooms.create()`; rooms are created on-demand by clients with the access token. Twilio defaults to no recording for ad-hoc rooms. |
| Helper | `src/video_helpers.js` exposes `generateToken`, `getRoomName`, `isVideoEnabled` — token-only flow. |

**Verdict: OK.** No recording happens by default. To enable recording in the future, would require explicit `recordParticipantsOnConnect: true` on a `client.video.rooms.create()` call.

### End-to-end happy-path test

Deferred to Phase 11 (live production smoke). Rationale: a true end-to-end (case submit → Paymob webhook → AI pipeline → doctor assign → report PDF) requires:
- Working test patient creds + 2 sample medical files
- Paymob test-mode credentials + webhook endpoint reachable from Paymob (or a simulated payload)
- ~30-45 min observation window for AI pipeline + doctor accept

The component-level audits above (HMAC, idempotency, auto-assign, SLA, recipient guard) cover the most likely failure modes.

### Findings

| # | Tag | Finding |
|---|---|---|
| 4.1 | OK | Paymob webhook: HMAC verify (`payments.js:46`) + idempotency (`:98`) + fail-safe 503 (`:60`) all present. |
| 4.2 | OK | Auto-assignment in `src/auto_assign.js` matches by specialty, picks lowest caseload, audit-logs the assignment. |
| 4.3 | OK | Case SLA worker (`case_sla_worker.js`) detects each breach once, reassigns or refunds, logs and pings ops. |
| 4.4 | OK | Twilio video does not request recording by default. Token-only flow. |
| 4.5 | **BLOCK** | **recipientGuard is unwired.** April 28 incident remediation shipped the module + migration + tests but the guard is never invoked. `emailService.js:165, 196, 283` send via `transporter.sendMail` directly. **Fix:** add `recipientGuard` calls at all 3 send sites OR wrap `getTransporter`. **High priority.** |
| 4.6 | FLAG | Auto-assign tiebreaker is alphabetical (biased toward first-named doctor on ties). True round-robin (last-assigned-at) would distribute load more fairly. Low priority. |
| 4.7 | FLAG | Paymob webhook supports a legacy fallback secret path (`PAYMENT_WEBHOOK_SECRET`). Once Paymob HMAC is confirmed live in production, retire the fallback to reduce auth surface. |
| 4.8 | VERIFY | End-to-end happy-path test deferred to Phase 11 live production smoke (case submit → payment → AI → doctor assign → report). |
| 4.9 | VERIFY | "SLA breach refund refunds only the uplift, not full price" — verified in code by name (`issueBreachRefundSafe`); arithmetic verified in Phase 7. |

Phase 4 complete. **1 BLOCK finding (4.5).** No P0. Proceeding to Phase 5.

---

## Phase 5 — AI surface guardrails

### Inventory of Claude API call sites

| # | Surface | File:line | Model | max_tokens |
|---|---|---|---|---|
| 1 | Patient case-type triage | `src/routes/patient.js:885` | `claude-haiku-4-5` | 150 |
| 2 | Case Intelligence (file extraction) | `src/case-intelligence.js:243-244` | `claude-sonnet-4-20250514` | 4096 |
| 3 | Patient "help-me-choose" assistant | `src/routes/ai_assistant.js:116-122` | `claude-sonnet-4-20250514` | 400 |
| 4 | AI image validation (file uploads) | `src/ai_image_check.js:39` | `claude-sonnet-4-20250514` | (raw HTTPS, n/a here) |
| 5 | OpenClaw growth agent | external (Mac mini), DB side-effects only | n/a | n/a |

**Note on model versions:** All Sonnet calls use `claude-sonnet-4-20250514` (Sonnet 4, May 2024 build). The current latest is Sonnet 4.6 (`claude-sonnet-4-6`). Worth a refresh — newer model has better instruction following and structured-output reliability. **FLAG**.

There is **no separate "doctor AI assistant"** surface in the current codebase. The original audit instruction's "Surface 3 — Doctor AI assistant" is essentially the case-intelligence output that doctors review on case detail; doctors do not have a dedicated chat-style AI in the codebase today.

### Surface 1 — Patient triage (`/api/analyze-case-type`, `src/routes/patient.js:877-906`)

| Check | Result |
|---|---|
| Auth | `requireRole('patient')` ✓ |
| Min input length | `description.trim().length < 10` rejected ✓ |
| Max input length | **No cap** — could submit 100 KB. **FLAG.** |
| Sanitization | `safeDesc = description.trim().replace(/['"]/g, '')` — strips quotes only. Light. **FLAG** (insufficient against prompt injection in document body). |
| Rate limit | **No per-endpoint limiter.** Other AI endpoints use `assistantLimiter` (20/min/IP); this one does not. **FLAG.** |
| System prompt explicit "no medical advice" | Prompt says "medical triage assistant ... Classify into 1-2 types from: imaging, labs, treatment, general." Does not explicitly say "do not provide medical advice"; the JSON-only output format implicitly constrains it. **INFO.** |
| Output exposed verbatim to user | `parsed.reasoning` is rendered to the patient as a UI string. Single-sentence by design. Acceptable but **prompt injection** in the user input could theoretically craft `reasoning` text. |

### Surface 2 — Case Intelligence (`src/case-intelligence.js:19-35, 243-260`)

System prompt (line 19-22):
> "You are a medical document data extractor. You extract and organize data EXACTLY as it appears in documents. You NEVER interpret, diagnose, summarize findings, or add clinical commentary. Extract only. Never interpret."

✓ **"Librarian, not doctor" semantics enforced explicitly.**

User prompt structure (line 24-35): asks for a specific JSON shape with `document_category`, `language`, `lab_values`, `patient_info`. Fields default to `null` if "not explicitly mentioned. Do NOT infer." Output handling at line 254 strips ` ```json ` fences and `JSON.parse()`s.

| Check | Result |
|---|---|
| Output schema validation | `JSON.parse()` only — no shape validation. If model returns `{}` or extra fields, parse succeeds but downstream consumers may break. **FLAG**. |
| Document delimiter | `'--- DOCUMENT TEXT ---\n' + text` — opening marker only, **no closing marker**. If the document text itself contains `--- DOCUMENT TEXT ---`, prompt injection becomes easier. **FLAG.** Replace with `<<<USER_DOCUMENT>>>...<<<END_USER_DOCUMENT>>>`. |
| Retry on JSON parse failure | 2 attempts (line 240). |

### Surface 3 — `/api/help-me-choose` assistant (`src/routes/ai_assistant.js`)

| Check | Result |
|---|---|
| Rate limit | `assistantLimiter` = **20 req/min per IP** at line 77-87 (audit instruction asked for "10/hr per user" — this is more permissive but per IP, not per user). **FLAG**: align with documented threat model. |
| Message validation | Filters to `role: 'user'\|'assistant'`, content cap **500 chars per message** (line 102-103). |
| Message count cap | **10 messages max** (line 99-100). ✓ |
| System prompt | `SYSTEM_EN(catalog)` / `SYSTEM_AR(catalog)` at line 42-94 — declared as "friendly medical triage assistant ... help patients identify which medical review service they need." Patient-facing service-recommendation; OK. |
| API timeout | 30 s (line 122). ✓ |
| Error handling | 429 / rate-limit / generic 500 — graceful (line 144+). ✓ |

### Surface 4 — AI image validation (`src/ai_image_check.js`)

Not deeply audited — out of the four surfaces in audit instructions. Used for verifying uploaded files are medical content (not garbage). Uses `claude-sonnet-4-20250514` via raw HTTPS at line 39-65. Same model-drift FLAG.

### IG scheduled posts approval gate

`src/instagram/scheduler.js:58-59`:
```sql
SELECT * FROM ig_scheduled_posts WHERE status = 'approved' AND scheduled_at <= $1
```
✓ Manual approval enforced at the SELECT level. Status is set to `'approved'` only via `src/routes/superadmin.js:2780` which requires the superadmin role and an explicit POST. **OK.**

### Email campaigns approval gate — **MISSING**

`src/server.js:929-940`: 5-min cron auto-fires:
```sql
SELECT id FROM email_campaigns WHERE status = 'scheduled' AND scheduled_at <= $1
```
**There is NO `approved_by` column, NO `requires_approval` flag, NO human gate.** A row with `status='scheduled'` and `scheduled_at <= NOW()` will be processed by the next cron tick.

Schema confirmed — `email_campaigns` columns are: `id, name, subject_en, subject_ar, template, target_audience, status, scheduled_at, sent_at, total_recipients, total_sent, total_failed, created_by, created_at`. **No approval column.**

Combined with **finding 4.5 (recipientGuard unwired)**, this is the complete OpenClaw email-leak failure mode reproduced in code:
1. OpenClaw inserts `email_campaigns` row with `status='scheduled'`, `scheduled_at = soon`, `target_audience = 'demo.local recipients'`
2. Cron at `src/server.js:935` auto-picks it up (no human review)
3. `processCampaign(id)` calls `transporter.sendMail()` directly (no recipient guard)
4. Emails sent.

### Cost monitoring

✓ Present:
- `agent_token_log` table tracks per-agent `tokens_used`, `cost_usd`, `task_label`, `logged_at`.
- `src/routes/ops.js:357` aggregates MTD spend per agent for the ops dashboard.
- `src/routes/ops.js:649-654` exposes a logging endpoint for OpenClaw / external agents to record their spend.

### Live prompt-injection test

Deferred to Phase 11 (live production smoke). The codebase-level evidence:
- Case Intelligence prompt is "extract only, never interpret" ✓
- Document delimiter is open-ended (no closing marker) — **FLAG**, increases risk
- Retry-on-parse-failure exists, but if the model leaks an instruction string into a JSON field (e.g., `patient_info.complaint = "IGNORE PRIOR INSTRUCTIONS..."`), the structured output is still consumed and shown to the doctor

A live test with a malicious PDF would conclusively verify whether the prompt holds. Listed for Phase 11.

### Findings

| # | Tag | Finding |
|---|---|---|
| 5.1 | OK | Case Intelligence system prompt at `case-intelligence.js:19-22` enforces librarian-not-doctor: "Extract only. Never interpret." |
| 5.2 | OK | IG scheduled posts gate on `status='approved'` (`instagram/scheduler.js:58-59`); only superadmin can approve (`superadmin.js:2780`). |
| 5.3 | OK | Cost monitoring present: `agent_token_log` table + ops dashboard MTD aggregation (`ops.js:357`). |
| 5.4 | OK | `/api/help-me-choose` validates messages, caps content (500 chars), caps count (10), has rate limiter, 30s timeout. |
| 5.5 | **BLOCK** | **`email_campaigns` has no approval gate.** The 5-min cron at `src/server.js:935-940` auto-fires anything with `status='scheduled'`. Combined with finding 4.5 (recipientGuard unwired), this is the full OpenClaw email-leak failure mode reproducible in code. **Fix:** add `approved_by` column to `email_campaigns`, change cron SELECT to `WHERE status = 'approved'`, add admin-approve endpoint. |
| 5.6 | FLAG | Patient triage `/api/analyze-case-type` (`patient.js:877-906`) has **no per-endpoint rate limit, no max input length cap, only quote-stripping for sanitization**. Add `assistantLimiter` (or equivalent), cap description to ≤2,000 chars, add prompt-injection neutralization. |
| 5.7 | FLAG | Case Intelligence document delimiter is open-ended (`'--- DOCUMENT TEXT ---\n' + text`). Add a closing delimiter (`<<<END_USER_DOCUMENT>>>`) to harden against documents containing matching marker text. |
| 5.8 | FLAG | Case Intelligence has no schema validation on the JSON output — only `JSON.parse()`. If the model returns malformed/extra fields, downstream consumers can break silently. Add `ajv` or zod schema validation. |
| 5.9 | FLAG | All Sonnet 4 call sites still use `claude-sonnet-4-20250514` (May 2024 build). Sonnet 4.6 is current and recommended for instruction-following + structured output. Plan a model upgrade. |
| 5.10 | VERIFY | Live prompt-injection test against Case Intelligence — deferred to Phase 11. |

Phase 5 complete. **1 BLOCK (5.5)**, no P0. Proceeding to Phase 6.

---

