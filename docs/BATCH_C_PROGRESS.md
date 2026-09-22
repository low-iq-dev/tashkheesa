# Batch C — progress ledger (Part 1: C1–C5)

OWNER: this session (MacBook, worktree `/Users/ziadelwahsh/tashkheesa-batchc`, branch `feat/doctor-access-and-api` cut from origin/main @ 5cd16e9cc)

**STATUS: Part 1 COMPLETE — stopped at the checkpoint. Nothing pushed, nothing merged, no production write committed. Part 2 (`/api/v1/doctor/*`) not started, per the brief.**

Baseline (no-DB, this machine, 2026-09-22): **1926 passed / 11 failed / 52 skipped** — `env DATABASE_URL= node tests/run.js`, deterministic across two runs. The 11 pre-existing failures: email-stub-mode ×5, env-vars-validated-or-documented ×1, orders-table-readers-allowlist ×1, payment-money-paths-wiring ×3, theme9-video-flag-enforcement ×1.
Final (same command, after fix round): **1965 passed / 11 failed / 52 skipped** — the SAME 11 failures, +39 new passing tests (23 hermetic auth, 16 structural).

| Item | Status | Notes |
|---|---|---|
| Upstream check | DONE | origin/main = 5cd16e9cc, nothing from Batch C upstream |
| C1 sessions table + per-device refresh/push | DONE | migration 110 + `services/user_sessions.js`; auth/admin/profile/push/deactivate/reject/erasure rewired; refresh honours `tokens_valid_after`; refresh tokens carry `jti`. **users.refresh_token / users.push_token stop being authoritative at this deploy** — they remain a transition mirror only (rollback safety + pre-cutover clients), to be dropped by a later migration |
| C1 acceptance test | DONE (hermetic, real routers) | device A + device B signed in → both refresh independently; sign out A → B still refreshes; sid + rotation + legacy-adoption all pinned. The web-portal half holds by construction: portal sessions are cookie-based and none of the C1 writes touch cookies or the session store |
| C2 doctor auth `/api/v1/doctor/auth/*` | DONE | 12h refresh (pinned: exp−iat = 43200), per-state answers, NO account creation (pinned: zero `INSERT INTO users` + identical before/after count), patient door refuses doctors (`DOCTOR_LOGIN_REQUIRED`), patient refresh serves patients only, OTP limiters SHARED across doors |
| C2 state table | DONE | unknown/patient/staff phone → 403 `NOT_A_DOCTOR` (one answer, no fingerprinting) · pending → 403 `ACCOUNT_PENDING_APPROVAL` · rejected → 403 `ACCOUNT_REJECTED` · deactivated → 403 `ACCOUNT_INACTIVE` · paused → signs in (routing, not lockout) · active → tokens |
| C3 decline + hand-back | DONE | decline = pre-accept via `reassignCase` (+`expectedDoctorId` race guard): no earnings row, no SLA event (`no_main_row` early-return, pinned); hand-back = post-accept: earns zero + SLA event; excused reasons excluded from auto-pause (`doctor_handback:excused%`, plus `doctor_declined%` backstop); portal forms on the case page, server-gated |
| C4 columns | DONE | migration 111: `users.appearance_preference` + `doctor_phrases` (app `DbPhrase` shape verbatim) |
| C5 RLS | DONE | migration 112: the brief's 3 tables PLUS `doctor_sla_events` (Batch B's 109 missed its opt-in — live pg_class check: exactly these 4 uncovered; after 110–112 the count of RLS-disabled public tables is 0) |
| Prod dry-run 110–112 | DONE | BEGIN…ROLLBACK via Supabase MCP: clean; 6 legacy sessions seeded (5 with push), appearance column lands, 0 RLS-disabled tables remain. Migrations apply for real on the next Render deploy per src/db.js |
| Spec review | DONE | docs/reviews/batch-c-2026-09-22/spec-review.md — 0 BLOCKER / 2 MAJOR / 5 MINOR / 6 NOTE; all items COVERED |
| Adversarial review | DONE | docs/reviews/batch-c-2026-09-22/adversarial-review.md — 0 BLOCKER / 1 MAJOR / 3 MINOR / 10 NOTE; token-laundering matrix, seed, CSRF, enumeration all verified clean |
| Fix round | DONE | docs/reviews/batch-c-2026-09-22/fix-round.md — every S/X finding dispositioned; 9 fixed, 1 deferred with ticket (session sweep), 1 accepted risk recorded for Ziad (X4 excused-hand-back loop), rest acknowledged |
| Final test run | DONE | 1965 / 11 / 52 — same 11 pre-existing failures as baseline; zero added |

## Things the brief missed (found during the work)

1. **`doctor_sla_events` had no RLS** (Batch B's migration 109 skipped the post-070 per-table opt-in). Added to migration 112 — needs Ziad's nod since it widens C5's letter.
2. **Same-second refresh rotation minted the identical JWT** (same claims + iat ⇒ same string), so "rotation" rotated a token onto itself. Fixed globally with a per-mint `jti` claim.
3. **A password change never ended mobile sessions** — the revocation stamp was only consulted for access tokens; the 30-day refresh token survived and re-minted. Refresh now honours `tokens_valid_after` (sanctioned by C1's wording).
4. **Account erasure would have left session rows** — `user_sessions` added to the deletion sweep.
5. **Deploy caveat for Ziad (adversarial X14):** any doctor who today signs into the PATIENT app will be signed out at cutover (by design — C2). Verify no functional doctor does before deploying.
6. **Accepted risk for Ziad (adversarial X4):** an excused hand-back is exempt from auto-pause on the doctor's own claim; every occurrence is admin-notified and auditable (`doctor_sla_events` reason `doctor_handback:excused:*`), but there is no automated brake. A threshold rule is a cheap future add if abused.
7. **Deferred with ticket:** a sweep for stale live session rows (S7/X9).

## Deploy notes

- Migrations 110→112 apply on Render boot. 110's seed guarantees nobody is signed out by the deploy; a **rollback** after cutover restores exactly pre-C1 single-slot behaviour (the most recently active device stays signed in, others re-authenticate).
- Hand-back is offered only from IN_REVIEW / SLA_BREACH. A case in `rejected_files` (files requested, SLA paused) cannot be handed back — resolve the request or have an operator reassign; this avoids silently carrying a paused clock to the next doctor.
