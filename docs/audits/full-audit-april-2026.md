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

