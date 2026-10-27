# Test runner — 27 October 2026

Branch `fix/test-runner-blind-2026-10-27`, worktree `../tashkheesa-testrunner`, cut from
`origin/main` at `3807321`. No product code changed. Nothing pushed, nothing deployed.

## The finding, reproduced

`tests/run.js` on `origin/main` (`3807321`), no database, this Mac (Node 24):

| | Passed | Failed | Skipped | Exit |
|---|---|---|---|---|
| Old runner's tally | 2833 | 5 | 53 | 1 |
| node:test marks in that same stdout | 41 ✔ | 13 ✖ | — | — |
| **New runner, same commit + this branch** | **3470** | **183** | **64** | **1** |

The brief's numbers (2740 / 0 / exit 0, 319 failing marks) came from a different commit and
environment (a checkout with its own `.env`); they were not re-created here. I did not load the
main checkout's `.env`: its `DATABASE_URL` could point at a real, migrated database, and the
suite writes to whatever it is pointed at.

The old runner had three separate blind spots:

1. **node:test results were never counted.** It tallied only `global._testRunner`.
2. **Most node:test tests never ran.** node:test schedules its tests asynchronously; the runner
   waited for its *own* counters to go quiet for 2 s, then called `process.exit()` underneath
   them. The 74 node:test files it loaded printed only 54 results in total before the exit.
3. **`src/**/__tests__/*.test.js` (8 files) were never discovered**, including the earnings,
   urgency-pricing and urgency-window tests. No npm script ran four of them.

178 of the 183 failures now counted come from node:test files. The other 5 (`email-stub-mode`)
are the only failures the old runner ever reported.

### The "no database" run was not database-free

When the schema probe fails the runner blanks `DATABASE_URL`. But 23 node:test files open their
own pool with `process.env.DATABASE_URL || 'postgresql://ziadelwahsh@localhost:5432/tashkheesa'`,
so an empty URL fell through to the local `tashkheesa` database (up, unmigrated: no
`orders_active`, no `error_logs.category`) and wrote fixtures into it. The old runner's
`process.exit()` then killed their `after()` cleanup.

- Local `tashkheesa.specialties` holds **3,522 leftover test fixtures** out of 3,540 rows
  (`spec-bulk-<pid>-<ms>-n`, `TEST_*_spec-pick-elig-…`, `spec-aa-elig-…`), oldest
  `spec-aa-elig-41139-1786910309101`. 28 of them are from my two reproduction runs today. **Not
  deleted**: this needs your go-ahead.
- In CI the same files failed for a different reason (no such role), so any baseline would have
  depended on the machine.

## What changed

- `tests/run.js` runs **every file in its own process, one at a time**:
  - node:test files run under `node --test --test-force-exit` with a counting reporter;
  - everything else runs under `tests/_helpers/run-one.js`, which writes each result to disk
    as it happens.
- **Failures:** a failing test or subtest, a hook failure, an uncaught exception, an unhandled
  rejection, a load crash, a non-zero exit, a file that reports nothing, and a file still
  running after 120 s (killed with its process group).
- **Skips:** only a test's own skip, or `tests/pin/`, which `npm test` never runs, as before.
  It needs a migrated DB and turns `admin_settings.auto_assign_enabled` on for its duration;
  run it on purpose with `npm run test:pin`. It is now printed and counted as skipped instead
  of being left out silently.
- **Counts agree with node:test's own.** In the final run, the per-file `ℹ` tally node prints
  for each of the 82 node:test files matches the runner's `↳` line exactly: 782 tests (594
  passed, 178 failed, 10 skipped or todo), 0 cancelled.
- **Output** keeps its old shape, plus one line per file, `↳ file · N passed · N failed · N
  skipped`, and a `Files:` line in the summary.
- `tests/_helpers/node-test-reporter.js` counts **leaf tests**. A parent that failed only
  because a subtest failed is not counted twice. Skip and todo count as skipped. A failure
  outside any test gets a stable name: `(file) failed outside any test`.
- `tests/_helpers/no-db-guard.js` is preloaded in no-database runs and refuses every `pg`
  connection at once, with the reason. Those tests now fail the same way on every machine and
  write nothing.
- **Discovery** now includes `src/**/*.test.js`. node:test is detected by a real `require`
  statement, not by any mention of `require('node:test')`.
- `--dir <path>` runs a different tree (used by the guard); `--update-baseline` rewrites the
  baseline; `TEST_RUNNER_KEEP_RESULTS=1` keeps per-file results for triage.
- **Two tests got their own `JWT_SECRET` default**: `auth/onboarding-self-heal` and
  `core/stranded-paid-case-rebroadcast`. Both had been borrowing one from an earlier file in
  the shared process, so they started failing the moment files were isolated.

## Baseline and gate

`baseline-nodb-failures.txt` **did not exist** before today: not on any branch, not in history.
The 6 Oct watchtower report already noted it was missing. No lint test compared against it.

- **`tests/baseline-nodb-failures.txt`** now holds the 183 failures, one `file :: test name`
  per line, with no durations or messages. It was:
  - generated by `node tests/run.js --update-baseline`;
  - identical across two consecutive runs;
  - identical again with CI's environment variables (`MODE=test`, `JWT_SECRET`, …), where
    3458 passed and the same 183 failed.
- **`tests/lint/nodb-baseline-gate.test.js`** runs **last** and receives every earlier file's
  failures:
  - **fails, naming each one, on any failure that is not in the baseline;**
  - lists baseline entries that now pass, without failing;
  - tests the comparison against made-up failure sets;
  - checks the baseline's format, order, and that each named file exists.

  It applies only to no-database runs of the whole suite. It is written in harness style, so it
  is counted even by a runner that is blind to node:test.
- **The baseline is a ledger, not a waiver.** `tests/run.js` still exits 1 while any test
  fails. The gate separates "the same 183" from "a new one".

## Guard

`tests/lint/runner-counts-every-failure.test.js` (harness style, for the same reason) builds
suites in temp dirs and runs the real runner on them:

1. **Control:** a passing node:test file and a passing harness file → exit 0, `Failed: 0`,
   `Passed: 3`.
2. **One deliberately failing node:test file → exit non-zero**, with the test in the tally and
   on its file line.
3. **Every other failure kind is counted** against its file: failing subtest (counted once),
   harness load crash, node:test load crash, unhandled rejection, non-zero exit, hang, no
   results.

## Triage of the 183

### (a) Real regressions in product code

**No regression was confirmed** among the tests that can run without a database. One product
defect turned up while I tried to run the database tests:

1. **A fresh database cannot be migrated past 109.**
   - `src/migrations/110_orders_is_practice.sql:18` does `create or replace view
     public.orders_active` with a column list in a different order from the view migrations
     043–045 build. Postgres refuses: `cannot change name of view column "broadcast_sent_at" to
     "reference_id"`.
   - Production boots today, and boot exits on a failed migrate, so production presumably
     applied 110 against a view built another way. That is an inference: I did not check
     production.
   - **A database built from migrations stops at 109** even when 059 and 067 are tolerated
     (below): CI with migrations, a new staging, a disaster-recovery rebuild. Reproduced on a
     throwaway local DB, since dropped. The local `tashkheesa_mobile` scratch DB also stops at
     109 (108 applied). That is consistent with this, but it may simply have been migrated
     before 110 existed.
   - **A plain boot on an empty database stops earlier, at 059.** 059 and 067 assert
     production-only rows (four price rows, eight named doctors). Only a tolerant wrapper such
     as `scripts/mobile-fixtures.js --migrate` gets past them.
   - Introduced in `f6dd359` (2026-09-22). The same file, as a bare `create or replace view`,
     also reset the view's options, dropping 072's `security_invoker` wherever it ran.
   - **Fixed on branch `fix/fresh-db-migrate-2026-10-27` (`f6ccc63`).** 110 now uses the
     084/121/129 re-sync (`SELECT *` with `security_invoker`, REVOKE, parity guard), and
     `tests/lint/orders-active-view-keeps-hardening.test.js` pins the rule. An empty DB then
     migrates to 131 with `migration_strict` on (059/067 tolerated).

**The database tests, run on that migrated DB.** This was a full run with CI's environment
variables: 3720 passed, 32 failed. 20 of the 22 database files are fully green, including every
money path:

| Files | What is at stake | Result |
|---|---|---|
| `admin/admin_refund`, `admin_refund_approve`, `admin_refund_deny`, `admin_refund_mark_paid` | issuing, approving, denying and paying out refunds | all pass |
| `admin/admin_verify_claim`, `admin/payment_event_review` | marking cases paid from claims and payment events | all pass |
| `src/services/addons/__tests__/pricing`, `prescription` | add-on prices and fulfilment | all pass |
| `src/services/addons/__tests__/video_consult` | video add-on commission | 2 fail, stale: expects 80%; migration 026 (2026-04-29) set 85% per the payout policy |
| `admin/admin_bulk_assign`, `src/__tests__/auto_assign`, `services/auto_assign_eligibility`, `assign_pick_eligibility`, `doctor_eligibility_integration`, `sla/sla-worker-eligibility` | which doctor gets a paid case, and when | all pass |
| `admin/admin_doctor_approve`, `admin_doctor_bulk_invite`, `admin_doctor_pause`, `admin_doctor_reject` | doctor lifecycle | all pass |
| `admin/admin_doctor_invite` | doctor invite | 1 fails, environment (below) |
| `services/services_coming_soon_sync`, `services/seed_my_services_fixtures` | the service catalogue | all pass |

**Harness files that skip without a database, and fail with one:** none is a product
regression.

- **Stale (c):**
  - `services/recompute-on-refund` (4): encodes the 2026-05-12 clawback policy. Since then,
    the scaled clawback (2026-08-17) and the Batch B decisions (2026-09-15) changed it: an SLA
    breach now reverses only the uplift. Documented in `src/services/earnings_writer.js` above
    `recomputeOnRefund`.
  - `finance/reassignment-earnings` (1): the in-transaction `doctor_sla_events` insert is
    still there (`earnings_writer.js:966`), past the test's fixed 4,000-character search
    window.
  - `sla/recalc-sla-breaches` (1): uses a REJECTED_FILES row as its "bad row", but that case
    may breach since `5b26d51` (2026-08-22).
  - `admin/doctor-approval` (3): byte-identical ar/en welcome templates (they diverged by
    design on 2026-08-25 and 2026-09-27), and source checks for a constant that moved to
    `doctor_welcome_payload.js`.
  - `core/notify-whatsapp` (1): the recipient guard (`697009b`, 2026-08-16) blocks
    non-production recipients before the misconfiguration branch the test aims for.
- **Environment (b):** `admin/admin_doctor_invite` (1) measures a 168 h token TTL as a
  wall-clock difference. This Mac's Postgres runs in `Africa/Cairo`, and in the week before
  Egypt leaves DST that difference is 167 h. Production pins its sessions to UTC.

### (b) Broken by environment

- **163 failures in the 22 files above.** Each one is a connection refused by the no-database
  guard. On a migrated database those 22 files report 3 failures in total; see the table
  above.
- **`core/email-stub-mode` (5 failures).**
  - `src/services/emailService.js:39` reads `EMAIL_ENABLED` once, at load. The test sets it
    *after* its fresh `require`, so it passes only where `EMAIL_ENABLED=true` was already in
    the environment.
  - It fails in CI, where `EMAIL_ENABLED=false`. The fix belongs in the test.
- **Fixed in this branch:** `auth/onboarding-self-heal` (3) and
  `core/stranded-paid-case-rebroadcast` (1) needed `JWT_SECRET`; see above.

### (c) Stale against intended behaviour

| Test | Failures | Why it fails | Since |
|---|---|---|---|
| `admin/admin_command_api` reassign tests | 2 | Expects the swap and COMMIT inside the route's transaction. The route deliberately ROLLBACKs and hands off to `case_lifecycle.reassignCase`, which uses its own pool (self-deadlock otherwise), at `src/routes/api/admin.js:~2000-2041`. | `5b26d51`, 2026-08-22 |
| `admin/admin_command_api` invite tests | 6 | They get HTTP 429 from `inviteIpLimiter` (10 per 15 min per caller, `src/routes/api/admin.js:326`) because the file sends more than 10 invites from one address. The test should reset or bypass the limiter. | Limiter `13de0c0`, 2026-08-10; keyed on caller `70a22bb`, 2026-10-11 |
| `core/api-cases-coming-soon-reject` | 3 | The handler resolves the service through `case_intake_pricing.resolveServiceForBooking` on the global pool, past the test's injected `safeGet`. SERVICE_NOT_BOOKABLE and INVALID_SERVICE are still enforced there (`src/services/case_intake_pricing.js` ~99–116). | `7dfbdfd`, 2026-08-25 |
| `services/worker_watchdog_push` | 2 | The test's fake pool answers `pg_try_advisory_lock`; the watchdog takes `pg_try_advisory_xact_lock` (`src/services/worker_watchdog.js:351`). No lock means no push. | `bc1f10d`, 2026-08-22 |
| `lint/urgency-tier-is-the-source` | 1 | Flags six reads that all prefer `urgency_tier` (`urgency_tier \|\| tier`, or select both and use `tierOf`): `case_sla_worker.js:1100`, `routes/superadmin.js:6699`, `services/business_pulse.js:48,78,104`, `services/refund_summary.js` (reported as :19, actually ~41 — the lint's comment stripping shifts line numbers). The allowlist already accepts the same pattern in `acceptance_watcher.js`. They need `ALLOWED` entries. | All six from 13–29 Sep, after the lint's 30 Aug; red and unseen since |
| `lint/erasure-covers-every-patient-table` | 1 | `admin_notification_prefs` (migration 123) holds operator settings keyed by an admin's `user_id`. It belongs in `NOT_PATIENT_OWNED`, like `ops_push_log`. | `bd3d063`, 2026-09-29 |

**Not failures:** 10 SQLite-era placeholder files (`admin/dashboard`, `admin/doctors`, …,
`reports/report-routes`) skip themselves explicitly with "rewrite pending". They are 10 of the
64 skips.

## CI

- `.github/workflows/ci.yml`'s `tests` job runs `npm test`, which is `node tests/run.js`, the
  same runner.
- Its Postgres service is never migrated (as known). The probe reports `orders_active` missing,
  so the run is a no-database run: 183 failures, exit 1. **The `tests` job will go red, and so
  will `deploy-check`, which needs it.**
- On `origin/main`, a migrate step alone would not help: a plain migrate stops at 059, and a
  tolerant one at 110. With `fix/fresh-db-migrate-2026-10-27`, a tolerant migrate (059/067
  recorded, as `scripts/mobile-fixtures.js` does) reaches the end.
- CI pins Node 20; this was verified on Node 24 only. `--test-force-exit` (20.14+) and
  `--test-timeout` are probed before use rather than assumed. **That CI goes red is certain;
  that its gate shows "0 NEW" is not.** If node:test's events or names differ on Node 20,
  CI's first run will list `(file) …` entries as NEW. That first run is the real check.
- **Runs that do have a migrated database now do more.** `npm test` also runs the
  `src/**/__tests__` files (add-ons, auto_assign), which write fixtures to that database, as
  the 23 node:test DB files under `tests/` already did. Only point a checkout's `.env` at a
  database you are willing to have test rows written to.
- CI triggers only on pushes to `main`/`staging` and PRs into `main`.

## Follow-up: the stale tests, repaired

Branch `fix/stale-tests-2026-10-27`, on top of this one. Test files only; no product code.
Every (b) and (c) test above now tests the intended behaviour:

- **The six no-database files:**
  - `admin_command_api`: reassignment is pinned as a hand-off to
    `case_lifecycle.reassignCase`. Two new tests: a refusal is `REASSIGN_FAILED`, and the
    lifecycle owns the previous-doctor notice. Each invite call presents its own caller
    address, and one new test pins the 10-per-15-minutes limit.
  - `api-cases-coming-soon-reject`: a fake `src/pg` under the real bookability rule, the
    fixtures placed in a real specialty, and a control that a bookable service passes.
  - `worker_watchdog_push`: the fake pool answers the transaction-scoped lock.
  - `email-stub-mode`: reloads the service with `EMAIL_ENABLED` on for the real-send cases.
  - `urgency-tier-is-the-source`: accepts a `tier` read only when `urgency_tier` immediately
    precedes it, not whole files, and reports true line numbers.
  - `erasure-covers-every-patient-table`: `admin_notification_prefs` is operator-owned.
- **The database-only files:**
  - `recompute-on-refund`: the current clawback policy, plus two new cases: a partial refund,
    and a refund after a breach write-down.
  - `reassignment-earnings`: the source check slices to the end of the function.
  - `recalc-sla-breaches`: an injected per-row failure.
  - `doctor-approval`: the ar/en files must carry the same two language blocks, each leading
    with its own; layout markers instead of colours; the constant where it now lives.
  - `notify-whatsapp`: the test number goes on `WHATSAPP_TEST_RECIPIENTS`.
  - `video_consult`: 85%.
  - `admin_doctor_invite`: the TTL in real elapsed time, exact across a DST change.

Verified:

- **Migrated database:** an empty local DB migrated with `fix/fresh-db-migrate-2026-10-27`,
  then the full suite with CI's environment variables: **3762 passed, 0 failed, 40 skipped,
  exit 0.**
- **No database:** **3498 passed, 163 failed, 64 skipped.** All 163 are database tests the
  no-database guard refuses, in 22 files. The baseline is now those 163, down from 183: the 20
  repaired entries are gone, and one renamed `video_consult` test changed its key. The gate
  reports 0 NEW and 0 now passing.
