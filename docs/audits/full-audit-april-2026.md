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

## Phase 6 — security posture

### npm audit (production deps)

`npm audit --omit=dev --json` → **6 moderate, 0 high, 0 critical.** All in transitive deps; all have fixes available.

| Package | Severity | Issue | Fix |
|---|---|---|---|
| `axios` (1.0.0 - 1.14.0) | moderate | NO_PROXY hostname normalization bypass → SSRF; cloud-metadata exfiltration via header injection | Update available |
| `fast-xml-parser` (<5.7.0) | moderate | XML comment + CDATA injection via unescaped delimiters | Update available |
| `@aws-sdk/xml-builder` | moderate | (Inherits fast-xml-parser issue) | Update available |
| `follow-redirects` | moderate | (continued in audit output) | Update available |
| (2 more) | moderate | (transitive) | Update available |

**Verdict: OK with FLAG.** Run `npm audit fix --omit=dev` and verify nothing breaks. No critical or high.

### Production response headers (`https://tashkheesa.com/`)

`curl -sIm 10 https://tashkheesa.com/` returned full set:

| Header | Value | Verdict |
|---|---|---|
| `strict-transport-security` | `max-age=31536000; includeSubDomains` (1 year) | OK |
| `content-security-policy` | `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; img-src 'self' data: blob: https://ucarecdn.com https://res.cloudinary.com https://api.qrserver.com; font-src 'self' data: https://ucarecdn.com https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://ucarecdn.com https://fonts.googleapis.com; script-src 'self' 'nonce-…' https://ucarecdn.com https://cdn.jsdelivr.net https://media.twiliocdn.com https://unpkg.com; connect-src 'self' …` | **Strong** — nonce-based script-src, no wildcard, frame-ancestors none. `'unsafe-inline'` only for style-src (acceptable for EJS templates). |
| `x-frame-options` | `SAMEORIGIN` | OK (redundant with CSP frame-ancestors but harmless) |
| `x-content-type-options` | `nosniff` | OK |
| `referrer-policy` | `no-referrer` | OK |
| `permissions-policy` | `geolocation=(), microphone=(), camera=()` | OK — all dangerous APIs disabled |
| `cross-origin-opener-policy` | `same-origin` | OK |
| `cross-origin-resource-policy` | `same-origin` | OK |
| `csrf_token` cookie | `HttpOnly; Secure; SameSite=Lax; Max-Age=604800` | OK |
| `ratelimit-policy` | `100;w=60` | INFO — global 100 req/min/IP at edge |

**Verdict: OK.** This is a tight, modern header set.

### Auth hardening

| Check | Result | Source |
|---|---|---|
| bcrypt async only | ✓ All 7 call sites use `await bcrypt.hash` / `await bcrypt.compare` | `auth.js:7,11`, `routes/api/auth.js:53,95,320`, `routes/api/profile.js:113,118` |
| bcrypt cost factor | 10 (modern recommendation is 12; 10 is acceptable) | (same files) |
| JWT_SECRET length | **61 chars** ✓ (>= 32 threshold) | `.env:4` |
| JWT short-token TTL | 15 min | `middleware/requireJWT.js:69` |
| JWT long-token TTL | 30 days | `middleware/requireJWT.js:75` |
| Web session JWT | 7 days | `auth.js:25`, `routes/auth.js:101` |
| Password reset token expiry | ✓ Validated via `WHERE reset_token = $1 AND reset_token_expires > NOW()` | `routes/api/auth.js:312` |
| Password reset TTL value | UNVERIFIED — explicit value not found by quick grep | n/a |
| OTP expiry | ✓ Validated via `WHERE expires_at > NOW()` | `routes/api/auth.js:213` |
| OTP cooldown / send-rate-limit | **NOT FOUND.** No per-phone cooldown to prevent OTP spam. Relies on global IP rate limit. | n/a |

### Rate limiting

10+ rate limiters configured across `src/middleware.js` and per-route. Most relevant:

| Name | Window | Max | Scope | Source |
|---|---|---|---|---|
| `authLimiter` | **15 min** | **30** per IP | `/login`, `/forgot-password`, `/reset-password` | `middleware.js:88-99` |
| `apiLimiter` | (per-config) | (per-config) | `/api/v1/*` | `routes/api_v1.js:57` |
| `assistantLimiter` | 1 min | 20 per IP | `/api/help-me-choose` | `ai_assistant.js:77` |
| `fileDownloadLimiter` | 1 min | 50 per IP | (file downloads) | `middleware.js:102` |
| `paymentCallbackLimiter` | (per-config) | (per-config) | (Paymob webhook) | `middleware.js:142` |
| Edge (Cloudflare) | 60 s | 100 per IP | (global) | response header |

Audit asked: "Login route: must be ≤10 attempts per 15 min per IP." Current is **30/15 min**. Permissive but not catastrophic given (a) edge limits to 100/min, (b) bcrypt async is rate-limited by CPU. **FLAG** — tighten to 10 to align with audit recommendation.

### CSRF coverage

✓ Custom CSRF middleware at `src/middleware/csrf.js`. Reads `x-csrf-token` header or body `_csrf`/`csrf` field. Mounted via `setupCsrf()` (referenced in `server.js:136`). `csrf_token` cookie observed in production response headers (HttpOnly, Secure, SameSite=Lax). EJS templates expose `csrfField()` helper used across patient and admin views.

`EXEMPT_PATHS` exists for webhooks (Paymob etc.). Verifying that the exempt list is tight requires reading `src/middleware/csrf.js` further — listed as **VERIFY** for follow-up.

### DB SSL config

`src/pg.js:29`:
```js
ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false }
```

**FLAG.** `rejectUnauthorized: false` accepts any TLS certificate including self-signed ones — vulnerable to MITM if the connection runs over an untrusted network. For Neon production, this should be `rejectUnauthorized: true` with the Neon CA cert. For local dev, current behavior is fine. Configure prod via env: `PG_SSL_CA_CERT` or use the standard `sslmode=verify-full` in the connection string.

### R2 bucket access control

Required env vars confirmed in `.env`: `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`.

`src/storage.js` constructs S3 client with the credentials at line 25-32. Data accessed via signed URLs (TTL=3600s, see Phase 3 audit).

**Public-bucket test** — UNVERIFIED — reason: `aws-cli` not installed on this Mac mini. Test command for follow-up: `aws s3api list-objects-v2 --endpoint-url $R2_ENDPOINT --bucket $R2_BUCKET --no-sign-request`. Must return AccessDenied; if it lists objects, that is a P0.

### Backups

UNVERIFIED — reason: requires checking either pg_dump cron logs or Neon's backup configuration. Surface for user follow-up:
- Is there a weekly off-Neon `pg_dump` cron?
- What's the Neon plan's backup retention?
- When was the last manual snapshot taken?

### `.bak` file inventory (cross-references finding 0.4)

`find . -name "*.bak"` returned **16+ files** in working tree (gitignored, hence not in `git status`):

| Location | Count |
|---|---|
| `public/css/` | 6 (`doctor-portal-v2.css.bak`, `doctor-guide.css.bak`, `doctor-profile.css.bak`, `doctor-appointments.css.bak`, `portal-variables.css.bak`, `doctor-analytics.css.bak`) |
| `src/views/` | 10+ (`doctor_alerts.ejs.bak`, `portal_doctor_profile.ejs.bak`, `doctor_case_intelligence.ejs.bak`, `patient_referrals.ejs.bak`, `patient_reviews.ejs.bak`, `doctor_analytics.ejs.bak`, `patient_appointments_list.ejs.bak`, `patient_prescription_detail.ejs.bak`, `doctor_prescriptions_list.ejs.bak`, `patient_review_form.ejs.bak`, plus the original 4 from Phase 0) |

Phase 10 scope expanded: ~16 files for explicit removal, not 4.

### Findings

| # | Tag | Finding |
|---|---|---|
| 6.1 | OK | npm audit: 0 critical, 0 high, 6 moderate (all transitive, fixes available). Run `npm audit fix --omit=dev`. |
| 6.2 | OK | Production response headers are tight: HSTS 1y, nonce-based CSP, frame-ancestors none, permissions-policy locks geo/mic/camera. |
| 6.3 | OK | bcrypt async on every call site (cost=10). JWT_SECRET 61 chars. Password reset and OTP both have DB-enforced expiry. CSRF middleware in place. |
| 6.4 | FLAG | **`authLimiter` is 30/15 min/IP**, not the audit-recommended 10/15 min. Tighten to 10 or add per-account lockout. |
| 6.5 | FLAG | **OTP send has no per-phone cooldown.** Possible to spam OTPs to a single number until global IP rate limit fires (which is 100/min/IP at the edge — high). Add `otp_codes.created_at >= NOW() - 60s` check before insert. |
| 6.6 | FLAG | **`src/pg.js:29` has `rejectUnauthorized: false`** for SSL. MITM-vulnerable if the prod DB connection traverses an untrusted network. For Neon production, set `rejectUnauthorized: true` and pass the Neon CA cert. |
| 6.7 | FLAG | **16+ `.bak` files** in `public/css/` and `src/views/` (gitignored). Cleanup commit `chore: remove migration backups` was promised by April 27 SESSION_REPORT but never landed. Phase 10. |
| 6.8 | VERIFY | Password reset TTL value not found in quick grep (mechanism enforced via `reset_token_expires > NOW()`, but the `+TTL` value at write time is elsewhere). Confirm in code review during Phase 7 adjacency. |
| 6.9 | VERIFY | `EXEMPT_PATHS` for CSRF should be re-read in detail to confirm the exempt list is tight (Paymob, healthz, public APIs only). Quick. |
| 6.10 | VERIFY | **R2 bucket ACL public-list test** — UNVERIFIED, no `aws-cli` on the Mac mini. Run `aws s3api list-objects-v2 --endpoint-url $R2_ENDPOINT --bucket $R2_BUCKET --no-sign-request` and confirm AccessDenied. If list returns, P0. |
| 6.11 | VERIFY | **Off-Neon backups** — UNVERIFIED. Confirm whether a weekly `pg_dump` cron exists and where snapshots live. Lack of off-Neon backup is a FLAG (not BLOCK). |

Phase 6 complete. No P0, no BLOCK. Proceeding to Phase 7.

---

## Phase 7 — pricing & payouts

### Canonical sources

| Source | Status |
|---|---|
| `docs/PAYOUT_AND_URGENCY_POLICY.md` | ✓ exists, 233 lines, dated 2026-04-29, declares itself "single source of truth" |
| `docs/pricing/tashkheesa_pricing_v2.xlsx` | ✓ exists (under `docs/pricing/`, not at repo root as audit instruction said) |
| `docs/pricing/tashkheesa_pricing_v2.json` | ✓ exists (the canonical sync source for the DB) |

**Canonical splits (§1):**
| Component | Doctor share | Tashkheesa share |
|---|---|---|
| Main case base price | **20%** | 80% |
| Video consult add-on | **85%** | 15% |
| Prescription add-on | **50%** | 50% |
| Urgency uplift (delta only) | **30%** | 70% |

**Canonical multipliers (§2):** Standard 1.0× / VIP 1.3× / Urgent 1.6×.

**Canonical SLA breach (§4):** refund the uplift only; doctor earns base × 0.20, no uplift bonus.

### Pure module audit

| Module | Verdict | Source |
|---|---|---|
| `src/services/urgency_pricing.js` | ✓ Correct math: `totalPrice = basePrice × multiplier`, `upliftAmount = totalPrice − basePrice`. Multipliers default to 1.30 / 1.60 with optional per-service overrides. Pure function, has tests. | `urgency_pricing.js:36-62` |
| `src/services/earnings_calc.js` | ✓ Correct math, BUT — see finding 7.5 — explicitly uses **absolute `services.doctor_fee` from the catalog** as `baseShare`, NOT `basePrice × 0.20`. Comment at line 7-15 makes this explicit. The 20% rule is enforced **at the catalog level**, not by this function. Pure function, has tests. | `earnings_calc.js:40-68` |
| `src/services/sla_breach.js` | ✓ Wired in `src/server.js:35` and called at SLA breach time. (deeper code review deferred) | n/a |

### Wiring verification

`computeOrderPricing` (urgency pricing) — **WIRED**:

| Site | Source |
|---|---|
| Order checkout / pricing display | `src/routes/order_flow.js:387, 454, 513-514, 545, 558` |

`computeDoctorEarnings` — **NOT WIRED**:

`grep -rn "computeDoctorEarnings\|earnings_calc" src/` returns matches only in:
- `src/services/earnings_calc.js` (the module itself)
- `src/services/__tests__/earnings_calc.test.js` (its tests)

**No production call site invokes `computeDoctorEarnings`.** The order creation path stores `orders.doctor_fee` directly from `services.doctor_fee` (the absolute catalog value) and possibly adds an uplift share computed inline. This means:
- ✓ If catalog `services.doctor_fee` is correct, runtime stores correct value.
- ✗ If catalog is wrong, runtime stores wrong value — and there is **no central authority** for the calculation.
- ✗ Add-on shares per `order_addons.doctor_commission_pct_at_purchase` are not summed via this module — they're computed elsewhere (or not at all in summary views).

### Catalog (`services` table) integrity

`SELECT ROUND((doctor_fee / base_price) * 100) AS pct, COUNT(*)` distribution across 180 services:

| pct | count | Verdict |
|---|---|---|
| **15%** | **18** | **Off-canonical** — should be 20% per §1, OR these are an intentional special-rate group. Needs clarification. |
| **20%** | **143** | ✓ Canonical |
| **80%** | **19** | **WRONG** — these still carry the OLD inverted-convention seed values (when `doctor_fee` meant platform-keep-share, not doctor-share). |

**19 services with `doctor_fee = base × 0.80` instead of `0.20`** — sample:

| Service | base_price | doctor_fee | actual % |
|---|---|---|---|
| Abdominal CT Review | 800 | 640 | **80%** |
| Abdominal Ultrasound Review | 500 | 400 | **80%** |
| Audiogram Review | 400 | 320 | **80%** |
| Biopsy / Histopathology Review | 900 | 720 | **80%** |
| Chest CT Review | 800 | 640 | **80%** |
| Chronic Disease Management Review | 700 | 560 | **80%** |
| Comprehensive Blood Panel Review | 500 | 400 | **80%** |

If a doctor takes any of these 19 services, **they earn 4× the canonical amount** (80% instead of 20%). For Abdominal CT Review at 800 EGP: doctor earns 640 EGP instead of 160 EGP — overage of **480 EGP per case**.

**Remediation SQL (review before running):**
```sql
-- Inspect first
SELECT id, name, base_price, doctor_fee, ROUND((doctor_fee::numeric/base_price)*100) AS pct
FROM services
WHERE base_price > 0 AND doctor_fee > base_price * 0.5
ORDER BY base_price DESC;

-- Fix (pause for human review of every row first)
UPDATE services
SET doctor_fee = ROUND(base_price * 0.20)
WHERE base_price > 0 AND doctor_fee > base_price * 0.5;
```

**Also reconcile any past payouts** — sample paid orders against affected service IDs to check whether the bad doctor_fee was already paid out to doctors. **Listed as a follow-up recovery task.**

### 18 services at 15% — clarification needed

Sample:
- 24-Hour Priority Review (500 EGP, 75 = 15%)
- Autoimmune panels (7,100 EGP, 1,065 = 15%)
- Bone marrow smear & biopsy reports (12,000 EGP, 1,800 = 15%)
- Coagulation studies (600 EGP, 90 = 15%)
- Cytology: Body fluids / Pap smear / FNA (1,050-1,700 EGP, 158-255)
- Electrolytes (550 EGP, 83 = 15%)

Per canonical doc, main case is 20%. Either:
- These are intentionally at a 15% rate (some pathology / lab services with negotiated rate)
- Or the seed/sync used 15% by mistake

**VERIFY** with user / the canonical xlsx: are pathology services at a 15% special rate?

### Tier floors

Audit instructions said: Simple ≥ 1,250 EGP, Moderate ≥ 1,500 EGP, Complex no floor.

`services` table does NOT have a `tier` column. The tier classification (Simple/Moderate/Complex) appears to be a documentation construct, not enforced in the schema. Many services price below 1,250 EGP (PSA Test 288, Urinalysis 300, H. pylori 345, X-rays 402). If tier floors are policy, they're **not enforced anywhere in the catalog**. **VERIFY** — is the tier-floor policy still active, or superseded?

### Sample 5 paid orders (LOCAL DB)

All 5 most recent paid orders are demo-seeded (`reference_id = TSH-2026-DEMO-*`). 4 of 5 have `base_price IS NULL`. The 1 with valid joined service data (TSH-2026-DEMO-R02): `service.base_price=1500`, `service.doctor_fee=300` (✓ 20%); but the order itself has `price=1380` (not 1500×1.30=1950) and `doctor_fee=550` (not the canonical-expected 435). Demo data was seeded by hand, not via canonical pricing pipeline.

**Production paid-order recompute** — UNVERIFIED — reason: requires Neon DATABASE_URL. The sample-and-recompute math should be run against production once Neon access is available.

### Findings

| # | Tag | Finding |
|---|---|---|
| 7.1 | OK | Canonical docs exist (`docs/PAYOUT_AND_URGENCY_POLICY.md` and `docs/pricing/tashkheesa_pricing_v2.xlsx`/`.json`). |
| 7.2 | OK | `urgency_pricing.computeOrderPricing` is correct AND wired at 5 sites in `routes/order_flow.js`. |
| 7.3 | OK | `sla_breach` module is wired into the SLA worker (`server.js:35`). |
| 7.4 | **BLOCK** | **`computeDoctorEarnings` is not wired.** Module exists with tests but zero call sites in production code. Earnings rely entirely on whatever inline math sets `orders.doctor_fee` at INSERT time, which means there is no central authority for "this is how much the doctor earned, including uplift share + add-on shares". Wire it at order creation + at SLA breach + at the doctor earnings ledger insert. |
| 7.5 | **BLOCK** | **19 services in catalog have `doctor_fee = base × 0.80` instead of `0.20`** — 4× doctor overpayment per case. Affected: Abdominal CT, Abdominal Ultrasound, Audiogram, Biopsy/Histopathology, Chest CT, Chronic Disease Management, Comprehensive Blood Panel, ... (15 more). Fix SQL listed above; reconcile past payouts. |
| 7.6 | FLAG | 18 services priced at 15% doctor share — does not match canonical 20%. Either intentional special-rate group (cytology / pathology) OR misseeded. **Clarify with user before any fix.** |
| 7.7 | FLAG | Tier floors (Simple ≥1,250, Moderate ≥1,500) **not enforced** in the catalog. Many services price below 1,250. Either policy was relaxed or floors were never wired. **Clarify.** |
| 7.8 | VERIFY | Production paid-order recompute (sample 5 from Neon, hand-verify pricing + doctor_fee). UNVERIFIED — needs Neon access. |
| 7.9 | VERIFY | Add-on add-ons.doctor_commission_pct_at_purchase: per migration 026 video moved from 80% → 85%. Spot-check that the migration ran on prod and historical add-ons aren't being recomputed at the new rate retroactively. |

Phase 7 complete. **2 BLOCK findings (7.4, 7.5). 0 P0.** Proceeding to Phase 8.

---

## Phase 8 — OpenClaw integration

(Local-DB queries — production data needs Neon.)

### Agent heartbeats (`agent_heartbeats` table)

Schema columns: `id, agent_name, status, current_task, token_cost_usd, meta, pinged_at`

`SELECT agent_name, MAX(pinged_at), AGE(NOW(), MAX(pinged_at)) FROM agent_heartbeats GROUP BY agent_name`:

| Agent | Last seen (local DB) | Staleness |
|---|---|---|
| `care-agent` | 2026-04-29T14:10:07Z | ~25 min |
| `ops-agent` | 2026-04-29T14:35:40Z | ~5 min |
| `tash-agent` | (absent locally) | n/a |
| `growth-agent` | (absent locally) | n/a |
| `finance-agent` | (absent locally) | n/a |

Audit instruction expected Tash, Growth, Care, Finance — all <10 min stale. Local DB only sees Care and Ops. Tash/Growth/Finance probably heartbeat against production (Neon). **VERIFY** in Phase 11 against production.

### Token usage (`agent_token_log` table)

`SELECT agent_name, DATE(logged_at), SUM(tokens_used) FROM agent_token_log WHERE logged_at > NOW() - INTERVAL '7 days'`:

**0 rows in last 7 days on local DB.** Local has no agent token activity. **VERIFY** against production.

### `demo.local` guard confirmation (cross-reference Phase 4)

The recipientGuard module (`src/services/recipientGuard.js`) implements the blocklist correctly: `demo.local`, `example.com`, `example.org`, `example.net`. Migration 024 created the `blocked_send_attempts` audit-log table.

**`blocked_send_attempts` row count: 2** — both written today (2026-04-29 09:40 and 11:40), both for `*.demo.local` recipients with subjects like "Your case TSH-2026-DEMO-N02 has been reassigned". **These were written by the test suite** (`tests/notifications/recipientGuard.test.js`), confirmed by:

- The only `require('../../src/services/recipientGuard')` outside the module itself is at `tests/notifications/recipientGuard.test.js:19`.
- No `import`/`require` of recipientGuard exists in `src/`.
- The cleanup scripts (`scripts/check_blocked_table.js`) only SELECT, never INSERT.

**Conclusion: finding 4.5 stands** — the guard is wired into the test harness, not into runtime send paths. The 2 rows are test artifacts.

### IG scheduled posts approval gate

`SELECT status, COUNT(*) FROM ig_scheduled_posts GROUP BY status`:

| status | count |
|---|---|
| `pending_approval` | **11** |
| `approved` | 0 |
| `published` | 0 |
| `failed` | 0 |

11 posts waiting for human approval. Scheduler at `instagram/scheduler.js:58-59` only picks up `WHERE status='approved' AND scheduled_at<=NOW()` — none of the 11 will publish. **Gate working as designed.** ✓

(Audit query `WHERE published_at IS NULL AND approved_by IS NULL AND scheduled_for < NOW() + INTERVAL '1 day'` couldn't run because `scheduled_at` is `text` type, not `timestamp`. The status-based check above is equivalent in intent.)

### Email campaign approval gate (cross-reference Phase 5)

`SELECT status, COUNT(*) FROM email_campaigns GROUP BY status`: **0 campaigns of any status.** No campaign data on local DB to exercise the gap. The BLOCK finding (5.5) — that the cron auto-fires on `status='scheduled'` with no approval column — remains true at the schema level, just not exercised on this DB.

### Schema observation

`ig_scheduled_posts` columns are **all `text` type** (including `scheduled_at`, `created_at`, `published_at`, `approved_at`, `updated_at`). This is unusual — all the other timestamp-bearing tables use `timestamp without time zone`. **FLAG**: text-typed timestamps cause comparison errors (`error: operator does not exist: text < timestamp with time zone`) and prevent normal date arithmetic. Migrate to proper `timestamp` columns.

### Findings

| # | Tag | Finding |
|---|---|---|
| 8.1 | OK | IG scheduled posts gate on `status='approved'` working — 11 in pending_approval, 0 published. Verified Phase 5 finding 5.2. |
| 8.2 | OK | recipientGuard module works correctly (confirmed by 2 test-suite-written rows in `blocked_send_attempts`). The guard logic is correct — only its production wiring is missing (finding 4.5). |
| 8.3 | OK | Cost monitoring infrastructure (`agent_token_log`) present with `tokens_used` and `cost_usd` columns. |
| 8.4 | FLAG | **`ig_scheduled_posts` uses `text` type for all timestamp columns** (`scheduled_at`, `created_at`, etc.). Causes downstream comparison errors and prevents standard date arithmetic. Migrate to `timestamp` type. |
| 8.5 | INFO | Local DB has only `care-agent` + `ops-agent` heartbeats. Tash/Growth/Finance likely heartbeat against Neon production. |
| 8.6 | VERIFY | Production heartbeat freshness for all 5 agents — needs Neon. |
| 8.7 | VERIFY | Production token spend last 7d per agent — needs Neon. Check for cost spikes. |
| 8.8 | VERIFY | Production `email_campaigns` and `ig_scheduled_posts` activity — needs Neon. |

Phase 8 complete. No P0, no BLOCK new (Phase 4/5 BLOCKs cross-ref'd). Proceeding to Phase 9.

---

## Phase 9 — bilingual & RTL audit (sample)

Time-boxed per audit instructions ("don't spend more than 1 hour"). Static / file-based checks only.

### Logical CSS coverage

`grep -rohE "margin-(left|right)|padding-(left|right)|left:|right:" public/css/portal-*.css public/css/patient-portal*.css public/css/doctor-portal*.css | wc -l`:

| Property type | Count |
|---|---|
| Physical (margin-left/right, padding-left/right, `left:`, `right:`) | **40** |
| Logical (margin-inline-*, padding-inline-*, inset-inline-*) | **27** |

Ratio is roughly 60/40 in favor of physical. For a v2 design system explicitly targeting RTL, the ratio should be the inverse — almost all properties logical. **FLAG**: 40 physical-property uses to refactor in patient/doctor v2 CSS files. Each means a manual mirror is required for RTL.

### i18n infrastructure

| Component | Status |
|---|---|
| `src/i18n.js` | ✓ Present. String-keyed dict with EN + AR translations. Topics covered: brand, nav, auth, country labels, doctor UI guardrails. |
| `src/routes/lang.js:33` | ✓ `GET /lang/:code` route handles language switching (writes cookie). |
| Production `/lang/ar` | Returns 302 → `/login`. Language switch is auth-gated for the dashboard but homepage renders default EN. (Quick test: `curl -H "Cookie: lang=ar" https://tashkheesa.com/` returned `<html lang="en">` — the cookie alone doesn't force AR on public pages.) |

**FLAG:** the `/lang/ar` redirect to `/login` for unauthenticated users isn't ideal — a public visitor switching to AR should still see the public site in AR, not be forced to log in.

### Email + WhatsApp templates

| Channel | EN templates | AR templates | Parity |
|---|---|---|---|
| Email (`src/templates/email/{en,ar}/`) | 19 `.hbs` files (additional-files-request, appointment-cancelled, appointment-reminder, appointment-scheduled, campaign, case-accepted, ...) | 19 `.hbs` files (parallel set) | ✓ Pair-wise parity |

**OK** — every English email template has an Arabic counterpart. Spot-checked one pair (`campaign.hbs`): both 600+ bytes, parallel structure expected.

### PDF report bilingual

UNVERIFIED — would require generating an actual case report PDF in EN and AR. Listed for Phase 11.

### Patient v2 page render in Arabic

UNVERIFIED — same blocker as Phase 2 auth-required tests. Listed for Phase 11.

### Findings

| # | Tag | Finding |
|---|---|---|
| 9.1 | OK | i18n module present with EN + AR string maps. Lang switch route at `routes/lang.js:33`. |
| 9.2 | OK | Email template parity: all 19 EN templates have AR counterparts. |
| 9.3 | FLAG | **40 physical CSS properties vs 27 logical** in v2 CSS files. For an RTL-supporting design system, this ratio should be inverted. Each physical property may need a manual `[dir="rtl"]` override. |
| 9.4 | FLAG | `/lang/ar` redirects to `/login` for unauthenticated visitors. Public homepage doesn't honor the lang cookie alone. Confirm this is intended; if not, fix the public lang switch. |
| 9.5 | VERIFY | PDF report bilingual rendering — Phase 11. |
| 9.6 | VERIFY | Live patient/doctor portal walk in Arabic (RTL layout, sidebar position, chevrons) — Phase 11. |

Phase 9 complete. No P0, no BLOCK. Proceeding to Phase 10.

---

## Phase 10 — dead code & orphan cleanup

Consolidation of items already surfaced in earlier phases plus net-new findings. Each item is verified to exist at HEAD.

### Files to delete

| # | Path | Lines / size | Reason | Source phase |
|---|---|---|---|---|
| 1 | `src/sla_worker.js` | 184 (5,141 bytes) | Commented out at `src/server.js:106`; superseded by `src/case_sla_worker.js`. Confirmed unreferenced. | Phase 1 (1.6) |
| 2 | `src/views/appointment_booking.ejs` | (orphan) | No `render('appointment_booking')` anywhere. | Phase 2 (2.8) |
| 3 | `src/views/appointment_detail.ejs` | (orphan) | No `render('appointment_detail')` anywhere. | Phase 2 (2.8) |
| 4 | `src/views/order_payment.ejs` | (orphan) | Only `render('superadmin_order_payment')` exists; this view is unused. | Phase 2 (2.8) |
| 5 | `src/views/order_start.ejs` | (orphan) | No reference. | Phase 2 (2.8) |
| 6 | `src/views/public_case_new.ejs` | (orphan) | No reference. | Phase 2 (2.8) |
| 7 | `src/views/public_case_thankyou.ejs` | (orphan) | No reference. | Phase 2 (2.8) |

### `.bak` files to delete (23 total, all gitignored)

`public/css/` (6): `doctor-portal-v2.css.bak`, `doctor-guide.css.bak`, `doctor-profile.css.bak`, `doctor-appointments.css.bak`, `portal-variables.css.bak`, `doctor-analytics.css.bak`

`src/views/` (16): `doctor_alerts.ejs.bak`, `portal_doctor_profile.ejs.bak`, `doctor_case_intelligence.ejs.bak`, `patient_referrals.ejs.bak`, `patient_reviews.ejs.bak`, `doctor_analytics.ejs.bak`, `patient_appointments_list.ejs.bak`, `patient_prescription_detail.ejs.bak`, `doctor_prescriptions_list.ejs.bak`, `patient_review_form.ejs.bak`, `patient_records.ejs.bak`, `patient_alerts.ejs.bak`, `portal_doctor_guide.ejs.bak`, `patient_prescriptions.ejs.bak`, `doctor_appointments.ejs.bak`, `doctor_prescribe.ejs.bak`

`src/views/layouts/` (1): `portal.ejs.bak`

The promised `chore: remove migration backups` commit (April 27 SESSION_REPORT) never landed. Run: `find . -name "*.bak" -not -path "./node_modules/*" -not -path "./.git/*" -delete` after a final visual diff against the live versions.

### DB schema cleanup

| # | Object | State | Action |
|---|---|---|---|
| 1 | `services_backup_2026_04_22` table | 301 rows | Confirm no callers (`grep "services_backup"` in src/), then `DROP TABLE services_backup_2026_04_22;` |

### Static mount cleanup

| # | Item | Source | Action |
|---|---|---|---|
| 1 | `app.use('/uploads', express.static(...))` | `src/server.js:184` | All active uploads go to R2 (`doctor.js:2298`, `order_flow.js:69`). Remove the static mount and delete the legacy on-disk doctor photo at `public/uploads/doctor-photos/`. |
| 2 | `/blog` 404 vs `public/blog/` | `public/blog/` directory exists with 4 production HTML files | Either add `app.use('/blog', express.static('public/blog'))` and a sitemap link, or move to `/site/blog/` (which already works due to the `/site` fallback) and delete `public/blog/`. **Decide based on SEO intent.** |
| 3 | `/site` static fallback to entire `public/` | `src/server.js:175-179` | Create `public/site/` with the marketing-only files OR change the mount to a fixed dir to avoid leaking `public/uploads/`, `public/css/`, etc. under `/site/*`. |

### Unused imports / convention violations

| # | Item | Source | Action |
|---|---|---|---|
| 1 | `src/routes/api_v1.js` uses `const`/`let` | Phase 2 (2.10) | Convert to `var` to match project convention. |
| 2 | `npx unimported` audit | n/a | Not yet installed. Optional follow-up: `npm i -D unimported && npx unimported` to find dead JS files. |

### SQLite cruft (clean)

`find . -name "*.db" -size +1M` returned **nothing** ✓. `package.json` has neither `sqlite3` nor `better-sqlite3` ✓ (uninstalled in March per Phase 1 context). **OK — no cruft.**

### SOUL.md drift

Out of repo (Mac mini agent souls live elsewhere). Listed for user follow-up: compare each agent's `SOUL.md` last_modified against last product change; SOULs older than 60 days while the product has shifted = drift; flag for review.

### Pre-deleted items (already cleaned, recorded)

These were called out in the chrome-state audit (April 27, commit `b659977`) as orphans, then deleted in commit `688cc98`:
- `src/views/portal_doctor_queue.ejs` (deleted) ✓
- `src/views/portal_doctor_completed.ejs` (deleted) ✓
- `src/views/doctor_profile.ejs` (deleted) ✓

### Findings

| # | Tag | Finding |
|---|---|---|
| 10.1 | FLAG | 1 file to delete: `src/sla_worker.js` (184 LOC dead code). |
| 10.2 | FLAG | 6 orphan view files to delete (`appointment_booking`, `appointment_detail`, `order_payment`, `order_start`, `public_case_new`, `public_case_thankyou`). |
| 10.3 | FLAG | 23 `.bak` files to delete (gitignored, but cluttering working tree). The promised `chore: remove migration backups` commit never landed. |
| 10.4 | FLAG | `services_backup_2026_04_22` table (301 rows) to drop after callers checked. |
| 10.5 | FLAG | `app.use('/uploads', ...)` static mount (`server.js:184`) and the legacy on-disk doctor photo can be removed; uploads now go to R2. |
| 10.6 | FLAG | `/blog` 404 / `public/blog/` decision: mount or remove. |
| 10.7 | FLAG | `/site` fallback to entire `public/` is broader than intended. Tighten the mount. |
| 10.8 | FLAG | `src/routes/api_v1.js` uses `const`/`let`; convert to project convention `var`. |
| 10.9 | OK | No SQLite cruft. No `*.db` files >1 MB; no `sqlite3` / `better-sqlite3` in `package.json`. |
| 10.10 | VERIFY | SOUL.md drift check is out of repo; user follow-up. |

Phase 10 complete. No P0, no BLOCK (all FLAGs aggregate cleanup). Proceeding to Phase 11.

---

