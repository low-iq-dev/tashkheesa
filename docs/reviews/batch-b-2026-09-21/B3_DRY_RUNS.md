# B3 — the two production `doctor_earnings` rows: dry runs and recommendation

Executed 2026-09-21 via the Supabase MCP (`execute_sql`, project
`wvmhliweujmhlzknmuzh`), each inside `BEGIN … ROLLBACK`. **Nothing was
committed.** Ziad runs the COMMIT after choosing (a) or (b).

## The rows (confirmed live before the dry runs)

Exactly two rows exist, both for order `1dfdfb9a-3c70-486d-9b1f-6f8911fd2412`,
doctor `15821672-a53a-4fcb-b49a-49e48074b47a`:

| id | gross | pct | earned | status | reason | created_at (UTC) |
|---|---|---|---|---|---|---|
| `earn-main-46c31e0e-1204-4454-893c-4c0f8ea924c5` | 320 | 0 | **0** | reassigned | sla_breach | 2026-08-23 18:29:50 |
| `earn-reassign-eb6b53a7-3e1c-4a2e-ba60-d35f5f283894` | 320 | 10 | **32** | reassigned | sla_breach | 2026-08-25 18:30:24 |

Context checks (same session): the order is **`cancelled`**, `completed_at`
NULL, its current `doctor_id` is the string `doc_ali_khaled_urology` (not a
UUID); the doctor holding both rows is `notreallydrake@gmail.com`, named
*"MARKETING DEMO - do not assign real cases (was Test Doctor Ortho)"*.
**`addon_earnings` holds 0 rows** — nothing to correct there.

## Dry run (a) — zero the token row, keep both rows as history

```sql
BEGIN;
UPDATE doctor_earnings
   SET earned_amount = 0::int,
       commission_pct = 0::int
 WHERE id = 'earn-reassign-eb6b53a7-3e1c-4a2e-ba60-d35f5f283894'
   AND status = 'reassigned'
   AND earned_amount <> 0::int;
SELECT json_build_object(
  'rows_after_update', (SELECT json_agg(json_build_object('id', id, 'earned', earned_amount::int, 'pct', commission_pct::int, 'status', status, 'reason', reassignment_reason) ORDER BY created_at) FROM doctor_earnings),
  'ledger_money_total', (SELECT COALESCE(SUM(earned_amount),0)::int FROM doctor_earnings),
  'ledger_row_count', (SELECT COUNT(*)::int FROM doctor_earnings),
  'assert_token_zeroed', (SELECT earned_amount = 0::int FROM doctor_earnings WHERE id = 'earn-reassign-eb6b53a7-3e1c-4a2e-ba60-d35f5f283894'),
  'assert_history_kept', (SELECT COUNT(*)::int = 2 FROM doctor_earnings WHERE appointment_id = '1dfdfb9a-3c70-486d-9b1f-6f8911fd2412')
) AS dry_run_a;
ROLLBACK;
```

Output (verbatim):

```json
{"dry_run_a":{
  "rows_after_update":[
    {"id":"earn-main-46c31e0e-1204-4454-893c-4c0f8ea924c5","earned":0,"pct":0,"status":"reassigned","reason":"sla_breach"},
    {"id":"earn-reassign-eb6b53a7-3e1c-4a2e-ba60-d35f5f283894","earned":0,"pct":0,"status":"reassigned","reason":"sla_breach"}],
  "ledger_money_total":0,
  "ledger_row_count":2,
  "assert_token_zeroed":true,
  "assert_history_kept":true}}
```

## Dry run (b) — delete both rows; the ledger starts genuinely empty

```sql
BEGIN;
DELETE FROM doctor_earnings
 WHERE appointment_id = '1dfdfb9a-3c70-486d-9b1f-6f8911fd2412'
   AND doctor_id = '15821672-a53a-4fcb-b49a-49e48074b47a'
   AND id IN ('earn-main-46c31e0e-1204-4454-893c-4c0f8ea924c5',
              'earn-reassign-eb6b53a7-3e1c-4a2e-ba60-d35f5f283894');
SELECT json_build_object(
  'ledger_rows_remaining', (SELECT COUNT(*)::int FROM doctor_earnings),
  'addon_ledger_rows', (SELECT COUNT(*)::int FROM addon_earnings),
  'assert_ledger_empty', (SELECT COUNT(*)::int = 0 FROM doctor_earnings),
  'order_untouched', (SELECT json_build_object('id', id, 'status', status, 'completed_at', completed_at) FROM orders WHERE id = '1dfdfb9a-3c70-486d-9b1f-6f8911fd2412')
) AS dry_run_b;
ROLLBACK;
```

Output (verbatim):

```json
{"dry_run_b":{
  "ledger_rows_remaining":0,
  "addon_ledger_rows":0,
  "assert_ledger_empty":true,
  "order_untouched":{"id":"1dfdfb9a-3c70-486d-9b1f-6f8911fd2412","status":"cancelled","completed_at":null}}}
```

## Recommendation: **(b) delete both rows**

The pair is test residue, not money: a cancelled order that was never
completed, held by the marketing-demo account, with a non-UUID doctor id on
the order itself. Deleting means every new aggregation is verified against a
genuinely empty ledger, and migration 109's backfill (which would otherwise
copy the token row into `doctor_sla_events`) seeds nothing if the delete
lands before the deploy. If (a) is chosen instead, the backfilled event is
harmless — its 2026-08-25 stamp is already outside every realistic 30-day
pause window.

Interaction with deploy order, either choice: safe. The migration's backfill
is `ON CONFLICT (id) DO NOTHING` and re-runs on every boot; the reader
excludes `earn-reassign-%` from money either way.

**Ziad runs the COMMIT** (re-issue the chosen block with `COMMIT;` in place
of `ROLLBACK;`).
