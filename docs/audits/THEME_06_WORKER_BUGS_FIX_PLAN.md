# Theme 6 — Worker Bugs: Fix Plan

**Date:** 2026-05-10
**Author:** Claude Opus 4.7 (1M context)
**Working tree HEAD:** `868df8a` (Theme 7 Phase 1 — doctor-accept transitionCase shipped)
**Sources:** `docs/audits/COMPREHENSIVE_PRE_LAUNCH_AUDIT_2026-05-06.md` § Section 06 — Background workers + crons (findings P0-WORKER-1..10, P1-WORKER-11..27, P2-WORKER-28..41, P3-WORKER-42..); verified directly against the live `868df8a` codebase for this scoping.

> Scoping document only. **No source files have been modified.** All diffs in §4 are *proposed*, not applied.

---

## 1. Executive summary

Theme 6 is four named worker defects on top of an architectural gap: only one worker (`case_sla_worker` / `runSlaEnforcementSweep`) is gated to a single Render instance, and only one interval id (`slaSweepIntervalId`) is tracked for graceful shutdown. Every other recurring task (notification worker, conversation auto-close, campaign cron, appointment reminders, Instagram, mac-mini SSH, IG scheduler) runs unconditionally on every instance.

**Sub-issue A** — `server.js:1011-1019` (conversation auto-close) and `:1071-1079` (notification worker) are registered **outside** the `if (CONFIG.SLA_MODE === 'primary') { ... }` block that closes at `:1009`. On the production 2-instance Render plan with `SLA_MODE=primary` on exactly one instance, both still fire from both boxes. Notification worker is the load-bearing case: `runNotificationWorker(50)` polls `notifications WHERE status IN ('queued','retry') LIMIT 50` and races UPDATE with no row-level claim — duplicate WhatsApp/email per row whenever two instances both grab the same batch. Conversation auto-close is lower stakes (idempotent UPDATE), but the same-batch UPDATE storm spikes the pool during boot warm-up via the `setTimeout(..., 5000)` boot run. Canonical pattern is right above (line 980) and used by `case_sla_worker`, `startVideoScheduler`, `startAcceptanceWatcher`, and `runSlaEnforcementSweep`'s interval — fix is mechanical.

**Sub-issue B** — `case_sla_worker.js:409-420` is the audit's named instance, and the bug is real and verified: `setInterval(() => { try { runCaseSlaSweep(); } catch (err) {...} }, intervalMs)` wraps an async fn in a synchronous try/catch. `runCaseSlaSweep` deliberately rethrows at line 393 (P3-OBS-1 comment block, intentional for pg-boss retry). On the in-process fallback path (when pg-boss schedule fails), every transient `fetchSlaCandidates` rejection escapes the try, surfaces as `unhandledRejection`, and trips `server.js:309`'s `process.exit(1)` guard. **Same pattern at `case_sla_worker.js:412`** — the boot-time `runCaseSlaSweep();` has no `.catch()` either, so a DB outage at boot crashes the process before the interval even arms. Investigation surfaced **three more sites with the same shape inside `runSlaEnforcementSweep`** (`server.js:954, 956, 959`): `runWatcherSweep(new Date())`, `dispatchUnpaidCaseReminders()`, and `caseLifecycle.sweepExpiredDoctorAccepts()` are all async but called without `await` inside sync `try { ... } catch`. The outer try/catch only catches the synchronous portion; the floating Promise rejections become `unhandledRejection`. Plus `server.js:1005-1007` (passive payment reminders) wraps async `dispatchUnpaidCaseReminders` in sync try/catch. Six call sites total in two files.

**Sub-issue C** — `server.js:1047-1052` confirmed: classic `var ci` hoisting. `for (var ci = 0; ci < scheduled.length; ci++) { ... setImmediate(function() { try { processCampaign(scheduled[ci].id); } catch(_){} }); }` — by the time `setImmediate` fires (next tick of the event loop, *after* the loop completes), `ci === scheduled.length`, so `scheduled[ci]` is `undefined`. `processCampaign(undefined)` → `queryOne('SELECT * FROM email_campaigns WHERE id = $1', [undefined])` returns null at `routes/campaigns.js:308-309` and the function silently returns. The campaign was already moved to `'sending'` at `:1049` before the setImmediate, so it stays in `'sending'` forever, no recipients ever emailed. **One additional defect on the same lines:** the cron is also unconditional (outside primary block) — even after fixing `var → let`, two instances running this cron both SELECT the same scheduled rows. Only one instance's UPDATE-to-'sending' matches (good), but **both instances still call `setImmediate(processCampaign(id))`** because the rowCount of the UPDATE is never checked. Net effect post-`let`-fix: campaigns send 2× on multi-instance. Theme 6's brief named only the hoisting bug; flagging the rowCount-not-checked sibling as P3-WORKER-N1 in §4-C2.

**Sub-issue D** — `video_scheduler.js:253` confirmed: the 48h auto-cancel notification to the patient passes `userId: slot.patient_id` instead of `toUserId: slot.patient_id`. `queueNotification` destructures `{ toUserId }` at `notify.js:221`, so the rogue field becomes `toUserId === undefined`, `normalizeToUserId(undefined)` returns null at `notify.js:66-77`, and the function returns `{ ok: false, skipped: true, reason: 'invalid_to_user_id' }` at `:233` without inserting. The patient who paid for a video slot that the doctor never accepted has their slot auto-cancelled and their payment auto-refunded — **and is never told.** Greppable lint catches this exactly: only one site in the entire codebase uses `userId:` as a direct queueNotification field name (`grep -rE 'queueNotification\s*\(\s*\{' src/ -A 12 | grep -B 1 -E '^\s*userId:'` returns one hit). **Two additional defects on the same function:** the 24h admin escalation at `:262-268` and the 48h admin alert at `:273-285` both pass `type: 'admin_alert'` (not a recognized parameter — queueNotification expects `channel`) and pass NO `toUserId` at all. Same silent-drop. **Admin alerts for stuck video slots have never reached anyone since the function was written.** Flagged as P3-WORKER-N2 in §4-D2.

**Sub-issue E** — Full inventory below. The audit's per-worker table (audit-doc lines 2444-2462, P0-WORKER-1..10) is accurate and matches what's in code. Surfaced findings the audit didn't name: (i) appointment-reminder cron at `server.js:1025-1027` is **also outside the primary block**, so two instances re-fetch the same `reminder_24h_sent = false` rows and the `queueMultiChannelNotification` dedupe-key only covers the multi-channel path — the direct `sendEmailFn` send at `appointment_reminders.js:97-100` has no dedupe (this overlaps audit P2-WORKER-40 but adds the multi-instance angle); (ii) campaign cron, Instagram scheduler, and the mac-mini SSH probe (`routes/ops.js:51`) are also unconditional. The mac-mini probe runs at module-require time on every instance — fires SSH `exec` at `OPS_SSH_HOST` regardless of `SLA_MODE`. (iii) Of 11 `setInterval` call sites in `src/`, only one (`slaSweepIntervalId` at `server.js:997`) is tracked for `clearInterval` in `gracefulShutdown` (line 1103). Every other interval pins the event loop until the 10s force-exit timer fires. (iv) `acceptance_watcher.js:152` returns the `setInterval` id but the caller at `server.js:991` discards the return value — the id is unreachable for cleanup.

**Estimated effort:** A (1h, mechanical move), C (15m + decision on multi-instance behaviour), D (15m for the rename + 30m for the admin-alert rewrite), B (3h — 6 call sites + an ESLint rule). Total ≈ 4-5h. Theme 6 ships in one commit batch.

---

## 2. Current state

### Sub-issue A — Notification worker + conversation auto-close run on every Render instance

**Location (verbatim, current `868df8a`):** `src/server.js:980-1019, 1071-1079`

```js
// :980 — primary-only block opens
  if (CONFIG.SLA_MODE === 'primary') {
    logMajor('SLA MODE: primary (single writer enabled)');
    // ... pg-boss SLA, startVideoScheduler, startAcceptanceWatcher,
    //     setInterval(runSlaEnforcementSweep, ...) all gated here
  } else {
    logMajor('SLA MODE: passive (no SLA mutations)');
    setInterval(function() {
      try { dispatchUnpaidCaseReminders(); } catch (err) { console.error('[payment-reminders] error', err); }
    }, 15 * 60 * 1000);
    logMajor('Payment reminders registered (every 15 min, passive mode)');
  }
// :1009 — primary-only block CLOSES here

  // :1011 — UNCONDITIONAL — runs on primary AND passive
  // Auto-close stale conversations
  try {
    var closeStaleConversations = require('./routes/messaging').closeStaleConversations;
    setTimeout(function() { try { closeStaleConversations(); } catch (_) {} }, 5000);
    setInterval(function() { try { closeStaleConversations(); } catch (_) {} }, 24 * 60 * 60 * 1000);
    logMajor('Conversation auto-close registered (daily)');
  } catch (e) {
    logMajor('Conversation auto-close registration failed: ' + e.message);
  }

  // ... appointment reminders cron @ :1025 — also unconditional
  // ... campaign cron @ :1037 — also unconditional
  // ... Instagram scheduler @ :1065 — also unconditional

  // :1071 — UNCONDITIONAL — runs on primary AND passive
  // Notification worker
  var runNotificationWorker = require('./notification_worker').runNotificationWorker;
  setInterval(async function() {
    try { await runNotificationWorker(50); } catch (err) { console.error('[notify-worker] interval error', err); }
  }, 30000);
  setTimeout(async function() {
    try { await runNotificationWorker(50); console.log('[notify-worker] initial run complete'); } catch (err) { console.error('[notify-worker] initial run error', err); }
  }, 5000);
  logMajor('Notification worker registered (every 30s)');
```

**`runNotificationWorker` query shape (`src/notification_worker.js:199-211`):** `SELECT … FROM notifications WHERE status IN ('queued','retry') AND (retry_after IS NULL OR retry_after <= NOW()) ORDER BY created_at ASC LIMIT 50`. There is **no `FOR UPDATE SKIP LOCKED`**, no two-phase claim (`UPDATE notifications SET status='sending' WHERE id=$1 AND status IN ('queued','retry') RETURNING *`), no per-row advisory lock. Each instance picks up the same 50 rows, sends up to 50 WhatsApps/emails each, then both UPDATE `status='sent'`/`'failed'` (last write wins on conflict — but the SEND already happened on both instances).

**`closeStaleConversations` query shape (`src/routes/messaging.js:398-413`):** single idempotent UPDATE on `conversations WHERE status='active' AND order_id IN (SELECT id FROM orders_active WHERE status='completed' AND completed_at < NOW() - INTERVAL '2 days')`. Idempotent on second run (status already 'closed' → no rows match), but the boot `setTimeout(..., 5000)` triggers a wide UPDATE during DB warm-up on every instance simultaneously.

**Canonical primary-gate pattern in this codebase** (used by every other worker that needs it):

| Worker | File:line | Gate shape |
|---|---|---|
| `case_sla_worker` setInterval fallback | `server.js:989` | inside `if (CONFIG.SLA_MODE === 'primary')` |
| `startVideoScheduler` | `server.js:990` | same block |
| `startAcceptanceWatcher` | `server.js:991` | same block |
| `runSlaEnforcementSweep` interval | `server.js:997-999` | same block |
| Passive payment reminders | `server.js:1005-1007` | inside `else` (passive-only) |
| `runSlaEnforcementSweep` body | `server.js:940` | early-return `if (CONFIG.SLA_MODE !== 'primary') return;` |
| `runSlaReminderJob` | `server.js:1129` | early-return `if (CONFIG.SLA_MODE !== 'primary') return;` |
| pg-boss SLA sweep | `job_queue.js:154` | `singletonKey: 'sla-primary'` (DB-level lock) |

So the fix shape is already used everywhere — these two callers were just registered in the wrong span.

---

### Sub-issue B — `setInterval` callbacks call async functions with sync try/catch

**Location 1 (verbatim) — `src/case_sla_worker.js:409-420`:**

```js
function startCaseSlaWorker(intervalMs = SCAN_INTERVAL_MS) {
  if (workerStarted) return;
  workerStarted = true;
  runCaseSlaSweep();                                  // ← line 412: boot run, NO .catch()
  setInterval(() => {
    try {
      runCaseSlaSweep();                              // ← line 415: returns Promise; sync try CANNOT catch async rejection
    } catch (err) {
      logFatal('Case SLA sweep failed', err);
    }
  }, intervalMs);
}
```

**The async rejection path that crashes:** `runCaseSlaSweep` deliberately rethrows on fetch failure at `case_sla_worker.js:389-393`:

```js
// c2 (P3-OBS-1): rethrow at the end so pg-boss still retries on transient
// pool exhaustion. The error is already logged to error_logs above; this
// ensures pg-boss marks the job failed (state='failed' in pgboss.job)
// instead of silently treating partial results as success.
if (fetchError) throw fetchError;
```

When `startCaseSlaWorker` is the active path (i.e. `scheduleSlaSweep()` returned `false` at `server.js:986-989`), the rethrow lands as a Promise rejection from the floating `runCaseSlaSweep()` call. `server.js:303-309` catches `unhandledRejection`:

```js
process.on('unhandledRejection', function(reason) {
  logFatal('Unhandled promise rejection', reason);
  // ... sendCriticalAlert
  setTimeout(function() { process.exit(1); }, 500).unref();
});
```

So a single transient `fetchSlaCandidates` failure on the in-process fallback path → `process.exit(1)`. Render restarts the instance, pg-boss schedule may still be unwiring, hot-loop on boot is plausible.

**Location 2 (verbatim) — same pattern in `runSlaEnforcementSweep`, `src/server.js:953-967`:**

```js
try {
  try { runWatcherSweep(new Date()); } catch (err) { logFatal('SLA watcher sweep error', err); }              // :954
  try { await runSlaReminderJob(); } catch (err) { logFatal('SLA reminder job error', err); }                 // :955  ← await: SAFE
  try { dispatchUnpaidCaseReminders(); } catch (err) { logFatal('Unpaid reminder sweep error', err); }        // :956
  try {
    if (typeof caseLifecycle.sweepExpiredDoctorAccepts === 'function') {
      caseLifecycle.sweepExpiredDoctorAccepts();                                                              // :959
    }
  } catch (err) { logFatal('Doctor accept sweep failed', err); }
  try { logVerbose('[SLA] enforcement sweep ran (' + srcLabel + ')'); } catch (e) {}
} catch (err) {
  logFatal('SLA enforcement sweep failed', err);
} finally {
  slaEnforcementRunning = false;
}
```

`runWatcherSweep` is `sla_watcher.runSlaSweep` (`async function runSlaSweep(now)` at `sla_watcher.js:29`). `dispatchUnpaidCaseReminders` is async (`case_lifecycle.js:458`). `sweepExpiredDoctorAccepts` is async (`case_lifecycle.js:2051`). All three are called WITHOUT `await` in lines 954, 956, 959. The sync `try { ... } catch` on each catches *synchronous* throws inside the function body up to the first `await`, and nothing else. Every async rejection past that becomes `unhandledRejection`.

**Location 3 — `src/server.js:1005-1007` (passive mode):**

```js
setInterval(function() {
  try { dispatchUnpaidCaseReminders(); } catch (err) { console.error('[payment-reminders] error', err); }
}, 15 * 60 * 1000);
```

Same shape. `dispatchUnpaidCaseReminders` calls `await ensureColumnCache()` at `case_lifecycle.js:459` *before* its outer try block; an early DB error here propagates as an unawaited rejection on the passive instance.

**Sites that already use the correct pattern (for reference, no changes needed):**

| File:line | Pattern |
|---|---|
| `server.js:1073-1075` (notification worker) | `setInterval(async function() { try { await runNotificationWorker(50); } catch (err) {...} })` — `async`+`await` correctly contains rejection |
| `server.js:1037-1057` (campaigns cron) | `cron.schedule('*/5 * * * *', async function() { try { ... } catch (_) {} })` — same |
| `instagram/scheduler.js:34-40` | `setInterval(async () => { try { await this.publishDuePosts(); } catch (err) {...} })` — same |
| `acceptance_watcher.js:11-44` | runAcceptanceWatcherSweep wraps full body in try/catch/finally; `setInterval(runAcceptanceWatcherSweep, …)` is safe because the inner Promise always resolves |
| `routes/messaging.js:398-413` (closeStaleConversations) | Inner full-body try/catch swallowing all errors; the sync wrapper at `server.js:1014-1015` is harmless because the Promise never rejects |
| `routes/ops.js:42-51` (mac mini probe) | `refreshMacMiniStatus` is sync (callback-based `sshExec`); not affected |

---

### Sub-issue C — `var ci` hoisting in campaign cron → `processCampaign(undefined)`

**Location (verbatim) — `src/server.js:1033-1061`:**

```js
// Campaign cron
try {
  var campaignCron = require('node-cron');
  var processCampaign = require('./routes/campaigns').processCampaign;
  campaignCron.schedule('*/5 * * * *', async function() {
    try {
      var now = new Date().toISOString();
      // B2 (April 29 audit): require human approval. Cron only fires
      // campaigns that have been explicitly approved via
      // POST /portal/admin/campaigns/:id/approve (sets approved_by).
      var scheduled = await safeAll(
        "SELECT id FROM email_campaigns WHERE status = 'scheduled' AND approved_by IS NOT NULL AND scheduled_at <= $1",
        [now], []
      );
      for (var ci = 0; ci < scheduled.length; ci++) {                                                          // :1047 — `var` hoists
        try {
          await execute("UPDATE email_campaigns SET status = 'sending' WHERE id = $1 AND status = 'scheduled' AND approved_by IS NOT NULL", [scheduled[ci].id]);  // :1049 — uses ci correctly (sync)
          setImmediate(function() { try { processCampaign(scheduled[ci].id); } catch (_) {} });               // :1050 — captures ci by ref; ci === scheduled.length when this fires
        } catch (_) {}
      }
      if (scheduled.length > 0) {
        logMajor('[campaigns] Triggered ' + scheduled.length + ' scheduled campaign(s)');
      }
    } catch (_) {}
  });
  logMajor('Campaign scheduler cron registered (every 5 min)');
} catch (campaignCronErr) {
  logMajor('Campaign scheduler cron registration failed: ' + campaignCronErr.message);
}
```

**Failure trace (verified by reading code path):**

1. Cron tick fires every 5 min (unconditional — no SLA_MODE gate).
2. `scheduled` = e.g. `[{id: 'campaign-A'}, {id: 'campaign-B'}]` (length 2).
3. Iteration `ci=0`: `await execute(UPDATE ... WHERE id = 'campaign-A')` succeeds → row goes to `'sending'`. Then `setImmediate(() => processCampaign(scheduled[ci].id))` is queued.
4. Iteration `ci=1`: same UPDATE fires for `'campaign-B'`. Another `setImmediate` queued.
5. Loop exits with `ci=2`.
6. Event loop drains microtasks, then runs the two queued `setImmediate` callbacks. **Both see `ci=2`**, so both evaluate `scheduled[2].id` → `TypeError: Cannot read properties of undefined`. The inner `try/catch (_) {}` swallows the error.
7. Net: `processCampaign` never runs for either campaign. Both rows stay in `'sending'` forever.

(If only one campaign was scheduled — `scheduled.length===1` — `setImmediate` sees `ci=1`, `scheduled[1]` is undefined, same TypeError, same silent swallow. The bug fires for **every** scheduled campaign.)

**`processCampaign` shape on undefined input (`src/routes/campaigns.js:304-309`):**

```js
async function processCampaign(campaignId) {
  var sendEmailFn;
  try { sendEmailFn = require('../services/emailService').sendEmail; } catch (_) { return; }
  var campaign = await queryOne('SELECT * FROM email_campaigns WHERE id = $1', [campaignId]);
  if (!campaign) return;     // ← undefined campaignId → no row → silent return
  ...
}
```

So even if the closure WERE captured correctly but the campaign id were `undefined` for any reason, the function would silent-return. The bug is well-hidden.

**Sibling (multi-instance) defect on the same lines:** the cron is unconditional. The UPDATE at `:1049` uses `WHERE status = 'scheduled' AND approved_by IS NOT NULL` — once one instance flips a row to `'sending'`, the other instance's UPDATE matches zero rows. **But the rowCount of that UPDATE is never checked** — the loop's `setImmediate(processCampaign(id))` fires regardless. Post-`var→let` fix, two instances both call `processCampaign(id)` for the same campaign → recipients receive duplicate emails. Calling out as P3-WORKER-N1 (see §4-C2).

---

### Sub-issue D — Video scheduler stale-slot notifications use wrong field name

**Location (verbatim) — `src/video_scheduler.js:250-291`:**

```js
// Notify patient
if (slot.patient_id) {
  queueNotification({
    userId: slot.patient_id,                                                     // :253 — BUG: should be `toUserId`
    type: 'whatsapp',                                                            // :254 — BUG: queueNotification has no `type`, expects `channel`
    template: 'video_slot_auto_cancelled_patient',
    data: { patient_name: slot.patient_name, amount: slot.payment_amount, currency: slot.payment_currency || 'EGP' },
    orderId: slot.order_id,
    dedupe_key: `video:slot:autocancelled:${slot.id}`
  });
}
// Notify admin
queueNotification({
  type: 'admin_alert',                                                           // :263 — BUG: not a recognized parameter
  template: 'video_slot_auto_cancelled_admin',                                   //         AND no `toUserId` at all
  data: { order_id: slot.order_id, doctor_name: slot.doctor_name, patient_name: slot.patient_name, status: slot.status },
  orderId: slot.order_id,
  dedupe_key: `video:slot:autocancelled:admin:${slot.id}`
});
logMajor(`[video-scheduler] Auto-cancelled slot ${slot.id} (order ${slot.order_id}) — unresolved 48h`);
} else if (ageHours >= 24) {
  // ESCALATION: notify admin once at 24h mark
  queueNotification({
    type: 'admin_alert',                                                         // :274 — same shape: `type:` not real, no `toUserId`
    template: 'video_slot_stale_admin',
    data: {
      order_id: slot.order_id,
      doctor_name: slot.doctor_name || '—',
      patient_name: slot.patient_name || '—',
      status: slot.status,
      age_hours: Math.floor(ageHours)
    },
    orderId: slot.order_id,
    dedupe_key: `video:slot:stale24h:${slot.id}`
  });
}
```

**Canonical signature — `src/notify.js:218-234`:**

```js
async function queueNotification({
  id,
  orderId = null,
  toUserId,                              // ← canonical name
  channel = 'internal',                  // ← canonical name (not `type`)
  template,
  status = 'queued',
  response = null,
  dedupe_key = null,
  dedupeKey = null
}) {
  const uid = await normalizeToUserId(toUserId);

  // If uid can't be resolved, do NOT insert (prevents trigger abort + bad data)
  if (!uid) {
    return { ok: false, skipped: true, reason: 'invalid_to_user_id', toUserId };
  }
  ...
}
```

**Failure trace:** for the patient call, `toUserId` is `undefined` (the caller passed `userId`, which is silently discarded by destructuring). `normalizeToUserId(undefined)` calls `String(undefined).trim() === 'undefined'` (length 9, not a UUID, not an email) → returns null → caller returns `{ ok: false, skipped: true, reason: 'invalid_to_user_id' }`. Notification row never written. Worker never picks it up. Patient never told.

**Lint-test viability:** I grep'd the entire `src/` for `queueNotification\s*\(\s*\{` followed by a `userId:`/`uid:`/`user_id:`/`recipientId:` direct field. **One hit**, the offending site. So a regression test that fails the build on any new occurrence is trivial — see §6.

**Two extra defects on the same function** (caller bug, not callee bug — they're real because every `admin_alert` call is currently dropped silently):

- `:262-268` (48h auto-cancel admin alert) and `:273-285` (24h escalation admin alert) both pass `type: 'admin_alert'` (a non-existent parameter — destructured into oblivion) and **no `toUserId`**. Dropped at line 233 with `reason: 'invalid_to_user_id'`.
- These are flagged as P3-WORKER-N2 below; the fix is the same pattern used by `sla_watcher.js:12` (`findSuperadmins()` → fan out one queueNotification per superadmin).

---

### Sub-issue E — Full worker inventory + new findings

**Per-worker table (verified at HEAD `868df8a`, supersedes audit-doc lines 2444-2462):**

| # | Worker | File:line | Cadence | Single-writer (primary-only)? | Async-in-setInterval safe? | `.unref()`? | Tracked for `clearInterval` in graceful shutdown? |
|---|---|---|---|---|---|---|---|
| 1 | `case_sla_worker` setInterval fallback | `case_sla_worker.js:412-419`, started by `server.js:989` | every 5 min | YES (gated at `server.js:980`) | **NO — Sub-issue B** | NO | NO |
| 2 | `case_sla_worker` via pg-boss | `job_queue.js:154` | cron `*/5 * * * *` | YES (singletonKey `sla-primary`) | n/a (pg-boss handles) | n/a | n/a |
| 3 | `runSlaEnforcementSweep` interval | `server.js:997-999` | every `SLA_ENFORCEMENT_INTERVAL_MS` (default 5 min) | YES (gated at `server.js:980`; `runSlaEnforcementSweep` also early-returns at `:940`) | sync wrapper but inner `runSlaEnforcementSweep` has full try/catch — **partially safe**; lines 954, 956, 959 are unawaited async (Sub-issue B) | YES (`server.js:1000`) | YES (`server.js:1103`) |
| 4 | `runSlaEnforcementSweep` event-triggered | `server.js:643` (every non-GET 2xx) | per request | YES (gated at body of fn) | safe (errors caught) | n/a | n/a |
| 5 | `sla_watcher.runSlaSweep` (re-exported as `runWatcherSweep`) | called from `runSlaEnforcementSweep:954` | indirect | inherits | **NO — Sub-issue B** | n/a | n/a |
| 6 | `sla_worker.startSlaWorker` (legacy) | `sla_worker.js:179` | dead — never called | n/a | n/a | n/a | n/a |
| 7 | `jobs/sla_watcher.runOnce` | `jobs/sla_watcher.js:108` | dead — never called | n/a | n/a | n/a | n/a |
| 8 | `acceptance_watcher.startAcceptanceWatcher` | `workers/acceptance_watcher.js:152`, started by `server.js:991` | every 2 min | YES | safe (full inner try/catch/finally) | NO | NO (interval id discarded by caller) |
| 9 | `video_scheduler` cron | `video_scheduler.js:303-307`, started by `server.js:990` | every 1 min | YES (only started inside primary block) | safe (cron `await ...`) | n/a (node-cron) | n/a (cron auto-stops) |
| 10 | `notification_worker` setInterval | `server.js:1073-1075` | every 30s | **NO — Sub-issue A** | safe (`async function` + `await`) | NO | NO |
| 11 | `notification_worker` boot setTimeout | `server.js:1076-1078` | once at boot+5s | **NO — Sub-issue A** | safe | NO | n/a (one-shot) |
| 12 | `closeStaleConversations` setInterval | `server.js:1015` | every 24h | **NO — Sub-issue A** | safe (full inner try/catch) | NO | NO |
| 13 | `closeStaleConversations` boot setTimeout | `server.js:1014` | once at boot+5s | **NO — Sub-issue A** | safe | NO | n/a |
| 14 | `appointment_reminders` cron | `server.js:1025-1027` | `*/15 * * * *` | **NO — P3-WORKER-N3** | safe (async cron handler) | n/a | n/a |
| 15 | campaign cron | `server.js:1037-1057` | `*/5 * * * *` | **NO — Sub-issue C2** | safe wrapper, but **`var ci` bug — Sub-issue C** | n/a | n/a |
| 16 | `InstagramScheduler` | `instagram/scheduler.js:34-40`, started by `server.js:1066` | every 5 min | NO (gated only on `IG_ACCESS_TOKEN` presence) — P3-WORKER-N4 | safe | NO | NO (has `stop()` method but never called by `gracefulShutdown`) |
| 17 | passive payment reminders | `server.js:1005-1007` | every 15 min | YES (passive-only) | **NO — Sub-issue B** | NO | NO |
| 18 | mac mini SSH probe | `routes/ops.js:51-52` | every 2 min, fires at module-require | **NO — P3-WORKER-N5** | safe (sync `sshExec` callback) | NO | NO |
| 19 | pg-boss `case-intelligence` | `job_queue.js:46` | on-demand | n/a | n/a | n/a | YES (`stopJobQueue` at `server.js:1107`) |
| 20 | pg-boss `case-reprocess` | `job_queue.js:47` | on-demand | n/a | n/a | n/a | YES |
| 21 | pg-boss `auto-assign` | `job_queue.js:48` | on-demand | n/a | n/a | n/a | YES |

**New P3-WORKER findings (added scope, not fixed):**

- **P3-WORKER-N1** (Sub-issue C2) — Even after `var ci → let ci`, the campaign cron's setImmediate fires on every instance because the rowCount of the `UPDATE … WHERE status='scheduled'` race is never checked. Fix: gate the cron on primary OR check rowCount before queueing `setImmediate`.
- **P3-WORKER-N2** (Sub-issue D2) — `video_scheduler.js:262-268, 273-285` admin alerts pass `type: 'admin_alert'` (not a queueNotification parameter) and no `toUserId`. Both silently dropped. Fix: mirror `sla_watcher.js:12` — query `findSuperadmins()` and fan out per-superadmin queueNotification calls.
- **P3-WORKER-N3** — Appointment reminder cron (`server.js:1025-1027`) is unconditional. On multi-instance, both instances re-fetch the same `reminder_24h_sent = false` rows; the `queueMultiChannelNotification` dedupe-key covers the multi-channel path but the direct `sendEmailFn` send at `jobs/appointment_reminders.js:97-100` has no dedupe. Patients get 2× appointment reminder emails on multi-instance. Overlaps with audit P2-WORKER-40 but adds the multi-instance angle. Fix: gate on primary (cleanest), or add a `FOR UPDATE SKIP LOCKED` claim.
- **P3-WORKER-N4** — Instagram scheduler is gated only on `IG_ACCESS_TOKEN` presence (`instagram/scheduler.js:24`), not on primary. Both instances will publish each due post twice. Fix: gate on primary.
- **P3-WORKER-N5** — Mac-mini SSH probe (`routes/ops.js:51-52`) registered at module-require time on every instance. Runs `sshExec` to `OPS_SSH_HOST` from both boxes every 2 min. Audit P0-WORKER-8 already names this; flagged here for completeness because §4 needs a coordinated fix-pattern.

**Graceful-shutdown gap:** of the 11 active `setInterval` sites in `src/`, **only `slaSweepIntervalId` is tracked for `clearInterval`** at `server.js:1103`. Every other interval pins the event loop after SIGTERM until the 10s force-exit timer at `:1096-1099`. On Render rolling deploys this means in-flight requests are killed after 10s. Fix: track every interval id; clear all in `gracefulShutdown`. Alternative: `.unref()` every non-critical interval (notification worker, conversation auto-close, mac mini probe, passive reminders) — they shouldn't pin the loop.

---

## 3. Root cause

Three architectural patterns explain all of Theme 6:

1. **Primary-mode gating is opt-in, not opt-out.** The codebase has a single `if (CONFIG.SLA_MODE === 'primary')` block at `server.js:980-1009`. Workers registered *outside* that block run unconditionally — and most workers were registered outside it because the original author reasoned per-worker about whether single-writer mattered. For SLA breaches, the author thought "only one instance should write 'breached'" and gated correctly. For notifications and conversation auto-close, the author thought "this is just sending emails / a single UPDATE — duplicate is harmless" and didn't gate. But notifications are externally-visible side effects (Twilio rate limits, patient SMS spam, Meta WhatsApp template caps); duplicates ARE harmful. The architectural fix is to default-deny: require a positive justification (idempotent, instance-local, etc.) to register a worker outside the primary block.

2. **`setInterval(syncCallback)` + async body looks correct but isn't.** JavaScript's `setInterval` invokes its callback synchronously each tick. If the callback is `function() { try { asyncFn(); } catch {} }`, the try only catches what executes synchronously up to the first `await` inside `asyncFn`. Anything past that is a floating Promise — its rejection becomes `unhandledRejection`. The fix shape is well-known: `setInterval(async () => { try { await asyncFn(); } catch {} })` (close to what `notification_worker` and Instagram scheduler already do), OR `setInterval(() => { asyncFn().catch(handleErr); })` (one-liner). The current pattern is a holdover from a time when `runCaseSlaSweep` was sync — when it was made async, the wrappers weren't updated. Same drift caused the three call sites inside `runSlaEnforcementSweep`.

3. **`var` + closure + `setImmediate` is JavaScript's most-loved footgun.** `for (var ci = 0; ci < n; ci++) { setImmediate(() => f(arr[ci])); }` always calls `f(undefined)` because `ci` is function-scoped, not block-scoped. ESLint rule `no-loop-func` catches this; this codebase doesn't run that rule (the loop creates a function). Easy fix; lint-test in §6 prevents recurrence.

The video-scheduler `userId:` typo is in a different category — a one-time copy-paste mistake (pattern was copied from a callsite that used a different signature). The lint-test for the canonical `toUserId:` field name catches this and any future drift.

---

## 4. Fix plan

Each sub-issue ships as its own commit. Order: D (15m, lowest blast radius), A (1h), C (45m), B (3h with ESLint rule). Total 4-5h.

### §4-A — Move notification worker + conversation auto-close inside primary block

**Proposed diff (`src/server.js`):**

```diff
   if (CONFIG.SLA_MODE === 'primary') {
     logMajor('SLA MODE: primary (single writer enabled)');
     ...
     slaSweepIntervalId = setInterval(function() {
       runSlaEnforcementSweep('interval');
     }, SLA_ENFORCEMENT_INTERVAL_MS);
     if (slaSweepIntervalId.unref) slaSweepIntervalId.unref();

     logMajor('Payment reminders dispatched via SLA sweep (every 5 min)');
+
+    // Conversation auto-close — primary-only, idempotent UPDATE,
+    // but the boot fire-once would spike the pool on every instance.
+    try {
+      var closeStaleConversations = require('./routes/messaging').closeStaleConversations;
+      var ccBoot = setTimeout(function() { try { closeStaleConversations(); } catch (_) {} }, 5000);
+      if (ccBoot.unref) ccBoot.unref();
+      var ccInterval = setInterval(function() { try { closeStaleConversations(); } catch (_) {} }, 24 * 60 * 60 * 1000);
+      if (ccInterval.unref) ccInterval.unref();
+      intervalIds.push(ccInterval);
+      logMajor('Conversation auto-close registered (daily, primary-only)');
+    } catch (e) {
+      logMajor('Conversation auto-close registration failed: ' + e.message);
+    }
+
+    // Notification worker — primary-only. The notifications table has no
+    // FOR UPDATE SKIP LOCKED claim, so multi-instance double-sends WhatsApps.
+    var runNotificationWorker = require('./notification_worker').runNotificationWorker;
+    var nwInterval = setInterval(async function() {
+      try { await runNotificationWorker(50); } catch (err) { console.error('[notify-worker] interval error', err); }
+    }, 30000);
+    if (nwInterval.unref) nwInterval.unref();
+    intervalIds.push(nwInterval);
+    var nwBoot = setTimeout(async function() {
+      try { await runNotificationWorker(50); console.log('[notify-worker] initial run complete'); } catch (err) { console.error('[notify-worker] initial run error', err); }
+    }, 5000);
+    if (nwBoot.unref) nwBoot.unref();
+    logMajor('Notification worker registered (every 30s, primary-only)');
   } else {
     logMajor('SLA MODE: passive (no SLA mutations)');
     setInterval(function() { ... }, 15 * 60 * 1000);
     logMajor('Payment reminders registered (every 15 min, passive mode)');
   }

-  // Auto-close stale conversations
-  try {
-    var closeStaleConversations = require('./routes/messaging').closeStaleConversations;
-    setTimeout(function() { try { closeStaleConversations(); } catch (_) {} }, 5000);
-    setInterval(function() { try { closeStaleConversations(); } catch (_) {} }, 24 * 60 * 60 * 1000);
-    logMajor('Conversation auto-close registered (daily)');
-  } catch (e) {
-    logMajor('Conversation auto-close registration failed: ' + e.message);
-  }
   ...
-  // Notification worker
-  var runNotificationWorker = require('./notification_worker').runNotificationWorker;
-  setInterval(async function() {
-    try { await runNotificationWorker(50); } catch (err) { console.error('[notify-worker] interval error', err); }
-  }, 30000);
-  setTimeout(async function() {
-    try { await runNotificationWorker(50); console.log('[notify-worker] initial run complete'); } catch (err) { console.error('[notify-worker] initial run error', err); }
-  }, 5000);
-  logMajor('Notification worker registered (every 30s)');
```

Where `intervalIds` is a new module-level `var intervalIds = [];` declared near line 935 (alongside `slaEnforcementRunning`), and `gracefulShutdown` adds:

```diff
   try {
     if (slaSweepIntervalId) { clearInterval(slaSweepIntervalId); slaSweepIntervalId = null; }
+    intervalIds.forEach(function(id) { try { clearInterval(id); } catch (e) {} });
+    intervalIds.length = 0;
   } catch (e) {}
```

**Rationale for `.unref()`:** `closeStaleConversations` and `runNotificationWorker` are best-effort sweeps; they shouldn't pin the event loop after SIGTERM. `slaSweepIntervalId` already calls `.unref()` (`server.js:1000`).

**Why not `SELECT ... FOR UPDATE SKIP LOCKED` for the notification worker?** It's the right long-term answer (would survive a future scale-out where multiple instances *should* run the worker), but it's a much larger change to `notification_worker.js:199-211` and requires a two-phase claim pattern. The audit (`P0-WORKER-1`) names primary-gating as the small fix and the row-claim as the alternative. Punt SKIP LOCKED to Theme 8 (or a follow-up sub-issue) — the gate alone fixes the bug for the current Render deployment topology.

---

### §4-B — Convert async-in-setInterval to safe pattern

**Proposed diff (`src/case_sla_worker.js`):**

```diff
 function startCaseSlaWorker(intervalMs = SCAN_INTERVAL_MS) {
   if (workerStarted) return;
   workerStarted = true;
-  runCaseSlaSweep();
-  setInterval(() => {
-    try {
-      runCaseSlaSweep();
-    } catch (err) {
-      logFatal('Case SLA sweep failed', err);
-    }
-  }, intervalMs);
+  // Boot run — `.catch` so a startup DB blip doesn't kill the process.
+  runCaseSlaSweep().catch(err => logFatal('Case SLA sweep failed (boot)', err));
+  // Setinterval body must use async+await OR `.catch`. The previous
+  // sync try/catch could not catch the rethrow at runCaseSlaSweep:393.
+  const id = setInterval(() => {
+    runCaseSlaSweep().catch(err => logFatal('Case SLA sweep failed', err));
+  }, intervalMs);
+  if (id.unref) id.unref();
+  return id;
 }
```

**Proposed diff (`src/server.js:953-967` inside `runSlaEnforcementSweep`):**

```diff
   try {
-    try { runWatcherSweep(new Date()); } catch (err) { logFatal('SLA watcher sweep error', err); }
+    try { await runWatcherSweep(new Date()); } catch (err) { logFatal('SLA watcher sweep error', err); }
     try { await runSlaReminderJob(); } catch (err) { logFatal('SLA reminder job error', err); }
-    try { dispatchUnpaidCaseReminders(); } catch (err) { logFatal('Unpaid reminder sweep error', err); }
+    try { await dispatchUnpaidCaseReminders(); } catch (err) { logFatal('Unpaid reminder sweep error', err); }
     try {
       if (typeof caseLifecycle.sweepExpiredDoctorAccepts === 'function') {
-        caseLifecycle.sweepExpiredDoctorAccepts();
+        await caseLifecycle.sweepExpiredDoctorAccepts();
       }
     } catch (err) { logFatal('Doctor accept sweep failed', err); }
```

**Note:** the function is already declared `async` at `:939`, so `await` is legal. The change makes each step's try/catch effective (rejection now lands in the catch instead of escaping).

**Proposed diff (`src/server.js:1005-1007`, passive mode payment reminders):**

```diff
-    setInterval(function() {
-      try { dispatchUnpaidCaseReminders(); } catch (err) { console.error('[payment-reminders] error', err); }
-    }, 15 * 60 * 1000);
+    var passiveReminders = setInterval(function() {
+      dispatchUnpaidCaseReminders().catch(function(err) { console.error('[payment-reminders] error', err); });
+    }, 15 * 60 * 1000);
+    if (passiveReminders.unref) passiveReminders.unref();
+    intervalIds.push(passiveReminders);
```

**ESLint rule (regression prevention):** add `eslint-plugin-promise` or write a custom rule that forbids:

```js
setInterval(function() { syncBody-with-bare-asyncFn-call(); }, ...)
```

A simpler grep-based lint test (more this codebase's style) is in §6.

---

### §4-C — Fix `var ci` hoisting + check UPDATE rowCount

**§4-C1 — primary fix (`src/server.js:1037-1057`):**

```diff
     campaignCron.schedule('*/5 * * * *', async function() {
       try {
         var now = new Date().toISOString();
         var scheduled = await safeAll(
           "SELECT id FROM email_campaigns WHERE status = 'scheduled' AND approved_by IS NOT NULL AND scheduled_at <= $1",
           [now], []
         );
-        for (var ci = 0; ci < scheduled.length; ci++) {
+        for (let ci = 0; ci < scheduled.length; ci++) {
+          const campaignId = scheduled[ci].id;
           try {
-            await execute("UPDATE email_campaigns SET status = 'sending' WHERE id = $1 AND status = 'scheduled' AND approved_by IS NOT NULL", [scheduled[ci].id]);
-            setImmediate(function() { try { processCampaign(scheduled[ci].id); } catch (_) {} });
+            const result = await execute(
+              "UPDATE email_campaigns SET status = 'sending' WHERE id = $1 AND status = 'scheduled' AND approved_by IS NOT NULL",
+              [campaignId]
+            );
+            // §4-C2 (P3-WORKER-N1): only the instance that won the
+            // scheduled→sending race should dispatch. Both instances
+            // SELECTed the same row; only one's UPDATE matched.
+            if (result && result.rowCount > 0) {
+              setImmediate(function() {
+                processCampaign(campaignId).catch(function(err) {
+                  console.error('[campaigns] processCampaign failed for ' + campaignId, err);
+                });
+              });
+            }
           } catch (_) {}
         }
         if (scheduled.length > 0) {
           logMajor('[campaigns] Triggered ' + scheduled.length + ' scheduled campaign(s)');
         }
       } catch (_) {}
     });
```

Three changes: (1) `var → let` (block-scoped, captures correctly per iteration); (2) hoist the id into a `const campaignId` to make the closure intent explicit; (3) check `rowCount > 0` so only the race-winner dispatches; (4) replace bare `try { processCampaign(...) } catch (_)` (which fails to catch async rejections — same shape as Sub-issue B) with `.catch()`.

**§4-C2 — defer or apply now?** The rowCount guard is small and defensible. Applying alongside the var fix is cleaner than a follow-up commit. Marking as part of Sub-issue C in the same commit; flag in commit message that this also addresses P3-WORKER-N1.

---

### §4-D — Fix video scheduler `userId` → `toUserId` + admin alerts

**§4-D1 — primary fix (`src/video_scheduler.js:250-260`):**

```diff
     // Notify patient
     if (slot.patient_id) {
-      queueNotification({
-        userId: slot.patient_id,
-        type: 'whatsapp',
+      await queueNotification({
+        toUserId: slot.patient_id,
+        channel: 'whatsapp',
         template: 'video_slot_auto_cancelled_patient',
         data: { patient_name: slot.patient_name, amount: slot.payment_amount, currency: slot.payment_currency || 'EGP' },
         orderId: slot.order_id,
         dedupe_key: `video:slot:autocancelled:${slot.id}`
       });
     }
```

Three changes: (1) `userId` → `toUserId` (the named bug); (2) `type` → `channel` (the named-but-not-named bug — same shape, was wrong but masked); (3) `await` the call so the worker's outer try/catch picks up insert failures instead of letting them escape to `unhandledRejection`.

**§4-D2 — admin alerts (P3-WORKER-N2):** replace each `type: 'admin_alert'` queueNotification with the canonical fan-out pattern from `sla_watcher.js:12-16`:

```diff
+    // Helper at top of file:
+    async function notifyAdmins(template, data, dedupeKey, orderId) {
+      const admins = await queryAll("SELECT id FROM users WHERE role = 'superadmin' AND COALESCE(is_active, true) = true");
+      for (const a of admins) {
+        await queueNotification({
+          toUserId: a.id,
+          channel: 'internal',
+          template,
+          data,
+          orderId,
+          dedupe_key: dedupeKey + ':' + a.id,
+        });
+      }
+    }

     // Notify admin (48h auto-cancel)
-    queueNotification({
-      type: 'admin_alert',
-      template: 'video_slot_auto_cancelled_admin',
-      data: { order_id: slot.order_id, doctor_name: slot.doctor_name, patient_name: slot.patient_name, status: slot.status },
-      orderId: slot.order_id,
-      dedupe_key: `video:slot:autocancelled:admin:${slot.id}`
-    });
+    await notifyAdmins(
+      'video_slot_auto_cancelled_admin',
+      { order_id: slot.order_id, doctor_name: slot.doctor_name, patient_name: slot.patient_name, status: slot.status },
+      `video:slot:autocancelled:admin:${slot.id}`,
+      slot.order_id
+    );
```

Same shape for the 24h escalation at `:273-285`. The dedupe-key suffix `:${a.id}` prevents double-suppression when admins are added/removed between sweeps.

---

## 5. Verification steps

### V1 — Sub-issue A: prove primary-instance gating works (multi-instance test)

A real multi-instance test requires two Node processes pointing at the same Postgres. Three viable shapes:

1. **Local two-process test** (recommended for `tests/core/`):
   - Spawn two Node processes via `child_process.fork`, set `SLA_MODE=primary` on one and `SLA_MODE=passive` on the other, both pointing at a test DB.
   - Insert a `notifications` row with `status='queued'`.
   - Wait 35s (notification worker fires every 30s + buffer).
   - Assert: only one row in `notification_send_log` (or whatever audit shape the worker writes).
   - Assert: passive instance's stdout contains `SLA MODE: passive` and does NOT contain `Notification worker registered`.

2. **Boot-log assertion** (cheaper, what the codebase prefers):
   - Boot the server with `SLA_MODE=passive` in a test fixture; capture log output.
   - Assert: stdout contains `SLA MODE: passive` AND does NOT contain `Notification worker registered` AND does NOT contain `Conversation auto-close registered`.
   - Boot again with `SLA_MODE=primary`; assert all three lines DO appear.
   - This is a `tests/core/theme6-passive-mode-skips-workers.test.js` style test — one-process boot, pure log-grep, no DB writes needed.

3. **Code-shape lint** (cheapest, prevents regression):
   - `tests/core/theme6-workers-gated-on-primary.test.js`: greps `src/server.js` for the `setInterval(...notification...)` and `closeStaleConversations` registrations and asserts they appear *between* the `if (CONFIG.SLA_MODE === 'primary')` line and its closing `}`. AST-based check via `acorn` is more robust than line-range grep. See §6 for the exact shape.

Recommend (2) + (3) for the §6 suite (lint + boot-log smoke), and (1) as a manual playbook entry in §5-V4.

### V2 — Sub-issue B: prove async-in-setInterval rejections no longer crash

Two-phase verification:

1. **Reproduce the bug** (sanity check that the audit's claim is real before fixing):
   - Add a temporary fault-injection flag to `case_sla_worker.fetchSlaCandidates` that throws on the next call.
   - Boot with `pg-boss` disabled (so `startCaseSlaWorker` is the active path).
   - Wait one tick (5 min default; lower interval to 5s for the test).
   - Observe `unhandledRejection` log line + `process.exit(1)`.
   - Verify Render alert fires (sendCriticalAlert).
   - **Remove the fault injection.**

2. **After fix**, repeat the same fault-injection scenario:
   - Observe `[case-sla] sweep failed` log line at `logFatal` level.
   - Process **does not exit**. Next tick proceeds normally.
   - Run for 3 ticks; verify the worker recovers when fault injection is removed.

3. **Static lint** (regression prevention, see §6):
   - Grep `src/` for `setInterval\s*\(\s*function\s*\(\s*\)\s*\{\s*try\s*\{\s*[a-zA-Z_]+\s*\([^)]*\)\s*;\s*\}\s*catch` (sync wrapper around possible async fn) and assert no hits OR hits on a documented allowlist (passive reminders, etc., once they're fixed).
   - Alternative AST-based check: parse with acorn, walk for `CallExpression { callee: 'setInterval' }`, inspect callback body's `try { ExpressionStatement }`, and assert the expression is either NOT a CallExpression returning a Promise OR the wrapping is `async` + `await` OR `.catch()`.

### V3 — Sub-issue C: prove `var ci` fix sends every campaign

1. **Pre-fix repro**: insert two `email_campaigns` rows with `status='scheduled'`, `approved_by NOT NULL`, `scheduled_at` past. Wait one cron tick. Assert: both rows are in `'sending'`, NO rows in `campaign_recipients` are `status='sent'`, after a generous wait both rows STILL `'sending'`.
2. **Post-fix repro**: same setup. Wait one cron tick + processCampaign budget (~20s for ~10 recipients). Assert: both campaigns transition `'sending' → 'sent'`; recipient rows show `status='sent'`.
3. **Multi-instance**: boot two processes against the same DB. Both have `SLA_MODE=primary` (worst case if Render misconfigured) OR both have the unconditional cron. After §4-C1's rowCount guard, assert each campaign's recipients receive **exactly one** email (via a mock sendEmailFn that counts calls per recipient).

### V4 — Sub-issue D: prove `toUserId` rename actually queues + lint catches regressions

1. Insert a video slot row aged 49h, `payment_id NOT NULL`. Run `sweepStalePendingSlots` once.
2. Assert: a row exists in `notifications` with `to_user_id = <patient.id>`, `template = 'video_slot_auto_cancelled_patient'`, `dedupe_key = 'video:slot:autocancelled:<slot.id>'`.
3. Assert: a row exists in `notifications` per superadmin with `template = 'video_slot_auto_cancelled_admin'`.
4. Assert: lint `tests/core/theme6-queue-notification-uses-to-user-id.test.js` (§6) passes — no `userId:` direct fields anywhere in `src/`.

### V5 — Manual multi-instance playbook (Render staging)

Record steps in `docs/playbooks/THEME_06_MULTI_INSTANCE_VERIFICATION.md`:

1. Scale staging Render service to 2 instances with `SLA_MODE=primary` on instance #0 and unset on instance #1 (instance-level env vars).
2. Verify boot logs: instance #0 logs `SLA MODE: primary`; instance #1 logs `SLA MODE: passive`.
3. Verify only instance #0 logs `Notification worker registered` and `Conversation auto-close registered`.
4. Insert one test notification (via `/api/test/queue-notification` debug endpoint, gated on staging).
5. Verify the notification fires exactly once (Twilio dashboard delivery count = 1).
6. Tear down to 1 instance.

Add this playbook as a checkbox to `docs/SLA_ARCHITECTURE.md` so it runs before any Render scale-out.

---

## 6. What to add to the test suite

All tests target `tests/core/` to match the existing suite shape (no test framework — direct `node tests/core/<name>.test.js` via the project's runner).

### T1 — `theme6-queue-notification-uses-to-user-id.test.js` (lint, Sub-issue D)

Pure source-grep. For every `queueNotification(` call site in `src/`, assert the next 12 lines do NOT contain a leading `userId:` (or `uid:`/`user_id:`/`recipientId:`/`recipient_id:`) before the closing `})`. Excludes `src/notify.js` itself (where `toUserId` is defined). Mirrors the shape of `tests/core/orders-table-readers-allowlist.test.js`. Reproducible verification:

```bash
grep -rE "queueNotification\s*\(\s*\{" src/ -A 12 | grep -B 1 -E "^\s*(userId|uid|user_id|recipientId|recipient_id):"
# Should print nothing after fix.
```

### T2 — `theme6-set-interval-async-pattern.test.js` (lint, Sub-issue B)

For every `setInterval(` call site in `src/`, parse the callback. Disallow the shape "sync function whose body is `try { asyncCallExpr; } catch`". Allowed shapes: (a) `async function() { try { await ...; } catch }`; (b) `function() { asyncFn().catch(...); }`; (c) inner async fn fully wrapped in try/catch/finally so its Promise always resolves (whitelist by callee name, e.g. `runAcceptanceWatcherSweep`, `closeStaleConversations`).

Implementation: parse `src/` files with `acorn` (or `@babel/parser`), walk for `CallExpression { callee: { name: 'setInterval' } }`, classify the callback. Fail if classification is "sync wrapper around bare async call". Allowlist by file:line for the `closeStaleConversations` boot setTimeout (Promise always resolves) — same allowlist pattern as `orders-table-readers-allowlist.test.js`.

Fallback (no acorn dep): pure-grep regex catching the offending shape `setInterval\s*\(\s*function\s*\(\)\s*\{\s*try\s*\{\s*\w+\s*\(\s*\)\s*;\s*\}\s*catch`. Less precise; misses arrow functions and multi-statement bodies. Acorn is preferred.

### T3 — `theme6-workers-gated-on-primary.test.js` (lint, Sub-issue A)

AST-based. Parse `src/server.js`, locate the top-level `if (CONFIG.SLA_MODE === 'primary')` IfStatement node. For each of the worker registrations that MUST be primary-only, assert their AST node range is entirely inside the IfStatement's consequent `{...}` block.

Workers to assert:
- `runNotificationWorker` setInterval and setTimeout
- `closeStaleConversations` setInterval and setTimeout
- `cron.schedule('*/5 * * * *', ...)` (campaign cron) — once §4-C2 lands
- `cron.schedule('*/15 * * * *', ...)` (appointment reminder) — once §P3-WORKER-N3 is fixed
- `new InstagramScheduler()` + `.start()` — once §P3-WORKER-N4 is fixed

Allowlist: passive payment reminder (`server.js:1005-1007`) is in the `else` branch; not primary, but is single-writer correctly. Skip.

### T4 — `theme6-no-var-in-async-loops.test.js` (lint, Sub-issue C)

Pure source-grep. For every `for (` loop in `src/` (excluding `tests/`, `node_modules`, `migrations/`), check whether the loop body contains `setImmediate(`, `setTimeout(`, or `setInterval(` AND whether the loop variable is declared with `var`. Fail if both true.

Equivalent to the ESLint `no-loop-func` rule scoped to var-loops with deferred callbacks. Trivial regex first pass:

```bash
grep -rEn "for\s*\(\s*var\s+\w+" src/ | while read -r line; do
  file="${line%%:*}"
  lineno="${line#*:}"; lineno="${lineno%%:*}"
  awk -v start="$lineno" -v end="$((lineno+25))" 'NR>=start && NR<=end' "$file" | grep -E "setImmediate|setTimeout|setInterval" >/dev/null && echo "FAIL: $file:$lineno"
done
```

### T5 — `theme6-graceful-shutdown-clears-intervals.test.js` (regression, §4-A diff)

Boots the server (mock-DB), records `setInterval` and `setTimeout` calls (monkeypatch on the `global` object), sends a SIGTERM, and asserts every recorded interval id received a `clearInterval` call (or that the interval was created with `.unref()`). Allowlist for `slaSweepIntervalId` and the new `intervalIds[]` array. Ensures we don't add a 12th worker without tracking it.

### T6 — Existing `tests/core/notify-whatsapp.test.js` audit

Verify it covers the queueNotification → notification_worker → Twilio path end-to-end (via stub). If yes, the §V1 multi-instance test can piggyback on the same stub. If not, T6 is a follow-up.

### T7 — Boot-log smoke (Sub-issue A) — `theme6-passive-mode-skips-workers.test.js`

Boot the server with `SLA_MODE=passive` in a child process, capture stdout for 3s, then SIGTERM. Assert stdout contains exactly: `SLA MODE: passive`, `Payment reminders registered (every 15 min, passive mode)` AND does NOT contain: `Notification worker registered`, `Conversation auto-close registered`, `[case-sla]`, `[video-scheduler]`, `[acceptance_watcher]`.

---

## 7. Rollback plan

Theme 6 ships as four independent commits (D → A → C → B order). Each is mechanical and surgically scoped:

| Sub-issue | Files touched | LoC | Commit | Rollback |
|---|---|---|---|---|
| D | `src/video_scheduler.js` | ~25 | `fix(video): toUserId + admin alerts (Theme 6 Sub-issue D)` | `git revert <sha>` — patient stops getting auto-cancel notice (was already silently broken) |
| A | `src/server.js` | ~30 | `fix(workers): gate notification worker + conv-close on primary (Theme 6 Sub-issue A)` | `git revert <sha>` — both instances re-double-send (was already broken) |
| C | `src/server.js` | ~10 | `fix(campaigns): var→let + rowCount guard (Theme 6 Sub-issue C)` | `git revert <sha>` — campaigns stuck in 'sending' (existing prod state) |
| B | `src/case_sla_worker.js`, `src/server.js` | ~15 | `fix(workers): convert sync-try/catch to .catch() for async setInterval bodies (Theme 6 Sub-issue B)` | `git revert <sha>` — async rejections crash again on in-process fallback path |

**No DB migrations.** All changes are runtime-behaviour, no schema or data effects.

**Lint test files** added in the same commits as their corresponding fix (lint test ships alongside fix to prove green CI). If a lint test alone breaks CI for a future PR, revert the lint test commit (or extend the allowlist with PR-level justification, mirroring `orders-table-readers-allowlist.test.js`'s allowlist pattern).

**Render rollback path:** if any of A/B/C/D triggers an unexpected production behaviour (e.g., notification worker stops on the primary instance because of a typo in the gate), Render's "Rollback to previous deploy" UI restores the prior commit in <2 min. SLA: pre-launch, no patient-facing degradation since the buggy path was already broken.

---

## 8. Open questions for Ziad

**OQ-1 — Multi-instance topology (load-bearing for §4-A and §V5).** The audit (line 7, line 28-29) says: "Stack confirmed: ... multi-instance on Render with `SLA_MODE=primary` on exactly one instance." Two questions:
  - **Q1a:** Is the production Render service currently scaled to >1 instance? If staging is 1-instance and production is 2-instance, the bug fires only in prod. If both are 1-instance today, the §V5 manual playbook needs to wait for the first scale-out.
  - **Q1b:** Is `SLA_MODE=primary` set as an instance-level env var (Render's per-instance overrides) or a service-level env var? If service-level, **both instances will set primary = true** and §4-A's gate alone won't help — we'd need a row-level claim (the SKIP LOCKED alternative). The audit assumed instance-level; please confirm.

**OQ-2 — `notification_worker` SKIP LOCKED.** §4-A applies the audit's "small fix" (primary-gate). The "alternative" is `SELECT … FOR UPDATE SKIP LOCKED` + a two-phase claim, which would let the worker safely scale to N>1 instances in the future. Want me to bundle the SKIP LOCKED change into Theme 6 (~3h extra) or punt it to Theme 8? **Recommendation: punt.** Pre-launch traffic is low; primary-gate is enough; SKIP LOCKED is a future-Render-scale concern.

**OQ-3 — Primary-only campaign cron AND appointment reminders AND IG scheduler.** §4-C1 fixes the `var ci` bug regardless. §4-C2 (rowCount guard) makes the cron multi-instance-safe even if it stays unconditional. P3-WORKER-N3 (appointment reminders) and P3-WORKER-N4 (IG scheduler) are similar shape — both are unconditional and would double-fire on 2 instances. Do you want them in Theme 6's scope, or split as Theme 6b? **Recommendation: bundle into Theme 6.** They're a single-line change each (move inside the primary block) and the §V5 multi-instance playbook covers all of them in one pass.

**OQ-4 — `acceptance_watcher` interval id discarded.** `workers/acceptance_watcher.js:152` returns the setInterval id; `server.js:991` calls `startAcceptanceWatcher()` and discards the return. Want me to plumb the id back via the new `intervalIds[]` array (graceful shutdown coverage) in Theme 6, or leave it for Theme 6b? **Recommendation: bundle in §4-A** — same diff already adds `intervalIds`; one extra `.push()` is free.

**OQ-5 — Mac-mini SSH probe (`routes/ops.js:51-52`) — gate on what?** It's not SLA-mode dependent — it's a monitoring probe. Options: (a) always run on instance #0 only via a new env (`OPS_PROBE_PRIMARY=true`); (b) gate on `SLA_MODE=primary` like everything else; (c) move to a one-time on-demand fetch via the ops dashboard rather than a recurring probe. **Recommendation: (b)**, simplest and consistent with the rest of the codebase. **Defer to Theme 6b** if the answer isn't immediate — this is a P0 in the audit but doesn't affect patient-facing flows.

**OQ-6 — `logFatal` semantics on caught-but-then-rethrown errors.** §4-B's `runCaseSlaSweep().catch(err => logFatal(...))` writes to stdout via `logFatal` (which is currently `console.error` per audit ERR-P0). Do you want this routed to the `error_logs` table (like `logErrorToDb`) so it's queryable in the ops dashboard, or is stdout fine for transient sweep failures? **Recommendation: stdout for now**, bump to `logErrorToDb` once the unified logger lands (out of scope for Theme 6).

---

*End of Theme 6 scoping. No source files modified; only this report file is committed.*
