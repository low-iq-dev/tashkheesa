# Watchtower — 6 October 2026

Branch `feat/watchtower`, cut from `origin/main` at `a80ea43`, built in the worktree
`../tashkheesa-watchtower`. Pushed to origin. **Not merged, not deployed.** No production
writes: every production query was a read, or the one migration dry run, which was forced
to roll back and then verified as rolled back.

Contents: [Part 0 findings](#part-0--findings) · [What was built](#what-was-built) ·
[Suite](#suite-before-and-after) · [Contract](#contract) · [Env vars](#environment-variables) ·
[Migrations](#migrations-and-the-production-dry-run) · [Found in review](#found-in-review) ·
[Deliberately not done](#deliberately-not-done) · [Needs Ziad](#needs-ziad)

---

## Part 0 — findings

### a. `src/critical-alert.js` as it was on origin/main

**Delivery path.** `sendCriticalAlert(message, alertKey?)`:

1. Derives a throttle key (the caller's, else the message's leading `EVENT_NAME:`, else `generic`).
2. Claims a 5-minute per-key slot with one `INSERT … WHERE NOT EXISTS` into `critical_alert_log`. No row back means throttled, and it returns. A database error fails open.
3. Fires a Command push through `notifySuperadmins` — fire-and-forget, with **no `kind`**, so always loud, and with **no record of the outcome**.
4. Then WhatsApp to `ADMIN_PHONE`: OpenClaw if `OPENCLAW_BASE_URL` + `OPENCLAW_SEND_KEY` are set, otherwise the Meta Cloud API with a utility template.

**What marked a row delivered.** Nothing did. The row carried `status_code` and `error`, and both described the WhatsApp attempt only (200 = OpenClaw or Meta accepted it). The push — the channel that actually reached a phone through August — left no trace on the row.

**Which kinds an empty `CRITICAL_ALERT_TEMPLATE_NAME` silences.** All of them, but only on the Meta path. There are 25 direct call sites of `sendCriticalAlert` in `src/` (payments ×6, video ×5, superadmin ×2, admin ×2, server.js ×2, and one each in api/admin, payments_kashier, error_rate_check, whatsapp_health_check, needs_attention, ai_health, sla_breach, worker_watchdog). With the template unset and Meta as the route, every one logged `template_not_configured` and sent no WhatsApp. In production today this is moot: the last 14 days of `critical_alert_log` are 22 rows at status 200 and one `openclaw: http_530`, so OpenClaw is the live route and the template gate is never reached.

**`superadmin-1` and other non-existent recipient ids.** Already fixed before this job. The only remaining occurrences in `src/` are comments, plus `scripts/reset_demo_users.js` (the demo seed that creates that id) and two guard tests that fail if it comes back. No literal `toUserId: '…'` exists anywhere in `src/`. `critical-alert.js` never named a recipient: the push resolves superadmins by `role = 'superadmin'`, and WhatsApp goes to `ADMIN_PHONE`. Production has one superadmin with 5 live device sessions.

### b. `needs_attention.js`

**How the sweep alerts.** Every 15 minutes (pg-boss singleton, heartbeat `attention_sweep`) it read `v_needs_attention`, kept items waiting 60 minutes or more, and sent **one digest** through `sendCriticalAlert(body, 'attention-sweep')` — so the same push + WhatsApp path as above.

**Dedupe.** A row in `error_logs` with `category = 'attention_alert'` whose `context` JSON lists the `kind:ref` keys alerted on; an item is skipped if such a row exists in the last 24 hours. A failed send is not recorded, so it retries next pass. On top of that, the critical-alert 5-minute throttle on the key `attention-sweep`.

**The view today (latest definition is migration 117; 115 changed one predicate; 114 is the original).** Columns `kind, ref, who, email, phone, summary, waiting_since (timestamptz), severity (int)`. Five kinds:

| kind | source | waiting when | severity |
|---|---|---|---|
| `contact_submission` | `contact_submissions` | `status = 'new'` | 2 |
| `pre_launch_lead` | `pre_launch_leads` | `handled_at IS NULL` (115; was `launch_notified_at`) | 1 |
| `abandoned_case` | `orders` | real case, `draft_step >= 1`, unpaid, draft-like status, older than 1 hour | 1 |
| `doctor_application` | `doctor_applications` | status new / pending / submitted | 3 |
| `payment_claim` (added in 117) | `payment_claims` | `status = 'pending'` and the order unpaid; `ref` is the order id | 1 |

### c. `ops_push.js` / `ops_push_prefs.js`

**Emitting a kind.** A producer calls `pushOpsEvent({ kind, dedupeKey, title, body, data, orderId })`. It claims `kind:dedupeKey` atomically in `ops_push_log` (per-kind cooldown, default 15 minutes), applies a per-kind budget per 15-minute window (over budget: the row is still logged and one "N more …" summary is pushed), then calls `notifySuperadmins` with the `kind`.

**The log.** One `ops_push_log` row per claimed event: `event_key, kind, title, body, order_id, sent_count`. `sent_count` is the number of registered superadmin devices, counted before the send. The worker watchdog bypasses the claim and calls `recordOpsEvent` so it still leaves a row.

**Loud / quiet / off.** `KIND_CATALOGUE` gives each kind a group, a default mode, English and Arabic labels, and optionally `lockOn` (cannot be turned off). Per-superadmin overrides live in `admin_notification_prefs`. `deliveryFor(mode)` turns the mode into Expo fields.

**How the app routes a tap** (read from `tashkheesa-command/lib/push.ts`, not changed): `data.burst` → Activity; `data.kind === 'payment_claim'` → Transfers; `data.screen === 'manual-queue'` → Manual queue; any `data.caseId` or `data.orderId` → that case; **everything else → the dashboard**. So `screen: 'ops'`, and the new `screen: 'attention'` and `screen: 'system'`, all land on the dashboard until the app job adds those routes.

### d. `funnel_digest.js`

**What.** Yesterday's funnel (Cairo day): landing and services views, taps, register views, signups, cases started, uploaded, submitted, paid with the EGP total, a per-campaign split, and since-launch totals.
**When.** A 15-minute interval on the primary instance; it sends once per Cairo day at or after 09:00, guarded by a `__digest_sent` claim row in `funnel_daily_counts`.
**To whom.** WhatsApp to `FOUNDER_ALERT_PHONES`, or two built-in personal numbers when that is unset, template `founder_funnel_digest`. Nothing went to the Command app.

### e. `/healthz` when a worker is down

**Status code: 200. Always.** The body is what changes:

```json
{ "ok": true, "mode": "production", "timestamp": 1759740000000, "uptimeSec": 86400,
  "requestId": "…", "pool": { "total": 4, "idle": 3, "waiting": 0 },
  "workers": [ { "name": "case_sla_worker", "status": "down", "ageSec": 1900, "staleSeconds": 720 },
               { "name": "acceptance_watcher", "status": "alive", "ageSec": 41, "staleSeconds": 360 }, … ],
  "workersOk": false,
  "clock": { "db": "UTC", "node": "UTC", "ok": true }, "clockOk": true }
```

`"ok"` stays `true` even then. A worker reads `starting` (not `down`) while the instance's uptime is shorter than that worker's staleness budget, and `starting` counts as ok.

**So a plain HTTP monitor on `/healthz` cannot alarm on a dead worker.** The "tashkheesa.com" monitor must be a **keyword** monitor: URL `https://tashkheesa.com/healthz`, keyword `"workersOk":true`, alert when the keyword is **not** found. That also catches a down site (no body, no keyword). A second keyword monitor on `"clockOk":true` covers the timezone fault. After this branch deploys, `workers` gains a sixth entry, `system_checks`.

### f. Already built — skipped or kept

- **Transfer claims waiting over 60 minutes are already a kind**: `payment_claim` (117), with the 60 minutes applied by the sweep. Not added again.
- **`superadmin-1`**: already fixed (see a). The only work left was to keep it true and pin it with a test.
- **A push from `sendCriticalAlert`** already existed (25 Aug). It was untyped and unrecorded; Part 1 made it primary, typed and recorded rather than adding one.
- **CSRF exemption** for `/api/v1/*` already exists as a prefix rule; `POST /api/v1/ops/checks` needed no change to `middleware/csrf.js`.
- **Daily maintenance path** exists (the daily heartbeat prune in `server.js`); history pruning was added to it.

---

## What was built

For each part: what it is, the guard that matters, and the test that fails when the guard is removed. Every "negative test" below was confirmed by actually removing the guard and watching the named test fail, then restoring it.

### Part 1 — critical alerts reach a phone

- Push is the primary transport. `sendCriticalAlert` sends the catalogue kind **`critical_alert`** (group system, default loud, lockOn, Arabic label «تنبيه حرج») to every superadmin device, and writes an Activity row.
- `critical_alert_log` gains `delivered`, `push_attempted`, `push_accepted`, `push_error` (migration 124). `delivered` is true only when Expo accepted at least one ticket. `status_code` / `error` keep meaning the WhatsApp attempt, so the `/ops` widget that reads them is unaffected.
- `notifySuperadmins` now returns `{ attempted, accepted, rejected, errors }` and the Expo call has an 8-second timeout. Existing callers ignore the return value.
- WhatsApp runs alongside the push, not after it. With `ADMIN_PHONE` unset, or neither transport's credentials set, it is off — no log row, no error. It cannot throw into the caller.
- If no ticket was accepted and WhatsApp is off, an `error_logs` row with category `critical_alert` says so.

| Guard | Negative test (in `tests/watchtower/critical-alert-push.test.js`) |
|---|---|
| Delivered only on an accepted ticket | "a rejected ticket is recorded as NOT delivered" — fails if `delivered` is forced true |
| The per-key throttle | "the per-key throttle holds" — fails if the throttled early-return is removed |
| WhatsApp unset must not throw or log | "unset WhatsApp config does not throw…" — fails if the unset branch throws |
| WhatsApp cannot fail the push | "a WhatsApp transport that throws cannot fail or block the push" |
| Nobody reachable is visible | "nobody reachable on any channel is written to error_logs" |

### Part 2 — attention API

- `attention_state` (migration 125) and four new kinds in `v_needs_attention` (migration 126; 114 untouched, 117's five arms copied byte for byte).
- `GET /attention` and the three state POSTs (contract below).
- Escalation runs inside the existing sweep. The four new kinds are pushed one item at a time as their own catalogue kind: **loud** — when first seen, again after 2 hours, then every 6, until acked or snoozed; **quiet** — once. `paid_unassigned` is loud + lockOn; `refund_stale`, `specialty_uncovered`, `send_failed` are quiet.
- The five existing kinds keep the sweep's rule exactly: one digest after 60 minutes, re-alert after 24 hours. The one change for them: a snoozed or resolved item is skipped.
- Two columns beyond the spec, on `attention_state`: `first_seen_at` / `last_seen_at` (the sweep stamps every item each pass) and `last_pushed_at` / `push_count` (the escalation clock). `specialty_uncovered` has no timestamp of its own, so it ages from `first_seen_at`. If an item leaves the view for over 2 hours and comes back, it is a new episode: the ack and the push count are cleared.

| Guard | Negative test (`tests/watchtower/attention.test.js`) |
|---|---|
| 15-minute threshold on `paid_unassigned` | "paid_unassigned: paid, no doctor, open, older than 15 minutes" — fails at 5 minutes |
| Practice exclusion | "practice cases are excluded from every order-touching kind" |
| Loud clock 2h then 6h | "loud: pushed first, again after 2h, then every 6h" — fails at 1h |
| Quiet is once | "quiet: pushed once and never again" — fails with the guard removed |
| Ack stops repeats | "loud: an ack or a snooze stops the repeat pushes" |
| State only on a real item | "state cannot be set on an unknown kind or on something not waiting" |
| Superadmin only | "routes are mounted below the superadmin gate, and nowhere else" |

### Part 3 — check registry

- `ops_checks` and `ops_check_history` (migration 127), RLS on, no policies. History is written by a **trigger**, so a row written by plain SQL is recorded like a posted one; it records the first sighting and every change of status or summary, not every identical heartbeat. Pruned at 90 days in the existing daily maintenance pass.
- `POST /api/v1/ops/checks` and `GET /api/v1/admin/system` (contract below).
- Worker `system_checks`: pg-boss singleton every 5 minutes, heartbeats as `system_checks`, registered in `admin_health.WORKER_SPECS` (12-minute budget). It writes eleven internal checks:

| check_key | area | warn | fail |
|---|---|---|---|
| `site.workers` | site | — | any worker `down` |
| `cases.paid_unassigned` | cases | any | oldest ≥ 60 min |
| `cases.sla_overdue` | cases | any | 3 or more |
| `money.claims_waiting` | money | any over 60 min | oldest ≥ 4 h |
| `money.refunds_stale` | money | any | — |
| `notifications.failed` | notifications | any in 24 h | 10 or more |
| `notifications.critical` | notifications | — | any alert not delivered in 24 h |
| `doctors.coverage` | doctors | any uncovered specialty | — |
| `growth.signups` | growth | zero signups in 48 h | — |
| `credentials.expiring` | credentials | any within 30 days or undated | any within 7 days |
| `ai.spend` | **money** | 24 h ≥ 3× the 7-day daily average | ≥ 6× |

  The spec named the check keys and three of the thresholds; the rest of the warn/fail lines are my choices. `ai.spend` sits in `money` because the fixed area list has no `ai` area; below $1 in 24 hours it never alarms.
- **Transitions are detected by the worker**, from `pushed_status`, for every row whatever its source. Rules: anything → `fail` pushes `system_check_failed` (loud for site / cases / money, quiet otherwise); `warn` or `fail` → `ok` pushes `system_check_recovered` (quiet); a check past twice its interval pushes `system_check_stale` once (quiet; loud for site). **A move to `warn` is not pushed.** A new row that arrives `ok` or `warn` pushes nothing; a new row that arrives `fail` pushes.
- `claude.brief.daily|weekly|monthly`: every new write pushes `ops_brief` (quiet) once.
- Per-area loudness needed one small addition: a producer may pass `defaultMode` ('loud' | 'quiet') for one event. A stored user preference still wins, and lockOn still holds.

**The statement a writer must use** (this exact text is `UPSERT_SQL` in `services/system_checks.js`; the Claude form with literals follows):

```sql
INSERT INTO ops_checks
  (check_key, area, status, summary, detail, checked_at, expected_every_seconds, source, updated_at)
VALUES
  ('backups.nightly', 'backups', 'ok', 'Nightly dump verified, 412 MB',
   '{"bytes": 431882240}'::jsonb, NOW(), 86400, 'claude', NOW())
ON CONFLICT (check_key) DO UPDATE SET
  area = EXCLUDED.area,
  status = EXCLUDED.status,
  summary = EXCLUDED.summary,
  detail = EXCLUDED.detail,
  checked_at = EXCLUDED.checked_at,
  expected_every_seconds = EXCLUDED.expected_every_seconds,
  source = EXCLUDED.source,
  updated_at = NOW();
```

Rules for a SQL writer: `check_key` matches `^[a-z0-9_.]{3,80}$`; `area` is one of the eleven; `status` is `ok`, `warn` or `fail`; `summary` ≤ 300 characters. **Never name `pushed_status`, `pushed_at`, `stale_pushed` or `brief_pushed_at`** — they belong to the worker, and setting them silences the push. The database does not enforce the validation for SQL writers (no CHECK constraints, following 121 and 123); `GET /system` drops a row with an unknown area and treats an unknown status as warn. A brief is the same statement with `check_key` `claude.brief.daily`, the headline in `summary`, and `detail` `{"lines": ["…", "…"]}` (at most 30).

The push for a SQL-written row arrives on the worker's next pass, so up to 5 minutes later.

| Guard | Negative test (`tests/watchtower/system-checks.test.js`) |
|---|---|
| Fail closed with no key | "FAIL CLOSED: with OPS_CHECKS_KEY unset the route answers 503 and stores nothing" |
| Wrong key | "a wrong, missing or malformed key is 401, and the key is never echoed" |
| Validation | "validation: key pattern, status, area list, summary 300, detail 4 KB, 50 per request" |
| Staleness is strictly over 2× | "staleness: stale only when now - checked_at EXCEEDS twice the expected interval" |
| Transition-only pushing | "a check that stays failed is pushed once, not on every pass" |
| Writers cannot silence a push | "the push decision is the worker's: pushed_status drives it, and no writer touches it" |
| Worker registered | "the worker is registered: WORKER_SPECS, a 5-minute singleton, a heartbeat, boot" |

### Part 4 — expiry register

`ops_expiries` (migration 128) seeded with the 18 keys, all undated. Three endpoints (contract below). One rule, used by both the API and the `credentials.expiring` check: no date → `unset` (counts as a warning); ≤ 30 days → `warn`; ≤ 7 days, including already expired → `fail`. Days are counted from the Cairo calendar day.

Guard and negative test: "expiry status: warn at 30 days, fail at 7, unset with no date" fails if the 7 becomes 3.

### Part 5 — daily digest

The existing 09:00 Cairo funnel digest now also sends one quiet push, kind `daily_digest`, from the same once-a-day claim. Body, for example: `5 waiting (1 urgent) · 2 failing, 1 stale · yesterday 3 paid, 4 delivered`. A number that could not be read shows `?`, never 0. The WhatsApp digest gains one line, "Reports delivered". A WhatsApp failure no longer prevents the push (it was previously an uncaught throw).

**Deep link: `data.screen = "system"`.** That is the route name for the System screen.

### How it was verified beyond unit tests

A throwaway local Postgres database (`watchtower_scratch`, since dropped) was brought to migration 128 with the app's own migration runner, seeded, and driven end to end: the real view, the real sweep, the real worker, and the real routes over HTTP with a signed superadmin token. 57 of 57 checks passed, including the SQL-written-row path, the history trigger, each state transition, the escalation clock at 1h59 / 2h / 5h / 6h, and a patient token being refused with 403. The JSON examples in the contract are the responses that run produced. That script is not committed (it needs a migrated database; the suite runs without one).

---

## Suite, before and after

`env DATABASE_URL= node tests/run.js`

| | Passed | Failed | Skipped |
|---|---|---|---|
| Before any change | 2575 | 6 | 53 |
| After | 2645 | 6 | 53 |

**`baseline-nodb-failures.txt` does not exist** — not in the worktree, not in the main checkout, not in git history on any branch. So the comparison is against the failure list captured from the pre-change run in this worktree. Against that, the six failing lines after are **identical, byte for byte**:

- `email-stub-mode` ×5 (gate strict; transport throw ×2; no transport ×2)
- `orders-table-readers-allowlist` ×1 ("Found 3 unfiltered 'FROM/JOIN orders' reads" — still 3)

+70 passes are the three new test files (10 + 30 + 30).

One of three after-runs reported 2644: the last result of the existing `final-audit-conversations-contract` test arrived after the runner's 2-second quiet window and was not tallied — it neither passed nor failed. See "found in review".

---

## Contract

Base path `/api/v1`. Envelope on every endpoint (unchanged, `middleware/apiResponse.js`):

- success: `{ "success": true, "data": … }`
- error: `{ "success": false, "error": "<message>", "code": "<CODE>" }`

All new fields are **snake_case**. All timestamps are ISO-8601 UTC strings or `null`. Admin endpoints need `Authorization: Bearer <superadmin access token>`, exactly like the rest of `/admin`: no token or a bad one → `401` (`AUTH_REQUIRED` / `INVALID_TOKEN` / `TOKEN_EXPIRED` / `TOKEN_REVOKED`); a non-superadmin token → `403 FORBIDDEN`. Every `/api/v1` route is also behind the existing 100-requests-per-15-minutes-per-IP limiter (`429 RATE_LIMITED`).

### GET `/admin/attention`

Query: `all=1` (optional) also returns snoozed and resolved items.

```json
{
  "success": true,
  "data": {
    "generated_at": "2026-10-06T08:58:38.027Z",
    "counts": {
      "open": 6,
      "loud": 1,
      "unacked": 6,
      "by_kind": { "refund_stale": 1, "send_failed": 2, "paid_unassigned": 1, "specialty_uncovered": 2 }
    },
    "items": [
      {
        "kind": "paid_unassigned",
        "ref": "c0ffee12-…",
        "label_en": "Paid case with no doctor",
        "label_ar": "حالة مدفوعة من غير دكتور",
        "who": "Mona Patient",
        "email": "p1@example.com",
        "phone": "+201…",
        "summary": "Paid, no doctor: case TSH-1042 (standard)",
        "waiting_since": "2026-10-06T08:18:37.291Z",
        "waiting_minutes": 40,
        "waiting_label": "40m",
        "severity": 1,
        "level": "loud",
        "escalates": true,
        "hidden": null,
        "state": {
          "acked_at": null,
          "acked_by": null,
          "snoozed_until": null,
          "resolved_at": null,
          "resolved_by": null,
          "note": null,
          "last_pushed_at": "2026-10-06T08:58:37.425Z",
          "push_count": 3
        }
      }
    ]
  }
}
```

- **Order:** oldest `waiting_since` first.
- `kind` — one of `contact_submission`, `pre_launch_lead`, `abandoned_case`, `doctor_application`, `payment_claim`, `paid_unassigned`, `refund_stale`, `specialty_uncovered`, `send_failed`.
- `ref` — what the kind points at: contact submission id; lead id; order id (`abandoned_case`, `payment_claim`, `paid_unassigned`); application id; refund id (`refund_stale`); specialty id, or `<specialty id>:urgent` for "no Urgent cover" (`specialty_uncovered`); recipient user id (`send_failed`). **It can contain a colon — URL-encode it in the POST paths.**
- `label_en` / `label_ar` — from the notification catalogue; `label_ar` is `null` for the three kinds not in it (`contact_submission`, `pre_launch_lead`, `abandoned_case`), where `label_en` is the kind with underscores replaced by spaces.
- `who`, `email`, `phone`, `summary` — string or `null`. For `specialty_uncovered`, `who` is the specialty name and both contact fields are `null`.
- `waiting_minutes` — whole minutes, never negative. `waiting_label` — `"40m"`, `"3h"`, or `"2d"` from 48 hours up.
- `severity` — integer 1 (highest) to 3.
- `level` — `"loud"` or `"quiet"`: the kind's default push mode. `escalates` — `true` for the four new kinds (per-item pushes on the clock above), `false` for the five that use the 24-hour digest rule.
- `hidden` — always `null` without `all=1`. With it: `null`, `"snoozed"` or `"resolved"`.
- `state.acked_by` / `state.resolved_by` — a superadmin user id. `push_count` — escalation pushes sent in this episode.
- `counts` covers open items only, even with `all=1`.
- Errors: `500 ATTENTION_ERROR`.

### POST `/admin/attention/:kind/:ref/ack`

No body. The item stays on the list; repeat pushes stop.

### POST `/admin/attention/:kind/:ref/snooze`

Body `{ "hours": 4 }` — a whole number, 1 to 72. The item leaves the list until then. A snooze also sets `acked_at` if it was empty.

### POST `/admin/attention/:kind/:ref/resolve`

Body `{ "note": "called her, sorted" }` — optional string, trimmed, cut at 1000 characters; empty becomes `null`. The item leaves the list. If the underlying condition is still true 24 hours later it reappears, un-acked, and is pushed afresh.

All three answer:

```json
{
  "success": true,
  "data": {
    "kind": "refund_stale",
    "ref": "rf_81",
    "action": "snooze",
    "state": {
      "acked_at": "2026-10-06T08:58:38.135Z",
      "acked_by": "d1d04fb8-…",
      "snoozed_until": "2026-10-06T12:58:38.135Z",
      "resolved_at": null,
      "resolved_by": null,
      "note": null,
      "last_pushed_at": "2026-10-05T23:58:38.109Z",
      "push_count": 1
    }
  }
}
```

`action` is `"ack"`, `"snooze"` or `"resolve"`. Errors:

| Status | code | When |
|---|---|---|
| 400 | `UNKNOWN_KIND` | `:kind` is not one of the nine |
| 400 | `BAD_REF` | `:ref` empty or over 200 characters |
| 400 | `BAD_HOURS` | snooze only: `hours` missing, not a whole number, or outside 1–72 |
| 404 | `NOT_FOUND` | the item is not waiting any more (not in the view) |
| 500 | `ATTENTION_WRITE_FAILED` | |

### GET `/admin/system`

```json
{
  "success": true,
  "data": {
    "generated_at": "2026-10-06T08:58:38.670Z",
    "status": "fail",
    "counts": { "total": 14, "failing": 1, "warning": 6, "stale": 1 },
    "areas": [
      {
        "area": "site",
        "status": "fail",
        "checks": [
          {
            "check_key": "site.dns",
            "status": "fail",
            "summary": "dns broken",
            "detail": null,
            "checked_at": "2026-10-06T08:58:38.472Z",
            "expected_every_seconds": 3600,
            "stale": false,
            "source": "claude"
          }
        ]
      },
      { "area": "tash", "status": "none", "checks": [] }
    ],
    "briefs": {
      "daily": {
        "check_key": "claude.brief.daily",
        "period": "daily",
        "headline": "Quiet day: 2 signups, 1 paid",
        "lines": ["2 signups", "1 paid case", "no failures"],
        "status": "ok",
        "checked_at": "2026-10-06T08:58:38.621Z",
        "stale": false,
        "source": "claude"
      },
      "weekly": null,
      "monthly": null
    }
  }
}
```

- `areas` — **always all eleven, always in this order**: `site`, `cases`, `money`, `notifications`, `doctors`, `growth`, `mini`, `tash`, `credentials`, `backups`, `stores`. Checks inside an area are sorted by `check_key`.
- A check's `status` — `"ok"`, `"warn"` or `"fail"`, exactly as written. `stale` — `true` when now − `checked_at` is more than twice `expected_every_seconds`. A stale check keeps its own `status`.
- An area's `status` — the worst of its checks, with a stale check counting as at least `warn`; `"none"` when the area has no checks.
- Top-level `status` — the worst area, ignoring `none`; `"ok"` when there are no checks at all.
- `counts.failing` / `counts.warning` count checks by their written status; `counts.stale` counts stale checks (a check can be in both).
- `detail` — whatever JSON the writer stored, or `null`. `source` — `"portal"`, `"api"`, `"claude"`, or whatever a writer set.
- `briefs.daily|weekly|monthly` — the latest of each, or `null`. `lines` is at most 30 strings. Briefs never appear inside `areas`.
- Errors: `500 SYSTEM_ERROR`.

### POST `/ops/checks` (machines only)

Not an admin endpoint. `Authorization: Bearer <OPS_CHECKS_KEY>`. No cookie, no CSRF token. Limited to 30 requests a minute per IP on top of the global limiter.

Body: one check, or an array of 1 to 50.

```json
[
  {
    "check_key": "mini.disk",
    "area": "mini",
    "status": "warn",
    "summary": "91% full",
    "detail": { "pct": 91 },
    "expected_every_seconds": 900
  }
]
```

| Field | Required | Rule |
|---|---|---|
| `check_key` | yes | `^[a-z0-9_.]{3,80}$`; unique within one request |
| `area` | yes | one of the eleven above |
| `status` | yes | `ok` \| `warn` \| `fail` |
| `summary` | no | string, at most 300 characters; default `""` |
| `detail` | no | JSON object or array, at most 4096 bytes serialised; default `null` |
| `expected_every_seconds` | no | integer 60 to 5,356,800 (62 days); default 86400 |
| `source` | no | `^[a-z0-9_]{2,20}$`; default `"api"` |

`checked_at` is always set by the server to now. A `claude.brief.*` key must be `.daily`, `.weekly` or `.monthly`, and `detail.lines`, if present, must be an array of at most 30 strings.

Success:

```json
{ "success": true, "data": { "accepted": 1, "checks": [ { "check_key": "mini.disk", "status": "warn" } ] } }
```

Errors — the request is all-or-nothing: one invalid check stores none of them.

| Status | Body |
|---|---|
| 503 | `{ "success": false, "error": "Check intake is not configured", "code": "OPS_CHECKS_DISABLED" }` — `OPS_CHECKS_KEY` is unset; nothing is read or stored |
| 401 | `{ "success": false, "error": "Unauthorized", "code": "UNAUTHORIZED" }` |
| 400 | `{ "success": false, "error": "validation failed", "code": "VALIDATION_FAILED", "errors": [ { "index": 1, "error": "check_key must match ^[a-z0-9_.]{3,80}$" } ] }` — `errors` is absent when the body as a whole is wrong (empty, or more than 50) |
| 429 | `{ "success": false, "error": "Too many requests. Slow down.", "code": "RATE_LIMITED" }` |
| 500 | `{ "success": false, "error": "Could not record checks", "code": "CHECKS_WRITE_FAILED" }` |

The route only stores. Pushes come from the worker within 5 minutes.

### GET `/admin/expiries`

```json
{
  "success": true,
  "data": {
    "warn_days": 30,
    "fail_days": 7,
    "counts": { "total": 19, "ok": 0, "warn": 1, "fail": 1, "unset": 17 },
    "expiries": [
      {
        "key": "apple_developer",
        "label": "Apple developer membership",
        "expires_on": "2026-10-26",
        "days_left": 20,
        "status": "warn",
        "owner": null,
        "notes": "renew via App Store Connect",
        "updated_at": "2026-10-06T08:58:38.681Z"
      }
    ]
  }
}
```

- Order: dated entries first, soonest first; then undated, by label.
- `expires_on` — `"YYYY-MM-DD"` or `null`. `days_left` — integer (negative once past) or `null`.
- `status` — `"ok"`, `"warn"`, `"fail"` or `"unset"`.
- Seeded keys: `domain_tashkheesa_com`, `apple_developer`, `apple_push_key`, `google_play`, `instagram_graph_token`, `meta_system_token`, `gmail_app_password_info`, `github_token_mini`, `tailscale_node_key`, `twilio`, `kashier_keys`, `cloudflare`, `render_plan`, `supabase_plan`, `google_workspace`, `cloudinary`, `expo_eas`, `anthropic_key`.
- Errors: `500 EXPIRIES_ERROR`.

### PUT `/admin/expiries/:key`

Body: any of `expires_on`, `notes`, `owner`. Only the fields sent change; an explicit `null` clears one. `date` is accepted as an alias of `expires_on`; `""` is treated as `null`.

```json
{ "expires_on": "2026-10-26", "notes": "renew via App Store Connect" }
```

Success: `{ "success": true, "data": { "expiry": { …same shape as a list row… } } }`

| Status | code | When |
|---|---|---|
| 400 | `BAD_KEY` | `:key` does not match `^[a-z0-9_]{3,60}$` |
| 400 | `BAD_DATE` | not a real date as `YYYY-MM-DD` (e.g. `2026-02-30`) |
| 400 | `BAD_NOTES` | not a string, or over 1000 characters |
| 400 | `BAD_OWNER` | not a string, or over 120 characters |
| 400 | `NOTHING_TO_UPDATE` | none of the three fields sent |
| 404 | `NOT_FOUND` | no such key |
| 500 | `EXPIRIES_WRITE_FAILED` | |

### POST `/admin/expiries`

```json
{ "key": "ssl_cert", "label": "SSL certificate", "expires_on": "2027-01-15", "owner": "Ziad", "notes": null }
```

`key` (`^[a-z0-9_]{3,60}$`) and `label` (1–120 characters) are required; the rest are optional. Success is **`201`** with `{ "success": true, "data": { "expiry": { … } } }`. Errors: `400 BAD_KEY` / `BAD_LABEL` / `BAD_DATE` / `BAD_NOTES` / `BAD_OWNER`, `409 KEY_EXISTS`, `500 EXPIRIES_WRITE_FAILED`. There is no delete.

### Changed: GET `/admin/notification-prefs`

Same shape. The `prefs` array has ten more rows, in catalogue order:

| kind | group | default | locked_on |
|---|---|---|---|
| `paid_unassigned` | cases | loud | true |
| `refund_stale` | money | quiet | false |
| `specialty_uncovered` | doctors | quiet | false |
| `send_failed` | system | quiet | false |
| `critical_alert` | system | loud | true |
| `system_check_failed` | system | loud | false |
| `system_check_recovered` | system | quiet | false |
| `system_check_stale` | system | quiet | false |
| `ops_brief` | system | quiet | false |
| `daily_digest` | system | quiet | false |

Note for the settings screen: `system_check_failed` shows default "loud", but with no stored preference a failure outside site / cases / money arrives quiet, and `system_check_stale` shows "quiet" but a stale **site** check arrives loud. Once the user stores a preference for either kind, it applies to every area.

`PUT /admin/notification-prefs` is unchanged and accepts the new kinds; `off` on `paid_unassigned` or `critical_alert` returns `400 LOCKED_ON`.

### Changed: GET `/admin/health` and `/healthz`

`workers` gains `system_checks` (same shape as the others; stale after 720 seconds).

### Changed: GET `/admin/events`

No shape change. New values of `kind` appear: the ten above. For `critical_alert` rows, `sent_count` is the number of **accepted** push tickets (0 = fired and reached nobody).

### Push payloads (`data`) the app will receive

Every ops push also carries `kind` and `mode` (`"loud"` | `"quiet"`).

| kind | `data` |
|---|---|
| `critical_alert` | `{ "kind", "screen": "ops", "alertKey": "<key>", "severity": "critical", "mode" }` |
| `paid_unassigned` | `{ "kind", "screen": "attention", "attentionKind": "paid_unassigned", "ref": "<order id>", "step": 0, "caseId": "<order id>", "mode" }` |
| `refund_stale`, `specialty_uncovered`, `send_failed` | `{ "kind", "screen": "attention", "attentionKind": "<kind>", "ref": "<ref>", "step": 0, "mode" }` |
| `system_check_failed`, `system_check_recovered` | `{ "kind", "screen": "system", "checkKey": "site.dns", "area": "site", "status": "fail", "mode" }` |
| `system_check_stale` | `{ "kind", "screen": "system", "checkKey": "…", "area": "…", "stale": true, "mode" }` |
| `ops_brief` | `{ "kind", "screen": "system", "brief": "daily", "checkKey": "claude.brief.daily", "mode" }` |
| `daily_digest` | `{ "kind", "screen": "system", "day": "2026-10-05", "mode" }` |

`step` is 0 for the first push of an item and counts up with each repeat. **Route names: `attention` for the Attention screen, `system` for the System screen.** Today's Command build sends both to the dashboard, except `paid_unassigned`, which opens the case because it carries `caseId`. When the app adds the Attention route it must check `screen === 'attention'` before the generic `caseId` rule.

---

## Environment variables

| Variable | New? | When missing |
|---|---|---|
| `OPS_CHECKS_KEY` | **new** | `POST /api/v1/ops/checks` answers `503 OPS_CHECKS_DISABLED` and stores nothing. Everything else works: the portal's own checks, `GET /admin/system`, SQL-written checks, pushes. Read per request, so setting or rotating it needs no deploy. Documented in `.env.example`. |
| `ADMIN_PHONE`, `OPENCLAW_BASE_URL` + `OPENCLAW_SEND_KEY`, `WHATSAPP_PHONE_NUMBER_ID` + `WHATSAPP_ACCESS_TOKEN`, `CRITICAL_ALERT_TEMPLATE_NAME` | existing, **meaning changed** | The WhatsApp transport for critical alerts is off, silently. The push still goes. Previously each of these missing wrote a suppression row to `error_logs` on every alert. One exception kept on purpose: Meta credentials present with no template name is still logged as `template_not_configured`, because that is a half-finished setup, not an unset one. The `.env.example` note calling the template a launch blocker is corrected. |

No other variable was added. The push needs none.

---

## Migrations, and the production dry run

Production's `schema_migrations` tops out at `123_admin_notification_prefs.sql`, the same as origin/main, so numbering starts at 124. (Its `id` column reads 125 for that row; ids are a sequence with gaps. Compare by filename.)

| # | File | What |
|---|---|---|
| 124 | `critical_alert_push_delivery` | four nullable columns on `critical_alert_log` |
| 125 | `attention_state` | new table, RLS on |
| 126 | `needs_attention_ops_kinds` | `CREATE OR REPLACE VIEW` with four more kinds |
| 127 | `ops_checks` | two tables, RLS on, history trigger |
| 128 | `ops_expiries` | new table, RLS on, 18 seed rows |

**Dry run.** All five were run against production in order, in one transaction, followed by probe statements, and then aborted by a deliberate exception so nothing could commit. Result, from production's own data:

- all five applied without error;
- the view kept its eight columns and their types (`waiting_since` is `timestamp with time zone` in every arm);
- the view returned `doctor_application` ×3 and **`specialty_uncovered` ×1 — "No Urgent cover for Radiology"**; no `paid_unassigned`, `refund_stale` or `send_failed` rows today;
- the history trigger wrote 2 rows for an insert + a status change + a timestamp-only update, as designed;
- 18 expiry rows; RLS true on all four new tables.

A follow-up read confirmed the rollback: `attention_state`, `ops_checks` and `ops_expiries` do not exist in production, `critical_alert_log` still has 6 columns, and the view's original comment is intact.

The dry run takes a brief exclusive lock on `critical_alert_log` and the view; the real migration will do the same. All five are safe to re-run (`IF NOT EXISTS`, `OR REPLACE`, `ON CONFLICT DO NOTHING`).

---

## Found in review

1. **`/healthz` cannot fail a plain uptime check.** It is 200 with `"ok": true` while a worker is down. Unless the UptimeRobot monitor is already a keyword monitor, it has never been able to alarm on a dead worker. (Part 0e.)
2. **The process-death alerts race a 500 ms exit.** `server.js` calls `sendCriticalAlert` un-awaited from `unhandledRejection` / `uncaughtException` and exits half a second later. The claim, the push and the delivery write all have to land inside that. Not new, and I kept push and WhatsApp concurrent so it is no worse, but a crash page can still be lost, and its row can be left with `delivered` NULL. Not changed: `server.js`'s crash handlers are outside this job.
3. **The `/ops` widget 5 reads `status_code` only.** With WhatsApp off, a push-delivered alert shows there with an empty status. `delivered` is the column to read now; the view was not edited.
4. **The test runner can drop a late result.** `tests/run.js` stops counting after 2 quiet seconds. One existing async test (`final-audit-conversations-contract`) finished after that window in one of three runs, so the total read 2644 instead of 2645 with no failure shown. A test that fails late would be dropped the same way.
5. **The runner shares one process across all test files.** My first version of the new tests stubbed `require.cache` and `global.fetch` and broke seven unrelated tests in the same run. The new files now re-run themselves in a child process. Existing tests that swap `global.fetch` have the same exposure.
6. **Fresh-database migrations do not run.** `059` has a post-condition that expects four production rows, so `migrate()` on an empty database stops there. I got a scratch database to 128 by cloning a local schema at 108 and running 109–128. The suite already skips "fresh-DB migration completeness".
7. **`send_failed` counts `skipped`, as specified.** Production's last 30 days: 17 WhatsApp and 12 email rows skipped versus 5 failed. If most skips are deliberate (opt-out, a disabled channel), this kind will be mostly noise. It is quiet and pushed once per recipient per episode. I did not inspect the skip reasons.
8. **`sent_count` in `ops_push_log` is devices registered, not tickets accepted**, for everything sent through `pushOpsEvent`. Only `critical_alert` records real acceptance. `notifySuperadmins` now returns the real numbers, so this is a small follow-up.
9. **Urgent cover in production today:** Radiology has a ready doctor but none who takes Urgent. That is real, and will be the first `specialty_uncovered` push after deploy.

---

## Deliberately not done

- **Not merged, not deployed, no production write.**
- **The Command app.** No Attention or System screen exists yet; that is the app job this contract is for.
- **`/healthz` status code left at 200.** Changing it could trip Render's own health check and restart the service over a stalled worker. Offered as an option below.
- **The five existing attention kinds were not moved onto the new escalation clock.** The spec says the sweep's 24-hour rule applies to "the rest", so `payment_claim` and the intake kinds still go out as one digest through `sendCriticalAlert`. Note the consequence: that digest is a `critical_alert` push — loud, locked on, titled "Critical: attention sweep" — which is what it effectively was before, now with a name.
- **No push on a move to `warn`.** The spec lists failed, recovered and stale.
- **No CHECK constraints** on `ops_checks.status` / `area`, following 121 and 123. SQL writers are trusted; the reader tolerates bad rows.
- **No delete endpoint for expiries.** Not in the spec.
- **No per-area notification settings.** One kind, with the producer choosing loud or quiet per event.
- **`doctor_application` and `contact_enquiry` pushes are untouched**, as are all money and auth paths.
- **The end-to-end script is not committed**; the scratch database is dropped.
- **Main checkout untouched.** I read its `.env` once to learn which database it points at (a local one) and symlinked its `node_modules` into the worktree (untracked, not committed).

---

## Needs Ziad

1. **`baseline-nodb-failures.txt` is missing.** I compared against the pre-change run instead (6 failures, identical after). If that file is meant to exist, it needs committing; the six lines are in "Suite" above.
2. **UptimeRobot.** Make the "tashkheesa.com" monitor a keyword monitor on `https://tashkheesa.com/healthz`, keyword `"workersOk":true`, alert when missing. Optional second one on `"clockOk":true`. If you would rather have a status code, say so and I will add `/healthz?strict=1` returning 503 when a worker is down, leaving the plain URL at 200 for Render.
3. **Set `OPS_CHECKS_KEY` on Render** (e.g. `openssl rand -hex 32`) if the mini or Tash will post checks. Until then the route is closed. SQL-written checks do not need it.
4. **Enter the 18 expiry dates.** Until they are in, `credentials.expiring` sits at `warn` ("18 with no date"). It does not push at warn.
5. **Expect these after deploy:** one quiet `specialty_uncovered` push for Radiology's Urgent cover; the `system_checks` worker appearing on `/healthz`; a quiet daily digest at 09:00 Cairo the next morning.
6. **Decide:** should `payment_claim` move to the new loud clock (first alert at 60 minutes, again at 2 hours, then every 6, stopping on ack) instead of the once-a-day digest? It is the closest existing kind to `paid_unassigned`. One line to change.
7. **Decide:** keep `skipped` in `send_failed`, or count `failed` only? (Found in review 7.)
8. **Decide:** `ai.spend` is filed under `money`, so a 6× day is a loud push. Say if it should be quiet.
9. **Check the thresholds I chose** in the Part 3 table — only the 3×/6× AI rule, the 30/7-day expiry rule, the 48-hour signup rule and the 60-minute / 48-hour counts came from the brief.
10. **Merge order.** `src/server.js` was being edited in the main checkout while this ran; that work was committed during the job as `6421bfd` on `fix/doctor-file-open-inline` (not by me). This branch also edits `server.js` (three small hunks: one import, the worker schedule, the prune). Whichever merges second may need that file reconciled by hand.
11. **Claude's scheduled runs** should use the INSERT in Part 3 verbatim, with `source = 'claude'`, and must set `expected_every_seconds` to their real cadence, or the check will be flagged stale (or never flagged).
