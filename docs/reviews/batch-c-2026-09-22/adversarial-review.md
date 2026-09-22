# Batch C Part 1 — Independent Adversarial Review (Authentication)

**Reviewer:** independent adversarial pass, 2026-09-22
**Scope:** commit `2b58b8c81` on `feat/doctor-access-and-api` (worktree `/Users/ziadelwahsh/tashkheesa-batchc`), read-only.
**Method:** full diff read; line-level trace of every refresh/logout/push/revocation path across `src/services/user_sessions.js`, `src/middleware/requireJWT.js`, `src/routes/api/auth.js`, `src/routes/api/doctor_auth.js`, `src/routes/api/admin.js`, `src/routes/api/profile.js`, `src/middleware/push.js`, `src/routes/doctor.js`, `src/case_lifecycle.js`, `src/services/earnings_writer.js`, `src/services/doctor_pause.js`, `src/services/access_revocation.js`, `src/middleware/csrf.js`, `src/auth.js`, migrations 110–112; hermetic test runs:

```
env DATABASE_URL= JWT_SECRET=x node tests/auth/batch-c-sessions-and-doctor-door.test.js   → all green (20 lines of ✅)
env DATABASE_URL= JWT_SECRET=x node tests/core/batch-c-decline-handback-structure.test.js → all green
```

**Verdict: 0 BLOCKER, 1 MAJOR, 3 MINOR, 10 NOTE.** The token-laundering, session-fixation, enumeration and CSRF surfaces are clean. The one MAJOR is a push-notification regression in the sid-path logout (mirror `users.push_token` is never cleared), which re-opens the AUDIT-APP-H6 defect for the transition window.

---

## Findings

### X1 — MAJOR — Sign-out no longer stops push to the signed-out device (mirror `push_token` survives sid-path logout)

**Where:** `src/routes/api/auth.js` `/logout` (and `doctor_auth.js` `/logout`), `src/services/user_sessions.js#revokeById`, `src/middleware/push.js#_liveTokensForUser`.

**Trace.** The old logout cleared `users.push_token` unconditionally (AUDIT-APP-H6: a signed-out device must stop receiving that patient's case/report pushes). The new logout branches:

- sid-less token → `revokeLegacyForUser` + `UPDATE users SET refresh_token = NULL, push_token = NULL` — old behaviour kept. ✔
- **sid token → `revokeById(sid)` only.** `revokeById` clears the mirror `refresh_token` when it matches the row's, but never touches `users.push_token`.

The send path (`_liveTokensForUser` / `livePushTokensForUser`) is the UNION of live session rows **plus `users.push_token`**. Migration 110's era leaves `users.push_token` populated for every existing user (the seed copies it into the legacy row but does not clear the column, by design), and the post-C1 registration paths (`profile.js` POST /push-token, `admin.js` /push-token) write ONLY the session row when a sid is present — they never refresh or clear the mirror.

**Attack/failure scenario (no attacker needed):** a patient whose device registered push before this deploy (i.e. every current device) updates the app, signs in (new sid session), later signs out on a shared/sold/returned phone via `POST /auth/logout`. The session row is revoked, but `users.push_token` still holds that device's stable Expo token, so `sendPushNotification` keeps delivering case/report notifications to the signed-out device indefinitely — medical information to a device the patient explicitly signed out of. The same shape applies to a signed-out Command device and superadmin worker alerts (the exact incident the admin push-token comment recounts), and to a signed-out doctor device once the doctor app ships.

**Mitigation that may exist:** if the app calls `DELETE /profile/push-token` on logout (that route clears the mirror unconditionally), the gap closes for the patient app. That is a client-behaviour assumption the server should not rely on; the pre-C1 server enforced it itself.

**Fix (small):** in `revokeById`, clear `users.push_token` where it equals the revoked session row's `push_token` (mirror-symmetric to the existing `refresh_token` clear), and/or in both sid-path logouts also run `UPDATE users SET push_token = NULL WHERE id = $1 AND push_token = (SELECT push_token FROM user_sessions WHERE id = $sid)`. Related: X11 (deactivate/reject also leave the mirror push token live).

### X2 — MINOR — Per-phone SMS budget doubled by the second door (and the limiter-key `+` variant is duplicated into it)

**Where:** `src/routes/api/doctor_auth.js` limiters vs `src/routes/api/auth.js` limiters (separate `express-rate-limit` instances, separate counters).

Confirmed caps per door per phone: 1 send/60s, 3 sends/15min, 5 verifies/15min. The doctor door duplicates these as **independent counters**, so a victim phone can now be sent 3 (patient door) + 3 (doctor door) = **6 SMS per 15 min** from the API alone — plus the web door's own 3 (`routes/auth.js`), i.e. up to 9/15min and ~2–3 SMS/minute sustained by alternating doors. Each is also a billable Twilio Verify request. This is a deliberate "surfaces stay independent" duplication, but the SMS-bombing/cost analysis in AUDIT-P0-8 was computed for one door; the aggregate ceiling has silently grown.

Additionally, both doors key the limiter on `cc.replace(/[^0-9+]/g,'') + digits` — `'+20'` and `'20'` produce different keys for what may be the same deliverable destination, so the per-door cap can potentially be doubled again by varying the `+`. Pre-existing in the patient door; copied verbatim into the new one. Suggest a shared keyer that strips to digits, and/or a single shared per-phone store across the three doors.

Verify-attempt budget for guessing a 6-digit code is now 5+5(+5 web) per 15 min per phone — still negligible odds (≈15/900k per window); fine.

### X3 — MINOR — Decline/hand-back TOCTOU: ownership and accept-state are checked from a stale read; `reassignCase` has no expected-current-doctor guard

**Where:** `src/routes/doctor.js` decline/handback handlers; `src/case_lifecycle.js#reassignCase`.

The routes read `orders_active`, check `doctor_id === me`, `accepted_at`, and status, then `await findNextAvailableDoctor(...)` and `await reassignCase(...)` — several round-trips later. `reassignCase` re-reads the case but validates only status ∈ {ASSIGNED, IN_REVIEW, SLA_BREACH, REASSIGNED} and `newDoctorId !== current doctor`; it does **not** verify the case still belongs to the caller, or that the accept-state still matches the action.

Consequences, all requiring a millisecond-scale interleaving:

1. **Decline racing the acceptance-timeout worker (or an admin reassign) that moved the case to doctor B, and B's accept:** A's late `reassignCase` re-reads doctor_id = B in an allowed status and moves the case away — zeroing **B's** just-written earnings row and recording a `doctor_sla_events` row against B (`markReassignedOnReassignment(originalDoctorId=B,…)`), with reason `doctor_declined:*`, which is **not** excluded from the 3-in-30 pause count. Without B's accept, the earnings layer's `no_main_row` early-return limits the damage to case churn.
2. **A doctor's own decline racing their own accept:** the decline the UI promised as "never affects your earnings or your record" lands post-accept, zeroes their new earnings row and writes a counted SLA event. Self-inflicted only.

The money backstops that DO hold: `already_paid` and `already_completed` guards (under FOR UPDATE) mean a **delivered** case can never be clawed this way, and double-submit of the same decline is caught by the route's re-read. The route handlers surface the "already assigned to this doctor" throw as a plain failure, which is correct.

**Fix direction:** pass the expected current doctor into `reassignCase` (WHERE doctor_id = $expected on the transition/UPDATE, or a re-check after `getCase`), and either exclude `doctor_declined:%` from the pause count or (better) make the guard structural. Same defect class the AUDIT-2026-08-22 note inside `reassignCase` already describes for the admin path.

### X4 — MINOR — Excused hand-back is an unmetered loop: accept → read the full record → hand back, at zero automated cost

**Where:** `src/routes/doctor.js` handback + `src/services/doctor_pause.js` exclusion.

A doctor can accept a case (which unblurs the full patient record), then hand it back with `on_leave` / `wrong_subspecialty` / `conflict_of_interest`. The stamped reason `doctor_handback:excused:<cat>` is excluded from the 3-in-30 auto-pause, and nothing else meters it. Abuse cost per cycle: the doctor earns zero for that case (`markReassignedOnReassignment`), an admin notification fires (deduped per (order, doctor) — repeats on the same case notify once), an order event and a `doctor_sla_events` row are written (audit trail exists), and the patient gets a "reassigned" email plus delay. There is **no automatic brake**: a doctor can cycle through their specialty's queue reading records, or dump every case they dislike, indefinitely, as long as they always tick an excused reason — the reason is free-text-free (allowlisted) but unverified.

This is a policy trade the commit makes consciously (excused = "doing the right thing early"), and admins are notified each time, so MINOR not MAJOR — but state the residual: the pause counter, the one automated reliability brake, is opt-out-able by the doctor's own claim. Cheap hardening: count `excused` hand-backs at a higher threshold (e.g. 6-in-30), or auto-flag a doctor whose excused count crosses N for human review.

### X5 — NOTE — `revokeById` / `setPushToken` trust the sid without checking row ownership (safe today; add the WHERE)

`sid` reaches these only from a **signed** JWT, and the server mints a sid exclusively into tokens for the user the session row was just created for; session ids are `sess-<uuid>` (unguessable, never reused), and the seeded `sess-legacy-<userId>` ids, while predictable, never appear in any attacker-obtainable JWT they don't already own. So user A cannot revoke B's session or write push tokens into B's row — every ordering checked. But the invariant lives entirely in the mint sites; `revokeById(sessionId)` and `setPushToken(sessionId, …)` would silently act cross-user if any future mint site got it wrong. Defense-in-depth: add `AND user_id = $callerId` to both UPDATEs (callers all have `req.user.id` in hand).

### X6 — NOTE — Patient `/refresh` legacy fallback has no role filter, but the later role check closes it in every ordering

`SELECT * FROM users WHERE id = $1 AND refresh_token = $2` (no role filter) → `adoptLegacyToken` → then `role !== 'patient'` → `revokeById` + `REFRESH_REVOKED`. Traced for a doctor row and a superadmin row: no tokens are minted before the role gate in any path, so nothing launders. Side effects only: a non-patient legacy token presented here gets adopted into a session row and immediately revoked (junk audit row), and the mirror column is nulled — i.e. whoever *possesses* a non-patient legacy token can burn it at this door, which is revocation, not escalation (deliberate per the "wrong door" comment). The seeded-row case short-circuits earlier: `findLiveByToken` finds the seeded row, so the fallback rarely runs. Admin refresh's legacy fallback DOES filter `role='superadmin'`; the doctor refresh has no fallback at all (correct — no pre-C2 token is legitimately a doctor-door token).

### X7 — NOTE — Token-laundering matrix: verified clean; wrong-door presentation burns the session (asymmetric at the admin door)

Every cell traced (and the hermetic tests cover the two dangerous ones):

| presented at → | patient /auth/refresh | /doctor/auth/refresh | /admin/auth/refresh |
|---|---|---|---|
| patient token (30d) | rotates, 30d, role patient ✔ | REFRESH_REVOKED + session revoked | REFRESH_REVOKED (session NOT revoked) |
| doctor token (12h) | REFRESH_REVOKED + session revoked (no 30d re-mint) | rotates, 12h ✔ | REFRESH_REVOKED |
| superadmin token (12h) | REFRESH_REVOKED + session revoked | REFRESH_REVOKED + session revoked | rotates, 12h ✔ |
| legacy sid-less mirror token | adopted then role-gated (X6) | no fallback → REFRESH_REVOKED | adopted, role-filtered ✔ |
| access token as refresh | `verifyRefreshToken` rejects (`type !== 'refresh'`) at all three | | |
| refresh token as access | no `role` claim → every `requireRole` refuses (see X10) | | |

Role-change edge: if an admin flips a user doctor→patient, that user's live doctor-door session refreshes successfully at the **patient** door (role check reads the current row) and re-mints as a 30-day patient pair — correct for the new role, noted for completeness. The admin door not revoking a wrong-role session (it just 401s) is a harmless asymmetry.

### X8 — NOTE — Migration 110 seed: collisions, idempotence, RLS ordering all safe; duplicate mirror tokens fail closed

- `'sess-legacy-' || u.id` — unique by users PK; no id collision possible.
- Two users somehow sharing one `refresh_token` string (only possible via a row-copy anomaly; JWTs embed the user id so normal operation can't produce it): the second seed INSERT hits the unique token index → `ON CONFLICT DO NOTHING` skips it. That user's device then refreshes: mirror matches, `adoptLegacyToken` conflicts, `findLiveByToken` returns the *other* user's row, `session.user_id !== decoded.id` → REFRESH_REVOKED. Fail-closed, one forced re-login, no cross-user auth. The prod dry-run seeded 6 rows cleanly.
- Re-run idempotence: targetless `ON CONFLICT DO NOTHING` arbitrates on **any** unique constraint (PK or token index), so a re-boot re-run is a no-op even after rotations.
- `ENABLE ROW LEVEL SECURITY` after the seed in the same transaction: fine — the migration runner and the app both connect as the rolbypassrls owner; RLS default-deny binds only anon/authenticated from commit onward.

### X9 — NOTE — `createSession` INSERT has no ON CONFLICT (500 on token collision — negligible under jti) and session rows never expire

A duplicate `refresh_token` at INSERT would throw → sign-in 500s; no ambiguous state (nothing partial: the mirror write follows the INSERT). With `jti: randomUUID()` on every mint, collision probability is cryptographically negligible; the jti fix also genuinely closes the same-second self-rotation bug (verified: claims now always differ). Remaining non-uniqueness is only `(user_id, device_id)` when the client sends no deviceId — rows accumulate one per sign-in, and revoked rows are kept forever by design. No TTL/sweeper exists; token expiry is enforced at the JWT layer (`jwt.verify` exp), so stale rows are inert but unbounded. Consider a periodic sweep of `revoked_at < NOW() - 60d` and legacy rows whose token JWT has expired.

### X10 — NOTE — Refresh tokens pass `requireJWT` as Bearer at role-ungated endpoints (pre-existing shape)

A refresh token is a valid signed JWT, so it authenticates at endpoints using `requireJWT` without a role gate: `/api/v1/auth/me` (returns the subject's own sanitized row) and the two logouts (revoke the token's own session). No role claim means `requireRole('patient'|'superadmin')` refuses it everywhere else, and the portal's `requireRole` refuses the empty role too. Impact is limited to the subject's own account; unchanged by this batch but the batch adds one more such endpoint (doctor logout). A `type === 'refresh'` rejection inside `requireJWT` would close it outright.

### X11 — NOTE — Revocation completeness after deactivate / reject / password change: refresh + access are fully dead; the push mirror is not

Verified for all three paths:
- **Sessions:** deactivate (`superadmin.js:4271` block), reject (route + `admin_doctor_reject.js`, the latter inside the rejection transaction) all `UPDATE user_sessions SET revoked_at = NOW()` — every device's refresh dies at the row.
- **Mirror refresh:** `refresh_token = NULL` in the same statements.
- **Access tokens (15m) and any surviving refresh JWT:** `tokens_valid_after` is stamped by all three (`superadmin.js:4271`, `:4935`, `admin_doctor_reject.js:77`); `requireJWT`, `attachUser`, and now **both refresh endpoints** consult `isTokenStale`. The cache is fail-open with a 60s TTL — a revoked account can hold on for up to ~60s plus one request, or longer only while the DB is unreachable (in which case refresh itself can't run either, so the fail-open window is effectively the cache-query-failure case only). Accepted, documented design.
- **Gap:** `users.push_token` is not cleared on deactivate/reject, and the revoked sessions' push tokens drop out of the union but the mirror doesn't — a deactivated doctor's device keeps receiving whatever pushes still target them (e.g. the reassignment notification itself). Same root as X1; the X1 fix should sweep this too.

### X12 — NOTE — Enumeration oracles: all doctor-door answers are post-OTP; no pre-verify oracle exists

`/doctor/auth/otp/request` behaves byte-identically for every well-formed phone (send + generic message), so someone who does NOT control a phone learns nothing (they can only ever see INVALID_OTP / RATE_LIMITED). Post-OTP — i.e. to someone who **does** control the phone — the doctor door distinguishes: NOT_A_DOCTOR (uniform for unknown/patient/staff — verified the staff and patient cases fall into the same `!user` branch because the resolver is role-gated to `doctor`), PHONE_AMBIGUOUS, and the three own-state answers. All of that is information about the caller's own number; acceptable and intended. The patient door's new DOCTOR_LOGIN_REQUIRED is likewise post-OTP only. Cross-door note: OTP state (Twilio Verify / `otp_codes`) is keyed per phone and shared, so a code requested at one door verifies at the other — harmless (same proof of control), but it's why the send caps in X2 aggregate.

### X13 — NOTE — CSRF posture confirmed on both sides

- The new portal POSTs `/portal/doctor/case/:id/decline` and `/handback` match **no** exemption in `src/middleware/csrf.js` (not `/api/v1`, not the enumerated paths), so the double-submit check enforces in prod; both new forms render `csrfField()`. ✔
- `/api/v1/doctor/auth/*` rides the blanket `/api/v1` exemption. Nothing cookie-authed reaches it: the OTP endpoints are credential-proving by construction, and `requireJWT` (logout) reads only the `Authorization` header — no cookie fallback — so an ambient-credential cross-site POST can neither authenticate nor prove a phone. ✔ (Contrast: the portal's `attachUser` DOES fall back to cookies, which is exactly why the portal routes stay inside CSRF.)

### X14 — NOTE — Field-client compatibility: patient app and Command are shape-identical; doctors-via-patient-door is the one deliberate break

Enumerated every request today's clients send:
- **Patient app** — register/login/otp/verify: same response envelope (`user`, `accessToken`, `refreshToken`); tokens now carry `sid`/`jti`, which clients treat as opaque. `/refresh` with a field token: matched by the seeded legacy row (or adopted from the mirror in the deploy window) → rotates as before; error codes unchanged (REFRESH_REVOKED). `/logout` with a sid-less field token: exact pre-C1 behaviour (legacy rows + both mirror columns cleared). `/auth/me`, push register/delete: unchanged shapes. Strictly compatible — the only behavioural change is the *improvement* (second device no longer kills the first) and X1.
- **Command app** — login/refresh keep the envelope and the mustGet 500-vs-401 discipline (`REFRESH_UNAVAILABLE` on DB blips is preserved through the new session lookups — verified both try/catch wrappers); push-token register/clear unchanged shapes with the sid upgrade.
- **Doctors who sign in through the patient app/door** — deliberately broken: OTP verify now answers 403 DOCTOR_LOGIN_REQUIRED and their existing 30-day refresh tokens answer REFRESH_REVOKED (session burned). This is the C2 cutover working as specified, but it is the one change that logs a live population out with no grace path until the doctor app ships. Confirm before deploy that no functional doctor (Medhat/Ghoneim) currently relies on the patient app; the web portal is untouched either way.

---

## Direct answers to the review questions

- **Token laundering:** none found; full matrix in X7. Lifetimes can only shrink or stay equal across doors; role checks precede every mint; legacy fallbacks are role-closed (X6).
- **Session fixation / cross-user:** no path creates or adopts a row whose token and user_id disagree with the presenting JWT's subject; sid is unforgeable and per-owner (X5, X8). Ownership WHERE-clauses recommended as hardening only.
- **Revocation completeness:** complete for refresh + access within the 60s cache TTL; push mirror is the gap (X1/X11).
- **Unique index / createSession:** 500-not-ambiguity on the impossible collision; jti is the load-bearing randomizer; seed is idempotent and fail-closed (X8, X9).
- **OTP doors:** SMS budget doubled (X2); enumeration requires phone control everywhere (X12).
- **C3:** cannot decline/hand back an unowned or completed case through the front door; the TOCTOU (X3) and the excused-loop economics (X4) are the residual risks; decline leaks nothing beyond a nameless "case reassigned" patient email, and the decliner-notification/pause paths correctly skip on `no_main_row`.
- **CSRF:** covered/exempt exactly as intended (X13).
- **Field clients:** unchanged or strictly better, except the intended doctor cutover (X14).

## Summary counts

| Severity | Count | IDs |
|---|---|---|
| BLOCKER | 0 | — |
| MAJOR | 1 | X1 |
| MINOR | 3 | X2, X3, X4 |
| NOTE | 10 | X5–X14 |

Recommended before merge: fix X1 (a few lines in `revokeById` + both sid logouts). X2–X4 can ship with tickets; X5/X10/X11's hardenings are cheap adds to the same files while they're open.
