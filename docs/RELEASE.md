# Release: when the test suite passes

27 October 2026. This is the rule `RELEASE_CHECKLIST.md` refers to. It covers `npm test`
(`tests/run.js`) from the runner fix of 27 October onward
(`docs/audits/TEST_RUNNER_2026-10-27.md`).

## The rule

**"The suite passes" means:**

- **With a migrated database:** `npm test` exits 0.
- **Without a database:** the baseline gate reports 0 new failures, and the count of database
  tests the run refused is printed.

Nothing else counts. `Failed: 0` on its own is not the rule:

- A no-database run never prints it. Every database test it refuses is counted as a failure,
  and the run exits 1.
- Before 27 October, the runner printed `Failed: 0` while node:test failures went uncounted.

The runner picks the mode itself. Before the first file, it checks the database for the app's
schema. If the schema isn't there, it says so at the top and runs without a database.

## With a migrated database

Use a database you are willing to have test rows written to. Never use production, or any
database you want to keep. Migrate it from zero with the app's own `migrate()`, the one the
server runs at boot. `scripts/mobile-fixtures.js --migrate` tolerates failing migrations, so it
does not count as a migration from zero.

```bash
createdb tashkheesa_release_check
psql -d tashkheesa_release_check -c "ALTER DATABASE tashkheesa_release_check SET tashkheesa.migration_strict = 'on'"
# CI's env block (the `tests` job in .github/workflows/ci.yml), with this database:
export DATABASE_URL=postgresql://localhost:5432/tashkheesa_release_check PG_SSL=false \
  MODE=test NODE_ENV=test JWT_SECRET=ci-test-secret-minimum-32-characters-long \
  EMAIL_ENABLED=false WHATSAPP_ENABLED=false SLA_MODE=passive TASH_API_KEY=ci-test-tash-key \
  UNSUBSCRIBE_SECRET=ci-test-unsub-secret PUBLIC_ORDER_API_KEY=ci-test-public-order-key
node -e "require('./src/db').migrate().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); })"
npm test; echo "exit $?"
dropdb tashkheesa_release_check
unset DATABASE_URL PG_SSL MODE NODE_ENV JWT_SECRET EMAIL_ENABLED WHATSAPP_ENABLED SLA_MODE \
  TASH_API_KEY UNSUBSCRIBE_SECRET PUBLIC_ORDER_API_KEY
```

- If CI's `env:` block changes, change this block with it.
- **Pass:** `exit 0`. The summary shows `Failed:  0` and has no
  `Note:   database integration tests skipped` line.
- The no-database gate skips itself in this mode. That is expected: the baseline does not
  describe a run with a database.

CI runs this mode on every push to `main` or `staging` and on every pull request into `main`
(job `tests` in `.github/workflows/ci.yml`), and `deploy-check` needs that job to pass. CI pins
Node 20.

## Without a database

Unset `DATABASE_URL`, and make sure no `.env` provides one. Then run:

```bash
npm test; echo "exit $?"
```

The run exits 1. That is expected while it refuses database tests. Three lines carry the result:

| Where | Line | What it tells you |
|---|---|---|
| Top of the run | `⚠  Database integration tests will be SKIPPED: DATABASE_URL is not set.` | The run is in no-database mode. |
| Last file, `📋 lint/nodb-baseline-gate.test.js` | `163 known failure(s) · 0 NEW · 0 baseline entries now passing` and `✅ no failure in this run is missing from tests/baseline-nodb-failures.txt` | The gate's verdict, and the refused count. |
| Summary | `Failed:  163` and `Note:   database integration tests skipped — DATABASE_URL is not set` | The refused count again. |

- **Pass:** the gate says `0 NEW` and its check is ✅.
  - Record the refused count with the release. On 27 October it was 163.
  - Every line in `tests/baseline-nodb-failures.txt` is a database test refused with
    `no-database test run — connections are refused`.
- **A `NEW` entry fails the gate,** and the gate lists it by name.
  - Fix the test or the code.
  - Don't add the entry to the baseline to make the gate pass.
- **A `now passing` entry is not a failure.** Shrink the baseline:
  `node tests/run.js --update-baseline` (no-database runs only). Commit the new file together
  with the change that made the entry pass.

## Known gap (27 October 2026)

In a full no-database run, `lint/bilingual-email-template-parity.test.js` sometimes reports only
part of its 84 tests: 75 in one run, 66 in another. Each time it exits 0 with nothing failed.

- Run alone, or as part of `--dir tests/lint`, it reports all 84 every time. A run with a
  database reported 84 too.
- No other file's count moved between runs, and the 163 failures and the gate's verdict were
  the same in every run.
- So the `Passed:` total can differ by a few between identical runs. That is why the rule
  above never names a pass count.
- The runner does not yet detect a file that loses results this way. A failure in the lost
  part would not be counted.
