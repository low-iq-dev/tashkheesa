# Tashkheesa Command (Superadmin Mobile App) — Phase 0 Audit Findings

**Scope:** read-only investigation only. No code written, no schema changed, no RLS changed.
**Verified against:** live PRODUCTION Supabase Postgres via the app's own `pg` pool (`src/pg.js`, `.env.production`), `information_schema` / `pg_catalog`, on 2026-06-14.
**Method:** 5 parallel read-only investigators + independent re-verification of the decision-critical names.

> The DB is Supabase Postgres reached over the pgbouncer pooler (`aws-1-us-east-1.pooler.supabase.com:6543`) through a direct `pg` Pool — **not** the supabase-js client. There is **no staging**; one prod DB.

---

## 0. Headlines (read these first)

**Good news — most of the hard plumbing already exists:**
- ✅ **Worker heartbeat already exists** (`agent_heartbeats`, migration 049). `case_sla_worker` and `acceptance_watcher` both report and are live. **The brief's "only genuinely new backend capability" is NOT needed.**
- ✅ **`/__version` exists** and returns `gitSha` + `startedAtIso` — the env banner can read it as-is.
- ✅ **Clean JSON API conventions exist** to mirror: `res.ok()/res.fail()` envelope, `requireJWT` + `requireRole('superadmin')` gate, refresh-token flow.
- ✅ **`users.password_hash` + exactly one `superadmin`** (`ziad.wahsh@shifaegypt.com`) → single-account model is valid and a server-side gate already exists.

**Brief corrections you need to know before any code (schema drift, as warned):**
| Brief says | Reality (verified) |
|---|---|
| `payments` table | ❌ **Does not exist.** Payment data lives in `payment_events` + `orders.payment_*` + `appointment_payments`. |
| `error_log` | ❌ Actual table is **`error_logs`** (plural). No `timestamp` col — use `created_at`. |
| Reads `orders` | ⚠️ `orders` **and** `cases` both exist. **`orders` is canonical** (read the **`orders_active` VIEW**). `cases` is frozen legacy (12 rows, `pending_review` only). |
| users custom `doc_…` slugs | ❌ `users.id` are **UUIDs** (text column, UUID values). No `doc_` slugs. |
| SLA col `sla_deadline` or `deadline_at` | Both columns exist; **`deadline_at` is canonical** (`= accepted_at + sla_hours`). `sla_deadline` is dead/unwritten. |
| urgency `urgent` duplicate col | No `urgent` col. Canonical pair is **`urgency_flag` (bool) + `urgency_tier` (text)**. |

**The one real piece of NEW plumbing v1 actually needs (not the heartbeat):**
- 🔴 **A superadmin login path for the mobile app.** The existing `POST /api/v1/auth/login` is hard-filtered to `role='patient'` (`...WHERE email=$1 AND role='patient'`). The superadmin literally cannot authenticate through it today. v1 needs a dedicated `POST /api/v1/admin/auth/login` (+ refresh) issuing **short-lived** superadmin tokens. This is auth plumbing, not a data write — still read-only as far as business data.

**Still open as a flagged risk (do NOT change here):**
- 🔴 **RLS is disabled on all 61 tables, zero policies.** The prior P0 is still open. The app connects with a full-access Postgres role; the superadmin gate is the *only* thing protecting patient medical data once the phone is pulling it over the network. **Decision (2026-06-14): leave disabled for v1 (read-only, single-account, app-gated is defensible). But an RLS phase is now a HARD PREREQUISITE for v2 — no v2 write endpoint ships until it is done.** Unchanged by this audit.

---

## 1. Existing web admin/superadmin endpoints

**Routers (all mounted in `src/server.js`):**
- `src/routes/superadmin.js` (193 KB) → `/superadmin/*` — the primary 6-tab dashboard. Gate: `requireRole('superadmin')` (`superadmin.js:44`).
- `src/routes/admin.js` (104 KB) → `/admin/*` — parallel admin surface. Gate: `requireRole('admin')`; financial sub-surfaces (`/admin/pricing`, `/admin/services/*`) use `requireRole('superadmin')`.
- `src/routes/ops.js` (47 KB) → `/ops/*` — ops portal, gated by a separate cookie JWT `requireOpsAuth` (`{ops:true}` claim). **This is where `agent_heartbeats` is read/written** (see §4).

**Response type:** **Almost entirely server-rendered EJS** (`res.render` of HTML with embedded data). A handful of POST routes return JSON for AJAX, but **there is NO existing JSON read API** that mirrors what the mobile app needs. We are building the `/api/v1/admin/` read layer from scratch (good — clean separation, contained attack surface, exactly as the brief wants).

**The data service to mirror — `src/services/superadmin_dashboard.js` (47 KB):** this is the gold. It backs the 6 web tabs and already computes the aggregations the mobile Pulse/Finance/Doctors screens need (counters, SLA lists, leaderboards, recent-event feeds) across ~17 tables. The new endpoints should call into / mirror these functions rather than re-deriving SQL.

**Six web tabs:** `operations | finance | doctors | patients | marketing | health`. Maps cleanly onto the app's `Pulse / Cases / Finance / Doctors / System / (Patients&Growth)` nav.

**Audit logging — `src/services/admin_audit.js`:** `logAdminAudit({ req, action, target })` does a best-effort, error-swallowing INSERT into **`error_logs`** with `level='audit', category='admin_audit'`. Async, non-blocking, zero-risk. Today it's only called on financial-view surfaces. ✅ Feasible to call on every `/api/v1/admin/` GET. ⚠️ Two caveats: (a) it writes to the same `error_logs` table the System screen reads as a crash feed — the crash feed query MUST filter `level IN ('error','fatal')` (or `category <> 'admin_audit'`) or audit-reads will masquerade as errors; (b) `error_logs` has no retention policy — add one if we log every read.

---

## 2. Patient `/api/v1` layer (the conventions the admin namespace must mirror)

**Composition:** `src/routes/api_v1.js` (factory `module.exports = (pool, helpers) => router`), mounted at `src/server.js:934`. Sub-routers in `src/routes/api/`: `auth, services, cases, files, conversations, notifications, profile`.

**Middleware stack (in order):** `apiResponse` (envelope) → `express.json({limit:'5mb'})` → CORS wildcard (RN clients send no origin) → `apiLimiter` (100 req/15min/IP); `/auth` additionally gets `authLimiter` (20/15min/IP). After `/auth`+`/health`: `requireJWT` → `requireRole('patient')`. **`/api/v1/*` is CSRF-exempt** (`src/middleware/csrf.js:80`) — JWT bearer is the auth.

**Response envelope — `src/middleware/apiResponse.js` (mirror exactly):**
```js
res.ok(data, meta)   → { success: true,  data, meta? }            // 200
res.fail(msg, status=400, code) → { success: false, error: msg, code? }  // status
```

**Auth — `src/middleware/requireJWT.js`:** verifies `Bearer` token with `JWT_SECRET` (required at boot), sets `req.user = { id, email, role, name }`. `requireRole(role)` → 401 if no user, 403 `FORBIDDEN` if `req.user.role !== role`. **Single-arg only** (see landmine below). The admin gate is literally `requireJWT, requireRole('superadmin')`.

**Tokens / refresh (mobile system — `requireJWT.js` `generateTokens`):** access **15m**, refresh **30d**, rotated on use, stored/validated against **`users.refresh_token`** (+ `users.refresh_token_expires_at`). Refresh endpoint `POST /api/v1/auth/refresh` (revokes if stored token ≠ presented). **For the admin app, shorten both** (e.g. 5m access / 12–24h refresh) via an admin-specific `generateTokens` variant — the brief wants a tighter window and no "remember me."

> ⚠️ **Two distinct JWT systems coexist.** The **web portal** uses a cookie JWT signed in `src/auth.js` `sign()` with **7-day** expiry (carries `role/phone/specialty_id`). The **mobile API** uses the bearer access/refresh pair above. The admin app should use the **mobile bearer system** (shorter TTL, secure-store), not the 7-day web cookie.

**Push — `src/middleware/push.js`:** Expo push is already wired. Token stored in **`users.push_token`** (validated `ExponentPushToken[…]`), registered via `POST /api/v1/profile/push-token`, sent via `exp.host/--/api/v2/push/send` with `DeviceNotRegistered` auto-cleanup. v1 just needs admin-flavored send helpers (breach / worker-down / new-doctor) and a superadmin push-token register route.

**Role-gating landmine:** the API `requireRole` ignores extra args — `requireRole('admin','superadmin')` silently enforces only `'admin'`. Use the **single-arg `requireRole('superadmin')`** form. (Note `src/middleware.js:282` has a *different*, variadic `requireRole(...roles)` used by EJS routes — don't import that one for the API.)

---

## 3. Live schema — verified columns + landmines resolved

### Canonical case table: `orders` (read via `orders_active` VIEW)
- `orders` is the live case table; `orders_active` is **the only VIEW** in the schema and is what `src/routes/api/cases.js` + the SLA worker read. `src/case_lifecycle.js:68` hardcodes `CASE_TABLE='orders'`. **Admin API should read `orders_active`** for parity (confirm its filter — almost certainly `deleted_at IS NULL` — at build time).
- `cases` (12 rows, status `pending_review` only) is **frozen legacy** — do not read it.

**`orders` columns that matter for the app (verified):**
- **Pricing:** `base_price` (float8), `urgency_uplift_amount` (numeric, NOT NULL default 0), `price` (float8, legacy), `currency` (text 'EGP'), `doctor_fee`, `total_price_with_addons`, `addons_json`.
- **Urgency:** `urgency_flag` (bool), `urgency_tier` (text 'standard'), `tier`.
- **SLA:** `deadline_at` (canonical countdown anchor), `sla_hours` (int), `acceptance_deadline_at`, `sla_paused_at`, `sla_remaining_seconds`, `breached_at`, `pre_breach_notified`, `sla_reminder_sent`. (`sla_deadline` exists but is dead.) Clock starts on **`accepted_at`** (`deadline_at = accepted_at + sla_hours`; `src/case_sla_worker.js:178`, `src/sla_status.js`).
- **Status/assignment:** `status`, `assignment_status` (default 'auto'), `doctor_id`, `reassigned_*`, `broadcast_*`.
- **Payment:** `payment_status` (default 'unpaid'), `payment_method`, `payment_reference`, `paid_at`, `paymob_intention_id`, `paymob_transaction_id`, `hmac_verified_at`.
- **Identity/clinical:** `id` (text/UUID), `reference_id`, `patient_id`, `specialty_id`, `service_id`, `clinical_question`, `report_url`, `case_files_url`.

### Other read tables (verified columns)
- **`order_timeline`** (case-detail timeline): `id, order_id, status, description, actor, created_at`. (Also `order_events`: `id, order_id, label, meta, at, actor_user_id, actor_role` — a second event stream; confirm which the detail view should show.)
- **`users`:** `id` (UUID), `email`, `role`, `name`, `display_name`, `password_hash`, `phone`, `country_code`, `pending_approval`, `is_active`, `is_available`, `is_paused`, `onboarding_complete`, `muted_until`, `push_token`, `refresh_token`, `refresh_token_expires_at`, doctor fields (`specialty_id`, `max_active_cases` default 5, `max_active_cases_urgent` default 8, `sla_tiers_supported`, license/edu fields), `approved_at/by`, `rejection_reason`. **Roles present:** `patient` (23), `doctor` (14), `superadmin` (1).
- **`doctor_specialties`** (`doctor_id, specialty_id`), **`specialties`** (`id, name, name_ar, is_visible`), **`services`** (`id, specialty_id, name, base_price, sla_hours` default 48, `urgent_multiplier`, `vip_multiplier`, …), **`service_regional_prices`** (per-country pricing).
- **`doctor_earnings`:** `id, doctor_id, appointment_id, gross_amount, commission_pct, earned_amount, status` (default 'pending'), `paid_at`, clawback fields. ⚠️ **Keyed by `appointment_id`, not `order_id`, and currently 0 rows.** The Finance "pending payouts" computation must be confirmed against `src/services/earnings_writer.js` before building (it may not map 1:1 to cases). See open items.
- **`payment_events`:** `id, order_id, paymob_transaction_id, paymob_intention_id, event_type, payload_json (jsonb), hmac_verified, received_at`. **This is the transaction log** (no `payments` table).
- **`refunds`:** `id, order_id, amount_egp, reason, status` (default 'pending'), `requested_amount, approved_amount, instapay_handle, instapay_reference, denial_reason, patient_reason, requested_by, reviewed_by, reviewed_at, paid_at, paymob_refund_id`. **0 rows in prod.** Rich enough to back the refund-owed queue, but the "owed" set is likely *computed* by `src/services/refund_eligibility.js` over orders (SLA-breach surcharge / pre-assignment cancellation), not just read from this table — confirm at build.
- **`conversations`** (`id, order_id, patient_id, doctor_id, status`), **`messages`** (`id, conversation_id, sender_id, sender_role, content, message_type, file_url, is_read, created_at`), **`reviews`** (`id, order_id, patient_id, doctor_id, rating, review_text, is_anonymous, is_visible, admin_flagged`).
- **`error_logs`:** `id, error_id, level` (default 'error'), `message, stack, context, request_id, user_id, url, method, created_at, category`.

### Status vocabulary — ⚠️ do not trust live GROUP BY
Live `orders` has only 27 rows (mostly pre-launch test data): `expired_unpaid` (22), `cancelled` (2), `completed` (1), `in_progress` (1), `paid` (1). The brief's vocabulary (`draft → submitted → under_review → assigned → in_progress → completed`; `rejected, cancelled, escalated`) is **not** observable in the sparse data. **The authoritative status set + transitions must be read from the `src/case_lifecycle.js` state machine** (not from prod rows) before building the Cases filter and the status→color map.

---

## 4. Worker heartbeat + `/__version`

**Heartbeat already exists — no new plumbing.** `agent_heartbeats` (migration 049): `id, agent_name, status, current_task, token_cost_usd, meta, pinged_at`. ~40.6k rows, 7-day retention (pruned via cron, `server.js:1317`). Workers POST to an internal `/ops/agent/ping` (`src/routes/ops.js:1120`) each cycle. Live as of audit:

| Worker (`agent_name`) | Cadence | Last run (audit time) | Started in |
|---|---|---|---|
| `case_sla_worker` (the "sla-sweep") | 5 min | fresh (~2 min ago) | `server.js:1118` |
| `acceptance_watcher` | 2 min | fresh (~3 min ago) | `server.js:1124` |
| `notification_worker` | 30 s | fresh | `server.js:1270` |
| `video_scheduler` | 1 min | fresh | `server.js:1121` |
| `instagram_scheduler` | 5 min | **no rows** (pings silently failing or never ran — minor, irrelevant to v1) |

> The brief's "sla-sweep ran 2,274+" was a stale snapshot; counts decay under 7-day pruning. The mechanism is healthy.

**`/__version`** (`src/routes/health.js`, mounted `server.js:644`): returns `{ ok, name, version, mode, slaMode, startedAt, startedAtIso, uptimeSec, gitSha, requestId }`. `gitSha` resolves from `GIT_SHA / COMMIT_SHA / RENDER_GIT_COMMIT / RENDER_COMMIT`, falling back to `git rev-parse`. Also available: `/health`, `/status`, `/healthz` (the last exposes pool `total/idle/waiting`). All public + read-only.

**Pulse status-strip → concrete data source:**
| Pill | Source |
|---|---|
| API reachable | any 200 from `GET /api/v1/admin/health` |
| DB connected | `/healthz` pool metrics, or `SELECT 1` / a recent `agent_heartbeats` row |
| sla-sweep alive | `MAX(pinged_at) WHERE agent_name='case_sla_worker'` (stale if > ~10 min) |
| acceptance_watcher alive | `MAX(pinged_at) WHERE agent_name='acceptance_watcher'` (stale if > ~5 min) |
| Last deploy | `/__version` → `gitSha` + `startedAtIso` |

**Recommendation:** one superadmin-gated `GET /api/v1/admin/health` that aggregates the above (4 cheap reads on `agent_heartbeats` + cached `gitSha` + `pool.idleCount`). Zero writes. `critical-alert.js` events persist to `critical_alert_log` (`alert_key, status_code, error, message, sent_at`) — that's the source for the System "critical-alert feed."

---

## 5. RLS status + security posture

- **RLS: DISABLED on all 61 base tables** (`relrowsecurity=false`, `relforcerowsecurity=false`), **zero `pg_policies`.** Prior P0 confirmed still open. All isolation is app-layer JWT only. Because the app uses a full-access Postgres role over the pooler, the `/api/v1/admin/` superadmin gate is the sole barrier between a stolen token and *all* patient medical data. **REPORTED ONLY — not changed.** Flag for a separate RLS decision; an admin phone client raises the stakes.
- **Superadmin gate to reuse:** `requireJWT` + `requireRole('superadmin')` from `src/middleware/requireJWT.js`. (EJS routes use a different `requireRole` in `src/middleware.js:282` that redirects to `/login` — not for the API.)
- **Single account:** exactly **1** superadmin — `ziad.wahsh@shifaegypt.com` (id `d1d04fb8-…`). ⚠️ **This is NOT your personal `ziadelwahsh1122@gmail.com`.** The app must authenticate the Shifa-domain account. Belt-and-suspenders: add a `SUPERADMIN_EMAIL`/`SUPERADMIN_ID` env allowlist checked on every admin request, on top of the role gate. (Prior note: a superadmin and a patient may share one EG phone — keep the admin login email/password-based, not phone-OTP, to avoid that collision.)
- **Token integrity:** signed/verified with `JWT_SECRET`; no in-life role revocation (acceptable for a 1-account model + short TTL; optionally a `role_version` check to kill all tokens on demotion).
- **Audit-on-read:** `logAdminAudit()` → `error_logs` (async, best-effort). Cheap; call (without `await`) on every admin GET. Add retention + remember the System crash-feed must exclude `category='admin_audit'`.

**RLS: flagged, NOT changed.** 🔒 **HARD GATE for v2:** no v2 write endpoint (force-assign, nudge, approve, mute, refund) ships until a dedicated RLS phase is completed. Recorded as a launch/scope prerequisite, not a v1 blocker.

---

## 6. What v1 actually needs to build on the backend (revised from the brief)

1. ✅ ~~Worker-heartbeat plumbing~~ — **already exists** (`agent_heartbeats`). Just read it.
2. 🔴 **Superadmin mobile login** — new `POST /api/v1/admin/auth/login` (+ `/refresh`) using `users.password_hash` (bcrypt) restricted to `role='superadmin'`, issuing **short-lived** tokens. *The existing patient login cannot serve superadmins.*
3. 🟡 **`/api/v1/admin/` read namespace** — superadmin-gated routes mirroring `superadmin_dashboard.js` aggregations, emitting the `res.ok/res.fail` envelope.
4. 🟡 **Admin push helpers** — Expo send templates for breach / worker-down / new-doctor; superadmin push-token register route.
5. 🟢 **Audit-on-read** — wire `logAdminAudit()` into admin GETs (+ error_logs retention + crash-feed filter).

---

## 7. Proposed endpoint → data-source map (confirm at build)

| Endpoint | Primary sources |
|---|---|
| `GET /admin/health` | `agent_heartbeats`, `/__version` `gitSha`+`startedAtIso`, pool metrics |
| `GET /admin/pulse` | counters over `orders_active` by `status`/`deadline_at`; today's money from `orders`(`paid_at`,`payment_status`); pending approvals `users(pending_approval, role='doctor')` |
| `GET /admin/sla-danger` | `orders_active` where assigned & `deadline_at` near/over, sorted asc; join `users` for doctor name |
| `GET /admin/anomalies` | server-side checks on `orders_active` (paid-but-draft, submitted-stale, payment/status mismatch) |
| `GET /admin/cases`,`/:id`,`/messages` | `orders_active`, `order_timeline`(+`order_events`?), `users`, `conversations`/`messages` |
| `GET /admin/cases/:id/files`,`/report` | `order_files`/`case_files` + R2 presign (`src/storage.js`) |
| `GET /admin/finance` | `orders`(revenue, `paid_at`), `doctor_earnings`(⚠️ confirm mapping), `payment_events` |
| `GET /admin/refunds-owed` | `refund_eligibility.js` over `orders` + `refunds` ledger |
| `GET /admin/doctors`,`/:id`,`/pending` | `users`(role doctor), `doctor_specialties`, `orders_active`(load), `reviews`(rating) |
| `GET /admin/growth` | `users`, `app_analytics_events`/`pre_launch_leads`, `reviews` |

---

## 8. Open decisions for you (not blocking — your call)

1. **Admin login auth model:** email + `password_hash` (bcrypt), `role='superadmin'` only — confirm. (Recommend email/password over phone-OTP given the shared-phone note.)
2. **Token TTLs for admin:** propose access **5m** / refresh **12–24h** (vs patient 15m/30d). Confirm window.
3. **`doctor_earnings` is appointment-keyed and empty** — is "pending payouts" computed from `earnings_writer.js` over orders, or strictly this table? Affects Finance screen.
4. **Refund-owed source:** computed via `refund_eligibility.js` vs read from `refunds` rows (currently 0). Confirm before Finance build.
5. **Status vocabulary** comes from `case_lifecycle.js` state machine, not live data — OK to derive the Cases filter/color-map from code?
6. **Timeline source:** `order_timeline` vs `order_events` for case detail (both exist).
7. **RLS:** separate decision — leave disabled for v1 (gate at app layer) or schedule an RLS phase before the phone pulls patient data?
8. **Bundle ID / repo name** (`com.tashkheesa.admin`) and **TestFlight-internal-only vs App Store listing** — your call (§10 of brief).

---

---

## 9. Decisions (approved 2026-06-14)

1. **Admin login:** email + `users.password_hash` (bcrypt), hard-gated to `role='superadmin'` AND the Shifa account `ziad.wahsh@shifaegypt.com` (email allowlist via `SUPERADMIN_EMAIL`). New `POST /api/v1/admin/auth/login`.
2. **Token TTLs:** access **15m** / refresh **12h** (`generateAdminTokens`). Biometric-on-resume is the real second factor.
3. **Finance pending payouts:** compute via `earnings_writer.js` logic over `orders_active`, NOT the empty `doctor_earnings` table.
   - **Reported finding (decision 3, not fixed):** the writer is correctly wired at all three P0-FIN-1 sites (`writePendingForCase` @ acceptance, `markCaseEarningsPaid` @ completion, `recomputeOnBreach` @ breach) but has **NEVER fired in prod** — `doctor_earnings`/`addon_earnings` are empty and zero `%earning%` events exist in `order_events`. The only "completed" order is a demo seed (`demo-order-completed-001`, `accepted_at=null`). Not a bug — no real case has completed the doctor accept→complete lifecycle yet. **Re-verify after the first real post-launch completion** (or a prod-schema-clone lifecycle run).
4. **Refund-owed:** compute via `refund_eligibility.js` over orders, NOT the empty `refunds` ledger.
5. **Status vocabulary:** derive the Cases filter set + color map from the `case_lifecycle.js` state machine, not live test data.
6. **RLS:** leave disabled for v1; **HARD prerequisite for v2** (see §5).
7. **App packaging:** bundle `com.tashkheesa.admin`, **TestFlight-internal only**, no App Store listing. (Bundle-ID availability to be confirmed by Ziad.)

## 10. Phase 1 status (backend) — IMPLEMENTED, verified, awaiting diff review

Built in this repo (the backend); the Expo app is a separate repo, started once the bundle ID is confirmed.

**Code:** `src/routes/api/admin.js` (login + refresh + health), `src/services/admin_health.js` (pure liveness helpers), `generateAdminTokens` in `src/middleware/requireJWT.js`, mounted in `src/routes/api_v1.js` (before the patient gate, strict limiter on `/admin/auth`), deploy meta threaded from `src/server.js`. TDD: `tests/admin/admin_command_api.test.js` (14 tests).

**Verified:** 14/14 tests green; full `api_v1` wiring (admin 200 superadmin / 403 patient; patient routes still 401); real prod `GET /api/v1/admin/health` → 200 reading live `agent_heartbeats`; no-token → 401; wrong-password login on the real Shifa account → 401 (read-only).

**Ops observation from verification:** at verify time both workers read stale (~3h; last ping ~07:28 UTC) — consistent with the Render free-tier instance sleeping on idle, which pauses the in-process cron workers. Two follow-ups came out of this:
- **(app, DONE in Phase 1):** the worker pills now report a tri-state — `alive` (green) / `starting` (grey: instance recently woke, worker warming up) / `down` (red: instance up well past the worker's budget yet still no ping). This stops free-tier idle-sleep from firing false-RED alarms. See `workerLiveness` in `src/services/admin_health.js`.
- **(infra, LAUNCH PREREQUISITE — flagged, NOT fixed):** see §11.

**Auth-infra note:** login/refresh perform the ONE write in an otherwise read-only v1 — rotating the superadmin's own `users.refresh_token` (enables server-side revocation; mirrors the patient pattern). A stateless-refresh variant (zero writes, no revocation) is available if preferred — flag at diff review.

## 11. Launch prerequisites surfaced by this work

These are NOT v1-app blockers and were NOT fixed here — recorded so they aren't lost.

1. 🔴 **Always-on worker execution before real Paymob traffic.** The SLA sweep (`case_sla_worker`) and acceptance auto-assign (`acceptance_watcher`) run as in-process `node-cron` jobs. On the current Render free-tier instance they **pause whenever the instance sleeps on idle** — verification showed both ~3h stale. That means SLA breach detection and unassigned-case auto-assignment **do not fire while the instance is asleep**. Fine for a pre-launch test box; a **launch blocker once real money/cases flow**. Fix before launch: an always-on instance (paid tier / health-ping keepalive) **or** move these workers to an external scheduler. *(The app's worker pills will correctly show this as `down` once the instance is long-up and still not pinging.)*
2. 🔴 **RLS phase before any v2 write endpoint** (see §5).

*Phase 0 audit + Phase 1 backend complete. No schema or RLS modified. Worker pills now distinguish idle-warmup from real failure. Stopping after `/admin/health` per instruction.*
