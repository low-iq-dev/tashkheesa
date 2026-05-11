# Theme 8 — Ops Blindness: Fix Plan

**Date:** 2026-05-11
**Author:** Claude Opus 4.7 (1M context)
**Working tree HEAD:** `de15753` (Theme 7b Phase 3 shipped — refund queue live; Themes 6 + 7 + 7b fully shipped)
**Sources:** `docs/audits/COMPREHENSIVE_PRE_LAUNCH_AUDIT_2026-05-06.md` §07 Errors/Obs (P0-ERR-1..6, P1-ERR-7..23, P2-ERR-24..37, P3-ERR-38..47); `docs/audits/THEME_06_WORKER_BUGS_FIX_PLAN.md` (OQ-2 SKIP LOCKED deferral, OQ-6 transient sweep error logging); `docs/audits/THEME_07_STATE_MACHINE_FIX_PLAN.md` (SLA_PAUSE_SKIPPED forensics from migration 047); plus targeted live-codebase reads of `src/logger.js`, `src/routes/{patient,doctor,superadmin,ops,payments}.js`, `src/notify.js`, `src/notification_worker.js`, `src/case_sla_worker.js`, `src/video_scheduler.js`, `src/workers/acceptance_watcher.js`, `src/instagram/scheduler.js`, `src/jobs/*.js`, `src/case_lifecycle.js`, `src/services/{emailService,paymob,sla_breach}.js`, `src/notify/{whatsapp,broadcast}.js`, `src/storage.js`, `src/critical-alert.js`, `src/views/ops-dashboard.ejs` against the live `de15753` codebase.

> Scoping document only. **No source files have been modified.** Code snippets in §3 are *proposed*, not applied.

---

## ⚠️ ALERT — Two cross-theme decisions need Ziad's sign-off before §3 lands

1. **SKIP LOCKED for `notification_worker` was explicitly deferred from Theme 6 (sub-issue D commit `3d6f05f`, OQ-2 deferral note in the commit message) to Theme 8.** It is *not* an ops-observability concern in the strict sense — it is a worker concurrency hardening item. The fix-plan here recommends keeping it in Theme 8 because (a) it is small (~15-line query change + one regression test), (b) it shares testing scaffold with the notification-worker visibility widget proposed in §3-G, and (c) deferring it again would leave a documented gap unaddressed at launch. The alternative — spinning it into a separate Theme 6b — adds planning overhead for one query change. **§3-G keeps it bundled; OQ-5 confirms.**

2. **`logErrorToDb` does not write `error_logs.category` today.** Five callers (`admin_audit.js`, `emailService.js`, `notify/whatsapp.js`, `auto_assign.js`, `services/doctor_pause.js` + one inline at `routes/admin.js:1814`) bypass `logErrorToDb` and write directly to the table to populate `category`. The §3-B remediation is to add the column to `logErrorToDb`'s INSERT and have callers pass it via `context.category`. That requires Ziad to decide whether the five direct-INSERT sites should also be migrated to `logErrorToDb` (consolidation = cleaner; risk = changes audit-row shape for `admin_audit` which is read by ops/permission-audit flows). Recommendation: keep the direct INSERTs as-is and only fix `logErrorToDb` (the dominant case). **OQ-3 confirms.**

---

## 1. Executive summary

The platform's three highest-traffic route files — `routes/patient.js` (3,314 LoC, 66 catch blocks, 17 `console.error` sites), `routes/doctor.js` (4,395 LoC, 106 catch blocks, 14 `console.error` sites), and `routes/superadmin.js` (3,368 LoC, 57 catch blocks, 8 `console.error` sites) — call `logErrorToDb` **zero times each** (verified live: `grep -c "logErrorToDb" src/routes/{patient,doctor,superadmin}.js` = `0 0 0`). Every catch in these files writes only to Render stdout, where lines are unstructured, lack `req.requestId` correlation past the access-log line, and cannot be queried from `/ops/errors`. Combined with two adjacent silent-failure paths — (a) `notify.js queueNotification` swallows DB-insert failures into a returned `{ ok:false, skipped:true, reason:'db_insert_failed' }` that ~50 fire-and-forget callers ignore (verified: `grep -c "queueNotification(" src/` = 61); (b) `logger.fatal` is still `(...args) => console.error('[' + MODE + ']', ...args)` with no DB write — most of the user-facing application runs blind in production.

The cost of this blindness was paid retroactively last week. Migration `047_alias_awaiting_files_to_rejected_files.sql:51-52` documents that `SLA_PAUSE_SKIPPED { reason: 'columns_missing' }` and `SLA_RESUME_SKIPPED` events were emitted to `case_events` *every time a doctor rejected files for months*, because `orders.sla_paused_at` and `orders.sla_remaining_seconds` were never added (`pauseSla`/`resumeSla` short-circuited at `case_lifecycle.js:1606,1636` and emitted the SKIPPED event instead of pausing). **Nothing surfaces SKIPPED-suffix case_events to /ops.** The bug was only caught when Theme 7 Phase 3's schema migration tried to write to the missing column. A similar pattern hit `video_scheduler.sweepStalePendingSlots` (Theme 6 sub-issue D, commit `3d6f05f`): three `queueNotification` calls had `userId:` instead of `toUserId:` and `type:` instead of `channel:`, so every patient + admin notification on a 24h/48h stale-slot auto-cancel was silently dropped at `notify.js:233` for the lifetime of the feature. Both bugs would have been caught by a `/ops/silent-failures` view or by `logErrorToDb` writes from the swallow paths.

**Sub-issue A** (route catches) — wrap every meaningful catch in `routes/patient.js`, `routes/doctor.js`, `routes/superadmin.js` with `logErrorToDb(err, { context, requestId: req.requestId, userId: req.user?.id, url: req.originalUrl, method: req.method, category: '<route-tag>' })`. Net new INSERTs ≈ 39 (17 + 14 + 8); the remainder are truly best-effort no-ops (empty-catch JSON parses, optional column reads, fire-and-forget logOrderEvent at handler entry) that should keep `catch (_) {}`. The §3-A inventory enumerates exactly which 39 sites get the wrap and which keep their no-op form.

**Sub-issue B** (`error_logs.category`) — fix `logger.js:136-140` to include `category` in the INSERT, defaulting to `context.category || null`. The partial index `idx_error_logs_category` (migration 035) is then usable for the first time. Five direct-INSERT callers (`admin_audit.js`, `emailService.js`, `notify/whatsapp.js`, `auto_assign.js`, `doctor_pause.js`, `routes/admin.js:1814`) are left untouched — they already populate the column correctly and changing them would risk audit-row shape regressions read elsewhere.

**Sub-issue C** (`queueNotification` swallow) — at `notify.js:340-350`, replace `console.error('[notify] queueNotification insert failed', err)` with a `logErrorToDb` write (category=`notification_queue_failure`). Also wrap the three `skipped:true` early returns (`invalid_to_user_id`, `no_phone`, `whatsapp_opted_out`, `no_email`) with a single counter row in `case_events`/`order_events` when the caller passed an `orderId` so an operator can see *which orders silently lost their notification*. The §3-C proposal extends the existing per-recipient dedupe-key shape rather than adding a new table.

**Sub-issue D** (worker error visibility) — six worker files (`case_sla_worker.js`, `notification_worker.js`, `video_scheduler.js`, `instagram/scheduler.js`, `workers/acceptance_watcher.js`, `sla_worker.js`, `jobs/sla_watcher.js`, `jobs/appointment_reminders.js`) currently mix three patterns: (i) `case_sla_worker` correctly calls `logErrorToDb` on the three fetch failures (added in Theme 7 Phase 2) but `logFatal` on every per-candidate handler failure (`handleBreach`, `handleDoctorTimeout`, `handlePreBreach` — lines 467, 475, 483) — and `logFatal` is just `console.error`; (ii) `notification_worker.js` writes zero `logErrorToDb` calls and three `console.error` sites; (iii) `video_scheduler.js`, `acceptance_watcher.js`, `instagram/scheduler.js`, `sla_worker.js`, `jobs/appointment_reminders.js` mostly `console.error`. The unified pattern in §3-D is: every worker catch routes through `logErrorToDb(err, { context: '<worker>:<phase>', category: 'worker', candidateId })` AND the existing `logFatal` is rewritten to be `logErrorToDb` + critical-alert (vs. its current bare `console.error`).

**Sub-issue E** (silent-failure surface) — three event labels in `case_events` represent code paths that ran but did nothing useful: `SLA_PAUSE_SKIPPED`, `SLA_RESUME_SKIPPED` (case_lifecycle.js:1608, 1638 — the months-of-silent-no-op bug class), and `CASE_REASSIGNMENT_FAILED` (case_sla_worker.js:332, 389). Build a `/ops/silent-failures` view that surfaces a COUNT and recent-10 view of any case_events row with a suffix in `('_SKIPPED', '_FAILED', '_NO_OP', '_DROPPED')`. The view is one route handler (~30 lines) + one new EJS template modelled on `ops-errors.ejs`. **This is the highest-ROI item in Theme 8 by past-incident count.**

**Sub-issue F** (webhook/integration visibility) — Paymob webhook + HMAC are already wired to `logErrorToDb` (verified: `payments.js:150,178,183,225,564`). WhatsApp send failures call `logWhatsAppError` which writes category=`whatsapp_send` (verified: `notify/whatsapp.js:28-50`). Resend lifecycle `sendMail()` does NOT call `_logEmailError` (verified: `emailService.js:543,559` — only `console.error`); only the templated `sendEmail()` path writes to error_logs. **Resend lifecycle gaps + R2 (`storage.js:93` is `console.error` only) + Uploadcare client-side failures (currently invisible) are the three integration gaps requiring fixes.** Twilio Verify failures (`services/twilio_verify.js:63,95`) also go to console only.

**Sub-issue G** (/ops dashboard gaps) — the dashboard surfaces 14 widget groups today (system bar, today's snapshot, MTD platform, recent activity, errors 24h, payment health, paymob health, notification status pills MTD, agents, IG pipeline, quick links — verified in `views/ops-dashboard.ejs:1-403` and `routes/ops.js:264-559`). The gaps that map directly to yesterday's bug class are: (i) silent-failures counter (sub-issue E); (ii) notification queue depth + oldest-stuck age + dispatched-vs-skipped split (currently `result.skipped → status='sent'` per `notification_worker.js:241` per P1-ERR-16); (iii) worker last-run age per cron (currently all rolled into a single "care-agent" heartbeat); (iv) error rate baseline + 5x threshold alert; (v) critical-alert delivery health (the WhatsApp pipe itself can be broken; today it is fire-and-forget — `critical-alert.js:53,57`). The §3-G widget add-pack is six widgets.

**SKIP LOCKED bundling decision** — recommend **bundle into Theme 8 Phase 4** (~15-line query change at `notification_worker.js:206-213` from `ORDER BY at ASC LIMIT $2` to `ORDER BY at ASC LIMIT $2 FOR UPDATE SKIP LOCKED` + atomic UPDATE-to-`processing` returning the row; plus one regression test). Keeping it separate adds planning overhead for one query change and the testing scaffold overlaps with §3-G's queue-depth widget. **§3-D + §3-G land it; OQ-5 confirms.**

**Estimated effort**: A (4h — 39 catch-wraps), B (30min — single INSERT change), C (1h — notify.js wrapper + 2 callers updated), D (4h — 6 worker files), E (3h — silent-failures view + route + EJS), F (2h — 4 integration sites), G (4h — six new widgets), SKIP LOCKED (1h — query + test). **Total ≈ 19.5h** (~3 days). Phase order in §4. Not blocking: full migration to structured JSON logging (`pino`) — flagged as P3-OBS-NEW1 in §3-G, scoped to a later cycle.

---

## 2. Current state

### 2-A. The three highest-traffic route files write zero rows to error_logs

**Verified via live grep (working tree HEAD `de15753`, 2026-05-11):**

```
$ wc -l src/routes/patient.js src/routes/doctor.js src/routes/superadmin.js
    3314 src/routes/patient.js
    4395 src/routes/doctor.js
    3368 src/routes/superadmin.js

$ grep -c "logErrorToDb" src/routes/patient.js src/routes/doctor.js src/routes/superadmin.js
src/routes/patient.js:0
src/routes/doctor.js:0
src/routes/superadmin.js:0

$ grep -cP "catch\s*\(" src/routes/patient.js src/routes/doctor.js src/routes/superadmin.js
src/routes/patient.js:66
src/routes/doctor.js:106
src/routes/superadmin.js:57
```

229 catch blocks across the three files. **None** of them write to `error_logs`. The breakdown by intent:

| File | catch sites | `console.error` sites | empty `catch (_) {}` | sites that SHOULD log to DB |
|---|---|---|---|---|
| `routes/patient.js` | 66 | 17 | 49 | 17 (the console.error sites — wizard, upload, payment, messages, refunds) |
| `routes/doctor.js` | 106 | 14 | 92 | 14 (the console.error sites — accept, reject-files, profile, diagnosis, signature, photo) |
| `routes/superadmin.js` | 57 | 8 | 49 | 8 (the console.error sites — sla check, additional-files approve, more-info-requested, doctor-approve, doctor-resend-welcome, case cancel, recalcSlaBreaches sweep ×2) |
| **Total** | **229** | **39** | **190** | **39** |

The 190 empty-catch sites are mostly intentional best-effort swallows (JSON.parse fallbacks, optional-column reads, post-success notify dispatches that should not fail the response). These keep their `catch (_) {}` form in §3-A; only the 39 console.error sites get wrapped.

**Sample console.error sites in `patient.js` (verified live):**

```
529   console.error('[alerts.json] fetch failed', e && e.message ? e.message : e);
561   console.error('[alerts mark-all-read] failed', e && e.message ? e.message : e);
608   console.error('[alerts mark-read] failed', e && e.message ? e.message : e);
930   console.error('AI analysis error:', error);
1015  console.error('[dashboard] order fetch failed', e && e.message ? e.message : e);
1408  console.error('[new-case step1] failed', e && e.message ? e.message : e);
1818  console.error('[stub-payment] markCasePaid failed', e && e.message ? e.message : e);
2044  console.error('[patient new-case] failed', err);
2288  console.error('[patient order create] failed', err);
2496  console.error('[payment_backfill_failed]', { orderId: order.id, error: String(e) });
2812  console.error('[patient-refund-request] insert failed', err);     ← NEW (Theme 7b Phase 2)
2910  console.error('[patient-refund-cancel] delete failed', err);      ← NEW (Theme 7b Phase 2)
2986  console.error('[v2-messages] ensureConversation failed', e && e.message ? e.message : e);
3019  console.error('[v2-messages] insert failed', e && e.message ? e.message : e);
```

Note: Theme 7b Phase 2 (commit `6b2ba5e`) added two more `console.error` sites in the new patient refund flow without `logErrorToDb` — confirms the pattern is still being propagated as new features land.

**Sample sites in `doctor.js`:**

```
1944  console.error('[doctor.accept] capacity-reassign failed:', err && err.message);
2013  console.error('[doctor.accept] transitionCase failed:', err && err.message);
2043  console.error('[earnings] writePendingForCase failed', e && e.message ? e.message : e);
2196  console.error('[doctor.reject-files] pauseSla failed:', err && err.message);
2220  console.error('[DOCTOR] reject-files error:', err.message);
2290  console.error('[DOCTOR] save diagnosis error:', err.message);
2634  console.error('[doctor-profile] update error for user ' + req.user.id + ':', ...);
2736  console.error('[doctor-profile-photo] upload/save error for user ' + req.user.id + ':', ...);
2754  console.error('[doctor-profile-photo] remove error for user ' + req.user.id + ':', ...);
2852  console.error('[doctor-profile-signature] upload/save error for user ' + req.user.id + ':', ...);
```

**Sample sites in `superadmin.js`:**

```
586   console.error('[performSlaCheck] delegation to runCaseSlaSweep failed:', err && err.message);
992   console.error('[recalcSlaBreaches] sweep failed:', err);
1746  console.error('[superadmin.additional-files.approve] markOrderRejectedFiles failed:', err && err.message);
1805  console.error('[EMAIL] notifyMoreInfoRequested failed:', err && err.message);
2183  console.error('[doctor-approve] token issuance failed:', err && err.message ? err.message : err);
2219  console.error('[doctor-resend-welcome] token issuance failed:', err && err.message ? err.message : err);
2716  console.error('[EMAIL] notifyCaseCancelled failed:', err && err.message);
2807  console.error('[recalcSlaBreaches] sweep failed:', err);
```

**Impact:** when a patient hits an error in dashboard, wizard, upload, payment, message, or refund-request; when a doctor accepts, rejects-files, saves diagnosis, updates profile, uploads photo, uploads signature; when a superadmin approves files, sends more-info-request, approves a doctor, cancels a case, runs an SLA sweep — **ops gets no `/ops/errors` row**. The error appears only in Render's unstructured stdout. Pattern detection ("all wizard step 5 calls failing since 14:30") is impossible.

### 2-B. `error_logs.category` populated by 6 callers — `logErrorToDb` itself never sets it

**Verified live:**

```
$ grep -n "INSERT INTO error_logs" src/
src/logger.js:137              ← canonical writer, omits category column
src/auto_assign.js:51          ← writes category='sla_routing'
src/notify/whatsapp.js:45      ← writes category='whatsapp_send'
src/routes/admin.js:1814       ← writes category='admin_audit' (national_id_view)
src/services/admin_audit.js:43 ← writes category='admin_audit'
src/services/doctor_pause.js:94 ← writes category='admin_audit' (auto-pause audit)
src/services/emailService.js:76 ← writes category='email_send'
```

**Canonical writer at `src/logger.js:136-140` (verified live):**

```js
await execute(
  `INSERT INTO error_logs (id, error_id, level, message, stack, context, request_id, user_id, url, method)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
  [id, errorId, level, message, stack, JSON.stringify(safeContext), requestId, userId, url, method]
);
```

The INSERT statement does NOT include `category`. Every caller using `logErrorToDb()` therefore writes `category=NULL` regardless of what they pass in `context.category` (the field is just stuffed into the `context` JSON blob, not the column).

**Migration 035 intent (`src/migrations/035_error_logs_category.sql:21-25`):**

```sql
CREATE INDEX IF NOT EXISTS idx_error_logs_category
  ON error_logs(category)
  WHERE category IS NOT NULL;
```

The partial index is unused for ~99% of rows. `/ops/errors` filter UI cannot filter by source.

**Backfill posture (intentional):** migration 035 explicitly does NOT backfill old rows. That decision is correct — but only if new rows start populating `category`. They don't.

### 2-C. `queueNotification` DB-insert failure → console.error + swallowed return

**`src/notify.js:340-350` (verified live):**

```js
try {
  await execute(
    `INSERT INTO notifications (...)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false)`,
    [...]
  );
  return { ok: true, id: notifId };
} catch (err) {
  console.error('[notify] queueNotification insert failed', err);
  return {
    ok: false,
    skipped: true,
    reason: 'db_insert_failed',
    error: err && err.message ? err.message : String(err)
  };
}
```

**Call sites:** `grep -c "queueNotification(" src/` = **61**. None of the 61 callers check the return value before reporting user-facing success. Sampled callers (live):

- `routes/public_orders.js:171` — patient submits case → confirmation
- `routes/patient.js:2285` — new-case wizard create
- `routes/doctor.js` — multiple accept/reject paths
- `services/sla_breach.js` — SLA breach refund notification
- `video_scheduler.js` — 5-min reminder + 48h auto-cancel (post-Theme-6-fix)
- `server.js:1047` — SLA reminder cron
- `notify.js:476,582` — internal helpers fan-out

If the `notifications` table is broken (trigger blocks insert, dedupe-key UNIQUE conflict from schema drift, pool exhausted), the user-facing operation that depends on the notification (case created, doctor assigned, payment received) shows success, but no email/WhatsApp/in-app notification is ever delivered. **The console.error line is the only signal.**

**Adjacent silent paths (verified live `src/notify.js:233,543,569,572,577`):**

```js
return { ok: false, skipped: true, reason: 'invalid_to_user_id', toUserId };       // queueNotification line 233
return { ok: false, skipped: true, reason: 'invalid_to_user_id', toUserId };       // queueMultiChannelNotification line 543
return Promise.resolve([ch, { ok: true, skipped: true, reason: 'no_phone' }]);     // whatsapp branch line 569
return Promise.resolve([ch, { ok: true, skipped: true, reason: 'whatsapp_opted_out' }]); // line 572
return Promise.resolve([ch, { ok: true, skipped: true, reason: 'no_email' }]);     // line 577
```

These are the silent-drop reasons that hit the `video_scheduler` bug class (the `userId:` vs `toUserId:` typos in commit `3d6f05f` all dropped at the first `invalid_to_user_id` branch). Currently invisible to ops.

### 2-D. Worker error visibility — inconsistent, mostly console-only

**Verified live — error logging patterns per worker:**

| Worker | `logErrorToDb` calls | `console.error` calls | `logFatal` calls | Notes |
|---|---|---|---|---|
| `src/case_sla_worker.js` | 3 (fetch failures only — lines 432, 442, 453) | 1 (line 155, dispatched-but-not-reassigned) | 8 (boot + per-candidate handlers at 435, 445, 456, 467, 475, 483, 523, 525) | Theme 7 Phase 2 added the fetch wrappers; per-candidate handlers still go to `logFatal` (= `console.error`). |
| `src/notification_worker.js` | 0 | 3 (lines 223, 278, 295) | 0 | The most-trafficked worker has zero DB error rows; failed deliveries are visible only via `notifications.status='failed'` rows, but P1-ERR-16 (still live) treats `result.skipped` as `'sent'`. |
| `src/video_scheduler.js` | 0 | 3 (lines 93, 209, 319) | 0 | Three sweep functions, three console-only catches. The bug class fixed in Theme 6 commit `3d6f05f` was downstream of this same blindness. |
| `src/instagram/scheduler.js` | 0 | 3 (lines 32, 38, 105) | 0 | All scheduled post failures go to stdout only. |
| `src/workers/acceptance_watcher.js` | 0 | 2 (lines 37, 41) | 0 | Doctor-acceptance timeout sweep — failures invisible. |
| `src/sla_worker.js` | 0 | 1 (line 202) | 0 | Legacy SLA worker (case_sla_worker is canonical; this one is deprecated but still loaded). |
| `src/jobs/sla_watcher.js` | (not surveyed in this scoping; flagged for inspection in §3-D) | — | — | — |
| `src/jobs/appointment_reminders.js` | 1 (line 68) | 0 (uses logErrorToDb properly) | 0 | **Only worker that does it right today.** Used as the §3-D template. |

**`logFatal` is just `console.error` (verified `src/logger.js:13`):**

```js
const fatal = (...args) => console.error(`[${MODE}]`, ...args);
```

No DB write, no critical-alert. Authors importing `logFatal` (intentionally or by import-shorthand) get *less* observability than `logError`. The case_sla_worker per-candidate handler failures at lines 467, 475, 483 — i.e. every time `handleBreach()`, `handleDoctorTimeout()`, or `handlePreBreach()` throws for a specific candidate — go to stdout only.

### 2-E. SKIPPED-suffix events: silent-failure surface that exists in DB but has no UI

**Verified live — `case_events` rows that mean "code ran but did nothing useful":**

| Label | Emitted at | Reason | Observable today? |
|---|---|---|---|
| `SLA_PAUSE_SKIPPED` | `case_lifecycle.js:1608` | `orders.sla_paused_at`/`sla_remaining_seconds` columns missing (fixed by migration 047 but defensive event remains) | NO — no `/ops` widget queries case_events |
| `SLA_RESUME_SKIPPED` | `case_lifecycle.js:1638` | Same — columns missing | NO |
| `CASE_REASSIGNMENT_FAILED` | `case_sla_worker.js:332,389` | `reason: 'no_doctor_available'` after breach or timeout | NO |
| `ADMIN_NOTIFIED` | `case_sla_worker.js:336,397,408` | Often follows REASSIGNMENT_FAILED — actual notification dispatch is in a separate code path that may itself fail silently | Partially — the row is written, but no widget surfaces "ADMIN_NOTIFIED count > queueNotification success count" gap |

**Forensic value (live evidence from `migrations/047_alias_awaiting_files_to_rejected_files.sql:43-53`):**

> "Production has been silently no-op'ing pauseSla()/resumeSla() since the runtime gating at case_lifecycle.js:1606 / :1636 was added; every call has emitted `SLA_PAUSE_SKIPPED { reason: 'columns_missing' }` or `SLA_RESUME_SKIPPED` to case_events instead of actually pausing."

That's months of production data sitting in `case_events` saying "I tried to do something but couldn't." There was no widget that surfaced it. The bug was caught only when Theme 7 Phase 3's schema migration tried to write to the missing column and failed at deploy.

### 2-F. Webhook + integration error visibility — partial coverage

**Verified live:**

| Integration | `logErrorToDb` writes? | Notes |
|---|---|---|
| **Paymob webhook (`routes/payments.js`)** | YES — 6 sites (lines 150, 178, 183, 225, 564) | Full coverage. HMAC failures additionally fire `sendCriticalAlert` (line 231). Already gold-standard for the platform. |
| **Paymob `createIntention`** | YES — `services/paymob.js:237` (`category` set in context but not in column per §2-B) | OK. |
| **WhatsApp send** | YES — via `logWhatsAppError` at `notify/whatsapp.js:28-50` → writes `category='whatsapp_send'` directly to error_logs | OK. Token-expiry path documented in P0-INT-17 — logs to DB but no alert fires; see Theme 9 plan. |
| **Resend lifecycle (`sendMail`)** | NO — `services/emailService.js:543,559` only `console.error` | **Gap.** The `sendMail()` path used by all lifecycle notifications (case received, doctor accepted, etc.) does not call `_logEmailError`. Only the `sendEmail()` templated path writes to DB. |
| **Resend templated (`sendEmail`)** | YES — `_logEmailError` at lines 154, 220, 311, 381, 406, 417, 441, 455, 465 | OK. |
| **R2 (Cloudflare storage, `src/storage.js`)** | NO — line 93 only `console.error` on bucket-connect failure | **Gap.** Upload/download failures inside route handlers are caught at the route level (so they hit patient.js/doctor.js — but per §2-A those don't log either). Two-layer blindness. |
| **Uploadcare** | NO — client-side; failures invisible | Currently the standalone-uploader form posts errors return via `?error=` query params (some of which are not rendered — P1-ERR-12). No client-side error reporting endpoint exists. |
| **Twilio Verify (OTP)** | NO — `services/twilio_verify.js:63,95` only `console.error` | **Gap.** OTP send/verify failures are user-blocking but invisible to ops. |
| **WhatsApp OTP fallback** | NO — `services/whatsapp_otp.js:101` only `console.error` | **Gap.** |

### 2-G. `/ops` dashboard widget inventory and gaps

**Verified live — widgets present (`src/views/ops-dashboard.ejs` + `src/routes/ops.js:264-559`):**

System bar: Uptime · Mode · SLA mode · Node version · Heap MB · RSS MB · DB pool active/total · Git SHA · Mac mini gateway status.
Today: cases · revenue · new patients · errors today.
MTD platform: cases · completed · revenue · revenue-all-time · pending · breached SLA · near-breach (<2h) · avg completion hrs · active/total doctors · total patients.
Recent activity: last 10 orders (status, price, patient, specialty).
Errors 24h: total count · breakdown by level · recent 10 errors with click-through to `/ops/errors/:id`.
Payment health: unpaid orders · failed payments.
Paymob: lastIntention age · lastWebhook age · HMAC failures 24h.
Notifications: status pills MTD.
Agents: heartbeat status · last task · last seen · tokens MTD · cost MTD · enable-toggle.
Instagram pipeline: post-status pills.
Quick links.

**Gaps mapped to yesterday's bug class:**

| Bug | Surfaced today? | What would have caught it |
|---|---|---|
| SLA_PAUSE_SKIPPED silent for months (commit `0a580de` revealed) | NO | A `/ops/silent-failures` view querying `case_events WHERE event_type LIKE '%\_SKIPPED'` (sub-issue E) |
| video_scheduler `userId:` typo dropped all notifications (commit `3d6f05f`) | NO | (a) `logErrorToDb` write inside `queueNotification`'s `invalid_to_user_id` early-return path (sub-issue C); OR (b) a `/ops/notifications-skipped` counter showing skipped-by-reason MTD (sub-issue G) |
| dispatchSlaBreach hardcoded recipient (Theme 7 Phase 2) | NO — would surface as zero rows in dispatched-vs-skipped split | Sub-issue G dispatched-vs-skipped widget |
| awaiting_files orphan rows (Theme 7 Phase 3) | NO — data integrity, not error logging | Out of Theme 8 scope (data-layer audit territory) |
| async-in-setInterval crash pattern (Theme 6 sub-issue B) | NO — `process.exit(1)` resets state before WhatsApp critical-alert lands | Sub-issue G critical-alert delivery health widget + DB-backed throttle (P1-ERR-7) |
| campaigns cron `var ci` hoisting (Theme 6 sub-issue C) | NO — `processCampaign` was called with `undefined`, silently no-op | Cron last-run age widget + per-cron success counter (sub-issue G) |

**Widget gaps surfaced by audit and not yet built:**

1. **Silent-failures counter** (sub-issue E) — SKIPPED/FAILED case_events rolling counts.
2. **Notification queue depth + oldest-stuck age** — `COUNT(*) FROM notifications WHERE status IN ('queued','retry')` + `MIN(at)` of stuck rows. Catches dead worker.
3. **Notification dispatched-vs-skipped split** — currently `result.skipped → status='sent'` (P1-ERR-16 still live at `notification_worker.js:241`). Split into `status='skipped'` with reason and pill it.
4. **Cron last-run age per cron** — campaigns, appointments, SLA sweep, video scheduler, instagram. Today they all heartbeat-ping `care-agent` (verified `notification_worker.js:298-307` etc.) but the rollup is undifferentiated.
5. **Error rate baseline + 5x threshold critical-alert** (P1-ERR-22).
6. **Critical-alert delivery health** — last alert sent age + last status code from Meta (currently swallowed at `critical-alert.js:53,57`).
7. **Resend health** — env present + last successful send age (currently nothing on dashboard).
8. **R2 health** — last successful upload + last bucket-connect status (currently `console.error` only).

---

## 3. Root cause

The platform was built fast under a single-implementer regime where the canonical errors path (`logErrorToDb` writing to `error_logs`, surfaced at `/ops/errors`) shipped at the same time as the route files that should call it. The instinct in subsequent commits was to write `console.error(...)` because it was already imported and worked locally — but the cumulative effect is that the most-trafficked routes have zero DB observability. The same pattern applied to workers and to swallowed return paths in `notify.js`/`queueNotification`. The `category` column was added in migration 035 but never plumbed through `logger.js`, so the indexed-filter affordance is unused.

The silent-failure surface (SKIPPED-suffix `case_events`) is a *correct* defensive pattern that runs ahead of schema; the gap is that no UI surfaces those rows, so the fall-back is invisible to operators. The fix is observational, not behavioral — the events are already being written.

**Why these gaps survived prior audits:** the comprehensive audit (`COMPREHENSIVE_PRE_LAUNCH_AUDIT_2026-05-06.md`) called this out explicitly at Tier 8 (item 39: "routes/patient.js (3,600 LoC, 16 catch sites), doctor.js, superadmin.js never call logErrorToDb"); Theme 6 deferred the `logErrorToDb` routing for transient sweep failures with note OQ-6; Theme 6 deferred SKIP LOCKED for `notification_worker` with note OQ-2. Both deferrals were correct sequencing — but they both pointed at Theme 8 as the destination. **Theme 8 is the catch-all for the deferred observability work.**

---

## 4. Fix plan

Phases are sequenced for testability: small-blast-radius schema/util changes first, then route wraps, then workers, then dashboard.

### Phase 1 — Fix `logErrorToDb` to populate `category` (P0-ERR-5)

**File:** `src/logger.js`
**Change:** add `category` parameter pulled from `context.category`, include in INSERT.
**Estimated effort:** 30 minutes including regression test.

**Proposed code shape:**

```js
async function logErrorToDb(err, context = {}) {
  const errorId = context.errorId || makeId('err');
  try {
    const { execute, queryOne } = require('./pg');
    const tableCheck = await queryOne(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'error_logs'"
    );
    if (!tableCheck) return errorId;

    const id = makeId('elog');
    const message = err && err.message ? String(err.message).slice(0, 2000) : String(err || 'Unknown error').slice(0, 2000);
    const stack = err && err.stack ? String(err.stack).slice(0, 8000) : null;
    const level = context.level || 'error';
    const requestId = context.requestId || context.req?.requestId || null;
    const userId = context.userId || context.req?.user?.id || null;
    const url = context.url || context.req?.originalUrl || null;
    const method = context.method || context.req?.method || null;
    const category = context.category || null;     // NEW

    const skipKeys = new Set(['req', 'res', 'errorId', 'level', 'category']);  // also strip category from JSON blob
    const filteredContext = {};
    Object.keys(context).forEach(k => { if (!skipKeys.has(k)) filteredContext[k] = context[k]; });
    let safeContext = filteredContext;
    try {
      const { maskObject } = require('./utils/mask');
      safeContext = maskObject(filteredContext);
    } catch (e) { /* mask not available */ }

    await execute(
      `INSERT INTO error_logs (id, error_id, level, category, message, stack, context, request_id, user_id, url, method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, errorId, level, category, message, stack, JSON.stringify(safeContext), requestId, userId, url, method]
    );
  } catch (e) {
    console.error('[logErrorToDb] DB write failed:', e.message);
  }
  return errorId;
}
```

**Regression test:** new `tests/core/theme8-logger-category.test.js` that calls `logErrorToDb(new Error('x'), { category: 'test_cat' })` and asserts the inserted row has `category = 'test_cat'`. Test scaffold mirrors `tests/core/theme6-queueNotification-uses-toUserId.test.js` (uses source-grep helpers from Theme 5).

### Phase 2 — Wrap the 39 console.error sites in patient/doctor/superadmin (P0-ERR-2)

**Files:** `src/routes/patient.js`, `src/routes/doctor.js`, `src/routes/superadmin.js`
**Change:** every `console.error('[X] failed', err)` becomes:

```js
console.error('[X] failed', err);   // keep for stdout dev visibility
logErrorToDb(err, {
  context: '<route>:<handler>',     // e.g. 'patient.alerts.mark_all_read'
  category: '<route>',              // 'patient' | 'doctor' | 'superadmin'
  requestId: req.requestId,
  userId: req.user?.id,
  url: req.originalUrl,
  method: req.method
});
```

The 39 sites get the wrap (listed in §2-A). The other 190 `catch (_) {}` sites stay as-is unless a downstream Phase identifies them as load-bearing.

**Estimated effort:** 4 hours (mostly mechanical; need to import `logErrorToDb` at top of each file — not currently imported in any of the three).

**Regression test:** new `tests/core/theme8-route-errlog-coverage.test.js` that lints `src/routes/{patient,doctor,superadmin}.js` for the pattern `console\.error\([^)]*\);(?![\s\S]{0,200}logErrorToDb)` — fails the build if a console.error is not followed by a logErrorToDb call within 200 characters. Excludes empty-catch sites by requiring the console.error to be inside a catch with an `err` parameter (not `(_)`).

### Phase 3 — Fix queueNotification swallow (P0-ERR-3)

**File:** `src/notify.js`
**Change at line 340-350:**

```js
} catch (err) {
  console.error('[notify] queueNotification insert failed', err);
  logErrorToDb(err, {
    context: 'notify.queueNotification.insert',
    category: 'notification_queue_failure',
    orderId,
    toUserId: uid,
    template,
    channel
  });
  return { ok: false, skipped: true, reason: 'db_insert_failed', error: err && err.message ? err.message : String(err) };
}
```

**Additional change at the four `skipped:true` early-return sites (lines 233, 543, 569, 572, 577):** when `orderId` is present, emit a `case_events` row before returning:

```js
if (!uid) {
  if (orderId) {
    try {
      const { logCaseEvent } = require('./case_lifecycle');
      await logCaseEvent(orderId, 'NOTIFICATION_DROPPED', {
        reason: 'invalid_to_user_id',
        toUserId,
        template,
        channel
      });
    } catch (_) { /* logCaseEvent failure is non-blocking */ }
  }
  return { ok: false, skipped: true, reason: 'invalid_to_user_id', toUserId };
}
```

This is the surface that the §3-E silent-failures view will query. The `NOTIFICATION_DROPPED` label is new (not previously emitted by any code path); §6 adds a lint test that searches for new SKIPPED/DROPPED labels and asserts they're documented.

**Estimated effort:** 1 hour.

### Phase 4 — Worker error visibility + SKIP LOCKED (P0-ERR-4, OQ-2, OQ-6)

**Files:** `src/case_sla_worker.js`, `src/notification_worker.js`, `src/video_scheduler.js`, `src/workers/acceptance_watcher.js`, `src/instagram/scheduler.js`, `src/sla_worker.js`, `src/jobs/sla_watcher.js`

**4-A. Make `logFatal` actually log fatally.** `src/logger.js:13`:

```js
const fatal = (...args) => {
  console.error(`[${MODE}]`, ...args);
  // Last arg is conventionally the Error; capture it for DB write.
  const err = args.find(a => a instanceof Error);
  if (err) {
    logErrorToDb(err, { category: 'fatal', level: 'fatal' }).catch(() => {});
  }
  // Optionally: critical-alert. Throttled at the alert layer.
  try { require('./critical-alert').sendCriticalAlert('FATAL: ' + (err ? err.message : args[0])); } catch (_) {}
};
```

This automatically fixes the 8 `logFatal` sites in `case_sla_worker.js` and the 5 in `server.js` without changing call sites.

**4-B. Worker catches that currently use bare `console.error`.** Apply Phase 2's wrap pattern to each worker. Notable per-file:

- `notification_worker.js:223,278,295` — load failure, max-retries-reached, process-failure. All three get `logErrorToDb(err, { category: 'notification_worker', notificationId, template, channel, attempts })`.
- `video_scheduler.js:93,209,319` — three sweep catches. All three get the wrap with `category: 'video_scheduler'` and the per-sweep `phase` (`reminder_dispatch`, `noshow_detection`, `stale_slot_sweep`).
- `instagram/scheduler.js:32,38,105` — same wrap with `category: 'instagram_scheduler'`.
- `workers/acceptance_watcher.js:37,41` — same wrap with `category: 'acceptance_watcher'`.
- `sla_worker.js:202` — legacy worker; deprecate or wrap with `category: 'sla_worker_legacy'`. Recommend: deprecation (OQ-4).

**4-C. `notification_worker` skipped-vs-sent split (P1-ERR-16).** Line 241-246:

```js
if (result.ok) {
  await execute('UPDATE notifications SET status = $1, response = $2 WHERE id = $3', ['sent', JSON.stringify(result), n.id]);
} else if (result.skipped) {
  await execute('UPDATE notifications SET status = $1, response = $2 WHERE id = $3', ['skipped', JSON.stringify(result), n.id]);
} else {
  // ... existing retry path
}
```

Migration `048_notifications_status_skipped.sql` may be needed if the column is a CHECK-constrained enum — verify before applying. (Per `src/migrations/`, the notifications.status column is currently plain TEXT — no constraint update needed.)

**4-D. SKIP LOCKED for `notification_worker` (OQ-2 from Theme 6).** `src/notification_worker.js:204-214`:

```js
notifications = await queryAll(
  `SELECT * FROM notifications
   WHERE status IN ('queued', 'retry')
     AND (retry_after IS NULL OR retry_after <= $1)
   ORDER BY at ASC
   LIMIT $2
   FOR UPDATE SKIP LOCKED`,
  [nowIso, limit]
);
```

For a single-instance Render deployment this is a no-op (no contention possible). It activates if a second instance is ever spun up (scale-out test, accidental dual deploy, manual one-off worker). Pairs with Theme 6 sub-issue A's `SLA_MODE=primary` gating: SKIP LOCKED is the defense-in-depth if the gating ever fails.

**Estimated effort:** 4 hours across all worker files + tests.

### Phase 5 — Silent-failures view at `/ops/silent-failures`

**Files (NEW):** `src/views/ops-silent-failures.ejs`, route handler in `src/routes/ops.js`.

**Route handler shape:**

```js
router.get('/silent-failures', requireOpsAuth, async function (req, res) {
  const counts = await safeAll(`
    SELECT event_type, COUNT(*) as c
      FROM case_events
     WHERE created_at >= NOW() - INTERVAL '7 days'
       AND (event_type LIKE '%\\_SKIPPED' ESCAPE '\\'
            OR event_type LIKE '%\\_FAILED' ESCAPE '\\'
            OR event_type LIKE '%\\_DROPPED' ESCAPE '\\'
            OR event_type LIKE '%\\_NO\\_OP' ESCAPE '\\')
     GROUP BY event_type
     ORDER BY c DESC
  `);
  const recent = await safeAll(`
    SELECT case_id, event_type, payload, created_at
      FROM case_events
     WHERE created_at >= NOW() - INTERVAL '7 days'
       AND (event_type LIKE '%\\_SKIPPED' ESCAPE '\\'
            OR event_type LIKE '%\\_FAILED' ESCAPE '\\'
            OR event_type LIKE '%\\_DROPPED' ESCAPE '\\')
     ORDER BY created_at DESC
     LIMIT 100
  `);
  res.render('ops-silent-failures', { counts, recent });
});
```

Add a quick-link card on `/ops` linking to this view. Card surfaces just the counts.

**Estimated effort:** 3 hours.

### Phase 6 — Webhook/integration coverage gaps

**Files:** `src/services/emailService.js`, `src/services/twilio_verify.js`, `src/services/whatsapp_otp.js`, `src/storage.js`.

- `emailService.sendMail` (line 543, 559): route both catches through `_logEmailError('error', to, ..., { error: err.message })`. The helper already exists and writes `category='email_send'`.
- `twilio_verify` lines 63, 95: add `logErrorToDb(err, { category: 'twilio_verify_otp', ... })`.
- `whatsapp_otp.js:101`: `logErrorToDb(err, { category: 'whatsapp_otp', ... })`.
- `storage.js:93`: `logErrorToDb(err, { category: 'r2_bucket' })`. The route-level handlers should also tag their R2 errors with `category: 'r2_upload'` / `r2_download` (covered in Phase 2's wrap pattern for the patient.js/doctor.js upload paths).

**Estimated effort:** 2 hours.

### Phase 7 — Six new /ops widgets (P1-ERR-21, P1-ERR-22)

**Files:** `src/routes/ops.js` (additions in `router.get('/')` handler), `src/views/ops-dashboard.ejs`.

Six widgets (in addition to the silent-failures card from Phase 5):

1. **Notification queue depth + oldest-stuck age:**
   - `SELECT COUNT(*) FROM notifications WHERE status IN ('queued','retry')`
   - `SELECT EXTRACT(EPOCH FROM (NOW() - MIN(at))) FROM notifications WHERE status IN ('queued','retry')`
2. **Notification dispatched-vs-skipped split (relies on Phase 4-C status enum):**
   - `SELECT status, COUNT(*) FROM notifications WHERE at >= date_trunc('month', NOW()) GROUP BY status` (already partially present)
3. **Cron last-run age per cron** — read from `agent_heartbeats` but split out the canonical 5 cron names instead of rolling everything into `care-agent`.
4. **Error rate baseline + 5x threshold:** compute baseline as avg(errors/hour) over last 7 days excluding the current hour; flag red if current hour ≥ 5× baseline AND ≥ 5 absolute. Wire to `sendCriticalAlert`.
5. **Critical-alert delivery health:** add a new `critical_alert_log` table (migration 048) recording `sent_at, status_code, error`. Surface `last_alert_at`, `last_status` on dashboard. Also fixes P1-ERR-7 (per-process throttle) by storing throttle state in DB.
6. **Resend health:** env present (`!!RESEND_API_KEY`) + last successful send age (`SELECT MAX(at) FROM notifications WHERE channel='email' AND status='sent'`). Pill red if env missing OR last send > 1 hour during business hours.

**Estimated effort:** 4 hours.

---

## 5. Verification steps

1. **Static grep tests** (run before each Phase merges; add to CI):
   - `tests/core/theme8-route-errlog-coverage.test.js` — fails build if any new `console.error(...)` in `routes/{patient,doctor,superadmin}.js` lacks a paired `logErrorToDb` call within 200 chars.
   - `tests/core/theme8-logger-category.test.js` — asserts `logErrorToDb` writes `category` column on a synthetic call.
   - `tests/core/theme8-worker-errlog-coverage.test.js` — same pattern as route test, applied to all `src/workers/`, `src/jobs/`, `src/notification_worker.js`, `src/video_scheduler.js`, `src/case_sla_worker.js`, `src/instagram/scheduler.js`, `src/sla_worker.js`.
   - `tests/core/theme8-no-bare-fatal.test.js` — asserts every `logFatal(...)` call passes an Error as the last argument so the DB write fires.

2. **Live DB smoke tests** (run after deploy to staging):
   - Trigger an intentional 500 in `patient.js:929` (AI analysis) by sending invalid input → verify `/ops/errors` shows the row within 5 seconds with `category='patient'`.
   - Submit a case with `EMAIL_ENABLED=true` but `RESEND_API_KEY=invalid` → verify `error_logs` row with `category='email_send'`.
   - Force a `queueNotification` insert failure (insert a duplicate `dedupe_key`+`channel`+`to_user_id` violating the unique index) → verify `error_logs` row with `category='notification_queue_failure'` AND a `NOTIFICATION_DROPPED` row in `case_events`.

3. **Silent-failures view sanity check:**
   - Visit `/ops/silent-failures` post-deploy. Should show `SLA_PAUSE_SKIPPED` and `SLA_RESUME_SKIPPED` counts of 0 for the last 7 days (Theme 7 Phase 3 / migration 047 fixed the underlying bug); historical rows for >7d should be excluded by the time filter.
   - Manually emit a test `CASE_REASSIGNMENT_FAILED` via SQL → confirm it appears within 1 minute.

4. **Worker observability spot-check:**
   - Kill the `notification_worker` for 3 minutes; confirm dashboard's notification queue depth widget shows ≥ 1 and "oldest stuck > 2 min".
   - Throw a synthetic error in `case_sla_worker.handleBreach`; confirm `/ops/errors` shows it with `category='fatal'` (from the rewritten `logFatal`).

5. **SKIP LOCKED verification** (manual; not in CI):
   - Spin up a second `notification_worker` locally against the staging DB; confirm both run without dup-sending. (For a single-instance Render production deploy, this verification is theoretical until/unless a second instance is spun up.)

---

## 6. What to add to the test suite (specifically lint tests)

Theme 8 is mostly observability — the verification is whether observability *coverage* is wide enough, not whether a specific function works. The test set therefore leans heavily on source-grep lint tests modelled on the Theme 5/6/7 pattern.

**New test files:**

1. `tests/core/theme8-logger-category.test.js` — 4 assertions:
   - `logger.js INSERT statement includes 'category' column`
   - `logErrorToDb populates category from context.category`
   - `direct INSERTs in admin_audit/email/whatsapp/auto_assign/doctor_pause/admin.js still include category`
   - `category column is never reset to NULL by logger.js`

2. `tests/core/theme8-route-errlog-coverage.test.js` — 6 assertions:
   - `routes/patient.js: every catch (err) { console.error(...) } is followed by logErrorToDb within 200 chars`
   - same for `doctor.js`
   - same for `superadmin.js`
   - `logErrorToDb calls in routes pass category, requestId, userId, url, method`
   - `logErrorToDb is imported at the top of each route file`
   - `no new console.error-only sites are introduced (compared to baseline)`

3. `tests/core/theme8-worker-errlog-coverage.test.js` — same shape as route test, applied to `notification_worker.js`, `video_scheduler.js`, `case_sla_worker.js`, `workers/acceptance_watcher.js`, `instagram/scheduler.js`, `sla_worker.js`, `jobs/sla_watcher.js`, `jobs/appointment_reminders.js`. 8 assertions total.

4. `tests/core/theme8-queueNotification-logs-failure.test.js` — 4 assertions:
   - `notify.js:340 catch wraps logErrorToDb(category='notification_queue_failure')`
   - `notify.js:233 (invalid_to_user_id) emits NOTIFICATION_DROPPED case_event when orderId present`
   - `same for the four other skipped:true early returns`
   - `NOTIFICATION_DROPPED is documented in src/case_lifecycle.js event-type registry`

5. `tests/core/theme8-no-bare-logfatal.test.js` — 3 assertions:
   - `logger.fatal calls logErrorToDb when passed an Error`
   - `logger.fatal optionally calls sendCriticalAlert`
   - `no source file imports logFatal and calls it without an Error argument` (lint)

6. `tests/core/theme8-silent-failures-view.test.js` — 5 assertions:
   - `route handler at /ops/silent-failures exists`
   - `query selects SKIPPED, FAILED, DROPPED, NO_OP suffix events`
   - `view template renders count + recent table`
   - `route is gated by requireOpsAuth`
   - `dashboard has a quick-link card to /ops/silent-failures`

7. `tests/core/theme8-skip-locked-notifworker.test.js` — 2 assertions:
   - `notification_worker.js SELECT includes FOR UPDATE SKIP LOCKED`
   - `query is wrapped in an explicit transaction OR uses pg-row-level-locking semantics`

**Existing tests to update:**

- `tests/core/theme6-queueNotification-uses-toUserId.test.js` — extend the broader-sweep to also assert `every queueNotification fail path emits a NOTIFICATION_DROPPED case_event when orderId is provided`. This regression-guards the §3-C visibility fix.

**Test budget:** ~32 new lint assertions across 7 files. Most are source-grep + AST-walks; runtime is <500ms total. Mirrors Theme 6's 35-test budget.

---

## 7. Rollback plan

Each Phase is independent and can be reverted via `git revert` without affecting the others. Specific rollback considerations:

| Phase | Rollback shape | Side effects |
|---|---|---|
| 1 (logger.js category) | `git revert <sha>` — restores 10-column INSERT | New rows post-rollback lose category column — partial index becomes unused again. No data loss. |
| 2 (route catches) | `git revert <sha>` — removes 39 logErrorToDb calls | Stdout still has console.error — no regression. |
| 3 (queueNotification + NOTIFICATION_DROPPED) | `git revert <sha>` — removes logErrorToDb call + case_event emit | `case_events` rows from the post-fix window remain (harmless — silent-failures view still queries them). |
| 4-A (logFatal) | `git revert <sha>` — restores `console.error`-only fatal | logFatal stops writing to DB; pre-fix behavior. No regression. |
| 4-D (SKIP LOCKED) | `git revert <sha>` — removes FOR UPDATE SKIP LOCKED clause | No regression for single-instance deploys. For multi-instance, dup-send risk returns — but multi-instance is not the launch shape, so safe. |
| 5 (silent-failures view) | Delete route + EJS file | No data dependency. |
| 6 (integration catches) | `git revert <sha>` per-file | Stdout still has console.error. |
| 7 (dashboard widgets) | `git revert <sha>` — removes widget queries + EJS sections | No schema change except critical_alert_log migration; that table can stay (untouched) or be dropped via migration 049. |

**Hard dependency:** Phase 4-C's notifications.status='skipped' value depends on the column being plain TEXT today (not CHECK-constrained). Verify before Phase 4 lands. If a CHECK constraint exists, migration 048 must alter it (and rollback is a CHECK re-add).

**Cross-phase dependency:** Phase 5 (silent-failures view) is most useful AFTER Phase 3 (NOTIFICATION_DROPPED emits) lands. The view works regardless — but a much-smaller dataset shows up if Phase 5 ships first. Sequence Phase 3 before Phase 5.

---

## 8. Open questions for Ziad

**OQ-1.** **Theme 7b Phase 2 added two new console.error-only sites in `patient.js` (lines 2812, 2910) — `[patient-refund-request] insert failed` and `[patient-refund-cancel] delete failed`.** These were shipped 2026-05-10/11 within the Theme 7b refund workflow without `logErrorToDb`. The lint test in §6.2 will catch this once Phase 2 lands. Should Phase 2 also retroactively wrap these two sites with `category='refund'`, or are refund errors already adequately observable via the new admin refund queue at `/superadmin/refunds`? **Recommendation: wrap them — refund queue shows successful state changes, not insert/delete failures.**

**OQ-2.** **`patient.js`, `doctor.js`, `superadmin.js` do not currently import `logErrorToDb`.** Phase 2's wrap requires importing it at the top of each file. Should it be added via the existing `require('../logger')` destructure that exists in some files but not others, or should we standardize on a single shared import shape? **Recommendation: standardize on `const { logErrorToDb } = require('../logger');` at the top of each file.** Verify against existing imports — `routes/payments.js:8` and `routes/admin.js:1814` already use this shape.

**OQ-3.** **The 5 direct-INSERT callers (`admin_audit.js`, `emailService.js:_logEmailError`, `notify/whatsapp.js:logWhatsAppError`, `auto_assign.js:logSlaRoutingShortage`, `doctor_pause.js`, `routes/admin.js:1814`) bypass `logErrorToDb` and write to `error_logs` directly.** Phase 1's `logErrorToDb` fix could enable migrating these to the canonical helper. **Recommendation: leave them as-is** — they each construct domain-specific context fields (masked email, masked phone, audit-trail fields). Migrating would risk shape regressions in audit-row reads. The category column is already populated correctly at each site.

**OQ-4.** **`sla_worker.js` is the legacy SLA worker; `case_sla_worker.js` is canonical (per `docs/SLA_ARCHITECTURE.md` and Theme 7 Phase 2's consolidation).** `sla_worker.js:202` still has a console.error. **Recommendation: deprecate `sla_worker.js` entirely** (remove the import + the legacy interval) rather than wrapping its catches. Confirm with Ziad: is anything still calling into `sla_worker`, or is it orphan code? Live grep of `require('./sla_worker')` returns 0 hits — likely orphan, safe to remove.

**OQ-5.** **SKIP LOCKED bundling decision (the user's explicit ask in the brief).** Recommendation: **bundle into Theme 8 Phase 4-D**. Reasoning: (a) it's a 15-line query change; (b) the test scaffold overlaps with Phase 7's queue-depth widget (both need to introspect notification_worker's fetch shape); (c) deferring it a second time would leave a documented gap untouched at launch. Alternative: spin out as a separate Theme 6b. Ziad signs off here.

**OQ-6.** **Critical-alert delivery health widget proposed in Phase 7 (#5) requires a new `critical_alert_log` table** (migration 048) to record per-send status from Meta. This also enables a DB-backed throttle (fixes P1-ERR-7 — multi-dyno alert multiplication). **Recommendation: add the migration.** Alternative: skip the table, just surface the last-sent in-memory state (works for single-instance only). Ziad confirms scope.

**OQ-7.** **Sub-issue C's `NOTIFICATION_DROPPED` event_type is new.** It would join `SLA_PAUSE_SKIPPED`, `SLA_RESUME_SKIPPED`, `CASE_REASSIGNMENT_FAILED` in the silent-failures registry. Should the registry be formalized (a new table or a const in `case_lifecycle.js` exporting known SKIPPED/FAILED labels) for the lint test in §6.4 to validate against? **Recommendation: add a `const SILENT_FAILURE_EVENTS = [...]` export at the top of `case_lifecycle.js`** so the registry has a single source of truth.

**OQ-8.** **Resend lifecycle `sendMail()` does not call `_logEmailError`.** Phase 6 wires this up. But the templated `sendEmail()` is the dominant code path — `sendMail()` is legacy infrastructure used by the lifecycle notifications (case received, doctor accepted). Are any of those still in use, or has Theme 7b's queue-based delivery replaced them? Confirm before Phase 6 lands. If `sendMail` is fully orphan, the fix is to delete it; otherwise wire `_logEmailError`.

**OQ-9.** **Render observability path long-term.** This theme adds DB-row observability via `error_logs`. Render itself supports JSON-aware log filtering — a future cycle could switch logger.js to structured (pino/winston) JSON output for end-to-end correlation. Is this in-scope for the launch milestone, or a follow-on? **Recommendation: out of scope for launch.** Filed as P3-OBS-NEW1 below.

---

## ROI test — retrospective: would Theme 8 have caught yesterday's bugs?

This is the most important question for justifying Theme 8 scope. Mapping each bug fixed in the 2026-05-09/10 cycle to the §3 fixes:

| Bug | Fixed in | Would Theme 8 fix have caught it pre-incident? |
|---|---|---|
| **SLA_PAUSE_SKIPPED silent for months** — `orders.sla_paused_at` column missing; every doctor reject-files call no-op'd the SLA pause and emitted `SLA_PAUSE_SKIPPED { reason: 'columns_missing' }` to case_events. | Theme 7 Phase 3 (commit `0a580de` + hotfix `b9f3562`, migration 047) | **YES — definitively.** §3-E silent-failures view querying `case_events WHERE event_type LIKE '%_SKIPPED'` would have surfaced the rolling 7-day count on the /ops dashboard. The first time a doctor rejected files post-deploy, the count would have ticked up and the operator would have seen "SLA_PAUSE_SKIPPED: 1 in last 7d". By month two the count would have been in the hundreds — impossible to miss. **This single observation justifies Theme 8 by itself.** |
| **video_scheduler dropped all notifications** — `userId:` instead of `toUserId:`, `type:` instead of `channel:`, `data:` instead of `response:` — every patient + admin notification on 24h/48h stale-slot auto-cancel was silently dropped at `notify.js:233` (`invalid_to_user_id`). | Theme 6 sub-issue D (commit `3d6f05f`) | **YES — partially.** §3-C's `NOTIFICATION_DROPPED` case_event emit would have produced a row every time the bug fired. §3-E's view would have surfaced the count. §3-G's "dispatched-vs-skipped" widget would have shown the skipped reason `invalid_to_user_id` climbing. The operator would have seen this within hours of the first stale-slot sweep firing, not months later. Additionally, §3-C's `logErrorToDb` call in the catch path means a separate `/ops/errors` row would have appeared with `category='notification_queue_failure'` (the insert succeeded but the row was useless without a recipient — a near-miss, not a direct error_logs hit; this is why "partially" not "definitively"). |
| **dispatchSlaBreach hardcoded recipient** — Theme 7 Phase 2 found `dispatchSlaBreach` was using a hardcoded admin user_id rather than fanning out to all active superadmins. | Theme 7 Phase 2 (consolidated into `notifyAdmins` helper) | **NO — Theme 8 would not have caught this.** It is a logic bug (wrong recipient), not an error-handling gap. The notification was successfully delivered to *someone*; the per-recipient fan-out was missing. **Not in Theme 8's remit.** |
| **awaiting_files orphan rows** — rows stuck in non-canonical 'awaiting_files' status with no SLA pause data. | Theme 7 Phase 3 (alias migration 047) | **NO.** This is data-integrity drift, not error logging. Theme 8 surfaces no row count for "rows in invalid status." That would belong to a data-layer-audit theme. |
| **async-in-setInterval crash pattern** — `setInterval(() => { try { runAsyncFn() } catch {} })` cannot catch async rejections; `process.exit(1)` followed by Render auto-restart. | Theme 6 sub-issue B (commit `ac5f002`) | **PARTIALLY.** §3-D's `logFatal → logErrorToDb` rewrite would have produced an `error_logs` row before the `process.exit(1)`. §3-G's critical-alert delivery health widget would have surfaced repeated crash-loops (each restart resets the per-process throttle, so every crash sends a WhatsApp — but the WhatsApp itself is fire-and-forget at `critical-alert.js:53,57`, so coverage was zero). The crash was caught because the process died, not because anyone read the logs — Theme 8 makes it visible *before* the crash compounds. |
| **campaigns cron `var ci` hoisting** — `setImmediate` captured the same `ci` binding, so all campaign IDs collapsed to the last one. `processCampaign(undefined)` was called repeatedly. | Theme 6 sub-issue C (commit `3992a8b`) | **PARTIALLY.** §3-D's worker-catch wrap would have logged the `processCampaign(undefined)` error inside `processCampaign`'s own catch. §3-G's cron last-run age widget would have shown campaigns silently completing (rowCount=0) every 5 minutes despite scheduled campaigns existing. Operators would have seen the "scheduled campaigns: N > 0 but completed today: 0" inconsistency. |

**Summary ROI:** Theme 8 would have caught **1 definitively, 3 partially, 2 not-in-scope** out of 6 bugs from the 2026-05-09/10 incident cycle. The 1 definitive catch (SLA_PAUSE_SKIPPED) represents *months* of silent production data loss — that alone justifies the theme.

**P3-OBS-N entries surfaced during scoping:**

- **P3-OBS-N1** (out of theme — flagged for future): `auth.js` form re-render on signup error doesn't preserve typed-in fields (re-entry friction; not silent, but adjacent UX issue. Audit P1-ERR-19.)
- **P3-OBS-N2** (out of theme): The 81 `catch (_) {}` and 22 `catch (e) {}` sites with no body across the codebase. Most are deliberate; the 5 surfaced as load-bearing in P2-ERR-26 (`routes/admin.js:2084,2162`, `case_lifecycle.js:1323,1538,1568,1940`, `routes/patient.js:2756`, `workers/acceptance_watcher.js:105`) should be audited in a follow-on.
- **P3-OBS-N3** (out of theme): `pgBoss` job state on /ops dashboard — `pgboss.job` table is queryable but no widget surfaces failed/active counts. Audit P3-ERR-41. Recommend adding in a follow-up post-launch.
- **P3-OBS-N4** (out of theme): Render runtime logs are unstructured (P1-ERR-9). Long-term migration to pino/winston with JSON output is filed as a separate cycle.
- **P3-OBS-N5** (out of theme): `audit.logOrderEvent` failures console-only (P2-ERR-33). The audit trail itself can silently lose rows. This is adjacent to Theme 8 but deserves its own scoping since `order_events` is the canonical event store and a silent gap there cascades into the silent-failures view's accuracy.
- **P3-OBS-N6** (out of theme): `runSlaReminderJob` rolls back its transaction but breach refund is outside the transaction (P2-ERR-36). Data-integrity concern; not observability.
- **P3-OBS-N7** (out of theme): `seed_specialties.js`, migration-runner errors, `Migration log lines in Mobile API migrate` (P2-ERR-27, P3-ERR-44, P2-ERR-30) — boot-path observability. Render captures stdout so the criticality is low.
