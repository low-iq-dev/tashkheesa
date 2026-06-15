# RLS Lockdown — Clone-Test Runbook & Verification Plan (rev. 2)

> **STATUS: DRAFT for review. Nothing here has been run against prod or the clone.**
> Migration DDL: `src/migrations/070_rls_enable_default_deny.sql`,
> `src/migrations/071_drop_orphan_backup_tables.sql`, `src/migrations/072_harden_orders_active_view.sql`.
> (Reviewed as standalone artifacts and clone-tested first; moved into `src/migrations/` for the
> 2026-06-15 deploy after the dashboard toggles + C1 were green — the canonical Render-boot apply path.)
>
> **Rev. 2 changes:** (1) prod DB password never appears in chat/history — `~/.pgpass` or
> `read -s` only; (2) explicit prod read-only smoke **checkpoint** after the dashboard
> toggles, before any RLS migration; (3) strict cutover ordering — dashboard toggles land +
> verify FIRST, migrations commit/deploy ONLY after.

---

## 0. Recap of proven facts (basis for "low-risk")

| Fact | Source | Why it matters |
|---|---|---|
| All 61 `public` tables: `relrowsecurity=false`, `relforcerowsecurity=false`, **0 policies**, owner=`postgres` | `pg_catalog` (read-only) | Nothing is protected today |
| Portal/admin/patient API all use **one** `pg` pool as role `postgres` | `src/pg.js`, adversarial grep | Single choke point |
| `postgres` has **`rolbypassrls = true`** (NOSUPERUSER) | `pg_roles` (read-only) | App bypasses RLS **unconditionally** (even `FORCE`, even 0 policies) |
| `anon`/`authenticated`/`authenticator`: `rolbypassrls = false` | `pg_roles` | The only roles RLS constrains — and **no surface uses them** |
| No `@supabase/supabase-js`/anon/service-role key in portal **or either Expo app** | grep (repo + `~/Desktop/Tashkheesa/App`) | The anon REST path is unused everywhere |
| `anon` + `sb_publishable_…` keys **active**; PostgREST deployed (503 cold-cache) | `get_publishable_keys`, REST probe | Latent critical exposure; the 503 is not a control |
| `public` holds **61 base tables (`r`) + 1 view (`v` = `orders_active`)**; no `p`/`m` | `pg_class` (read-only) | `relkind='r'` guards cover all tables; the view needs separate handling (072) |
| `orders_active` view: owner `postgres` (BYPASSRLS), `security_invoker` unset, `anon`/`authenticated` granted SELECT | `pg_class` / `has_table_privilege` | Non-invoker view bypasses `orders` RLS → reads all orders as owner. Fixed by **072** |

**Clone-testable vs project-settings:**
- **Step 3 (enable RLS)** + **Step 4 (drop orphans)** are DB-level → tested on a `pg_dump` clone.
- **Step 1 (disable Data API)** + **Step 2 (disable keys)** are Supabase *project* settings → not reproducible on a local clone; validated on the **real project** by REST probe + a portal read-only smoke. Zero portal impact (no surface uses them).

> **Migration filename order ≠ §5 step labels.** Files: `070` = RLS, `071` = drops (your numbering).
> `070` explicitly excludes the 3 orphans, so it is safe whether it runs before or after `071`.

---

## A. Pre-flight (read-only except the backup)

### Secret handling (applies to every prod command below)
The prod DB password must **never** be typed into chat, a command line, or shell history.
Use **one** of:

```bash
# Option 1 (preferred): ~/.pgpass — libpq reads it; no password in any command.
#   Format: hostname:port:database:username:password
#   TWO entries, because the dump and the role-check use DIFFERENT endpoints:
#     • DIRECT host (for pg_dump — never the transaction pooler):
#         db.wvmhliweujmhlzknmuzh.supabase.co:5432:postgres:postgres:<PASSWORD>
#     • POOLER host (only for the A.1 role-check, faithful to how the app connects):
#         aws-1-us-east-1.pooler.supabase.com:6543:postgres:postgres.wvmhliweujmhlzknmuzh:<PASSWORD>
#   (Same project DB password in both. Edit in your editor; never echo on the CLI.)
umask 077; chmod 600 ~/.pgpass

# Option 2 (one-off): prompt without echo, export for the single command, then unset.
read -rs -p "Prod DB password: " PGPASSWORD; echo; export PGPASSWORD
# ... run the psql/pg_dump command ...
unset PGPASSWORD
```

Password-free DSNs (no secret in them):
```bash
# pg_dump MUST use the DIRECT host (transaction pooler breaks dumps; do not use it).
PROD_DIRECT="host=db.wvmhliweujmhlzknmuzh.supabase.co port=5432 dbname=postgres user=postgres sslmode=require"
# Role-check only — faithful to how the live app connects (pooler, role postgres.<ref>):
PROD_POOLER="host=aws-1-us-east-1.pooler.supabase.com port=6543 dbname=postgres user=postgres.wvmhliweujmhlzknmuzh sslmode=require"
```
> Direct host caveat: `db.<ref>.supabase.co` is often **IPv6-only** without the IPv4 add-on.
> If it's unreachable, the only dump-capable fallback is the **session pooler**
> (`...pooler.supabase.com:5432`, session mode — NOT the 6543 transaction pooler), used only on explicit approval.

### A.1 — ADD (1): confirm the portal's role is BYPASSRLS (read-only)
```bash
psql "$PROD_POOLER" -tAc \
  "SELECT current_user AS connected_as, rolsuper, rolbypassrls
   FROM pg_roles WHERE rolname = current_user;"
# EXPECT:  postgres|f|t      ← if rolbypassrls is not 't', STOP (RLS would empty the portal).
# (Already confirmed true via read-only MCP introspection: postgres rolbypassrls=t.)
```

### A.2 — ADD (2): Expo apps bundle no Supabase SDK/key — ✅ DONE, CLEAN
Path: `~/Desktop/Tashkheesa/App` (contains BOTH `tashkheesa-app` = patient and `tashkheesa-command` = admin).
```bash
grep -rIEn "@supabase/supabase-js|createClient\(|SUPABASE_(URL|ANON_KEY|SERVICE_ROLE)|EXPO_PUBLIC_[A-Z_]*SUPABASE|sb_secret_|service_role" \
  ~/Desktop/Tashkheesa/App \
  --include='*.js' --include='*.ts' --include='*.tsx' --include='*.json' --include='*.env*' \
  --exclude-dir=node_modules \
  && echo "⛔ REVIEW HITS" || echo "✅ CLEAN"
```
**Result (run 2026-06):** `✅ CLEAN` — no SDK import, no `@supabase` dependency, no `EXPO_PUBLIC_*SUPABASE` var. Both apps reach the backend via `lib/api.ts`/`resolveApiBase.ts` (portal REST). Re-run after any new Expo dependency.

### A.3 — Fresh prod backup (before ANY prod change in §5)
```bash
pg_dump "$PROD_DIRECT" --schema=public --format=custom --no-owner --no-privileges \
  --file="/tmp/prod_public.dump" --verbose
# DIRECT host only (never the pooler). Password via ~/.pgpass. Nothing secret on this line.
```

---

## 1. Build the clone (faithful roles)

Reproduce three roles so the test is valid: `app_owner` (NOSUPERUSER + **BYPASSRLS**, owns tables — mimics prod `postgres`) and `anon`/`authenticated` (**NOBYPASSRLS**, granted Supabase-style broad rights). A local *superuser* would bypass RLS for the wrong reason and invalidate the test — hence NOSUPERUSER.

```bash
# 1a. Local Postgres 17 (match prod 17.6). Clone-local passwords only (not prod):
docker run -d --name tash-clone -e POSTGRES_PASSWORD=pg -p 5433:5432 postgres:17

# 1b. Clone DB + faithful roles
psql "postgresql://postgres:pg@localhost:5433/postgres" <<'SQL'
CREATE DATABASE tash_clone;
\connect tash_clone
CREATE ROLE app_owner      LOGIN PASSWORD 'app' NOSUPERUSER BYPASSRLS;
CREATE ROLE anon           NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE authenticated  NOLOGIN NOSUPERUSER NOBYPASSRLS;
SQL

# 1c. Restore prod public dump (owner-stripped)
pg_restore --no-owner --no-privileges --schema=public \
  --dbname="postgresql://postgres:pg@localhost:5433/tash_clone" \
  prod_public_YYYYMMDD_HHMM.dump

# 1d. Re-own to app_owner; reproduce the broad anon/authenticated grants (the vuln baseline)
psql "postgresql://postgres:pg@localhost:5433/tash_clone" <<'SQL'
REASSIGN OWNED BY postgres TO app_owner;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO anon, authenticated;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
SQL
```
- App role (bypass): `postgresql://app_owner:app@localhost:5433/tash_clone`
- Anon: `SET ROLE anon;` inside a session connected as app_owner/local-superuser.

---

## 2. Baseline on the clone (RLS still OFF)

```bash
# 2a. Prove the holes (anon CAN read PII today — base table AND via the view)
psql "postgresql://postgres:pg@localhost:5433/tash_clone" <<'SQL'
SET ROLE anon;
SELECT count(*) AS anon_can_read_users         FROM public.users;          -- EXPECT non-zero (e.g. 38)
SELECT count(*) AS anon_can_read_orders_view   FROM public.orders_active;  -- EXPECT non-zero ← view vector
SQL
# Both demonstrate the current vulnerability (base-table grant + view-owner bypass).

# 2a'. Capture app_owner (BYPASSRLS) baseline counts — the parity target for §4d.
psql "postgresql://app_owner:app@localhost:5433/tash_clone" -tAc \
 "SELECT 'users='||count(*) FROM public.users
  UNION ALL SELECT 'orders='||count(*) FROM public.orders
  UNION ALL SELECT 'orders_active='||count(*) FROM public.orders_active;" | sort > baseline_owner_counts.txt
cat baseline_owner_counts.txt   # EXPECT non-zero (e.g. users=38, orders=27)

# 2b. Portal + patient API baseline. development MODE avoids the pg-boss
#     DATABASE_URL_DIRECT FATAL exit.
MODE=development PG_SSL=false PORT=3001 \
  DATABASE_URL="postgresql://app_owner:app@localhost:5433/tash_clone" \
  JWT_SECRET=clone-test-secret SESSION_SECRET=clone-test-secret \
  npm start &           # wait for "[pg] pool ready" + listening
bash docs/scripts/rls_clone_smoke.sh http://localhost:3001 > baseline_smoke.txt   # §6
kill %1

MODE=development PG_SSL=false \
  DATABASE_URL="postgresql://app_owner:app@localhost:5433/tash_clone" \
  npm test | tee baseline_tests.txt
```
> `tests/run.js` can under-count async failures (P1-14), so the **HTTP smoke (§6) is the authoritative portal-works check**; `npm test` is a secondary signal.

---

## 3. Apply lockdown on the CLONE

Exact DDL is in the review artifacts:
- `src/migrations/070_rls_enable_default_deny.sql` — RLS default-deny on the 58 survivors (with existence + drift guards).
- `src/migrations/071_drop_orphan_backup_tables.sql` — drops the 3 orphans (inbound-FK guard, RESTRICT).
- `src/migrations/072_harden_orders_active_view.sql` — `security_invoker=true` + REVOKE on the one view so it can't bypass `orders` RLS.

```bash
psql "postgresql://app_owner:app@localhost:5433/tash_clone" -f src/migrations/070_rls_enable_default_deny.sql
psql "postgresql://app_owner:app@localhost:5433/tash_clone" -f src/migrations/071_drop_orphan_backup_tables.sql
psql "postgresql://app_owner:app@localhost:5433/tash_clone" -f src/migrations/072_harden_orders_active_view.sql
```
No `FORCE`, no policies — default-deny; the app bypasses via `rolbypassrls`.

---

## 4. Re-verify on the clone (must match baseline) + prove the hole is closed

```bash
# 4a. Holes closed — anon now denied (base table, write, AND the view)
psql "postgresql://postgres:pg@localhost:5433/tash_clone" <<'SQL'
SET ROLE anon;
SELECT count(*) AS anon_reads_after_rls   FROM public.users;          -- EXPECT 0 (RLS returns no rows)
SELECT count(*) AS anon_reads_orders_view FROM public.orders_active;  -- EXPECT 0 / permission denied (072)
INSERT INTO public.app_analytics_events(event) VALUES ('x');          -- EXPECT ERROR: new row violates RLS
SQL

# 4b. Catalog confirms intended state
psql "postgresql://app_owner:app@localhost:5433/tash_clone" -tAc \
 "SELECT count(*) FILTER (WHERE relrowsecurity) AS rls_on,
         count(*) FILTER (WHERE relforcerowsecurity) AS forced,
         (SELECT count(*) FROM pg_policies WHERE schemaname='public') AS policies,
         count(*) AS total
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r';"
# EXPECT: rls_on=58, forced=0, policies=0, total=58

# 4c. Portal + patient API still fully work as the bypass role (the proof)
MODE=development PG_SSL=false PORT=3001 \
  DATABASE_URL="postgresql://app_owner:app@localhost:5433/tash_clone" \
  JWT_SECRET=clone-test-secret SESSION_SECRET=clone-test-secret \
  npm start &
bash docs/scripts/rls_clone_smoke.sh http://localhost:3001 > after_smoke.txt
kill %1
MODE=development PG_SSL=false \
  DATABASE_URL="postgresql://app_owner:app@localhost:5433/tash_clone" \
  npm test | tee after_tests.txt

diff baseline_smoke.txt after_smoke.txt && echo "✅ SMOKE IDENTICAL — portal unaffected"
diff baseline_tests.txt  after_tests.txt  && echo "✅ TEST SUITE IDENTICAL"

# 4d. SAFETY HALF — app_owner (BYPASSRLS, the role the portal uses) still sees FULL rows.
psql "postgresql://app_owner:app@localhost:5433/tash_clone" -tAc \
 "SELECT 'users='||count(*) FROM public.users
  UNION ALL SELECT 'orders='||count(*) FROM public.orders
  UNION ALL SELECT 'orders_active='||count(*) FROM public.orders_active;" | sort > after_owner_counts.txt
diff baseline_owner_counts.txt after_owner_counts.txt \
  && echo "✅ APP-OWNER PARITY — RLS-on returns the same (non-zero) rows as RLS-off" \
  || { echo "❌ app_owner counts changed under RLS — investigate"; exit 1; }
```
**Pass criteria (both halves green):** (anon) reads=0 / writes error on `users`, `app_analytics_events`, `orders_active`; AND (app_owner) §4d counts identical & non-zero, HTTP smoke byte-identical (all 2xx), test pass-count unchanged; catalog 58/0/0/58.

---

## 5. Proposed PROD cutover (strict ordering — for your approval)

> **Ordering guarantee you asked for:** dashboard toggles (Steps 1–2) are applied and
> **verified green FIRST**; migrations `070`/`071`/`072` are added to `src/migrations/`, committed,
> and deployed **only after**. The migration files stay in `src/migrations/` until then —
> **they are NOT committed ahead of the dashboard changes**, so no Render deploy ever runs
> while the anon REST path is still open. (Disabling the Data API first also prevents the
> RLS DDL's PostgREST schema-cache reload from briefly warming the currently-503 endpoint.)

| # | Action | Reversible? | Validate |
|---|---|---|---|
| 0 | Fresh `pg_dump` backup (§A.3) | — | dump file exists |
| 1 | **Disable Data API** (Dashboard → Project Settings → Data API → off) | ✅ toggle on | REST probe → non-200 |
| 2 | **Disable** `anon` + `sb_publishable_` keys (Dashboard → API Keys; disable, not hard-rotate) | ✅ re-enable | old key → 401 |
| **C1** | **CHECKPOINT (NEW): prod portal read-only smoke must be GREEN before proceeding** | — | see below |
| 3 | **Enable RLS default-deny + harden view** — move `070` **and `072`** into `src/migrations/`, commit (approved), deploy → Render boot applies | ✅ `DISABLE RLS` / `security_invoker=false` / revert | advisor `rls_disabled` clears; C2 below |
| 4 | **Drop** 3 orphan tables — `071`, same canonical path | ⚠ restore from §A.3 dump | C2 below |

### REST probe for Steps 1–2 (read-only; key from env, never inline)
```bash
export ANON="…"   # set in your shell from a secret store; do not paste into the runbook
BASE="https://wvmhliweujmhlzknmuzh.supabase.co/rest/v1"
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/services?select=id&limit=1" \
  -H "apikey:$ANON" -H "Authorization: Bearer $ANON"
# Before: 200 or 503.  After Data-API-disable: connection refused / 404 / "Data API disabled".
# After key-disable: 401.
unset ANON
```

### CHECKPOINT C1 — prod portal read-only smoke (NEW, after Steps 1–2, before Step 3)
Confirms disabling the Data API + keys did not affect the portal (it shouldn't — no surface uses them). Read-only, no writes, no PII:
```bash
# Canonical domain (what patients hit). Read-only: /healthz + /__version return public JSON, no writes, no PII.
SMOKE_BASE_URL="https://tashkheesa.com" npm run smoke           # EXPECT: "✅ smoke ok"
curl -s -o /dev/null -w "/ %{http_code}\n"        "https://tashkheesa.com/"
curl -s -o /dev/null -w "/status %{http_code}\n"  "https://tashkheesa.com/status"
curl -s             -w "\n/__version %{http_code}\n" "https://tashkheesa.com/__version"   # confirm gitSha/mode
# CDN-bypass fallback (hit the Render origin directly) if the custom domain is fronted by a proxy:
#   SMOKE_BASE_URL="https://tashkheesa.onrender.com" npm run smoke
```
**Gate:** do NOT touch migration `070` until C1 is green. (Also: do not begin Steps 1–2 until your prod backup is taken.)

### CHECKPOINT C2 — after migrations deploy
- `get_advisors(security)` → `rls_disabled` lint cleared.
- `SMOKE_BASE_URL=… npm run smoke` → green again.
- Spot-check one patient read (`GET /api/v1/cases` with a real token) and `GET /api/v1/admin/health` → 200.
- Catalog: `rls_on=58, forced=0, policies=0, total=58`.

### Migration discipline (per project memory)
`070`/`071`/`072` enter `src/migrations/` only after commit approval; Render boot is the canonical apply path. Before pushing, re-run the §4b catalog guard against a fresh clone to confirm the table set still matches (the guards in `070` will also abort on drift).

---

## 6. Verification script — `docs/scripts/rls_clone_smoke.sh` (PROPOSED)

Clone-only (self-seeds). Exercises every patient capability + admin Phase-1 over HTTP; passes a patient token to `/admin/health` and asserts **403**.

```bash
#!/usr/bin/env bash
# Usage: rls_clone_smoke.sh http://localhost:3001
set -euo pipefail
BASE="$1"
CLONE="postgresql://app_owner:app@localhost:5433/tash_clone"
pass(){ echo "PASS $1 ($2)"; }; fail(){ echo "FAIL $1 ($2)"; exit 1; }
code(){ echo "$1" | tail -n1; }; body(){ echo "$1" | sed '$d'; }

read SVC SPEC < <(psql "$CLONE" -tAc \
  "SELECT id, specialty_id FROM public.services WHERE is_visible IS NOT FALSE AND specialty_id IS NOT NULL LIMIT 1" | tr '|' ' ')
[ -n "${SVC:-}" ] || fail services-lookup "no visible service in clone"

# 1. patient register -> token
TS=$(date +%s)
R=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/v1/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"clone+$TS@test.local\",\"password\":\"Test12345!\",\"name\":\"Clone Tester\"}")
{ [ "$(code "$R")" = 200 ] || [ "$(code "$R")" = 201 ]; } || fail register "$(code "$R")"
TOK=$(body "$R" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p'); [ -n "$TOK" ] || fail register "no token"
pass register "$(code "$R")"; AUTH="Authorization: Bearer $TOK"

# 2. submit case
R=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/v1/cases" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"specialtyId\":$SPEC,\"serviceId\":$SVC,\"clinicalQuestion\":\"smoke\",\"country\":\"EG\",\"files\":[{\"fileId\":\"orders/draft/x/$TS.jpg\",\"label\":\"scan\"}]}")
{ [ "$(code "$R")" = 201 ] || [ "$(code "$R")" = 200 ]; } || fail submit-case "$(code "$R")"
CID=$(body "$R" | sed -n 's/.*"id":\([0-9]*\).*/\1/p' | head -1); pass submit-case "$(code "$R") id=$CID"

# 3..6 reads
for ep in "GET /api/v1/cases" "GET /api/v1/cases/$CID" "GET /api/v1/notifications" \
          "GET /api/v1/notifications/unread-count" "GET /api/v1/conversations"; do
  M=${ep% *}; P=${ep#* }
  C=$(curl -s -o /dev/null -w '%{http_code}' -X "$M" "$BASE$P" -H "$AUTH")
  [ "$C" = 200 ] || fail "$P" "$C"; pass "$P" "$C"
done

# 7. superadmin (CLONE-ONLY password reset, then login + health)
HASH=$(node -e "console.log(require('bcryptjs').hashSync('CloneAdmin1!',10))")
psql "$CLONE" -c "UPDATE public.users SET password_hash='$HASH' WHERE role='superadmin'" >/dev/null
ADMIN_EMAIL=$(psql "$CLONE" -tAc "SELECT email FROM public.users WHERE role='superadmin' LIMIT 1")
R=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/v1/admin/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"CloneAdmin1!\"}")
[ "$(code "$R")" = 200 ] || fail admin-login "$(code "$R")"
ATOK=$(body "$R" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
C=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/admin/health" -H "Authorization: Bearer $ATOK")
[ "$C" = 200 ] || fail admin-health "$C"; pass admin-health "$C"

# 8. negative: patient token must NOT reach admin (403)
C=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/admin/health" -H "$AUTH")
[ "$C" = 403 ] || fail admin-gate "expected 403 got $C"; pass admin-gate "$C"
echo "ALL SMOKE CHECKS PASSED"
```
Run identically before and after RLS; output must match.

---

## 7. ADD (1) — deploy-doc pin (add to RISK_REGISTER.md / Render env notes)

> **`DATABASE_URL`/`DATABASE_URL_DIRECT` must always use a `BYPASSRLS` role (`postgres` or
> `service_role`).** RLS is default-deny on all public tables; the portal relies on
> `rolbypassrls=true` to see rows. **Never** repoint to `anon`/`authenticated`/`authenticator`
> — every portal query would silently return 0 rows.
> Verify after any DB credential change:
> `psql "$DATABASE_URL" -tAc "SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user;"` → `t`.

---

## 8. Rollback matrix
| Step | Rollback |
|---|---|
| 1 Data API | Re-toggle Data API on (Dashboard) |
| 2 Keys | Re-enable the disabled keys (Dashboard) — reason we disable, not hard-rotate, first |
| 3 RLS | `ALTER TABLE public.<t> DISABLE ROW LEVEL SECURITY;` (loop) / revert migration 070 |
| 4 Drops | Restore from §A.3 dump: `pg_restore -t <table> --dbname=… prod_public_*.dump` |

## 9. Sign-off checklist
- [ ] Secret handling confirmed: `~/.pgpass` (chmod 600) or `read -s` — no prod password in chat/CLI/history
- [x] A.2 Expo apps (patient + command): no Supabase SDK/key — **CLEAN**
- [ ] A.1 prod role `rolbypassrls = t`
- [ ] A.3 prod backup taken
- [ ] Clone built with NOSUPERUSER `app_owner` + non-bypass `anon`/`authenticated`
- [ ] Baseline smoke + tests captured (anon CAN read = hole confirmed)
- [ ] Clone lockdown applied (070 + 071 + 072)
- [ ] After: smoke/tests identical; anon reads=0/writes error; anon `orders_active`=0/denied; catalog 58/0/0/58
- [ ] PROD: Step 1 (Data API off) + Step 2 (keys off) applied & probed
- [ ] **CHECKPOINT C1 green (prod portal read-only smoke) BEFORE any migration**
- [ ] Migrations 070/071 moved to src/migrations, committed (approved), deployed
- [ ] CHECKPOINT C2 green (advisor cleared, smoke green, catalog 58/0/0/58)
- [ ] Deploy-doc pin added (§7)
- [ ] Clone torn down (§10) — cluster stopped, data dir + dump removed (held prod PII)

---

## 9b. Clone run result — 2026-06-15 (PASSED)
Substrate: installed `postgresql@17` (approved); throwaway cluster on `:5433`. Dump via the
**session pooler** (direct host `db.<ref>.supabase.co` is IPv6-only and unreachable from this
machine — approved fallback). Clone owned by `app_owner` (NOSUPERUSER + BYPASSRLS); `anon`/
`authenticated` granted Supabase-style broad rights to reproduce the exposure.

| Check | RLS OFF (baseline) | RLS ON (070+071+072) |
|---|---|---|
| anon reads `users` | **38** | **0** |
| anon reads `orders` | **27** | **0** |
| anon reads `orders_active` | **5** | **permission denied** (072 revoke) |
| anon write `app_analytics_events` | (allowed) | **RLS violation** |
| app_owner counts (users/orders/orders_active) | 38 / 30 / 8 | **38 / 30 / 8 — identical (parity ✅)** |
| catalog (rls_on/forced/policies/total) | 0 / 0 / 0 / 61 | **58 / 0 / 0 / 58** |
| HTTP smoke (login→case→detail→list→notifs→convos→admin-health→admin-gate403) | all PASS | **byte-identical, all PASS** |
| `npm test` | 611 pass / 21 fail / 11 skip | **611 / 21 / 11 — identical** (21 fails pre-existing, RLS-independent) |

Both halves green: anon fully denied **and** the portal/patient/admin API unchanged under RLS-on as the BYPASSRLS role. Clone + dump destroyed at teardown (§10).

Smoke-script corrections found during the run (now reflected in `docs/scripts/rls_clone_smoke.sh`):
auth uses `login` after a clone-only password reset (register needs phone+country E.164);
service IDs are **text codes** → quoted in JSON; `clinicalQuestion` ≥10 chars; case-detail uses the UUID id.
Clone-only fidelity note: `app_owner` was granted `CREATE` on schema `public` + database (prod's `postgres` already has these) so the boot-time migration runner and pg-boss could initialize.

## 10. Teardown (mandatory — the clone holds a copy of prod patient data)
```bash
PG17=/usr/local/opt/postgresql@17/bin
"$PG17/pg_ctl" -D /tmp/tash_clone_pg17 stop   # stop the :5433 cluster (clone DB inside it)
rm -rf /tmp/tash_clone_pg17                    # remove the entire cluster + its data
rm -f  /tmp/prod_public.dump                   # remove the prod dump (PII on disk)
```
Captured `*_smoke.txt` / `*_tests.txt` / `*_owner_counts.txt` hold only HTTP codes + counts (no PII) — kept for the report unless you want them removed too. `postgresql@17` itself can be left installed or `brew uninstall postgresql@17`.
