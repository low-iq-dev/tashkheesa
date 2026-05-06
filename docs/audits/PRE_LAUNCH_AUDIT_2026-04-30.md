# Pre-Launch Final Audit — Tashkheesa Portal

**Date:** 2026-04-30
**Auditor:** Claude Opus 4.7 (1M context), interactive
**Working tree HEAD:** `ebbfd51` (matches prod `/__version` git_sha = `ebbfd51ff6570c7483eea434a82b0b9e7ec88769`)
**Branch:** `main`
**Methodology:** static code review + production curl probes against `https://tashkheesa.com` + read-only SQL against production Supabase.

---

## Phase 0 — environment + ground rules

### Production database (GR-DB-1)

- `DATABASE_URL` in `.env.production` resolves to **Supabase pooler** at `aws-1-us-east-1.pooler.supabase.com:6543`, project ref `wvmhliweujmhlzknmuzh` (matches the canonical project ref recorded in GR-DB-1; the pooler is the standard PgBouncer endpoint that fronts the same `postgres.wvmhliweujmhlzknmuzh.supabase.co` direct host — same database, different access path).
- All SQL claims below are tagged **VERIFIED-prod** when executed against this hostname; the connection result echoed `current_database=postgres`, `current_user=postgres`, `server_version=17.6`.
- 33 migrations applied on prod (`schema_migrations` table). All today's fixes (024 `blocked_send_attempts`, 025 `email_campaigns_approval`, 026 `addon_commission_fix`, 027 `urgency_multipliers`, 028 `refunds`, 030 `urgency_uplift_amount`, 031 `canonicalize_urgency_tier_vip`, 032 `orders_paid_at`) are present.
- **Migration numbering anomaly:** files `020_orders_paid_at.sql` and `032_orders_paid_at.sql` both exist in `src/migrations/` and **both** have a row in `schema_migrations` (id 18 + 33). `orders.paid_at` exists exactly once (`information_schema.columns` count = 1). 020 was an earlier attempt that was either rolled back or `IF NOT EXISTS`-guarded; 032 is the canonical fix landed today. **No production harm**, but two files for the same column is bad hygiene — keep 032 and delete 020 (or convert to a no-op marker). There is **no migration 029** in the file tree (gap between 028 and 030); cosmetic.

### Production state

| | Value | Source |
|---|---|---|
| Mode | `production` | `/__version` |
| SLA worker | `slaMode=primary` | `/__version` |
| Uptime at audit start | 1,747 s (~29 min) | `/__version` |
| Active doctors | **1** | `users WHERE role='doctor' AND is_active`; pending=0 |
| Patients | 8 (mostly seed) | `users WHERE role='patient'` |
| Orders total | **3** (2 expired_unpaid, 1 cancelled) | `orders` |
| Paid orders ever | **0** | `orders WHERE payment_status='paid'` |
| `doctor_earnings` rows | **0** | `doctor_earnings` |
| `addon_earnings` rows | **0** | `addon_earnings` |
| `order_addons` rows | **0** | `order_addons` |
| `refunds` rows | **0** | `refunds` |

> **Implication:** the entire payment / earnings / refund / addon pipeline has **never been exercised in production**. Launch day will run real money through code paths that have, in production, only ever returned 0 rows. This is the main reason the P0s below matter — every one of them is a latent bug that will surface on the first paid order.

### Ground-rule application

Every finding below tags evidence as:
- **VERIFIED-prod** — direct SQL against Supabase or direct curl against `tashkheesa.com` (cite the response).
- **VERIFIED-code** — explicit code+behavior trace at `file:line`.
- **INFERRED** — read from code, reasoned conclusion (cannot prove without runtime exercise).
- **UNVERIFIED** — needs runtime access or a test transaction the audit didn't have.

GR-FINANCIAL-1 (catalog blast-radius) — applied: any pricing-data finding has its production blast-radius noted (almost universally **0 affected paid orders** because there are none).

---

## Section 0 — coverage checklist

This is the surface map I walked. Each row's last column is what I actually did.

### A. Public/marketing
| Surface | Verdict | Evidence |
|---|---|---|
| `/` (homepage) | OK | curl 200; CSP+CSRF+HSTS headers tight |
| `/about` | OK | curl 200 |
| `/contact` | OK | curl 200 |
| `/services` | OK | curl 200 |
| `/privacy`, `/terms` | OK | curl 200 |
| `/how-it-works` | OK (anchor) | curl redirects to `/#how-it-works` |
| `/specialties` | **404** | curl 404 — see P1-PUB-1 |
| `/blog` | **404** | curl 404 — see P1-PUB-1 |
| `/faq` | **404** | curl 404 — see P1-PUB-1 |
| `/help-me-choose` | OK with bad CTA | curl 200; submit URL → /order/start (dead) — P1-PUB-2 |
| `/order/start` | broken-by-design | renders coming_soon — P1-PUB-3 |
| `/coming-soon` | OK | renders coming_soon |
| `/healthz`, `/__version` | OK | both return JSON |
| Language toggle (`/lang/ar`, `/lang/en`) | UNVERIFIED — code-only | not curl-exercised; legacy April finding 9.4 (`/lang/ar` redirects unauth to `/login`) re-flag below |

### B. Auth flows
| Surface | Verdict | Evidence |
|---|---|---|
| GET `/login` | OK | curl 200; csrf_token + lang cookies set |
| POST `/login` (success/fail) | INFERRED OK | code trace `auth.js:197-266` — proper error copy, role-based redirect, `pending_approval` gate, locked-account gate |
| GET `/register` | OK | curl 200 |
| POST `/register` | INFERRED OK | `auth.js:559-650` — country whitelist, email-exists check, welcome email queued, redirect to onboarding |
| GET `/forgot-password` | OK | curl 200 |
| POST `/forgot-password` (portal) | INFERRED OK after today's fix | `auth.js:280-329` — sendEmail wired ✓, but **patient-only filter** — see P1-AUTH-1 |
| POST `/api/v1/auth/forgot-password` (mobile) | INFERRED OK after today's fix | `api/auth.js:271-314` — uses `password_reset_tokens` ✓ |
| POST `/api/v1/auth/reset-password` (mobile) | **BROKEN** | `api/auth.js:327-338` queries `users.reset_token` which is no longer written — see P0-AUTH-1 |
| GET/POST `/reset-password/:token` | INFERRED OK | `auth.js:457-543`, validates token, marks used_at |
| GET/POST `/set-password` | INFERRED OK | `auth.js:391-451`, requires session, gates on `password_hash IS NULL` |
| GET/POST `/logout` | INFERRED OK | `auth.js:787-798`, clears session cookie |
| GET `/doctor/login`, `/doctor/signup` | OK | curl 200 |
| POST `/doctor/signup` | INFERRED OK | `auth.js:692-775`, sets `pending_approval=true`, queues internal notification |
| Forgot-password for doctors | **No path** | `auth.js:283` filters `role='patient'` — see P1-AUTH-1 |

### C. Patient case intake (post-login wizard)
| Surface | Verdict | Evidence |
|---|---|---|
| GET `/patient/new-case` (step 1-5) | OK code | `patient.js:1126-1300` — 5-step wizard, requires `role='patient'` |
| POST `/patient/new-case/step1` (condition) | OK code | `patient.js:1331-1392` |
| POST `/patient/new-case/step2` (documents) | OK code | `patient.js:1399-1426` — file count guard |
| POST `/patient/new-case/step3` (specialty/service) | OK code | `patient.js:1432-1476`, validates specialty + service-belongs-to-specialty |
| POST `/patient/new-case/step4` (review/SLA) | partial | `patient.js:1481-1508` — see P1-PATIENT-1 (urgency tier never offered, SLA always 72h) |
| POST `/patient/new-case/step5` (pay) | INFERRED OK | `patient.js:1517-1551`; live mode resolves Paymob URL via `getOrCreatePaymentUrl`, stub mode bounces to `/payment-success?stub=1` |
| GET `/portal/patient/payment-return` | INFERRED OK | `patient.js:1564-1594`, ownership-gated, status-mapped |
| GET `/portal/patient/orders/:id/payment-success` | INFERRED OK in stub, **broken in live** if webhook 403'd | `patient.js:1605-1683` — see P0-PAY-1 |
| Paymob webhook POST `/payments/callback` | **BROKEN** | curl returns 403 (CSRF middleware blocks before HMAC) — see P0-PAY-1 |
| Old `/order/start` legacy flow | broken-by-design | `order_flow.js:115-117` hard-renders coming_soon |
| `service_assistant` / help-me-choose | broken CTA | submits to `/order/start` → coming_soon |

### D. Patient post-payment + dashboard
| Surface | Verdict | Evidence |
|---|---|---|
| `/dashboard` (auth-gated) | UNVERIFIED — no session | curl unauth → redirects to `/login?next=/dashboard` ✓ |
| Patient dashboard CTAs | OK code | `patient_dashboard.ejs:375` "Start my case" → `/patient/new-case` ✓ |
| Patient prescriptions, records, referrals, reviews | UNVERIFIED — auth-gated | code-only review of routes; `.bak` siblings exist (P2-CLEANUP-1) |

### E. Doctor portal
| Surface | Verdict | Evidence |
|---|---|---|
| GET `/portal/doctor/today`/dashboard | INFERRED OK | `doctor.js:127`, queries `orders WHERE doctor_id=?` |
| GET `/portal/doctor/queue`, `/cases`, `/completed` | INFERRED OK | `doctor.js:455-557` |
| GET `/portal/doctor/case/:id` (case detail) | UNVERIFIED — auth-gated | `doctor.js:1205` |
| POST `/portal/doctor/case/:id/accept` | INFERRED OK | `doctor.js:1540` |
| POST `/portal/doctor/case/:id/diagnosis` | INFERRED OK | `doctor.js:1817` |
| POST `/portal/doctor/case/:id/report` (deliver) | INFERRED PARTIAL | `doctor.js:1894` — handler does NOT write `doctor_earnings` for main case — see P0-FIN-1 |
| GET `/portal/doctor/messages` | ✅ RESOLVED 2026-05-05 | `doctor.js:819` 301 → `/portal/messages` (shared inbox); see P1-DOC-1 |
| GET `/portal/doctor/earnings` | ✅ RESOLVED 2026-05-02 (commit `8507b51`) | Lifetime tiles + 24-month statement reading `doctor_earnings` + `addon_earnings`. Reassigned-status surfacing added 2026-05-05 follow-up; see P1-DOC-2 |
| GET `/portal/doctor/profile` | INFERRED OK | `doctor.js:1918` |
| Doctor reviews received | INFERRED OK | `doctor_reviews.ejs` exists |
| Doctor signup → admin approval flow | INFERRED OK | `auth.js:692-775` queues internal notify; `superadmin.js:2088` approves |

### F. Pipelines
| Pipeline | Verdict | Evidence |
|---|---|---|
| Email transport (Resend) | OK | `services/emailService.js`; SDK adapter shape preserved; recipientGuard wrapped — see INFO-EMAIL-1 |
| Email templates EN+AR coverage | OK structurally | both `templates/email/{en,ar}/` have all 20 same-name `.hbs` files; bilingual lifecycle wrappers (`notifyCaseReceived` etc.) are EN-hardcoded — see P1-NOTIF-1 |
| In-app notifications (`notifications` table) | OK schema | `notifications` table has both legacy (`template,status,at,response`) and new (`type,title,message,is_read,data`) columns — schema is mixed |
| Notification friendly-title mapping | UNVERIFIED | did not enumerate all event templates against translator map |
| Doctor earnings ledger (main case) | **BROKEN** | no `INSERT INTO doctor_earnings` exists for main-case completion path — see P0-FIN-1 |
| Doctor earnings ledger (video addon) | OK code | `routes/video.js:805,988`, `video_scheduler.js:128` — but production rows = 0 |
| Doctor earnings ledger (prescription/video addons V2) | OK code | `services/addons/video_consult.js:73`, `prescription.js:87` write `addon_earnings` — but rows = 0 |
| Addon V1+V2 dual-write | OK code | `routes/payments.js:237-292` calls `safeDualWrite('video_consult'/'prescription', 'onPurchase', ...)` after V1 path |
| SLA enforcement | INFERRED OK | `case_sla_worker.js` sweeps; `services/sla_breach.js` issues refunds; SLA_MODE=primary on prod |
| SLA breach refund (refunds uplift only, recompute earnings) | UNVERIFIED | no breached cases in prod to verify; pure-function `services/earnings_calc.js` exists but **call sites = 0 outside tests** — see P0-FIN-1 |

### G. Admin / superadmin / ops (mutation surfaces)
| Surface | Verdict | Evidence |
|---|---|---|
| `/superadmin` (auth-gated) | OK | curl unauth → `/login?next=/superadmin` |
| Mark-paid manual (superadmin/admin) | INFERRED OK | `superadmin.js:2223`, `admin.js:1429` — should be tested with a real order on launch day |
| Reassign / cancel / extend-SLA | INFERRED OK | `superadmin.js:2476/2535/2582` |
| Doctor approve/reject | INFERRED OK | `superadmin.js:2088/2115` |
| `/superadmin/doctors/new` (create doctor) | **VULN** | `superadmin.js:1974` `console.log` of generated temp password — see P0-SEC-1 |
| Pricing catalog edits | OK code | `admin.js:2416/2471` — VIP/Urgent multipliers + service prices |
| `/ops/login`, `/ops/*` | INFERRED OK | curl `/ops/login` → 200; `requireOpsAuth` middleware on the rest |

---

## P0 — LAUNCH BLOCKERS

### P0-PAY-1 — Paymob webhook `POST /payments/callback` is CSRF-blocked before reaching HMAC verification

**Severity:** P0 — every real payment will silently fail to flip the order to `paid`.
**Surface:** Patient.
**Evidence:** **VERIFIED-prod**.

- Curl `POST https://tashkheesa.com/payments/callback` with empty JSON body → **HTTP 403** (CSRF rejection).
- `src/server.js:655` mounts `app.use('/payments', paymentRoutes)`; `src/routes/payments.js:39` defines `router.post('/callback', …)` — so the actual webhook URL is `/payments/callback`.
- `src/middleware/csrf.js:83` exempts `/callback` (no route at root → 404), `/portal/video/payment/callback` (video-only), and `/payments/webhook` (typo / wrong path) — but **NOT** `/payments/callback`. The webhook falls through to the CSRF token check, which fails because Paymob doesn't send a session cookie or token.
- The patient.js comment `patient.js:1542` confirms intent: *"the webhook (POST /payments/callback) is the source of truth"*.
- Production has 0 paid orders, so this defect has not yet caused harm — but it is the first thing that will break when a real patient pays.

**Symptom on launch day:** patient pays via Paymob iframe, Paymob POSTs to `/payments/callback`, server returns 403. Paymob retries forever. Order stays `payment_status='unpaid'` despite the patient being charged. The patient's browser hits `/portal/patient/orders/:id/payment-success` which re-queries DB, sees `payment_status != 'paid'`, renders the "we're confirming your payment" interim banner that auto-refreshes for ~60s and then suggests WhatsApp support. Lifecycle never advances to `markCasePaid`, doctor is never auto-assigned, no notification fires.

**Proposed fix (1 line):** in `src/middleware/csrf.js:83`, change `p.startsWith('/payments/webhook')` to `p.startsWith('/payments/callback')` (or add `p === '/payments/callback'` to the exempt set). Verify Paymob's webhook URL in the Paymob dashboard matches.

---

### P0-FIN-1 — `computeDoctorEarnings` still unwired (B3 from April audit, still OPEN); main-case `doctor_earnings` ledger never written

**Severity:** P0 (financial integrity at platform-accounting level).
**Surface:** Doctor + Pipeline + Admin.
**Evidence:** **VERIFIED-code** + **VERIFIED-prod**.

- `grep -rn computeDoctorEarnings src/` outside the function file + tests returns **0 results**. The pure function in `src/services/earnings_calc.js:40-68` exists with documented contract and tests, but is called nowhere.
- `INSERT INTO doctor_earnings` exists only at three sites and all are video-addon paths: `src/routes/video.js:805` and `:988` (manual schedule), and `src/video_scheduler.js:128` (auto-create). The main-case completion path (`src/routes/doctor.js:1894` POST `/portal/doctor/case/:caseId/report`, calling `handlePortalDoctorGenerateReport`) does **not** write to `doctor_earnings` at all.
- Production: `doctor_earnings` row count = **0**. So neither the doctor-side dashboard nor the admin "pending payouts" surface (`admin.js:1108`, `superadmin.js:1402-1404`) will ever show a number for main-case revenue.
- Doctor's per-month dashboard stat in `doctor.js:243-244` reads `SUM(orders.doctor_fee) FILTER (WHERE status='completed')` directly — so the doctor *does* see correct fees on the dashboard for their main-case revenue. **The doctor isn't shortchanged.** The break is at the platform-accounting level: pending payouts query returns 0 forever, the V1.5 statements page can't be populated without rewriting history, and SLA-breach earnings recalculation has nowhere to write the corrected row.

**Tagged P0** because: (a) this is the second time it's been flagged (April audit B3 → still OPEN), (b) it's the blocker for the doctor earnings page coming out of "Coming in v1.5" stub, and (c) launch-day pending-payouts dashboard will be obviously wrong to anyone running ops.

**Proposed fix:** wire `computeDoctorEarnings` at three sites per the policy:
1. **At order creation** in `patient.js POST /patient/new-case` (after the orders INSERT) — write a `doctor_earnings` row with `status='pending'`, splitting base / uplift / addon shares.
2. **At main-case completion** in `doctor.js handlePortalDoctorGenerateReport` — flip the existing pending row to `paid` (or write the row if order-creation step was skipped on legacy orders). Use `computeDoctorEarnings({ baseDoctorFee: orders.doctor_fee, upliftAmount: orders.urgency_uplift_amount, addons: order_addons rows })`.
3. **At SLA breach** in `services/sla_breach.js` — recompute with `upliftAmount=0` and update the row.

**Note:** This is mostly a back-end accounting fix. Doctors will not see different numbers. Admin "pending payouts" will start populating.

---

### P1-FIN-2 — Reassignment leaves orphan `doctor_earnings` rows _(known issue, accepted at P0-FIN-1 ship)_

**Severity:** P1 (admin-side over-counting; not user-facing).
**Surface:** Admin pending-payouts dashboard.
**Evidence:** **VERIFIED-code** at P0-FIN-1 implementation time.

When P0-FIN-1's site 1 (acceptance) writes a pending `doctor_earnings` row for the assigned doctor, and the case is later **auto-reassigned on SLA breach** (`case_lifecycle.js:1416`) or via a manual reassignment, the original doctor's pending row is **not** cancelled. When the new doctor accepts, site 1 fires again and writes a second pending row for the same `appointment_id` (the case id). Result: admin "pending payouts" sums over both rows, double-counting the case.

The auto-reassign-on-capacity path at `doctor.js:1591-1611` does **not** trigger acceptance (it just rewrites `orders.doctor_id`), so it doesn't create the duplicate — but it also leaves the original pending row pointing at a doctor who is no longer assigned. Same over-count from a different angle.

**Why accepted now:** the audit's P0-FIN-1 fix is the prerequisite. The orphan condition only manifests on reassignment, which is rare (current prod has zero breached cases). The doctor-side display is unaffected — only the `superadmin.js:1409`/`admin.js:1113` totals are impacted.

**Proposed fix (sketch (a) from P0-FIN-1 review):**
1. Widen the schema-level CHECK on `doctor_earnings.status` to include `'cancelled'` (currently no constraint exists; just text — so this is a code convention, not a migration).
2. In `case_lifecycle.js reassignCase()`, before writing the new `doctor_id`, mark all existing pending main-earnings rows for the case as `status='cancelled'`:
   ```sql
   UPDATE doctor_earnings
      SET status = 'cancelled'
    WHERE appointment_id = $caseId
      AND id LIKE 'earn-main-%'
      AND status = 'pending';
   ```
3. Update the admin/superadmin pending-payouts queries to add `AND status = 'pending'` (already present) — implicitly excludes cancelled.

**Estimated effort:** 30-45 minutes including a regression test that reassigns a paid case mid-flight and asserts the old row goes to `'cancelled'` while the new doctor's row is `'pending'`.

---

### P1-FIN-3 — Tier-based fast-submission bonus structure _(deferred 90d for ops data)_

**Filed:** 2026-05-04 by P3 cleanup batch (PR 1).
**Status:** DEFERRED. Re-evaluate after 90 days of paid-case operating data (target window: 2026-05-04 → 2026-08-04).

**Idea:** layer a tier-based submission-speed bonus onto `computeDoctorEarnings` (P0-FIN-1's pure function). Sketch:
- +10% bonus when `completed_at - accepted_at <= 24h`
- +5% bonus when `completed_at - accepted_at <= 48h`
- 0% otherwise (current behavior)

**Why deferred:** the bonus is an incentive lever, not a defect fix. Modeling its margin impact requires the actual distribution of doctor turnaround times under real workload, not seed data. As of filing prod has 0 paid cases. After ~90 days of ops, we'll have a turnaround histogram from the new "Avg. turnaround (30d)" doctor-dashboard metric (shipped in PR 2 of the same P3 cleanup batch) and the platform-side margin per case.

**Decision criteria (when we revisit):**
- If median doctor turnaround is already < 24h without a bonus, the bonus pays for behavior we'd get for free → don't ship.
- If median turnaround is 30-60h and platform margin tolerates a 5-10% earnings uplift on the fastest cases, ship the tiered structure.
- If turnaround is bimodal (a fast cohort + a slow cohort), consider the bonus as a nudge for the slow cohort rather than a reward for the fast one.

**Inputs required at decision time:**
- `SELECT AVG/p50/p90 (completed_at - accepted_at) FROM orders WHERE status='completed' AND completed_at >= NOW() - INTERVAL '90 days'`
- Per-case platform margin (currently 80% of base price minus payment-processor fees) over the same window.
- Doctor count and case-volume distribution per doctor.

**Cite (at file time):** none yet — pure planning entry. `services/earnings_calc.js:40-68` is the function that would gain the bonus tier.

---

### P0-AUTH-1 — Mobile API `/api/v1/auth/reset-password` reads orphan column

**Status (2026-05-05):** ✅ **RESOLVED** — handler now consumes `password_reset_tokens` (matches portal flow). See `src/routes/api/auth.js:343-415`. Bidirectional interop verified by `tests/auth/reset-password-mobile.test.js` (mobile-issued tokens redeemable by portal endpoint and vice versa). Orphan `users.reset_token` / `users.reset_token_expires` columns left in place — see **P3-AUTH-3** for follow-up cleanup.

**Severity:** P0 if the mobile app calls this endpoint; **P1** if it doesn't (TODO already flagged "no evidence the mobile app currently calls it" — UNVERIFIED).
**Surface:** Mobile API.
**Evidence:** **VERIFIED-code**.

- `src/routes/api/auth.js:327-338` queries `SELECT … FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()` — those columns still exist on the `users` table (verified prod schema), but **no code path writes to them anymore** since today's `forgot-password` fix routed mobile token issuance to `password_reset_tokens`.
- Result: any reset token issued by `POST /api/v1/auth/forgot-password` will never satisfy the SELECT in `POST /api/v1/auth/reset-password`. Every legitimate token returns `INVALID_RESET_TOKEN`.
- Already documented in `TODO.md` as "Stranded, discovered 2026-04-30" and explicitly held back per scope rules. Re-flagging here so it isn't forgotten.

**Symptom:** if a mobile-app build ships a native reset-password screen that calls this endpoint, every password-reset attempt fails. If the mobile app routes users to the portal `/reset-password/:token` link in the email instead (which is the current flow per the TODO), this defect is dormant.

**Proposed fix (per existing TODO):** mirror the portal reset logic — `findValidToken` against `password_reset_tokens`, `UPDATE users SET password_hash` + mark token used. Then drop `users.reset_token` and `users.reset_token_expires` columns (migration 033).

---

### P0-SEC-1 — Superadmin "Create Doctor" leaks generated temp password to stdout

**Status (2026-05-03):** ✅ **RESOLVED** — superseded by token-based password-reset flow.

**Resolution evidence:** `src/routes/superadmin.js:1976-2076` (current `POST /superadmin/doctors/new` handler).
- Doctor row inserted with `password_hash = NULL` (line 1982). No temp password generated, so nothing exists to log.
- One-time token issued via `password_reset_tokens` (lines 2015-2022) — same machinery as `POST /forgot-password` in `src/routes/auth.js`.
- `emailService.sendEmail({ template: 'password-reset', ... })` sends the doctor a self-serve setup link (lines 2044-2054). Token is never echoed to stdout, the response body, or the DB outside the canonical reset-tokens table.
- On email-send failure: handler returns a 200 text response telling the superadmin to use the manual reset-link tool. Doctor row is NOT rolled back. Failure path is observable via `error_logs` (category=`email_send`) after P1-NOTIF-3.

**Codebase-wide credential-leak grep (2026-05-03):** swept `console.(log|error|warn|info|debug)` for occurrences of `password|temp_pass|tempPassword|tempPass|secret|api_key|apiKey|token` in production code (excluding tests).

| File:line | Match | Verdict |
|---|---|---|
| `src/create_test_doctor.js:64,67` | logs hardcoded test password `Doctor123!` | **NEW FINDING (P3)** — manual seed script, run by hand with `DATABASE_URL` env. The "leaked" value is hardcoded in the script source (line 18), so it's not a runtime credential leak in any meaningful sense. Suggest moving the password to an env var and printing only "password set; run with DOCTOR_PASSWORD=… to override" in a follow-up. Not blocking. |
| `src/bootCheck.js:68` | "ALLOW_PRIMARY_IN_DEV enabled — running SLA_MODE=primary in development (token acknowledged)" | False positive — the word "token" appears in a banner string; no token value is logged. |
| `src/middleware/push.js:46,80` | `[push] Invalid push token for user ${userId}` / `[push] Removed invalid token for user ${userId}` | False positive — logs user id and the *fact* of an invalid push token, not the token value. |
| `src/instagram/scheduler.js:122,126` | `[IG Scheduler] Refreshing access token...` / `Token refreshed. Expires in X days` | False positive — logs the action, not the token. |
| `src/routes/auth.js:321`, `src/routes/api/auth.js:312` | `[forgot-password] email send failed: <err.message>` | False positive — error-message logging only; no token in the payload. |

**Outcome:** P0-SEC-1 is closed. One new low-severity finding filed (`create_test_doctor.js`) for follow-up; not in scope for P1-NOTIF-3.

---

### P0-SEC-2 — Plaintext credentials in scratch scripts (process gap)

**Filed:** 2026-05-04 by P3 cleanup batch (PR 1).
**Severity:** P0-SEC (filed but operationally accepted as risk).
**Owner:** process / security.
**Status:** local file deleted; filename gitignored; password rotation deferred (founder accepted disclosure risk).

**What happened:** on 2026-05-03, `verify-doctor-signup.sh` was created in repo root with a plaintext `DATABASE_URL` containing the production Supabase password. The file was untracked but **not gitignored**, so a future `git add -A` would have committed credentials to git history. Caught during the P3 cleanup batch on 2026-05-04 before any git inclusion occurred. Verified zero git history touched the file (`git log --all --full-history -- verify-doctor-signup.sh` returned empty; `git rev-list --all --objects | grep verify-doctor-signup` returned empty).

**Remediation already applied:**
- File deleted from disk on 2026-05-04.
- Filename added to `.gitignore` (commit `c1061d9`).
- Password rotation deferred — founder accepted that the credential's disclosure surfaces (local disk, AI session logs, conversation history) are tolerable for now.

**Process improvements (defer to future SEC pass):**
1. Project policy: **NEVER hardcode credentials in any file in the repo, even gitignored.** Use environment variables exclusively (`process.env.DATABASE_URL` from a `.env` file that is itself gitignored).
2. Add a pre-commit hook to scan staged content for credential patterns (`postgres://`, `postgresql://`, `DATABASE_URL=`, AWS-key prefixes, common password patterns) and refuse the commit on a hit.
3. Document a credential-rotation runbook so the next time rotation is needed, it's a 5-minute procedure: rotate in Supabase → update Render env var → bounce service → verify.
4. Audit any other scratch scripts in `scripts/` and `tools/` for similar inline credential patterns. (`run_price_update.sh` is already gitignored — check whether *its* contents have the same gap.)

**Cite:** `verify-doctor-signup.sh:9` (file no longer present); `.gitignore:48` (current).

---

### P0-FORM-1 — Patient signup phone field is OPTIONAL; WhatsApp parity meaningless without phone capture

**Severity:** P0 (launch blocker).
**Surface:** Patient signup form; downstream notification dispatch.
**Evidence:** **VERIFIED-data**.

- Production `users` table audit (2026-05-03): 8/37 patients have a `phone` value populated (≈22%). 78% of existing patients have NO phone on file.
- Of the 8 with phones, formats vary: most are `+201XXXXXXXXX` (E.164 with `+`), some are truncated test data (`+2010`), one example with embedded spaces (`+20 100 123 4567`). `sendWhatsApp` strips non-digits at dispatch, so format inconsistency doesn't break sends — but the optionality at signup means the column is empty for the majority.
- Surfaced while shipping P1-NOTIF-1 (WhatsApp parity for case-acceptance and payment-confirmation events). Both flows already call `queueMultiChannelNotification` with `channels: ['email', 'whatsapp', 'internal']`. The WhatsApp channel silently skips with `{ skipped: true, reason: 'no_phone' }` for any user without `users.phone`. Net effect: WhatsApp parity is wired and tested, but only delivers to ~22% of patients on launch.

**Why P0 (launch blocker):**
Egyptian patients heavily prefer WhatsApp over email for transactional notifications. Shipping with email-only delivery to 78% of the user base undermines the case-acceptance and payment-confirmation UX — the two highest-value patient touchpoints in the funnel.

**Proposed fix:**
1. Make `phone` REQUIRED in the patient signup form (`src/routes/auth.js` register handler + frontend form).
2. Validate E.164 format server-side: leading `+`, country code, 8–15 digits total (`/^\+[1-9]\d{7,14}$/`). Strip spaces before validation.
3. Backfill prompt for existing 29 patients who lack a phone: on next login, redirect to a one-time `/profile/phone` form before granting access to dashboard. Skipping the form is a deliberate opt-out (set `users.notify_whatsapp = false`).
4. Add a unit test asserting an attempt to register without a phone returns 400.

Out of scope for this fix: SMS-OTP verification of the entered phone (P3). Initial release just trusts the form input — same posture as email.

---

## P1 — should fix before launch (high signal but not catastrophic)

### Patient

**P1-PATIENT-1 — `/patient/new-case` wizard does not honor policy SLA hours or urgency tiers.**
*Evidence:* **VERIFIED-code**. `patient.js:1500` writes `urgency_tier` as `'priority'` (legacy) instead of canonical `'vip'` from migration 031. `patient.js:1807-1813` derives `slaHours` from `services.sla_hours` (which on prod is uniformly 72h for all 92 visible services) or hardcoded 24h fallback if `sla_type='24'`. Policy (`docs/PAYOUT_AND_URGENCY_POLICY.md` §2) requires Standard 48h, VIP 18h, Urgent 4h. Wizard never offers Urgent at all and never charges the 1.3× / 1.6× uplift. The pricing helper `computeOrderPricing` is wired in `order_flow.js` but **not** in the canonical `patient.js` wizard — so urgency tier UX exists in `order_review.ejs` (legacy guest flow) but not in the post-login flow.
*Impact:* patient cannot select VIP or Urgent → platform earns no urgency uplift revenue → doctor sees 72h SLA on every Standard case (which actually buys the doctor more time vs the 48h policy promise — patient-favorable, doctor-favorable, platform loses uplift revenue).
*Fix sketch:* port the `slaChoice → slaHours/urgencyTier` logic from `order_flow.js POST /order/:id/payment` into `patient.js POST /patient/new-case/step4`, including the 7am–7pm Cairo cutoff redirect to `/order/:id/urgency-conflict`.

**P1-PATIENT-2 — Step1 wizard creates a draft `orders` row before the patient picks specialty/service.**
*Evidence:* code-only, `patient.js:1331-1392`. This is by-design (multi-step wizard), but no cleanup job purges abandoned drafts.
*Impact:* `orders` table will accumulate `DRAFT` rows. Cosmetic at low traffic; cumulative at scale.
*Fix sketch:* add a daily worker that hard-deletes drafts older than 30 days with no payment.

**P1-PATIENT-3 — `/portal/patient/payment-return` trusts `?success=true` query param.**
*Evidence:* **VERIFIED-code**, `patient.js:1564-1594`. The `isSuccess` check only redirects to the success page; the success page itself re-queries DB and refuses to flip status without webhook/stub. So the trust boundary is correct **only because** the success page does its own check. Tightly coupled — if a future change makes success-page write status without re-querying, this becomes a CSRF-style spoofing vector. Today: safe.

### Doctor

**P1-DOC-1 — `/portal/doctor/messages` is a "Coming in Phase 2" stub.**

**Status (2026-05-05):** ✅ **RESOLVED** — discovery during fix: the doctor messages experience was already implemented at `/portal/messages` (shared patient + doctor handler in `src/routes/messaging.js:72-124`, view at `src/views/messages.ejs`). The "stub" was purely a routing oversight — the doctor sidebar pointed at a doctor-namespaced URL that rendered "Coming in Phase 2" while the real shared inbox lived a path away. Fix: doctor sidebar `href` → `/portal/messages`, stub route → `res.redirect(301, '/portal/messages')` (preserves deep-links / mobile push targets / bookmarks), stub view deleted, doctor tour step 4 repointed at the real page (updates yesterday's P1-DOC-7 commit 3 — per-case fallback was correct then, direct repoint correct now), help-guide mockup URL updated. 5 tests in `tests/core/doctor-messages.test.js` (redirect, sidebar regression guard, inbox render with seeded conversation + unread badge, empty state, bilingual EN+AR template static check). Filed during fix: **P3-PATIENT-1** for the v2 patient sidebar's broken `/portal/patient/messages` link.

*Evidence:* **VERIFIED-code**, `doctor.js:616-630`. View renders an empty page. Doctors who try to message a patient hit a dead end.
*Impact:* doctors who need to ask a patient something out-of-band fall back to phone/whatsapp, breaking audit trail.
*Fix sketch:* either ship a minimal messages list (read-only initially) or remove the sidebar nav item.

**P1-DOC-2 — `/portal/doctor/earnings` is a "Coming in v1.5" stub.**

**Status (2026-05-05):** ✅ **RESOLVED** — page itself shipped 2026-05-02 in commit `8507b51` (alongside the P0-FIN-1 writer wiring) but the audit doc lagged. Same staleness pattern that hit P1-DOC-1: stub fix was packaged into a different commit's body and the routing table never got updated. Implementation: lifetime tiles (Lifetime / Paid / Pending) + 24-month statement table reading `doctor_earnings` + `addon_earnings`, friendly empty state for new doctors, full bilingual EN+AR. Investigation also surfaced a latent correctness bug — the page filtered status for only `'paid'` and `'pending'` but P1-FIN-2's `'reassigned'` status (SLA-breach 10%-baseShare partial pay) inflated Lifetime silently while paid+pending tiles ignored it (Lifetime ≠ Paid + Pending whenever a reassignment occurred). Fix landed in this PR: reassigned amounts surface as inline notes under the Lifetime tile ("Includes reassigned partial pay") and Pending tile ("+ X EGP reassigned (SLA-breach partial pay)"), plus an amber "Reassigned" pill with help-tooltip in the monthly status column for reassigned-only months. Notes are conditional on `reassigned > 0` so the 99% case (today: 0 reassigned rows in prod) sees no visual change. 3 tests in `tests/core/doctor-earnings-reassigned.test.js` (notes hidden, math integrity 1000+500+87=1587, reassigned-only pill renders). Filed during fix: **P3-DOC-8** (chronological per-earning list — the user spec's "Recent earnings" requirement, currently the page only does monthly rollup), **P3-DOC-9** (time-period filter month/quarter/all-time toggle), **P3-DOC-10** (CSV export).

*Evidence (historical):* **VERIFIED-code**, `views/portal_doctor_earnings.ejs:13-32`. The view explicitly tells the doctor "fees per case are visible inside each case detail." Combined with P0-FIN-1, doctors never see a monthly statement.
*Impact:* doctors will ask "how do I see my total earnings?" — the answer is "look at every case manually". Bad UX, but not money-losing because the dashboard summary uses `SUM(orders.doctor_fee)` which is correct.
*Fix sketch:* basic earnings page reading `doctor_earnings` (after P0-FIN-1 is wired) + `addon_earnings`, grouped by month.

**P1-DOC-3 — Doctor cannot reset their password via the portal forgot-password form.**
*Evidence:* **VERIFIED-code**, `auth.js:283`: `WHERE email=$1 AND role='patient' AND is_active=true`. Doctors silently fall into the "if an account exists you'll receive a link" branch but no email is sent.
*Impact:* a doctor who forgets their password has no self-serve recovery path; they must contact superadmin (who would need to use the manual reset-link generator at `superadmin.js:2645`).
*Fix sketch:* widen the WHERE clause to `role IN ('patient','doctor') AND is_active=true`. The `password-reset.hbs` template is generic enough to work for doctors.

**P1-DOC-4 — `/portal/doctor` redirects.**
*Evidence:* code-only, `doctor.js:110`. This redirects `/portal/doctor` → `/portal/doctor/today`. Confirmed working but two-step navigation; minor.

**P1-DOC-7 — Doctor dashboard underuses shipped infrastructure: tour engine never auto-fires; activity feed surfaces order events only.**
*Evidence:* code-only.
- `public/js/portal-tours.js` (295 lines) + `public/js/tours/doctor-tour.js` define a working `PortalTour` engine with a 4-step `doctorDashboardTour`, but the engine only triggers on a manual button click (`portal_doctor_dashboard.ejs:542`). First-login doctors never see it.
- The "Recent Activity" card (`portal_doctor_dashboard.ejs:478-502`, query at `doctor.js:311-322`) reads from `order_events` only. Unread patient messages and recently-paid `doctor_earnings` (both signals doctors care about) aren't surfaced anywhere on the dashboard.
- `doctor-tour.js:25-30` references "Patient Messages" — but `/portal/doctor/messages` is a P1-DOC-1 stub. A doctor following the tour today is pointed at a "Coming in Phase 2" page.
*Impact:* first-login doctors miss the guided onboarding the codebase already supports; doctors with money owed (paid `doctor_earnings`) or unread patient questions get no visual cue from the dashboard landing page.
*Fix sketch:* (1) auto-chain `doctorDashboardTour` after the welcome-modal dismiss using a localStorage gate (one-time per browser); (2) refresh `doctor-tour.js` step copy to remove or repoint the P1-DOC-1 stub reference (per-case fallback acceptable until P1-DOC-1 ships); (3) add two compact widgets above the Recent Activity card — "Unread messages" (count + click → most-recent unread case detail) and "Recently paid" (latest EGP amount + click → case detail fallback until P1-DOC-2 ships). No schema changes.
*Filed by:* P1-DOC-4 cleanup investigation 2026-05-05.

### Public / marketing

**P1-PUB-1 — `/blog`, `/faq`, `/specialties` return 404 on prod.**
*Evidence:* **VERIFIED-prod**, three direct curls.
*Impact:* if marketing campaigns or social-media posts link to these slugs, users hit 404 and bounce. April audit also flagged `/blog` (FLAG 2.5) — still unresolved. `public/blog/` directory has 4 production HTML pages but no Express route mounts them.
*Fix sketch:* either mount `app.use('/blog', express.static('public/blog'))` OR remove links from any view that references them. A grep showed no in-tree references to `href="/blog"` etc., but external campaigns may.

**P1-PUB-2 — `/help-me-choose` AI assistant submits to dead `/order/start`.**
*Evidence:* **VERIFIED-code**, `views/help_me_choose.ejs:108`: `const SUBMIT_BASE = '/order/start';`. The page renders fine, the AI chat works, but the final "submit" CTA sends the user to the coming-soon page.
*Impact:* the AI service-finder is a dead-end UX trap. A guest who used it ends up at coming_soon and has no way to convert.
*Fix sketch:* change SUBMIT_BASE to `/register?next=/patient/new-case` (or whichever signed-in entry point applies).

**P1-PUB-3 — `/order/start` hard-renders coming_soon; `service_assistant` partial defaults to it.**
*Evidence:* **VERIFIED-code+prod**, `order_flow.js:115-117` (route returns `coming_soon`); `views/partials/service_assistant.ejs:3` defaults `_saSubmitUrl = '/order/start'`. The floating chat partial is included in `views/services.ejs` and `views/order_start.ejs`.
*Impact:* every page that includes the service-assistant chat has a "submit" path that lands on coming-soon for guests. Logged-in patients never hit `/order/start` (their flow is `/patient/new-case`), so the impact is guests only.
*Fix sketch:* change the default `submitUrl` in `service_assistant.ejs` to `/register?next=/patient/new-case`. Resolve `/order/start` policy explicitly: either revive the legacy guest flow (uncomment `order_flow.js:120-129`) or delete the route + its references.

### Auth

**P1-AUTH-1 — Forgot-password is patient-only.** (cross-listed as P1-DOC-3)

**P1-AUTH-2 — Mobile API OTP code generated with `Math.random()`.**
*Evidence:* **VERIFIED-code**, `routes/api/auth.js:157`: `Math.floor(100000 + Math.random() * 900000)`. Math.random is not cryptographically secure.
*Impact:* an attacker who can predict server entropy could in principle predict the next OTP. In practice mitigated by 10-min TTL + single-use + Twilio Verify primary path. Still: don't ship medical PHI auth on `Math.random`.
*Fix:* `require('crypto').randomInt(100000, 1000000).toString().padStart(6, '0')`.

**P1-AUTH-3 — `/api/v1/auth/login` filters `role='patient'` strictly.**
*Evidence:* **VERIFIED-code**, `api/auth.js:94`. So a doctor cannot log in via the mobile API. Whether this is intentional depends on whether the mobile app is patient-only. If the mobile app ever needs doctor sessions, this is a blocker. UNVERIFIED — flagging.

### Pipelines / data

**P1-NOTIF-1 — Lifecycle email wrappers (`notifyCaseReceived`, `notifyCaseAssigned`, `notifyMoreInfoRequested`, `notifyCaseReassigned`, `notifyCaseCancelled`, `notifyDoctorFileUploaded`) are EN-only hardcoded text.**
*Evidence:* **VERIFIED-code**, `services/emailService.js:482-567`. The function bodies ship plain English strings (`"Hello Doctor,"`, `"Your case X has been received"`) and don't read from the bilingual Handlebars templates. The 6 callers don't pass a `lang` parameter.
*Impact:* AR-language patients/doctors get English emails for these specific lifecycle events. The 14 templated emails (welcome, password-reset, payment-success, case-submitted, case-assigned via template, etc.) ARE bilingual; only these 6 hardcoded wrappers are EN-only.
*Fix sketch:* either route them through `sendEmail({ template, lang })` against the existing `case-submitted.hbs` / `case-assigned.hbs` etc., or duplicate the EN strings as AR.

**P1-DATA-1 — `services.sla_hours` uniformly 72h on prod.**
*Evidence:* **VERIFIED-prod**: `SELECT sla_hours, COUNT(*) FROM services GROUP BY sla_hours` returns `72h: 92` (only).
*Impact:* policy says Standard SLA is 48h. Catalog says 72h. The April-29 plan included "update existing SLA hours: Standard 72h → 48h" — never ran. Patients are promised 72h instead of 48h; doctors get 72h instead of being held to 48h. Patient/doctor-favorable but mis-reps the policy promise.
*Fix:* migration `UPDATE services SET sla_hours = 48 WHERE sla_hours = 72`.

**P1-SCHEMA-1 — Schema drift: `users` has both `country` (text, populated for 4/8 patients) and `country_code` (text, populated for 4/8).**
*Evidence:* **VERIFIED-prod**. Two columns, half-and-half population.
*Impact:* every read of `users.country` vs `users.country_code` could return different values. `routes/auth.js` writes `country_code`; `routes/api/auth.js:60` writes `country`. Cross-flow inconsistency.
*Fix:* pick one (recommend `country_code`), backfill, drop the other.

**P1-SCHEMA-2 — `users.reset_token` and `users.reset_token_expires` columns still on the table.**
*Evidence:* **VERIFIED-prod**. After the password_reset_tokens migration, no code writes these anymore but `api/auth.js:328` still reads them (P0-AUTH-1). Drop after the mobile reset-password fix lands.

### Security / hardening

**P1-SEC-1 — `/superadmin/users/:id/generate-reset-link` returns the token in the HTTP response body.**
*Evidence:* **VERIFIED-code**, `superadmin.js:2676`: `return res.send(\`Reset link: ${url}\`);`. Browser displays the raw reset URL on the superadmin page.
*Impact:* the link is shown to a privileged superadmin (so on the trust boundary, not crossing it). But: any browser cache, screen-recording, screenshot, or person looking over the superadmin's shoulder gets the token. Better UX is "we emailed it to the user" without exposing the link.
*Fix:* call `emailService.sendEmail({ template: 'password-reset', to: user.email, ... })` instead of returning the URL.

---

## P2 — log and move on (polish, debt, minor inconsistencies)

- **P2-CLEANUP-1** — 16 `.bak` files in `src/views/` (`doctor_alerts.ejs.bak` etc.). April audit FLAG 10.3 — still unresolved. None served by Express but they add review noise.
- **P2-CLEANUP-2** — root-level "BRIEF" markdown files (`CLAUDE_CODE_BRIEF*.md`, `LOGO_AND_*FIX.md` etc.) — temp scratch from prior debug sessions. Not deployed; review noise.
- **P2-DEAD-1** — `src/sla_worker.js` already noted dead (April audit FLAG 10.1). Comment in `server.js:104-106` explicitly disables it. Delete the file.
- **P2-DEAD-2** — `src/migrations/020_orders_paid_at.sql` is superseded by `032_orders_paid_at.sql`. Both ran on prod. 020 should be a no-op marker or be deleted (with `schema_migrations` row left in place).
- **P2-MIG-1** — Migration numbering gap: no `029_*.sql` exists. Cosmetic.
- **P2-LOG-1** — 9 `console.log` calls in `src/routes/`. Most are info-level (paymob-return query, contact-form message preview, doctor SLA dashboard sample). None leak PHI directly, but `static-pages.js:89/138` print contact-form name+email and lead name+email to logs, mild PII leakage. Move to `verbose()` from `logger.js` to suppress in production.
- **P2-CSRF-1** — exempt list in `csrf.js:83` is a hardcoded path-prefix list. Adding new webhooks will require touching the middleware. Consider per-route opt-in via `router.post('/callback', csrfExempt, …)` pattern.
- **P2-CSP-1** — homepage CSP `script-src` includes `https://media.twiliocdn.com` — verify it's still needed (Twilio Verify call is server-side; no Twilio JS on homepage AFAICT).
- **P2-COOKIE-1** — `Set-Cookie: lang=en` appears twice on `GET /login` response (curl shows two identical headers). Cosmetic.
- **P2-LANG-1** — April audit 9.4: `/lang/ar` redirects unauth visitors to `/login` instead of localizing the public site. Re-flag, no curl re-test.
- **P2-PRELAUNCH-1** — `order_flow.js:51` constant `PRE_LAUNCH_MODE = false` and the dead `if (PRE_LAUNCH_MODE)` block above the route are vestigial (the actual coming-soon is hardcoded one route below). Delete after deciding `/order/start` policy.
- **P2-TODO-1** — `doctor.js:3125` TODO comment about SLA-minutes fields on dashboard. Non-blocking.
- **P2-PAYMOB-1** — legacy fallback `PAYMENT_WEBHOOK_SECRET` still honored at `payments.js:42-58`. Retire once HMAC is the only path (April audit FLAG 4.7).
- **P2-RATELIMIT-1** — `authLimiter` rate is 30/15min/IP per April audit. Tighten to 10/15min or add per-account lockout (April audit FLAG 6.4).
- **P2-PG-1** — `src/pg.js:29` uses `rejectUnauthorized:false` (April audit FLAG 6.6). MITM-vulnerable on prod connections; fix with Supabase CA cert.
- **P2-OPS-1** — `/ops/agent/ping`, `/ops/agent/log-tokens` are CSRF-exempt (`csrf.js:86-99`). They have their own auth model (UNVERIFIED in this audit). Worth a focused review post-launch.
- **P2-PUBLIC-3** — Arabic service-name translation initiative. The `services` table has no `name_ar` column by design — only `specialties.name_ar` is populated, joined at query time. Consequence: on `/specialties/[id]` AR pages, the service rows render English service names ("Echocardiogram", "Holter Monitor", etc.) inside an otherwise-Arabic page. Adding AR translations across 269 services is a multi-day translation effort that requires medical-Arabic review, not a P3 cleanup. Filed by P3 cleanup batch on 2026-05-04 (originally mis-filed as P3-DATA-2). _Cite:_ `src/views/specialty_detail.ejs` services table; `src/migrations/` (no migration ever added `services.name_ar`).
- **P2-POLICY-1** — Reconsider whether the 72h Standard SLA tier should remain a public option. Current public catalog offers Standard 48h / VIP 18h / Urgent 4h, but `services.sla_hours` was historically 72h (P1-DATA-1) and migration 036 corrected most rows to 48h. Open question for product: should the platform restructure to a 24h/48h-only tier system with appropriate doctor compensation? **Owner: Ziad (product), not engineering.** No code change pending — engineering will react to the policy decision. Filed by P3 cleanup batch on 2026-05-04. _Cite:_ `docs/PAYOUT_AND_URGENCY_POLICY.md` §2; `src/migrations/036_sla_hours_align_to_policy.sql`.
- **P2-VIEW-1** — EJS templates dereferencing locals without `typeof` guards. Filed 2026-05-05 by patient new-case uploader-error investigation. Pattern: an EJS view declares `const __x = !!localName` (no `typeof` guard) and a subset of route handlers fails to pass `localName` in `res.render(...)` payloads — EJS evaluates in strict-ish mode and throws `ReferenceError: localName is not defined`, hitting the express error middleware which writes a row to `error_logs` and returns a 500 with the user's form data lost. Confirmed instance fixed today: `src/views/patient_new_case.ejs:25-26` (`uploaderConfigured`, `uploadcarePublicKey`) crashed on every form-validation re-render because 7 of 8 `render('patient_new_case', …)` call-sites in `src/routes/patient.js` didn't pass them. Likely additional instances throughout v2 patient + doctor views — every render call-site that adds a new local without auditing every error-render path is a latent ReferenceError waiting to fire on a validation error. _Fix sketch:_ (a) standardize on `typeof`-guarded local destructuring at the top of every EJS file (matches the pattern already used for `draft`, `files`, `error` in patient_new_case.ejs:22-24); (b) add a CI lint that scans `<% const __x = ... %>` patterns and warns when no `typeof` guard is present; or (c) introduce a `safeLocal(name, fallback)` helper that all views import. _Filed by:_ patient new-case 500-on-validation investigation 2026-05-05.
- **P2-TEST-1** — `tests/run.js` suite totals don't reflect async test outcomes. Filed 2026-05-05 by P3 cleanup batch discovery. Severity P2 (not P3): the runner is silently hiding real test failures, masking regressions in CI/local. Two confirmed instances today: P1-DOC-1 (commit `b07dfff`) shipped with `tour content refresh` failing while suite totals reported `Failed: 0`; P1-DOC-2 (commit `d50eb1c`) shipped on top of the same hidden failure. _Evidence:_ `tests/run.js` emits Passed/Failed/Skipped totals synchronously after `require()` returns, but each test file's `(async function run(){...})()` IIFE doesn't complete until later, so async `t.fail()` / `t.pass()` calls never update the printed totals. _Impact:_ regressions can land on main without anyone noticing. The kind of bug that grows until something serious breaks in prod and the post-mortem can't explain why tests didn't catch it. _Fix sketch:_ either (a) refactor `tests/run.js` so each test file exports a single async function the runner can `await` sequentially, then print totals after the loop, or (b) less invasive — add a `Promise` collector each test file pushes its IIFE into and have the runner `await Promise.allSettled(global._testIifes)` before the totals block. Option (a) is the cleaner long-term shape but touches every test file; (b) requires adding ~5 lines to each test file's top. _Cite:_ `tests/run.js:46-71` (suite totals printed after the require loop); `tests/core/doctor-dashboard.test.js:165` (canonical async IIFE pattern); P1-DOC-7 commit 2 + P1-DOC-1 + P1-DOC-2 test report comments noting "168 / 0 / 10" while async tests were still running.
- **P3-DRIFT-1** — `orders.locked_price` / `orders.locked_currency` env-specific schema drift. Columns added by `src/migrate_mobile_api.js` (boot-time path that doesn't write to `schema_migrations`) — present in production, absent in some dev environments. `src/routes/patient.js:2306-2310` SELECTs them, so hitting `/portal/patient/pay/:id` 500s in dev environments missing the columns. Same pattern as `037_orders_base_price.sql` codification. _Fix sketch:_ add a migration that idempotently adds `locked_price` + `locked_currency` to orders, mirroring 037 (uses `IF NOT EXISTS` guard so prod is a no-op). _Filed by:_ P1-PAY-1 commit 3 dev smoke testing 2026-05-05. The new POST `/payments/paymob/create-intention` route was deliberately written against `o.price` / `o.currency` to avoid this drift, so this ticket only blocks the pre-existing `/portal/patient/pay/:id` view in dev.
- **P3-DOC-6 part 4** — _(✅ **RESOLVED 2026-05-05**)_ SLA banner test thresholds drifted from impl. Yesterday's commit `acd1ae9` (P3-DOC-6 part 2) tuned SLA banner thresholds from red≤10%/amber 10–25% to red≤25%/amber 25–50% in `src/routes/doctor.js`. Tests in `tests/core/doctor-dashboard.test.js` ("SLA banner amber" + "SLA banner none") still seed against the old thresholds and now fail. Pre-existing, surfaced during P1-DOC-7 development. _Impact:_ 2 test failures show as red in CI runs, no functional impact in production. _Fix sketch:_ update test seed values to expect red at 25% remaining (was 10%) and amber transitions at 50% (was 25%). One-test-file change. _Filed by:_ P1-DOC-7 implementation 2026-05-05. _Resolution:_ seeds adjusted to 10% / 40% / 70% (each comfortably inside its new bucket); file-header comment, comment-line annotation, and the 3 assertion messages all updated to match new thresholds. Both previously-failing tests now pass.
- **P3-PUBLIC-5** — _(✅ **RESOLVED 2026-05-05**)_ Western digits in AR doctor dashboard perf grid. Doctor dashboard "This Month" card displays values like "43 ساعة" with Western digits in AR mode, inconsistent with the AR locale rule applied in PR 1 commit `3782db2` to public specialty pages (`Number.toLocaleString(__isAr ? 'ar-EG' : 'en-US')`). Harmonization deferred — affects all dashboard stat values (`completed` count, `compliancePct`, `avgTurnaroundHours`, `avgTurnaround30dHours`, hero-stat tiles, "earnings this month"), not just the new turnaround metric. Treat as a dashboard-wide locale pass. Surfaced during P3-DOC-6 part 3 verification. _Cite:_ `src/views/portal_doctor_dashboard.ejs:521-530` (perf grid), `src/views/portal_doctor_dashboard.ejs:163-166` (`_fmtEgp` helper, already locale-aware — pattern to extend). _Resolution:_ added `_fmtNum()` locale-aware helper next to `_fmtEgp()`, wrapped 14 raw-number sites across hero-stat tiles (5 sites), `dd-card-count` badges on the New Assignments / Recent Alerts / In Review / Completed cards (4 sites), and the perf grid (5 sites — Completed value, SLA compliance, Avg TAT, 30d Avg, plus the trend-up compliance pct in the green hero tile). AR doctors now see "٤٣ ساعة" everywhere. Filed P3-DOC-11 for the line-590 hardcoded "h" suffix (an AR-affordance gap, separate from digit locale).

---

## INFO — observations, no action required

- **INFO-EMAIL-1** — Resend integration looks well-done: SDK adapter preserves nodemailer shape, recipientGuard wraps every send, batch-safe filtering, blocked attempts logged to `blocked_send_attempts` table. EN+AR templates symmetric (20 each).
- **INFO-PRICE-1** — Production catalog: 92 visible services, **all** at exactly `doctor_fee = base_price × 0.20` (verified). 95 hidden services have NULL pricing. Closes April audit B4 / FLAG 7.6 false-positive permanently.
- **INFO-ADDON-1** — addon_services on prod: prescription = 50% commission ✓, video_consult = 85% ✓ — matches `PAYOUT_AND_URGENCY_POLICY` §1.
- **INFO-MULT-1** — All 92 visible services have `vip_multiplier=1.30, urgent_multiplier=1.60` ✓. Migration 027 verified applied.
- **INFO-SEC-1** — Production security headers tight: CSP with nonce, X-Frame-Options DENY (homepage)/SAMEORIGIN (login), HSTS preload-eligible, Permissions-Policy locked. CSRF mode = enforce (verified by 403 on `POST /register` without token).
- **INFO-DEPLOY-1** — Prod is on `ebbfd51` per `/__version`. Local HEAD is also `ebbfd51`. Working tree is clean. Deploy is up-to-date with main as of audit start.
- **INFO-DB-1** — Prod has 1 active doctor, 8 patients (mostly seed), 3 orders (none paid). The first paid order in production will be a system shake-out.

---

## Launch readiness summary

1. **Verdict: NO-GO until P0-PAY-1 is fixed.** Every Paymob webhook hits HTTP 403 today. The first patient who pays will be charged real money and the system will not know. Diagnosis to fix is one line in `src/middleware/csrf.js:83`.

2. **P0-FIN-1 is also a no-launch item** if you care about the platform-side accounting being right on day 1. The doctor isn't shortchanged, but admin pending-payouts will say 0 forever for main-case revenue. Wiring `computeDoctorEarnings` at three known sites is a small, well-scoped fix.

3. **P0-SEC-1 (temp password to logs)** is a P0 only if you treat Render logs as untrusted. Either fix today (~30 min — wire emailService to the create-doctor flow) or accept the risk for the small set of doctors you'll create manually pre-launch and rotate their passwords.

4. **P0-AUTH-1 (mobile API reset-password)** is dormant unless the mobile app actually calls that endpoint. Confirm with the mobile team. If they don't, downgrade to P1.

5. **The biggest practical UX risk after P0-PAY-1** is P1-PATIENT-1: the canonical patient wizard never offers VIP or Urgent and always uses 72h SLA. You launch with the policy promise of 1.0×/1.3×/1.6× and 48h/18h/4h, but the system charges 1.0× and promises 72h. You can launch and fix this in week 1, or fix before launch and charge correctly from order #1 — your call.

6. **Doctor-facing UX risks**: forgot-password locks doctors out (P1-DOC-3), `/portal/doctor/earnings` is a stub that says "Coming in v1.5" (P1-DOC-2), `/portal/doctor/messages` is a stub (P1-DOC-1). None of these stop a doctor from accepting cases and writing reports. They're support-ticket generators, not launch blockers.

7. **Marketing 404s** (P1-PUB-1: `/blog`, `/faq`, `/specialties`) — only matters if external traffic links to them. Internal views don't.

8. **Migration housekeeping** (duplicate `paid_at` migration files, gap in numbering, schema drift on `users.country` vs `country_code`, orphan `users.reset_token` columns) — not blockers, but the `country` drift will bite when someone writes a query joining on the wrong column. Schedule for week 1.

9. **What I did not verify (UNVERIFIED items, in priority order):**
   - End-to-end real Paymob test transaction (impossible without Paymob test cards — would prove P0-PAY-1 in vivo).
   - Authenticated patient + doctor portal walks (browser, both EN and AR).
   - SLA breach refund refunds **uplift only** with the policy arithmetic (no breached cases on prod to sample).
   - PDF report bilingual rendering.
   - Whether the mobile app calls `/api/v1/auth/reset-password` (would confirm P0-AUTH-1 severity).
   - `/lang/ar` unauth public-site behavior (re-confirm April audit 9.4).
   - Notification friendly-title mapping covers every event template.

10. **Minimum set of fixes I would want before accepting real patients tomorrow:**
    1. **P0-PAY-1** — change CSRF exempt path (1 line). **Mandatory.**
    2. **P0-SEC-1** — replace `console.log` of temp password with email send (~30 min). **Strongly recommended.**
    3. **P1-DOC-3** — let doctors reset their password (1 WHERE-clause widen, ~5 min). **Strongly recommended.**
    4. **P1-PUB-2 / P1-PUB-3** — fix `/help-me-choose` and `service_assistant` to point at `/register?next=/patient/new-case` (~10 min). **Strongly recommended** so guest funnel doesn't dead-end.
    5. **P0-FIN-1** — wire `computeDoctorEarnings` at order-creation + completion + breach. **Estimated 2-3 hours of focused work** including a regression test against the policy worked-example E. Defer if you're willing to live with broken admin payouts for week 1.
    6. **P1-PATIENT-1** — port urgency-tier UX from `order_flow.js` into `patient.js` wizard step4. **Estimated 3-4 hours** including the 7am-7pm Cairo cutoff handling. Defer if you're willing to launch at Standard-only pricing.

**Estimated time to fix all four mandatory + strongly-recommended P0/P1 items: ~1 hour.**

**Estimated time to fix the full P0 set (including P0-FIN-1 wiring): ~3-4 hours.**

**Verdict: GO-WITH-FIXES.** Fix P0-PAY-1, P0-SEC-1, P1-DOC-3, P1-PUB-2/3 today. Fix P0-FIN-1 tomorrow if at all possible (broken accounting on launch day is recoverable but uncomfortable). Treat P1-PATIENT-1 as the first week-1 follow-up.

---

## Appendix A — production curl probes (raw HTTP status)

```
GET /                       → 200
GET /healthz                → 200 (JSON OK)
GET /__version              → 200 (git_sha=ebbfd51)
GET /login                  → 200
GET /register               → 200
GET /forgot-password        → 200
GET /about                  → 200
GET /contact                → 200
GET /services               → 200
GET /privacy, /terms        → 200
GET /how-it-works           → 200 (anchor /#how-it-works)
GET /blog                   → 404
GET /faq                    → 404
GET /specialties            → 404
GET /help-me-choose         → 200
GET /order/start            → 200 (renders coming_soon)
GET /coming-soon            → 200
GET /doctor/login           → 200
GET /doctor/signup          → 200
GET /dashboard              → 302 → /login?next=/dashboard
GET /portal/doctor          → 302 → /login?next=/portal/doctor
GET /superadmin             → 302 → /login?next=/superadmin
GET /admin                  → 302 → /login?next=/admin
GET /patient/new-case       → 302 → /login?next=/patient/new-case
GET /ops/login              → 200
POST /payments/callback     → 403  ← P0-PAY-1
POST /callback              → 404
POST /payments/webhook      → 404
POST /register (no CSRF)    → 403  ← CSRF enforce ✓
POST /api/v1/auth/login     → 401
GET /api/v1/services        → 401
```

## Appendix B — production SQL spot checks (read-only, Supabase pooler)

```
SELECT current_database(), current_user, current_setting('server_version');
  postgres / postgres / 17.6

SELECT COUNT(*) FROM schema_migrations;                              → 33

SELECT COUNT(*) FROM services WHERE COALESCE(is_visible,true)=true;  → 92
SELECT pct, COUNT(*) FROM ... GROUP BY pct;                          → 20.0% : 92  (uniform)
SELECT COUNT(*) FROM services WHERE doctor_fee >= base_price;        → 0  (no inverted rows)

SELECT COUNT(*) FROM services WHERE COALESCE(is_visible,true)=true GROUP BY sla_hours;
  72h : 92                                                            ← P1-DATA-1

SELECT vip_multiplier, urgent_multiplier, COUNT(*) FROM services
 WHERE COALESCE(is_visible,true)=true GROUP BY ...;
  vip=1.30 urgent=1.60 : 92                                           ✓

SELECT id, doctor_commission_pct FROM addon_services;
  prescription : 50                                                    ✓
  video_consult : 85                                                   ✓

SELECT COUNT(*) FROM users WHERE role='doctor' GROUP BY pending_approval, is_active;
  pending=0 active=1 inactive=0

SELECT COUNT(*) FROM orders;                                         → 3
  status: expired_unpaid (2), cancelled (1), paid (0)

SELECT COUNT(*) FROM doctor_earnings;                                → 0
SELECT COUNT(*) FROM addon_earnings;                                 → 0
SELECT COUNT(*) FROM order_addons;                                   → 0
SELECT COUNT(*) FROM refunds;                                        → 0

SELECT COUNT(*) FROM information_schema.columns
 WHERE table_name='orders' AND column_name='paid_at';                → 1 (no duplicate)

SELECT COUNT(*) FILTER (WHERE country IS NOT NULL AND country_code IS NULL) AS only_country,
       COUNT(*) FILTER (WHERE country IS NULL AND country_code IS NOT NULL) AS only_cc,
       COUNT(*) FILTER (WHERE country IS NOT NULL AND country_code IS NOT NULL) AS both
  FROM users WHERE role='patient';
  only_country=4, only_cc=0, both=4                                  ← P1-SCHEMA-1
```

---

## Appendix C — file:line citation index

Pinned references for fast triage:

| Finding | Primary cite |
|---|---|
| P0-PAY-1 | `src/middleware/csrf.js:83`, `src/server.js:655`, `src/routes/payments.js:39`, `src/routes/patient.js:1542` |
| P0-FIN-1 | `src/services/earnings_calc.js:40-68`, `src/routes/doctor.js:1894`, `src/routes/video.js:805,988`, `src/video_scheduler.js:128` |
| P0-AUTH-1 | `src/routes/api/auth.js:327-338`, `TODO.md` "Stranded, discovered 2026-04-30" |
| P0-SEC-1 | `src/routes/superadmin.js:1972-1974` |
| P1-PATIENT-1 | `src/routes/patient.js:1500,1807-1813`, `src/routes/order_flow.js:431-434,441-461` |
| P1-DOC-1 | `src/routes/doctor.js:616-630` |
| P1-DOC-2 | `src/routes/doctor.js:633-647`, `src/views/portal_doctor_earnings.ejs:13-32` |
| P1-DOC-3 | `src/routes/auth.js:283` |
| P1-PUB-1 | curl + `public/blog/`, no Express mount |
| P1-PUB-2 | `src/views/help_me_choose.ejs:108` |
| P1-PUB-3 | `src/routes/order_flow.js:115-117`, `src/views/partials/service_assistant.ejs:3` |
| P1-AUTH-2 | `src/routes/api/auth.js:157` |
| P1-AUTH-3 | `src/routes/api/auth.js:94` |
| P1-NOTIF-1 | `src/services/emailService.js:482-567` |
| P1-DATA-1 | prod SQL, `src/migrations/` (no Standard-48h migration ran) |
| P1-SCHEMA-1 | prod SQL, `src/routes/auth.js` vs `src/routes/api/auth.js:60` |
| P1-SCHEMA-2 | prod SQL, `src/routes/api/auth.js:328` |
| P1-SEC-1 | `src/routes/superadmin.js:2676` |

---

## P3 backlog (filed during P0/P1 work)

### P3-AUTH-2: Apply requirePhone() gate to mobile API endpoints

**Filed:** 2026-05-04 by P0-FORM-1.
**Scope:** The `requirePhone()` middleware introduced in P0-FORM-1 gates
web portal routes only. Mobile API endpoints under `/api/v1/*` are gated
by `requireRole('patient')` but not `requirePhone()`, so a mobile patient
without a phone (currently 0 such accounts post-fix; possible legacy
OTP-auto-created rows could exist) can still call case/order endpoints
without supplying a phone.

**Why deferred:** mobile API requires JSON-shaped backfill UX (return a
structured `403 PHONE_REQUIRED` with a redirect-target URL, not a 302 HTML
redirect). Belongs in the same PR as the React Native phone-collection
screen update.

**Acceptance:** mobile API returns `403 PHONE_REQUIRED` from gated
endpoints when `users.phone IS NULL`, with payload pointing to the mobile
complete-profile flow.

**Cite:** `src/middleware/requirePhone.js` (the `if (path.indexOf('/api/') === 0) return next();` line is the explicit deferral point).

---

### P3-AUTH-3: Drop `users.reset_token` + `users.reset_token_expires` orphan columns

**Filed:** 2026-05-05 by P0-AUTH-1 fix.
**Severity:** P3 (cleanup, not functional).

**Evidence:** After P0-AUTH-1 migrated `POST /api/v1/auth/reset-password` to `password_reset_tokens`, the `users.reset_token` and `users.reset_token_expires` columns are orphan. Pre-fix, the only readers were the broken handler at `src/routes/api/auth.js:354,363`. Post-fix, no production code reads these columns (verified by `grep -rn "reset_token\b\|reset_token_expires" --include="*.js"` — only matches are in the bootstrap script `src/migrate_mobile_api.js:26-27` that originally created them).

**Fix sketch:**
- Add `src/migrations/042_drop_users_reset_token_columns.sql` with:
  ```sql
  ALTER TABLE users DROP COLUMN IF EXISTS reset_token;
  ALTER TABLE users DROP COLUMN IF EXISTS reset_token_expires;
  ```
- Remove `src/migrate_mobile_api.js:26-27` so the one-shot bootstrap no longer recreates the columns on a fresh dev DB.

**Risk:** zero (no readers post-fix). Deferred purely for diff hygiene — destructive schema migrations don't belong in a security-fix PR.

**Cite:** `src/routes/api/auth.js:343-415` (current handler, post-P0-AUTH-1); `src/migrate_mobile_api.js:26-27` (one-shot column creator).

---

### P3-AUTH-4: `password_reset_tokens.expires_at` TZ comparison

**Filed:** 2026-05-05 by P0-AUTH-1 fix discovery.
**Severity:** P3 (developer-experience trap, not a production bug).

**Evidence:** `password_reset_tokens.expires_at` is `TIMESTAMP WITHOUT TIME ZONE` (per `src/migrations/001_initial_tables.sql`). Writers (`src/routes/auth.js:299`, `src/routes/api/auth.js:313`) serialize ISO-Z strings; readers (`src/routes/auth.js:404`, the new `src/routes/api/auth.js:355-367` mobile helper) compare via `new Date(row.expires_at).getTime() < Date.now()`. The round-trip is only correct when the JS process's local TZ is UTC. Production (Render) runs UTC so it works. A dev environment in Cairo (UTC+3) silently rejects every freshly-issued token as expired — the bare wall-clock written by pg gets re-interpreted as local time on read, shifting the epoch by the local-TZ offset.

**Affects:** both portal and mobile reset-password flows; both writer and reader sides.

**Fix sketch:**
- Preferred: migrate the column to `TIMESTAMPTZ` via `src/migrations/043_password_reset_tokens_tz.sql` (`ALTER TABLE password_reset_tokens ALTER COLUMN expires_at TYPE TIMESTAMPTZ USING expires_at AT TIME ZONE 'UTC'`, plus the same for `used_at` and `created_at` for consistency). pg-types then returns proper TZ-aware Date objects and the existing JS comparisons are correct in any TZ.
- Alternative (no migration): normalize the comparison via explicit `Date.UTC(...)` reconstruction from the row's components. Less clean and only fixes the read side.
- The TIMESTAMPTZ migration is cleaner long-term and unblocks dev-environment testing without per-test `TZ=UTC` workarounds.

**Cite:** `tests/auth/reset-password-mobile.test.js` (test setup explicitly pins `TZ=UTC` and `PGTZ=UTC` in the spawned-server env to work around this — see header comment in that file).

---

### P3-DATA-2: services.name_ar translation gap _(CLOSED 2026-05-04 — schema-not-a-bug)_

**Filed:** original premise was "92 services missing Arabic name translations on AR specialty pages."

**Investigation finding:** the premise is invalid. The `services` table has no `name_ar` column and never has had one. Migration history: 001 created `services` with only `(id, specialty_id, code, name)`, and no subsequent migration ever added `name_ar` to it. Arabic rendering on `/specialties/[id]` AR pages comes from `specialties.name_ar` (specialty-level, joined at query time), not from a per-service Arabic field. There is nothing to "translate" inside the existing schema — adding service-level Arabic is a feature initiative, not a defect.

**Disposition:** closed as schema-not-a-bug. The underlying user need (AR readers seeing English service names mid-page) is real but is not a cleanup item. Re-filed as **P2-PUBLIC-3** (Arabic service-name translation initiative).

**Cite:** schema review of `src/migrations/001_initial.sql` through `041_*.sql`; `services` table column list at investigation time.

---

### P3-DOC-8: Doctor earnings page — chronological per-earning list

**Filed:** 2026-05-05 by P1-DOC-2 fix.
**Severity:** P3 (UX expansion, not a correctness issue).

**Evidence:** The doctor earnings page at `/portal/doctor/earnings` (handler `src/routes/doctor.js:825-926`, view `src/views/portal_doctor_earnings.ejs`) presents a 24-month rollup table — useful for high-volume doctors but unhelpful for a doctor who has 1-3 cases this month and wants to see "did I get paid for case #abc1234 yet?" The original P1-DOC-2 spec called for a "Recent earnings list (last 10-20 paid, reverse chronological) — Each row: case ref, amount, paid date, link to case detail." The shipped page does the rollup half but not the per-row half.

**Fix sketch:**
- Add a "Recent earnings" card between the lifetime tiles and the monthly statement.
- Query: `SELECT de.*, COALESCE(ap.order_id, o.id) AS order_id FROM doctor_earnings de LEFT JOIN appointments ap ON ap.id = de.appointment_id LEFT JOIN orders o ON o.id = de.appointment_id WHERE doctor_id=$1 ORDER BY COALESCE(paid_at, created_at) DESC LIMIT 20`. The COALESCE pattern is identical to the P1-DOC-7 dashboard widget (`doctor.js:557-571`) — `appointment_id` is overloaded with either an appointments PK (video flow) or an orders PK (main-case flow post-P0-FIN-1).
- Each row: case ref (slice of order_id), amount + EGP, status pill (Paid/Pending/Reassigned), paid_at or created_at relative time, link to `/portal/doctor/case/<order_id>`.

**Cite:** `src/views/portal_doctor_earnings.ejs:80-126` (current monthly statement); `src/routes/doctor.js:557-571` (P1-DOC-7 widget query — has the order-resolution JOIN to copy).

---

### P3-DOC-9: Doctor earnings page — time-period filter

**Filed:** 2026-05-05 by P1-DOC-2 fix.
**Severity:** P3 (UX polish).

**Evidence:** The current page is a fixed 24-month window. Doctors who want to file taxes for a specific quarter, or compare this-month vs. last-month performance, have to eyeball the table. P1-DOC-2's MVP spec asked: "Time period filter: month/quarter/all-time, or just all-time for MVP?" — answered "just all-time for MVP" but flagged for follow-up.

**Fix sketch:** small toggle above the monthly statement: `[ This month | This quarter | This year | All time ]`. Default to All time (current behavior). Pure server-side: append `WHERE created_at >= NOW() - INTERVAL '...'` to both the lifetime and monthly queries, parameterized by toggle state. No frontend JS needed if the toggle is a set of links to `?period=quarter` etc.

**Cite:** `src/routes/doctor.js:825-911` (handler — both queries hardcode `LIMIT 24` and no time filter on the lifetime totals).

---

### P3-DOC-10: Doctor earnings page — CSV export

**Filed:** 2026-05-05 by P1-DOC-2 fix.
**Severity:** P3 (UX polish; mentioned out-of-scope for the P1-DOC-2 MVP).

**Evidence:** The earnings view footer notes that pending amounts "move to Paid on the next monthly payout" but provides no exportable record. Doctors filing tax returns or reconciling against bank statements need the data in a portable format. P1-DOC-2's MVP spec explicitly listed CSV export as out-of-scope.

**Fix sketch:** add a `GET /portal/doctor/earnings.csv` endpoint that returns the same 24-month rollup (or, per P3-DOC-9, the filtered window) as text/csv with columns: month, case_count, main_total, addon_total, combined_total, paid_total, pending_total, reassigned_total. Reuse the handler's existing `byMonth` merge logic — split into a helper, render either EJS or CSV. Render a download link in the view header next to "Monthly statement".

**Cite:** `src/routes/doctor.js:892-911` (the merge logic to factor out); `src/views/portal_doctor_earnings.ejs:82-86` (the card header where the download link belongs).

---

### P3-DB-1: Audit other long-lived workers for pool-checkout patterns

**Filed:** 2026-05-05 by runCaseSlaSweep timeout investigation.
**Severity:** P3 (preventive — same root cause may exist elsewhere undetected).

**Evidence:** `runCaseSlaSweep` was failing ~1 in 3 scheduled runs with `Error: timeout exceeded when trying to connect` from the `src/pg.js` pool. Root cause: `max=5` + `connectionTimeoutMillis=5000` was too aggressive against Supabase Free pgbouncer transaction-mode (15-client cap) under burst contention. Fixed in same commit (`max=10`, `connectionTimeoutMillis=15000`). The same pool-checkout-under-bursty-load pattern likely affects other crons listed in `src/server.js`: `notification_worker` (every 30s), `payment-reminders` cron (every 5min), `Instagram scheduler` (every 5min), `appointment reminders` cron (every 15min), `conversation auto-close` (daily — low risk), `video-scheduler` (every 1min — high risk).

**Fix sketch:** for each cron, audit the entry-point function for `await pool.query(…)` / `queryAll` / `queryOne` calls that fan out into multiple checkouts, and either (a) coalesce into a single transaction via `withTransaction` to hold one connection through the whole sweep, or (b) catch + log + rethrow per the c2 pattern landed in `runCaseSlaSweep` so timeouts surface to `error_logs` instead of dying silently in pg-boss queue tables. Bonus: instrument with a per-cron success counter so missing data shows up on `/ops` rather than only via complaint.

**Cite:** `src/pg.js:25-39` (post-tune); `src/case_sla_worker.js:328-380` (post-c2 wrap); `src/server.js:` cron registrations.

---

### P3-OBS-1: pg-boss handler errors don't reach error_logs by default

**Filed:** 2026-05-05 by runCaseSlaSweep timeout investigation.
**Severity:** P3 (observability gap).

**Evidence:** `runCaseSlaSweep` was failing every 5min in production for an unknown duration before the user noticed nothing was being acted on. Root-cause discovery required querying `pgboss.job WHERE name='sla-sweep' ORDER BY created_on DESC` directly — there were zero matching rows in `error_logs` because pg-boss catches handler throws internally, marks the job `failed`, and never propagates to express's global error middleware (which is what writes the `error_logs` table). The `/ops/errors` view stays silent on every pg-boss handler failure. Same gap applies to all 4 other pg-boss handlers in `src/job_queue.js`: `handleCaseIntelligence`, `handleCaseReprocess`, `handleAutoAssign`, plus future handlers.

**Fix sketch:**
- Preferred: wrap every pg-boss handler in `src/job_queue.js` with a thin error-logging helper:
  ```js
  function withLogging(name, fn) {
    return async function(job) {
      try { return await fn(job); }
      catch (err) {
        const { logErrorToDb } = require('./logger');
        logErrorToDb(err, { context: 'job-queue.' + name, jobId: job.id, level: 'error' });
        throw err; // preserve pg-boss retry
      }
    };
  }
  ```
  Then `await boss.work('case-intelligence', { … }, withLogging('case-intelligence', handleCaseIntelligence));` for each. ~15 lines total, every handler covered.
- Alternative: a separate cron that pulls failed pg-boss jobs into `error_logs` periodically (heavier, lossy, but catches handler-internal logic-errors that don't throw).

**Today's runCaseSlaSweep ships a c2-style in-handler wrap covering its specific fetches; that's a one-off fix. The systemic gap remains.**

**Cite:** `src/job_queue.js:46-50` (handler registrations missing the wrap); `src/case_sla_worker.js:328-380` (one-off c2 example); `src/logger.js:101-145` (`logErrorToDb` shape).

---

### P3-DOC-11: Doctor dashboard line 590 hardcodes "h" suffix in AR

**Filed:** 2026-05-05 by P3-PUBLIC-5 fix discovery.
**Severity:** P3 (cosmetic AR-affordance gap).

**Evidence:** `src/views/portal_doctor_dashboard.ejs:590` renders `<%= _perf.avgTurnaroundHours %>h` regardless of `_isAr`. Line 596 (P1-DOC-7's avg-turnaround-30d stat) correctly branches with `_isAr ? ' ساعة' : 'h'`. Inconsistent treatment within the same perf grid: AR doctors see "32h" for the Avg TAT row but "32 ساعة" for the Avg turnaround (30d) row, side-by-side in the same card.

**Impact:** AR doctors see "32h" instead of "32 ساعة" for the Avg TAT row. Cosmetic only — same units, same semantics, just the unit symbol fails to localize.

**Fix sketch:** apply the same `_isAr` branch as line 596:
```ejs
<div class="dd-perf-value"><%= _fmtNum(_perf.avgTurnaroundHours) %><%= _isAr ? ' ساعة' : 'h' %></div>
```
~1 line change, no helper needed. Note: P3-PUBLIC-5 (commit landing alongside this filing) already wraps the number in `_fmtNum` so the digit half is fixed; only the unit symbol needs the branch.

**Cite:** `src/views/portal_doctor_dashboard.ejs:590` (post-P3-PUBLIC-5; line 590 inline comment marks the deferred branch).

---

### P3-FORM-1: Phone E.164 validation at signup _(CLOSED 2026-05-04 — resolved by P0-FORM-1)_

**Filed:** before P0-FORM-1 landed; ticket asked for E.164 validation on patient and doctor signup phone inputs.

**Resolution:** fully resolved by P0-FORM-1, commit `af38619` (2026-05-03). The `validatePhoneE164(input, lang)` helper at `src/validators/phone.js` is wired into all 4 patient signup entry points (`/register` web, `/api/v1/auth/register` mobile, `/api/v1/otp/verify` auto-create, `/portal/patient/onboarding/profile`) and the doctor signup validator (`src/validators/doctor_signup.js:129`). E.164 enforcement at form layer matches the ticket's acceptance criteria.

**Out-of-scope leftover:** `superadmin.js:1994` (admin-create doctor flow) accepts raw input — admin-only trust boundary, intentionally less strict; not a regression.

**Cite:** `src/validators/phone.js`, `src/routes/auth.js:601`, `src/routes/api/auth.js:48`, `src/routes/api/auth.js:253`, `src/routes/onboarding.js:87`, `src/validators/doctor_signup.js:129`. Verification commit: `af38619`.

---

### P3-PATIENT-1: Patient sidebar v2 links to non-existent route

**Filed:** 2026-05-05 by P1-DOC-1 fix discovery.
**Severity:** P3 (cosmetic / broken link).

**Evidence:** `src/views/partials/patient/sidebar.ejs:49` (the "v2" patient sidebar) lists the Messages nav item with `href: '/portal/patient/messages'` — a route that has no Express handler. The other patient sidebar at `src/views/partials/patient_sidebar.ejs:49` correctly links to `/portal/messages` (the canonical shared inbox). Which sidebar renders for patients depends on which partial the parent view includes.

**Impact:** depends on which sidebar variant is live. If the v2 sidebar is what patients actually see, clicking Messages 404s — equivalent to the doctor's pre-P1-DOC-1 dead-end.

**Fix sketch:**
- Audit which patient pages include `partials/patient/sidebar` vs. `partials/patient_sidebar` and pick a canonical one.
- For the chosen sidebar, set the Messages href to `/portal/messages` (the shared inbox shipped by `src/routes/messaging.js:72-124`).
- Delete the non-canonical sidebar partial to prevent future drift.

**Cite:** `src/views/partials/patient/sidebar.ejs:49` (broken href); `src/views/partials/patient_sidebar.ejs:49` (correct href reference).

---

### P3-PUBLIC-4: AR plural grammar in fmtSla()

**Filed:** 2026-05-04 by P3 cleanup batch (PR 1).
**Status:** ✅ **RESOLVED 2026-05-05** — `fmtSla` now uses `Intl.PluralRules('ar-EG')` to select the right Arabic plural form: `one → ساعة`, `two → ساعتان` (dual, rendered without leading numeral per Arabic convention), `few (3-10) → ساعات`, `many (11-99) → ساعة` (singular accusative), `other → ساعة`. Net visible change: `fmtSla(4)` now returns "٤ ساعات" (was "٤ ساعة"). EN side intentionally unchanged — `1 hours` / `2 hours` continue to render with literal `hours`, matching the existing UI convention across orders, appointments, and earnings displays; an EN plural fix would be scope creep into a different audit item. _Cite:_ `src/views/specialty_detail.ejs:62-77` (post-fix).

**Issue:** `fmtSla(hours)` in `src/views/specialty_detail.ejs:62-66` returns "٤ ساعة" (singular form) for any input. Arabic plural grammar requires "ساعات" (plural) for counts of 3-10. Static AR tier text in the same file already uses the correct plural ("٤ ساعات" for the Urgent tier card), so dynamic and static SLA labels are inconsistent for non-1 hour counts.

The previous `fmtSla` (pre-P3-PUBLIC-2) had the same singular-only behavior — this PR's locale-aware refactor preserved the bug rather than introducing it. Filing now so it isn't lost.

**Fix sketch:** wrap the noun choice with `Intl.PluralRules` (Arabic supports `zero/one/two/few/many/other`):
```js
var rules = new Intl.PluralRules('ar-EG');
var arNoun = ({ one: 'ساعة', two: 'ساعتان', few: 'ساعات', many: 'ساعة', other: 'ساعة' })[rules.select(h)];
```

In practice the visible specialty page uses three SLA values (4, 18, 48) — `4 → few → ساعات`, `18 → many → ساعة`, `48 → many → ساعة`. So the user-visible fix is just for the 4-hour Urgent case, and the Urgent tier already hardcodes "٤ ساعات" correctly. Dynamic helper still benefits from the rule because services may override SLA at the row level.

**Owner:** future polish PR. Low priority — affects only doctors who configure non-default service-level SLA hours, which is currently zero.

**Cite:** `src/views/specialty_detail.ejs:62-66`.

---

### P3-TEST-1: Cross-test require-cache pollution

**Filed:** 2026-05-05 by P0-AUTH-1 fix discovery.
**Severity:** P3 (developer-experience trap).

**Evidence:** `tests/auth/onboarding-self-heal.test.js:33-43` installs an in-memory pg stub by overwriting `require.cache[pgPath]` (also `src/middleware` and `src/logger`). Because `tests/run.js` loads every test file into the same node process via sequential `require()`, that stub leaks into every test file that loads after it alphabetically. New tests touching the real DB must explicitly `delete require.cache[require.resolve('../../src/pg')]` and re-require to escape the stub. Symptom on hit: `queryOne` returns the stub's pre-canned `{ onboarding_complete: true, name: 'Stale User', phone: '+201012345678', lang: 'en' }` regardless of the actual SELECT, and `execute` is a no-op so seed INSERTs silently disappear.

**Fix sketch:**
- Preferred: refactor `onboarding-self-heal.test.js` to use a sandboxed require pattern that restores the cache in a `finally` block (capture `const original = require.cache[pgPath]; ... ; require.cache[pgPath] = original`). Same for the middleware and logger stubs. No other test file needs to know about the stubs.
- Alternative: have `tests/run.js` snapshot `require.cache` before each test file load and restore after. Heavier but immune to any test that forgets cleanup.
- Both fixes let new tests use plain `require('../../src/pg')` without the workaround.

**Cite:** `tests/auth/onboarding-self-heal.test.js:33-43` (source of pollution); `tests/auth/reset-password-mobile.test.js:54-65` (workaround example with explanatory comment).

---

### P3-VIEW-2: Spread `uploadcareLocals` across all 7 patient_new_case error-render paths

**Filed:** 2026-05-05 by patient new-case ReferenceError fix.
**Severity:** P3 (defense-in-depth follow-up; not a correctness gap after the P2-VIEW-1 typeof-guard ships).

**Evidence:** `src/routes/patient.js:73-76` defines a `uploadcareLocals` object exactly so route handlers can spread it into render payloads:
```js
const uploadcareLocals = {
  uploadcarePublicKey: process.env.UPLOADCARE_PUBLIC_KEY || '',
  uploaderConfigured: String(process.env.UPLOADCARE_PUBLIC_KEY || '').trim().length > 0,
};
```
Today only the happy-path GET handler at `:1315` passes these locals, and it does so by **inlining** the same logic at lines 1326-1327 rather than spreading the helper. The 7 error-rerender paths (`:1362`, `:1942`, `:1953`, `:2042`, `:2128`, `:2149`, `:2280`) don't pass them at all. Today's typeof-guard fix in the EJS template (P2-VIEW-1 follow-up) keeps the view from crashing, but the underlying smell — a "shared-locals" helper that nobody uses — remains.

**Fix sketch:**
- Replace the inlined logic at `:1326-1327` with `...uploadcareLocals` spread.
- Add `...uploadcareLocals` to all 7 error-rerender render payloads.
- Optional: extend the helper to also include `paymobLiveMode`, `queryErr`, `uploadedFlash` (the other locals the happy-path render computes inline) so all 8 sites share one source of truth.

**Risk:** zero — the EJS template's typeof guard already handles the missing-locals case. This is purely a code-organization improvement that future-proofs against the next person adding a render call-site that forgets the locals.

**Cite:** `src/routes/patient.js:73-76` (the helper); `src/routes/patient.js:1326-1327` (inlined-instead-of-spread); `src/views/patient_new_case.ejs:25-26` (the view-side guard the helper-spread would make redundant but doesn't hurt to keep).

---

### P3-CSP-1: Patient new-case CSP-nonce blocked all 4 inline scripts _(CLOSED 2026-05-06 — commit `797e00e`)_

**Filed:** 2026-05-06 by /patient/new-case?step=2 unresponsive-uploader investigation.
**Severity:** P3 postmortem (resolved). Filed for institutional memory because diagnosis took 7 commits and the surface symptoms repeatedly mis-pointed.

**Original (incorrect) hypothesis:** `res.locals.cspNonce` was being clobbered between the CSP middleware and the EJS render scope. Five commits chased downstream patches based on that theory:
- `17aae43` add cspNonce to res.locals at render call-sites
- `29b4c32` defensive `__nonceAttr` fallback chain in views
- `0bb0148` spread cspNonce through 8 render call-sites
- `23616a9` attach cspNonce to `req` and dual-read in renders
- `e2a40e3` instrumentation commit (later reverted)

None worked. The instrumentation commit finally produced ground truth: `cspNonce` reached `patient_new_case.ejs` as a 24-char string. That falsified the "value lost between middleware and view" theory and exposed two **independent** bugs:

**Bug 1 — EJS partial-scope drop (commit `e0f0183`).** `<%- include('partials/patient/foot', {active, isAr, unreadCount}) %>` does NOT merge parent locals into the partial's scope when an explicit data object is passed. So `cspNonce` was present in the parent template but absent in `head.ejs` and `foot.ejs` where the actual `<script>` tags live. Fix: explicitly pass `cspNonce: cspNonce` in the two affected `include()` calls.

**Bug 2 — EJS HTML-escape on attribute fragment (commit `797e00e`).** The helper builds `__nonceAttr` as a complete attribute fragment (`' nonce="<base64>"'`) and emits it via `<%= __nonceAttr %>`. EJS's `<%=` HTML-escapes its output, so the literal `"` characters became `&#34;`, rendering as `<script nonce="&#34;<base64>&#34;">`. The browser parsed the nonce *value* with literal quote characters, which never matched the CSP header's `nonce-<base64>` token, so all 5 inline scripts (3 in `patient_new_case.ejs`, 2 in `partials/patient/foot.ejs`) were CSP-rejected. Fix: switch all `<%= __nonceAttr %>` to `<%- __nonceAttr %>` — the raw operator emits the attribute fragment as-is. `__nonceAttr` is built from `String(cspNonce)` which is base64-only, so there is no XSS surface to escape away.

**Diagnostic dead-ends worth flagging:**
1. `script.getAttribute('nonce')` and `outerHTML` return `""` for **successfully-validated** nonced scripts in modern Chromium and Safari (CSP3 "nonce hiding" — W3C: <https://www.w3.org/TR/CSP3/#is-element-nonceable>). This made our verification snippet unreliable. Reliable checks: `view-source:` on the page (shows raw server HTML), DevTools Console for `Refused to execute inline script` errors, or functional tests of the JS itself.
2. `app.locals.cspNonce` was proposed as an alternative to per-include passing. It is **race-unsafe**: middleware sets app.locals, then awaits DB calls before render; another concurrent request can overwrite the global between set and render → response A's HTML gets nonce-B but its CSP header has nonce-A → A's scripts blocked. Functional, not security, bug — but reproduces the exact symptom we were trying to fix. Don't go there.

**Lesson:** When a fix doesn't land, **instrument first, theorize second**. Five commits of pure-theory patching cost more than one commit of three `console.log` statements would have.

**Cite:**
- Fix-1: `src/views/patient_new_case.ejs:73-80, 988-992` (cspNonce passed to head + foot includes — commit `e0f0183`).
- Fix-2: `src/views/patient_new_case.ejs:415, 890, 891` and `src/views/partials/patient/foot.ejs:36, 102` (`<%= __nonceAttr %>` → `<%- __nonceAttr %>` — commit `797e00e`).
- Helper definitions (untouched): `src/views/patient_new_case.ejs:28-33`, `src/views/partials/patient/foot.ejs:17-22`, `src/views/partials/patient/head.ejs:44-46` (head defines `__nonce` only, has no `<script>` tags using `__nonceAttr`).
- CSP middleware (correct from the start): `src/server.js:230-252`.

---

*End of report.*
