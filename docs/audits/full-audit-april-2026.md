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

