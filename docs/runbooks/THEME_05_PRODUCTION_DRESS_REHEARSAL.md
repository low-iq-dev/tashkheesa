# Runbook — Theme 5 Production Dress Rehearsal (10 Concurrent Payments)

**Owner:** Ziad
**When:** After Theme 5 ships to production (commit `<sha>`).
**Why:** Verify in production that `markCasePaid` now holds exactly one
pool slot per payment under realistic concurrency, and that the
saturation footgun caught in audit `PERF-P0-1` is closed.

This is the OQ-5 production proof. Local + staging tests prove the code
is correct in isolation; the dress rehearsal proves the live pool
behaves under 10 simultaneous webhooks.

## Before you start

| Check | Command | Expected |
|---|---|---|
| New code is live | `curl -s https://tashkheesa.com/__version` | `"gitSha":"<theme-5-sha>"` |
| `[pg] pool ready: …` log line present | Render runtime log filter `[pg] pool` | Includes `statement_timeout=30000ms` |
| `[pg] env: mode=production DATABASE_URL_DIRECT=set` | Render runtime log | Both fields present |
| `pg-boss started` | Render runtime log filter `pg-boss` | One line, no fallback warning |

If any of those are missing, **do not run the dress rehearsal**. Investigate
the deploy first.

## Setup — seed 10 disposable test orders

These rows are throwaway. Tag them with a `theme5-rehearsal-` id prefix so
the cleanup query at the end is one DELETE.

Run on Supabase SQL editor (production):

```sql
-- 10 patients + 10 'submitted' orders ready to be marked paid.
DO $$
DECLARE
  i int;
  pid text;
  oid text;
  ts text := to_char(now(), 'YYYYMMDDHH24MISS');
BEGIN
  FOR i IN 1..10 LOOP
    pid := 'theme5-rehearsal-pat-' || ts || '-' || i;
    oid := 'theme5-rehearsal-ord-' || ts || '-' || i;
    INSERT INTO users (id, email, password_hash, name, role, is_active, created_at)
    VALUES (pid, pid || '@test.local', '$2b$10$x', 'Rehearsal ' || i, 'patient', true, NOW());
    INSERT INTO orders (id, patient_id, status, payment_status, urgency_tier, sla_hours,
                        price, currency, paid_at, created_at, updated_at)
    VALUES (oid, pid, 'submitted', 'paid', 'standard', 48,
            500, 'EGP', NOW(), NOW(), NOW());
    RAISE NOTICE 'seeded %', oid;
  END LOOP;
END $$;
```

Capture the 10 order IDs (`SELECT id FROM orders WHERE id LIKE 'theme5-rehearsal-ord-%'`).

## The drill

In one terminal, sample `/healthz` once a second and write to a log:

```bash
( while true; do
    printf '%s ' "$(date +%H:%M:%S.%3N)"
    curl -s --max-time 3 https://tashkheesa.com/healthz | grep -oE '"pool":\{[^}]+\}'
    echo
    sleep 1
  done ) | tee /tmp/pool-trace.log
```

In a second terminal, fire 10 simultaneous Paymob webhooks. Easiest path:
forge the HMAC for each order using the existing helper. Pseudo:

```bash
# Replace IDS with the 10 captured ids
IDS="theme5-rehearsal-ord-... theme5-rehearsal-ord-... ..."
for ID in $IDS; do
  ( BODY=$(./scripts/forge-paymob-callback.sh "$ID")
    SIG=$(./scripts/forge-paymob-hmac.sh "$BODY")
    curl -s -X POST "https://tashkheesa.com/payments/callback" \
         -H 'Content-Type: application/json' \
         -H "x-paymob-hmac: $SIG" \
         -d "$BODY" \
         -o "/tmp/rehearsal-$ID.out" \
         -w "%{http_code} %{time_total}s\n" ) &
done
wait
```

If forging the Paymob HMAC is too involved, a simpler alternative is to
hit a manual `/superadmin/orders/<id>/mark-paid` for each order in
parallel using a stored ops cookie — same end-state, slightly different
code path. The pool behavior is what matters; either entry point exercises
`markCasePaid`.

## What to look for

### In `/tmp/pool-trace.log`

Expected (after the fix):

- During the burst, `total` rises to ~10, `idle` drops to ~0, **`waiting` stays at 0** for any noticeable window.
- Within ~1 second of the last 200 returning, `idle` returns to ~10, `waiting` goes back to 0.
- No `total: 10, idle: 0, waiting: N>0` lines lasting more than ~1 second.

Pre-fix, you'd have seen `waiting > 0` rise into the 5+ range during the
burst with the queue holding for several seconds.

### In Render runtime logs

- 10 lines: `[case-lifecycle] markCasePaid completed for theme5-rehearsal-ord-...` (or whatever the existing equivalent log is) — confirms all 10 transitions ran.
- **Zero** `[pg] failed to SET statement_timeout` warnings.
- **Zero** `pool waiting=` panic logs (if such exist).
- **Zero** "timeout exceeded when trying to connect" errors from the pool.

### DB-side sanity (Supabase SQL editor)

```sql
-- All 10 rows should be in the canonical paid lifecycle now.
SELECT id, status, payment_status, paid_at, sla_hours
  FROM orders
 WHERE id LIKE 'theme5-rehearsal-ord-%'
 ORDER BY id;
-- expect: 10 rows, status='paid', payment_status='paid', sla_hours=48,
--         paid_at within the last 5 minutes.

-- Idempotency: exactly one PAYMENT_CONFIRMED event per order.
SELECT case_id, COUNT(*) AS n
  FROM case_events
 WHERE event_type = 'PAYMENT_CONFIRMED'
   AND case_id LIKE 'theme5-rehearsal-ord-%'
 GROUP BY case_id
HAVING COUNT(*) > 1;
-- expect: zero rows.

-- Pool didn't leak across the burst — sample pg_stat_activity right
-- after the burst finishes.
SELECT count(*), state
  FROM pg_stat_activity
 WHERE application_name LIKE '%tashkheesa%'
 GROUP BY state;
-- expect: idle and active counts that match a quiet steady state, not
--         a long tail of "idle in transaction" rows.
```

## Cleanup

```sql
-- One-shot delete.
DELETE FROM case_events WHERE case_id LIKE 'theme5-rehearsal-ord-%';
DELETE FROM orders      WHERE id      LIKE 'theme5-rehearsal-ord-%';
DELETE FROM users       WHERE id      LIKE 'theme5-rehearsal-pat-%';
```

If anything in the rehearsal looks wrong (waiting>0 that doesn't drain,
unexpected 500s, idle-in-transaction tail in pg_stat_activity), capture
`/tmp/pool-trace.log` + the Render log slice and open a follow-up issue.
The fix isn't on fire — production was *already* susceptible before
Theme 5 — but the dress rehearsal is the gate before we start cutting
real Paymob traffic at the new code path under load.

## What's NOT covered by this rehearsal

- **statement_timeout enforcement** is exercised by the in-pool tests
  (Phase 2 verification). It's not part of this drill because no slow
  query in `markCasePaid` would naturally trigger it.
- **pg-boss session-mode behavior**. Stage-1 verified at deploy time;
  this drill only stresses the request pool.
- **Co-saturator helpers** (`runSlaReminderJob`, `dispatchUnpaidCaseReminders`)
  are still on the old pattern (deferred per OQ-4 to `P2-PERF-FOLLOW-UP`).
  If pool stats look bad during the rehearsal at a moment when the SLA
  sweep also fires, that may be the unfixed co-saturator — check
  `pgrep -af "[SLA job]"` log lines around the spike timestamp.

## Reference

- Theme 5 fix plan: `docs/audits/THEME_05_POOL_SATURATION_FIX_PLAN.md`
- Comprehensive audit `PERF-P0-1`/`PERF-P0-2`/`PERF-P0-3`:
  `docs/audits/COMPREHENSIVE_PRE_LAUNCH_AUDIT_2026-05-06.md`
