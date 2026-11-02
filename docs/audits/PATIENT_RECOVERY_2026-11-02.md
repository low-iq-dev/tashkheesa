# Patient recovery batch — hand-back (2 Nov 2026)

Branch `feat/patient-recovery-2026-10-16`, worktree `../tashkheesa-recovery`, cut from
`origin/main` at `0645ded`. Nothing pushed, nothing deployed, no production writes
(production was read, and migrations 132–134 were dry-run inside transactions that
rolled back — see §5).

Commits, in order: Part D `7c68681`, Parts E + B `82d4429`, Part A `b53d320`,
Part C `85d7064`, the recovery-path fix `0b12702`, the classifier source `837fc05`, and this
report (head SHA in §9).

---

## 0. Findings before building

### 0a. Draft lifecycle, and why production holds `DRAFT` and `draft`

- **Web** creates the draft at `POST /patient/new-case/step1` — `src/routes/patient.js:2362-2371`:
  `INSERT INTO orders (... status ...) VALUES (..., 'DRAFT', ..., 'patient_wizard_v2', 1, ...)`.
  Step column: `orders.draft_step` ("last step completed", migration 021). Question:
  `orders.clinical_question`.
- **App** creates it at `POST /api/v1/cases/draft` — `src/routes/api/cases_draft.js:247-255`:
  `'DRAFT'`, `source = 'patient_app_v1'`, `draft_step = 1`. No reference until submit.
- `case_lifecycle.createDraftCase` also writes `'DRAFT'` but has no callers.
- **Every writer writes uppercase.** The lowercase rows come from the boot-time fixup in
  `src/db.js:339-341`: `UPDATE orders SET status = LOWER(status) WHERE status != LOWER(status)`.
  A draft reads `DRAFT` from creation until the next deploy or restart, then `draft`.
  That is TSH-2026-000026/27 (created after the last restart) vs 000021–23 (before it).
- Submit lowercases too: web through `transitionCase` → `'submitted'`, app at
  `cases_draft.js:894-920` → `'submitted'`.
- Every predicate in this job folds case (`UPPER(COALESCE(status,'')) = 'DRAFT'`).
- Production today: the only `DRAFT`/`draft` rows are 000021 and 000022, both
  `is_practice = true`. 000023/26/27 were real phone-only patients (no email) and are no
  longer drafts.

### 0b. `case_lifecycle` on origin/main

- `isUnpaidReminderEligible` (`case_lifecycle.js:785`): the payment chaser is for
  `UNPAID_REMINDER_STATUSES = [SUBMITTED]` only. A draft gets **nothing** today.
- `UNPAID_CASE_TTL[DRAFT]` = 30 days on `updated_at` (`:1621`). At expiry the sweep sets
  `expired_unpaid` and queues `case_expired_unpaid_patient` (internal). That is the only
  message a draft ever produces.
- `dispatchUnpaidCaseReminders` (`:988`) sends the highest due level of 30m / 6h / 24h,
  anchored on `submitted_at`. It writes one row per channel (whatsapp, email, internal) under
  `payment_reminder:<level>[:<seq>]:<channel>:<case>:<user>`. It checks the key with
  `hasNotificationByDedupeKey`, whatever the existing row's status.

### 0c. The notification path

- `notify.queueNotification` (`src/notify.js:951`) inserts one row. It is unique on
  `(dedupe_key, channel, to_user_id)` (migration 083).
- Re-queuing a key whose row is `failed` re-arms that row (F3, `notify.js:1245`).
- The worker (`src/notification_worker.js`) runs every 30 s. It claims `queued`/`retry`
  rows to `sending` (10-minute lease) and writes the outcome:
  - `ok` → `sent`
  - `skipped` → `skipped` (opted out, no phone, no email, flag off)
  - `permanent` → `failed`
  - anything else → `retry` at 30 s, 120 s, then `failed` after `NOTIFICATION_MAX_RETRIES`
    (3), with an error_logs line and a NOTIFICATION_DROPPED event
- **WhatsApp** goes `processWhatsApp` → `notify/whatsapp.sendWhatsApp` → OpenClaw →
  `lib/openclaw_client.sendViaOpenClaw`: `POST <OPENCLAW_BASE_URL>/send`, 10 s abort.
  - `oc_env_misconfigured` when the URL or key is missing.
  - `http_<status>` on any non-2xx (the 14 Oct `http_502`).
  - `oc_timeout` on abort.
  - A 202 (the gateway "accepted, sending async") is recorded `sent`.
- **Email** with no address is `skipped` `no_email_for_user` (production, 14 Oct: every
  payment-reminder email row for the phone-only patient).
- **Internal** is the in-app row. The worker marks it `sent` at once; the push is sent when
  it is queued.

### 0d. `abandoned_case` and the 24 h re-alert

- Migration 126, the `abandoned_case` arm: not practice, not `demo_appreview`, not deleted,
  `draft_step >= 1`, not paid, `LOWER(status) IN ('draft','pending','expired_unpaid','awaiting_payment')`,
  `created_at < NOW() - 1 hour`.
- It is a "legacy" kind in `services/needs_attention.js`: alerted once it has waited 60
  minutes, then again after 24 hours (`REALERT_AFTER_HOURS`). The ledger is `error_logs`
  category `attention_alert`.

### 0e. Twilio

- OTP goes through Twilio **Verify**: `services/twilio_verify.js`,
  `client.verify.v2.services(TWILIO_VERIFY_SERVICE_SID).verifications.create({ to, channel: 'sms' })`.
- The portal has no plain-SMS code before this branch.
- **I could not read the account's Messaging configuration.** The only credentials on this
  machine (`/Users/macmini/tashkheesa-portal/.env`, April) return 401 on GET calls. The live
  ones are on Render. I did not look further for them.
- **Twilio's Egypt guidance**
  ([twilio.com/en-us/guidelines/eg/sms](https://www.twilio.com/en-us/guidelines/eg/sms)):
  - International long code: Twilio "Supported", operator "Not Supported". On Etisalat
    those messages are delivered under a generic alpha sender.
  - Twilio recommends pre-registered alphanumeric sender IDs, because Egyptian operators
    block and filter.
  - Alphanumeric pre-registration: domestic "Required" (3 weeks); international "Not
    Required" (1 week). Dynamic alphanumeric is listed as supported.
  - **UCS-2 (Arabic) on domestic registered senders is listed as "N/A".**
  - Two-way SMS: not supported, so STOP cannot be received by SMS.
  - Prohibited: "medicine/drug related" content.
  - Marketing curfew: 21:00–09:00, and not on Fridays, Saturdays or official holidays.
- **Plain answer:** a plain SMS to +20 from an unregistered sender may be accepted by Twilio
  and then filtered or rebranded by the operator. It is not reliable today. Ziad needs to
  register an alphanumeric sender (see §7). Until then `notifications.sms` will show
  fallbacks skipped as `sms_unconfigured`.

### 0f. Specialty choice and the classifier

- Web step 3 lists `specialties WHERE COALESCE(is_visible, true)` (`patient.js:1919-1925`).
  The services offered are the bookable ones.
- The classifier (`services/classify_job.js:46-86`) is only **shown visible specialties
  with a bookable service**. A reply naming anything else throws
  (`specialty_classifier.js:230-232`) and is retried.
- **So it cannot predict `spec-neurology` while neurology is hidden.** What it does instead
  depends on the case:
  - No classification at all: the web shows "Analysing…" and, after 12 s, "please choose
    the right one below". The app gets `classification: null`.
  - Low confidence (`< min`, default 0.55, or `specialty_id: null`): the case is parked
    `manual_queue` and the patient sees the plain grid.
  - A classification written before a specialty was hidden: the web can dead-end. At or
    above the lock threshold the hidden specialty's services are refused and
    `override_not_permitted` loops.
- There is no `classifier_parked` 409 in the API. `classifier_parked` is only an ops-push
  kind.
- Production: neurology is hidden, with 11 services (7 visible and priced) and no doctor.
  Internal Medicine and Pediatrics are visible, with `entry_read_*` at 750 EGP.

### 0g. How malformed numbers reached Twilio

- The **doctor app's** door, `POST /api/v1/doctor/auth/otp/request` (`routes/api/doctor_auth.js:119`
  on main), concatenated `` `${countryCode}${phone}` `` with no normalisation.
- The doctor app's `splitPhone` (`tashkheesa-doctor/lib/data/api.ts:389`) does this with
  the typed number:
  - `010000000930129` → `{+20, 10000000930129}` → **`+2010000000930129`** (16 Oct 03:13, 03:14).
  - `…1550000000930129` → **`+201550000000930129`** (11, 12 and 28 Oct). That is the store
    review number `+201550000000` with digits appended.
- The patient doors (web `parseOtpPhone`, app `/otp/request`) use `normalizePhone`, which
  refuses both as longer than E.164's 15 digits.
- But `normalizePhone` accepts **`+201990000177`** (11 Oct) and **`+206504992804`**
  (25–26 Sep): valid E.164, not Egyptian mobiles.
- The delete-account sends (web and app) pass the stored phone straight to Twilio.
- Twilio refuses with `Invalid parameter To` before sending. The cost is the patient's
  per-phone budget (3 sends / 15 min) and a code that never comes.

### Part E — duplicate payment reminders (loop a1015dupnudge)

Case TSH-2026-000020, 14 Oct, a phone-only patient (`+201111111113`). Evidence from three
places:

1. **Production `notifications`.** One row per (level, channel): the whatsapp 30m and 6h
   rows are `failed`, `attempts 3`, `http_502`. Email is `skipped` `no_email_for_user`.
   Internal is `sent`. The 24h whatsapp row on 15 Oct is `sent` (`queued:true`, a 202).
2. **The gateway decision log** (`~/openclaw-gateway/state/decisions.log`). Three distinct
   sends per level, at 09:59:48, 10:00:47, 10:03:18 and 15:29:48, 15:30:48, 15:33:18.
   - Each was `cli_failed` ("No active WhatsApp Web listener").
   - The 15 Oct 24h send is also `failed` at the gateway, after a 202 the portal recorded
     as `sent`.
3. **OpenClaw's own queue** (`~/.openclaw/state/openclaw.sqlite`, `delivery_queue_entries`).
   - Each of those six sends is a separate outbound entry.
   - OpenClaw writes an entry before attempting it and replays pending entries when
     WhatsApp reconnects.
   - All 19 entries from 13–15 Oct were retried once at 15 Oct 12:01 and moved to `failed`.

Answers to the brief's three questions:

- **Is the dedupe key per (order, level) or per attempt?** Per (order, level, channel). The
  sweep never made a second row and never re-armed one: `hasNotificationByDedupeKey`
  matches a row of any status.
- **Is a failed row re-sent by the retry path, and by the next sweep?**
  - The worker's retry path: yes. Three sends to the mini in four minutes.
  - The next sweep: no.
  - `queueNotification`'s F3 re-arm would re-send it if anyone re-queued the key; payment
    reminders don't.
- **Does the ladder re-fire when `sent_at` is never written?** No. There is no `sent_at`;
  the ladder keys on the dedupe key's existence.

On the duplicates themselves: what is proven is three gateway sends per level, each a
queued OpenClaw entry. OpenClaw's record shows all of them failed, so I cannot show from
this machine that three copies reached the phone. Had WhatsApp reconnected, every entry was
a copy waiting to go out. The fix is the same either way.

---

## 1. What was built, per part

Suite results are in §2.

### Part D — phone validation before the OTP (`7c68681`)

- `src/validators/otp_phone_guard.js`:
  - `normalizePhone` first, unchanged, so the trunk-zero repair stays exactly as it is.
  - Then, on +20 only, `^\+201[0125]\d{8}$`.
  - Other countries: E.164 shape only.
  - Refused inputs are logged to error_logs at `warn`, category `otp_phone_rejected`, with
    the shape only: digit count, dial code, first two national digits.
- **Web `/login/otp/request`:** 422 `{ok:false, error:'phone_invalid', message}` (EN/AR).
  It runs after the per-IP limiter and before the per-phone ones. `public/js/login-phone.js`
  shows the message and stays on the phone step.
- **App `/api/v1/auth/otp/request` and doctor `/api/v1/doctor/auth/otp/request`:**
  422 `PHONE_INVALID`, before the limiters.
  - An empty field keeps its `VALIDATION_ERROR`.
  - The store-review number is exempt.
  - The doctor door now sends **and** verifies the E.164 form (`doctorOtpPhone`).
- **Delete-account sends (web and app):** a stored unsendable number is never sent to. It
  gets the existing "could not send" answer.
- **Save paths** (web register, onboarding, web profile, app register, app profile): the
  Egyptian-mobile check is added after the existing normalisation, so the pinned lines are
  untouched.
- Tests: `tests/auth/otp-phone-guard.test.js`
  - the 16 Oct and 28 Oct inputs, `+201990000177`, `+206504992804`
  - 010/011/012/015 with and without the trunk zero
  - UK, UAE and Saudi numbers
  - a 9-digit stub
  - the real app and doctor routers: refused before Twilio; good numbers sent as E.164
  - the log carries no number
- `tests/auth/batch-c-sessions-and-doctor-door.test.js`: the doctor-door OTP seeds moved
  from `+2001…` to `+201…`, because that door now normalises. Its comment is updated.
- **Known gap, by the brief's rule:** `+9746504992804` (27 Oct) passes. Other countries are
  checked on E.164 shape only.

### Part E — one WhatsApp attempt, never re-armed (`82d4429`)

- `lib/openclaw_client`: failures now carry `outcome`. This is additive.
  - `'not_sent'`: a gateway 4xx (every 4xx is a refusal before it enqueues), Cloudflare
    530, a connection never made, missing config.
  - `'unknown'`: a 5xx, a timeout, a dropped connection.
- `notify/sms_fallback.whatsappFailureIsFinal`, wired into the worker. For the
  SMS-allowlisted templates to a patient:
  - an `unknown` WhatsApp failure is final on the first attempt: `failed`,
    `no_retry: 'whatsapp_single_attempt'`
  - `not_sent` keeps the 30 s / 120 s ladder on the same row
- The stuck-`sending` recovery retires these rows instead of re-queuing them.
- `queueNotification` never re-arms a failed whatsapp/sms row of these templates.
- **Departure from the brief's literal test**, and why:
  - "502 three times then 200 → exactly one delivered" assumed a 502 means "not sent". On
    this gateway it does not: a gateway 502 may already be queued in OpenClaw.
  - I could not tell a gateway 502 from a tunnel 502 by body. The 14 Oct 502s reached the
    portal with no JSON body.
  - So every post-connect failure is final. The test therefore runs two cases:
    1. 502, 502, 502, 200: the mini is called once, one copy is delivered, one SMS row.
    2. 530, 530, 530, 200 (tunnel down, nothing reached the mini): retried on the same row,
       exactly one delivered, no SMS.
- Tests:
  - `tests/notifications/whatsapp-single-attempt.test.js` (DB, a fake mini). It also checks:
    - the sweep run three times in four minutes leaves one row per channel, and the failed
      key is never re-armed;
    - a row left in `sending` by a crashed tick is retired without a second send, and its
      SMS keeps the queued payload, resume link included.
  - `tests/notifications/sms-fallback.test.js` (unit).

### Part B — the SMS channel (`82d4429`)

- `src/notify/sms_provider.js`: Twilio Programmable Messaging behind a provider interface
  (`PROVIDERS`, `SMS_PROVIDER`). A second, Egyptian gateway is one more entry; callers do
  not change.
  - Off unless `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_SMS_FROM` is set. Until then
    every sms row is `skipped` `sms_unconfigured` and nothing throws.
  - Outside production, only `SMS_TEST_RECIPIENTS` can be texted, failing closed (the same
    rule as WhatsApp).
- `src/notify/sms_templates.js`: the allowlist, plus short EN/AR bodies (reference and
  link only):
  - `draft_resume_1h`, `draft_resume_24h`
  - `payment_reminder_30m|6h|24h`
  - `report_ready_patient`
  - `patient_refund_approved|denied|paid`
  - `additional_files_requested_patient`
  - `coverage_lead_open` (Part C sends on the Part A ladder)

  Links are rebuilt as absolute URLs. The payment-reminder payload carried a relative
  `/portal/patient/pay/<id>`, as the 14 Oct gateway log shows. Draft links use the short
  `/r/<token>`.
- `src/notify/sms_fallback.js`: the decision lives in the worker.
  - One SMS when the WhatsApp row ends `failed`, or `skipped` for a reason other than
    opt-out or no phone, **and** the patient has no email or the email row ended
    skipped/failed.
  - Never after WhatsApp was sent.
  - Its key is the WhatsApp key with the channel swapped, or `sms_fallback:<row>`.
  - 3 per patient per 24 h (`sms_patient_cap`); `SMS_DAILY_CAP` (default 100) per Cairo
    day (`sms_cap`) with one quiet ops push a day (kind `sms_cap`).
  - Twilio's SID, status, price and segments are recorded in the row.
  - An SMS is never retried.
- **Opt-out:** SMS honours `users.notify_whatsapp`, the store the gateway writes on STOP.
  Receiving STOP or إيقاف by SMS would need a two-way number and an inbound webhook. Egypt
  does not support two-way SMS (§0e), so an opt-out stays a WhatsApp reply or a support
  request.
- **Checks:** `notifications.sms` (sent / skipped by reason / failed, 24 h). It warns when
  a fallback could not go out.
- Tests:
  - `tests/notifications/sms-fallback.test.js`
  - `tests/lint/sms-templates-fit.test.js`: EN ≤ 160 and GSM-7, AR ≤ 134, rendered with the
    longest real values; the allowlist pinned; no payload field but the reference reaches a
    body.

### Part A — draft-resume nudges (`b53d320`)

- `src/services/draft_nudges.js`. The eligibility SQL (`ELIGIBLE_DRAFTS_SQL`) plus the
  email check:
  - status draft (either casing)
  - real case: not practice, not demo or practice source, not deleted
  - patient, active
  - recipientGuard on the email when present
  - question ≥ 10 characters, or at least one file
  - idle ≥ 60 minutes, measured as `GREATEST(updated_at, last link open)`
  - ≤ 7 days old
  - the patient's newest case of any status (stricter than "newest draft": a patient who
    went on to submit another case is not reminded of the old draft)
  - `notify_whatsapp` not false
  - no coverage lead on the draft
- **Ladder:** 1h at 60 minutes idle, 24h at 24 hours idle, never a third. Key
  `draft_resume:<order>:<level>`.
- **Quiet hours:** 22:00–08:00 Cairo, via a shared helper, `src/utils/cairo_quiet_hours.js`.
  The signup nudges keep their own 22:00–09:00, unchanged.
- **Channels:** internal + whatsapp (with a phone) + email (with one); the worker adds SMS.
  This is Part B's worker rule, not Part A's "WhatsApp → SMS → email": a patient whose email
  works is not also texted.
- **How the worker learns the WhatsApp outcome:** from the gateway's synchronous answer.
  With a single attempt, that is within one 30-second tick. A `not_sent` row is retried at
  30 s and 120 s and then fails, about 3 minutes. Both are inside 10 minutes; the mini is
  never polled.
  - **Gap:** a 202 is recorded as sent. The gateway has no delivery callback (§7).
- **Resume link** — `/portal/patient/resume/<token>`, and `/r/<token>` for SMS
  (`src/routes/draft_resume.js`, `src/services/draft_resume.js`):
  - The token is a 10-character id plus a 12-character HMAC (key derived from
    `JWT_SECRET`). Only its SHA-256 is stored, and `notifications` carries the id, never the
    link: the worker rebuilds it at send time.
  - 72 hours, one draft, never a sign-in:
    - own session → `/patient/new-case?resume=<id>` (the draft at its saved step)
    - no session → `/login?next=…`
    - anyone else, expired, or forged → their home
  - Opening it clears queued nudges and counts `draft_resumed` once.
- **Schedule:** pg-boss `draft-nudges` every 15 minutes, `createQueue` first. Heartbeat
  `draft_nudges` in `admin_health.WORKER_SPECS` (40 minutes).
  - The check `cases.draft_nudges` reports sent / resumed / converted today.
  - The funnel steps `draft_resume_sent`, `draft_resumed` and `draft_resume_converted` are
    in `funnel_daily_counts`, with a digest line.
- **Copy:** WhatsApp is the brief's EN/AR text, word for word, and in-app titles and bodies
  are fixed text. The email is `draft-resume-1h|24h.hbs` in the warm family, signed "the
  Tashkheesa team" / فريق تشخيصة. «شفاء» never takes the article.
- Tests:
  - `tests/core/draft-nudges.test.js` (unit): the ladder, quiet hours (22:30 waits, 08:05
    sends), channels and payload, the guard (and the F9 interaction), the token (scope,
    tamper, expiry), the route, copy, wiring.
  - `tests/core/draft-nudges-db.test.js`: every clause against the real SQL, the ladder end
    to end, stop-on-submit with the conversion counted once, a resume clearing the queue and
    the attention row.
  - `tests/lint/needs-attention-134-arms.test.js`.

### Part C — coverage leads (`85d7064`)

- `src/services/coverage_leads.js`: one lead per draft. The partial unique index is the
  guard.
  - The patient's own draft, still a draft. A hidden specialty or "other" plus text.
  - The phone comes from the account.
  - The draft is kept and its queued nudges are cancelled.
  - The classifier trigger (`coverageTrigger`) fires on low confidence, no prediction, or a
    stale classification naming a hidden specialty.
  - General-read offers are priced by `case_intake_pricing.resolveAndPriceIntake`, standard
    tier, with the patient's own pricing country.
- **Web:** "My specialty is not listed" on step 3 (`partials/patient/coverage_lead_panel.ejs`).
  - It renders outside the step-3 form and is server-rendered; no new script.
  - It shows the brief's EN/AR copy and three actions: Tell me when it opens, Choose a
    related specialty, and Report read at its real price. The report read is not offered at
    the locked tier, where step 3 would refuse it.
  - `POST /patient/new-case/coverage-lead` (`src/routes/coverage_leads_web.js`). A lead
    left from a panel the classifier opened is recorded with `source = 'classifier'`; a
    patient's own pick is `'web'`; the app's is `'api'`.
- **API**, additive (`src/routes/api/coverage_leads.js`):
  - `GET /api/v1/cases/draft/:id/coverage`
  - `POST /api/v1/cases/draft/:id/coverage-lead`
- **Superadmin:** `/superadmin/coverage-leads` (`src/routes/superadmin_coverage.js`), linked
  from Services.
  - One row per specialty with waiting leads.
  - Dry-run count, then the specialty's name must be typed to send.
  - Refused while the specialty is hidden.
  - Each lead is claimed before it is told, so a second run sends nothing.
  - Admin audit line.
  - Template `coverage_lead_open` on the Part A ladder.
- **Attention:** kind `coverage_lead`, quiet, with an Arabic label, in migration 134. Check
  `growth.coverage_leads`, with per-specialty counts.
- Leads are converted when the draft is later sent.
- **Account erasure** now covers `coverage_leads` and `draft_resume_tokens`. The PDPL lint
  caught the omission.
- Tests:
  - `tests/core/coverage-leads.test.js` (unit, including a full step-3 render in EN and AR)
  - `tests/core/coverage-leads-db.test.js` (the real API router, the unique index, the view,
    nudge exclusion, notify dry run + send + idempotency, conversion)

## 2. Suite results on the final head

Run on code head `837fc05`. The commits after it touch only this report. Both modes
follow `docs/RELEASE.md`.

- **With a database.** Built from zero: `createdb`, `migration_strict = on`, the app's own
  `migrate()` through 134, then CI's env block.
  - `npm test` → **exit 0**.
  - `Passed: 3957 · Failed: 0 · Skipped: 40 · Files: 385 (0 with failures)`.
  - No "integration tests skipped" note.
  - The new database tests ran rather than skipped: `core/draft-nudges-db` 11,
    `core/coverage-leads-db` 6, `notifications/whatsapp-single-attempt` 4.
- **Without a database.** No `DATABASE_URL`, no `.env` in the worktree.
  - `npm test` → exit 1, as expected.
  - Gate: **`163 known failure(s) · 0 NEW · 0 baseline entries now passing`**, ✅.
  - `Passed: 3666 · Failed: 163 · Skipped: 67`. Refused count: 163, the same as on
    27 Oct.
  - The three new database test files skip themselves in this mode and are counted as
    skipped, not failed. The baseline file is unchanged.

New test files and their counts (from the database run):

- `auth/otp-phone-guard` 20
- `notifications/sms-fallback` 23
- `notifications/whatsapp-single-attempt` 4
- `lint/sms-templates-fit` 14
- `core/draft-nudges` 22
- `core/draft-nudges-db` 11
- `lint/needs-attention-134-arms` 3
- `core/coverage-leads` 20
- `core/coverage-leads-db` 6

One existing test changed: `auth/batch-c-sessions-and-doctor-door`, whose doctor-door OTP
seeds are now E.164 (§1, Part D).

The web UI was checked by rendering the real templates in tests: the full step-3 wizard in
EN and AR with the panel, and the superadmin page. It was **not** clicked through in a
browser against a running server.

## 3. API and view changes — safe for installed builds?

| Change | Safe? |
|---|---|
| `POST /api/v1/auth/otp/request`: a +20 non-mobile or over-long number is now 422 `PHONE_INVALID` before the limiters | Safe. Same code and shape this route already returned for an unparseable number; good numbers unchanged |
| `POST /api/v1/doctor/auth/otp/request`: 422 `PHONE_INVALID` for unsendable numbers | Safe. The installed doctor app shows its generic "could not send" copy; the field message is a follow-up |
| `POST /api/v1/doctor/auth/otp/verify`: checks the E.164 form | Safe. Identical to the old concatenation for everything the doctor app sends (it strips the trunk zero) |
| `POST /api/v1/auth/register`, `PATCH /api/v1/profile`: refuse a +20 non-mobile | Safe. Existing `PHONE_INVALID` |
| App delete-account code: a stored unsendable number gets the existing 502 `OTP_SEND_FAILED` without calling Twilio | Safe |
| New `GET /api/v1/cases/draft/:id/coverage`, `POST …/coverage-lead` | Safe, additive |
| New notification templates `draft_resume_1h/24h`, `coverage_lead_open` on channel internal | Safe for the list (title and body come from the server). **Check:** the app derives its tap target from `order_id`, which for a draft nudge is a draft. Confirm the app's case screen tolerates a draft id |
| Web `/login/otp/request` 422 | Safe. An old cached `login-phone.js` treats it as "advance", as before |
| New web routes `/portal/patient/resume/:token`, `/r/:token`, `POST /patient/new-case/coverage-lead`, `/superadmin/coverage-leads` | Safe, additive |
| Step-3 panel | Safe. Renders only with its context; the step renders as before without it |

## 4. New environment variables

| Variable | When unset |
|---|---|
| `TWILIO_MESSAGING_SERVICE_SID` (preferred) or `TWILIO_SMS_FROM` | SMS is off. Every sms row is written `skipped` `sms_unconfigured`; `notifications.sms` warns when that cost a patient a message |
| `SMS_PROVIDER` | `twilio` |
| `SMS_DAILY_CAP` | 100 per Cairo day |
| `SMS_TEST_RECIPIENTS` | Outside production, no SMS goes anywhere (fail closed) |

The existing `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` are reused.

`JWT_SECRET` now also keys the resume links: rotating it invalidates links still open, and
they then go to the patient's home.

## 5. Migrations — production dry-run (BEGIN … ROLLBACK)

- Next free number: 132. Production's `schema_migrations` tops out at
  `131_promo_codes.sql` (26 Oct), the same as main, and no unmerged branch carries
  migrations.
- Each dry run ran cumulatively in one transaction and ended in `RAISE EXCEPTION`, which
  rolls the transaction back.
- The 132 and 133 rows below came from runs I compacted by hand. The 134 run was then
  repeated with the generated text: all three files' statements, verbatim, with only `--`
  comment lines and blank lines removed. That run is the authoritative one, and its result
  is identical.

| Migration | Result |
|---|---|
| `132_draft_resume_tokens.sql` | `DRY-RUN 132 OK: draft_resume_tokens created, 0 rows, rls=t` |
| `133_coverage_leads.sql` (with 132) | `DRY-RUN 133 OK: coverage_leads created, 0 rows, rls=t` |
| `134_needs_attention_recovery.sql` (with 132, 133) | `DRY-RUN 134 OK: v_needs_attention 1 rows; by kind: specialty_uncovered=1; abandoned with nudges_sent not null: 0`. Live view, same moment: `specialty_uncovered=1` |

- Afterwards: `to_regclass` is null for both tables, and the view still has 8 columns.
  Nothing persisted.
- All three also ran twice on the local DB without error (IF NOT EXISTS; CREATE OR REPLACE
  VIEW).

## 6. Opening Neurology once a doctor is onboarded

1. Onboard and approve the doctor through the normal flow, and map them to the neurology
   services (`doctor_services`). The services' `coming_soon` resyncs in that same
   transaction (`services_coming_soon_sync`).
2. Check the catalogue. On 2 Nov, 7 of the 11 neurology services were visible and priced:
   ```sql
   SELECT id, name, base_price, is_visible, coming_soon FROM services WHERE specialty_id = 'spec-neurology' ORDER BY name;
   ```
   Make visible and price only the ones you want to sell.
3. Open the specialty:
   ```sql
   UPDATE specialties SET is_visible = true WHERE id = 'spec-neurology';
   ```
4. Confirm a ready doctor. This should return nothing, except `spec-neurology:urgent` if
   nobody takes Urgent:
   ```sql
   SELECT * FROM v_needs_attention WHERE kind = 'specialty_uncovered' AND ref LIKE 'spec-neurology%';
   ```
5. Open `/superadmin/coverage-leads` → Neurology → **Notify waiting leads**. Read the dry-run
   count, type `Neurology`, send. A second run sends nothing.

The classifier picks neurology up on its own once neurology is visible and has a bookable
service: it is shown visible specialties only.

## 7. Needs Ziad

- **SMS sender.**
  - Register an alphanumeric sender ID for Egypt in the Twilio console. Tashkheesa is an
    Egyptian company, so the domestic route is likely: about 3 weeks, Vodafone documents.
    Keep it simple, with no special characters.
  - Create a Messaging Service that carries it, and set `TWILIO_MESSAGING_SERVICE_SID` on
    Render.
  - Confirm with Twilio that Arabic (UCS-2) is delivered on that sender. The guidance table
    lists it as "N/A" for domestic registered senders.
  - Confirm that "medicine/drug related" does not catch a case-status SMS from a medical
    service.
  - For a later second provider, an Egyptian SMS gateway is one more adapter in
    `notify/sms_provider.js`.
- **Optional:** `SMS_DAILY_CAP` if 100 a day is wrong.
- **SMS at night — your call.**
  - Payment reminders, report-ready and refund messages have no quiet hours today. Once SMS
    is configured, a WhatsApp that fails at 03:00 produces an SMS at 03:00.
  - The draft nudges are only sent 08:00–22:00, so they are unaffected.
  - If the SMS fallback should wait for 08:00 Cairo, that is a small change in
    `notify/sms_fallback.processSms` (`utils/cairo_quiet_hours` is there to reuse). Not
    done here.
- **Production schema, checked read-only:** `notifications` has no triggers and no check
  constraints, only the primary key, so `channel = 'sms'` rows are accepted. The 3-column
  unique dedupe index the SMS keys rely on exists.
- **`/r/` is free:** no route, view, public asset or marketing link uses it.
- **The 202 gap.**
  - The gateway answers 202 on its common path, because the CLI takes 13–18 s. The portal
    then records `sent` for a send that may still fail, as happened on 15 Oct.
  - Closing it needs a gateway → portal delivery callback. That is a change on the mini,
    not in this repo.
  - Until then a WhatsApp that fails after a 202 gets no SMS.
- **The same duplicate risk applies to every other WhatsApp template**, doctors included.
  This job changed only the patient templates on the SMS allowlist. Doctor messages are out
  of scope here and deserve the same rule.
- **F9 / recipientGuard.** It is email-only: `validateRecipient(null)` throws
  `missing_or_empty`. Applied literally, it would block every phone-only patient from the
  nudges. It is applied to the email when there is one; phone-only patients pass. Not
  changed here.
- **Password-less OTP sign-in and `next`.** A patient with no password who signs in by phone
  OTP is sent to `/set-password` first. That is existing behaviour in `routes/auth.js`, and
  it ignores `next`. A resume link opened without a session therefore lands them on
  set-password, and the draft is then one tap away on the dashboard's "Continue your case"
  tile. Carrying `next` through set-password is a small follow-up.
- **The doctor app** shows "could not send" for a 422 `PHONE_INVALID`. Showing the server's
  field message is an app follow-up, as is the patient-app coverage screen.
- **Payment-reminder links in WhatsApp are relative** (`/portal/patient/pay/<id>`, gateway
  log, 14 Oct). The SMS builds absolute links. The WhatsApp body is out of scope here
  (reminder copy) and deserves a fix.
- **perf/fast-start-2026-10-15 is still unmerged.** It is one commit, `23f8af3`, touching
  `src/server.js`, `doctor.js`, `api/doctor_cases.js` and some views. This branch avoids
  its lines and should merge cleanly. `fix/patient-batch-2026-10-11` is merged.
- **`coverage_leads` did not exist on origin/main**, and the 25 Oct patient batch built
  none of these parts.

## 8. A note on this session

To stop my own test run I ran `pkill -f tests/run.js`. That pattern matches any test
runner on this machine, not only the one in this worktree. If another session was running
the suite at that moment, it was stopped too.

## 9. Branch

`feat/patient-recovery-2026-10-16`. Code head `837fc05`; the branch head is the commit that adds
the final version of this report (named in the hand-back message). Not pushed.
