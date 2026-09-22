# Batch C — fix round (2026-09-22)

Implementer's disposition of every spec-review (S) and adversarial-review (X)
finding. Reviews were taken against commit `2b58b8c81`; several findings were
already fixed in the worktree when the reviews snapshotted (marked ✦) — this
round commits them and adds the rest.

| # | Severity | Finding | Disposition |
|---|---|---|---|
| S1 / X2 | MAJOR / MINOR | Per-phone OTP budget doubled across the two doors (separate limiter instances) | **FIXED** ✦ — limiter instances extracted to `src/middleware/otp_phone_limits.js` and SHARED by both doors: one 60s cooldown / 3-sends / 5-verifies budget per phone, door-independent |
| S2 | MAJOR | Account erasure left `user_sessions` rows (tokens + device names) behind | **FIXED** ✦ — `user_sessions` added to `OPTIONAL_USER_TABLES` in `services/account_deletion.js` (existence-guarded, same transaction) |
| X1 / S4 | MAJOR / MINOR | sid-path logout never cleared the push MIRROR (`users.push_token`), so a signed-out device kept receiving medical pushes (re-opened AUDIT-APP-H6) | **FIXED** — `revokeById` now clears the mirror when it is attributable to the revoked session's own push token OR when the user has no live session left; a still-signed-in other device's mirror registration is untouched. Two new tests pin both halves |
| X3 | MINOR | Decline/hand-back TOCTOU: stale ownership read + `reassignCase` had no expected-current-doctor guard — a racing decline could zero a successor's earnings and write a counted SLA event against them | **FIXED** — `reassignCase` gains an optional `expectedDoctorId` and throws when the case no longer belongs to the asserted doctor; both routes pass it. Structural backstop: `doctor_pause` now also excludes `doctor_declined%` from the 3-in-30 count (a decline must never count, whatever race artefact wrote it) |
| S3 | MINOR | A refresh token rotated away by pre-C1 code in the deploy window stayed redeemable through its seeded legacy row | **FIXED** — `adoptLegacyToken` revokes the user's other live `device_id='legacy'` rows holding a different token (pre-C1 single-slot semantics restored at adoption). Test added |
| S5 | MINOR | The `earnings_writer` half-done-state repair path could stamp a backfilled SLA event with the CALLER's reason (e.g. `doctor_declined:*`) | **FIXED** — the fall-through now reuses the row's stored `reassignment_reason` for the repaired event; a decline can never appear to have written one |
| S6 | MINOR | `ops_push` superadmin recipient count read the mirror column only, disagreeing with the sessions-UNION send path | **FIXED** ✦ — count now runs the same UNION as `notifySuperadmins` |
| X5 | NOTE | `revokeById`/`setPushToken` trusted the sid without a row-ownership clause | **FIXED** — both take the caller's userId and carry `AND ($n::text IS NULL OR user_id = $n)`; every route call site passes `req.user.id` |
| X11 | NOTE | Deactivate/reject left the doctor's mirror push token live | **FIXED** — all three revocation sites (web deactivate, web reject, reject service) also NULL `users.push_token` |
| S7 / X9 | MINOR / NOTE | Live session rows never expire; no cleanup sweep | **DEFERRED** — follow-up ticket: a worker revoking rows with `last_seen_at` older than the refresh TTL. Not a credential risk (expired JWTs fail verification first); affects only fan-out candidate sets and a future devices UI |
| X4 | MINOR | Excused hand-back is an unmetered accept→read-record→hand-back loop (the doctor's own claim opts out of the pause counter) | **ACCEPTED RISK — Ziad decision recorded**: this is the brief's own trade ("a legitimate hand-back must not auto-pause good consultants"). Every hand-back notifies admins with the excused flag and writes an auditable `doctor_sla_events` row with reason `doctor_handback:excused:<cat>`, so the data for a future brake (e.g. excused-count ≥ N in 30d → flag for human review) already accumulates. Building that brake would be new policy — out of Batch C scope |
| S8 | NOTE | Migration 112 covers a 4th table (doctor_sla_events) the spec didn't name | ACKNOWLEDGED — deliberate: live pg_class check showed exactly 4 uncovered tables; 109 (Batch B, last week) missed its RLS opt-in. Flagged in the report for Ziad's sign-off |
| S9 | NOTE | A rollback keeps only the most recent device signed in | ACKNOWLEDGED — the best a single-slot mirror can offer; identical to pre-C1 behaviour; in the deploy notes |
| S10 | NOTE | Patient refresh now enforces `tokens_valid_after` (patient-visible change) | ACKNOWLEDGED — sanctioned by C1's "the existing revocation stamp must still be honoured"; closes a stolen-device hole (password change now ends mobile sessions) |
| S11 | NOTE | Progress ledger lagged the code | RESOLVED — docs and code land in this same commit |
| S12 | NOTE | `ACCOUNT_REJECTED` ordering if a row had `pending_approval=true` AND `rejection_reason` | NO ACTION — both reject paths clear `pending_approval` in the same statement; no such row can be produced by the code; both answers are 403 dead-ends with support copy |
| S13 / X6–X8, X10, X12–X14 | NOTE | Confirmations (token-laundering matrix clean, seed safe, CSRF correct, enumeration oracles all post-OTP, field clients shape-identical) and pre-existing shapes | NO ACTION — X14's deploy caveat recorded for Ziad: confirm no functional doctor signs into the PATIENT app before deploy (their patient-door session dies at C2 cutover, by design) |

After the round: targeted suites 23/23 (auth) + 16/16 (structure); full suite
re-run recorded in `docs/BATCH_C_PROGRESS.md`.
