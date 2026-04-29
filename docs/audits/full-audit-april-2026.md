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

