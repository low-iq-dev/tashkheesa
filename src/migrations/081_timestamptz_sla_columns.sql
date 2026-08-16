-- ============================================================================
-- 081 — convert the SLA/audit timestamp columns to `timestamptz`
--
-- WHY
-- ---
-- orders.deadline_at, sla_deadline, acceptance_deadline_at, accepted_at,
-- completed_at, breached_at, created_at, updated_at (and the doctor_assignments
-- equivalents) were declared `TIMESTAMP` — WITHOUT time zone.
--
-- Every application write to them is a JS `.toISOString()`, i.e. UTC. Postgres
-- stores a naive column by DISCARDING the offset, so the digits on disk are
-- UTC. But the sweeps compare with `NOW()::timestamp`, which is the SESSION's
-- wall clock. Production inherited Africa/Cairo, so every deadline read 2-3
-- hours further into the past than it was: cases breached early, doctors were
-- reassigned off cases they had not missed and clawed back to 10% partial pay,
-- and the acceptance windows (10/60/240 min at the time — all shorter than the
-- skew) meant the doctor broadcast/accept handshake never ran at all.
--
-- The hotfix (ed1d78d) pinned both the DB session and the Node process to UTC.
-- That is correct and is guarded by tests, but it leaves the *type* lying: the
-- column claims to have no timezone while every consumer assumes UTC, and the
-- whole thing rests on a `SET TIME ZONE` that is fire-and-forget on a pooled
-- connection.
--
-- This migration makes the type honest. `AT TIME ZONE 'UTC'` states what the
-- digits already are.
--
-- IS THIS A BEHAVIOUR CHANGE?
-- ---------------------------
-- No. Under a UTC session, reading `timestamp` and reading
-- `timestamp AT TIME ZONE 'UTC'` produce the same instant. This migration is
-- semantically a no-op *today*; what it removes is the dependency on the
-- session setting staying UTC forever.
--
-- THE ONE CAVEAT, STATED PLAINLY
-- ------------------------------
-- A handful of columns were historically written by SQL-side `NOW()` rather
-- than by the application: created_at (DEFAULT NOW() and one explicit site),
-- updated_at, reassigned_at, and doctor_assignments.completed_at. Before the
-- session was pinned, those writes stored CAIRO wall-clock digits. Rows written
-- that way, before 2026-08-16, will read 2-3 hours early once labelled UTC.
--
-- These are audit/display columns, never SLA inputs — no deadline, breach or
-- payment decision reads them. And they are ALREADY being read as UTC since the
-- session was pinned, so this migration does not make anything worse; it just
-- stops pretending. Confirmed acceptable: pre-launch data is test/demo.
--
-- Deadline columns have no such ambiguity — every write to them is, and always
-- was, a JS ISO-8601 UTC string.
--
-- MECHANICS
-- ---------
-- `ALTER COLUMN ... TYPE` fails with "cannot alter type of a column used by a
-- view" — orders_active is `SELECT * FROM orders`, and anything built on top of
-- it inherits the dependency. So: capture every view definition, drop them,
-- alter, then recreate. The recreate runs as a retry loop so views that depend
-- on other views come back in a workable order without hardcoding one.
--
-- Column selection is data-driven (information_schema), so a column added since
-- this was written is converted too rather than silently left behind.
-- Idempotent: on a database where the columns are already timestamptz, the
-- ALTER list comes back empty and the whole thing is a no-op.
-- ============================================================================

DO $$
DECLARE
  v          RECORD;
  col        RECORD;
  alters     TEXT;
  tbl        TEXT;
  remaining  INT;
  progressed BOOLEAN;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'orders'
  ) THEN
    RAISE NOTICE '081: orders table absent, skipping';
    RETURN;
  END IF;

  -- STEP 1. Snapshot every public view, then drop the ones depending on our two
  -- tables. CASCADE takes transitive dependents; they come back in step 3.
  CREATE TEMP TABLE _v081 (name TEXT PRIMARY KEY, def TEXT, done BOOLEAN DEFAULT FALSE)
    ON COMMIT DROP;

  INSERT INTO _v081 (name, def)
  SELECT c.relname, pg_get_viewdef(c.oid, true)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'v' AND n.nspname = 'public';

  FOR v IN
    SELECT DISTINCT c.relname AS name
      FROM pg_depend d
      JOIN pg_rewrite r ON r.oid = d.objid
      JOIN pg_class   c ON c.oid = r.ev_class AND c.relkind = 'v'
     WHERE d.refobjid IN (
             SELECT oid FROM pg_class
              WHERE relname IN ('orders', 'doctor_assignments')
                AND relnamespace = 'public'::regnamespace
           )
  LOOP
    EXECUTE format('DROP VIEW IF EXISTS public.%I CASCADE', v.name);
    RAISE NOTICE '081: dropped view % (will be recreated)', v.name;
  END LOOP;

  -- STEP 2. Convert every timezone-naive timestamp column on the two tables.
  FOREACH tbl IN ARRAY ARRAY['orders', 'doctor_assignments'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl
    ) THEN CONTINUE; END IF;

    alters := '';
    FOR col IN
      SELECT column_name
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = tbl
         AND data_type = 'timestamp without time zone'
       ORDER BY column_name
    LOOP
      IF alters <> '' THEN alters := alters || ', '; END IF;
      alters := alters
        || 'ALTER COLUMN ' || quote_ident(col.column_name)
        || ' TYPE timestamptz USING ' || quote_ident(col.column_name)
        || ' AT TIME ZONE ' || quote_literal('UTC');
    END LOOP;

    IF alters <> '' THEN
      EXECUTE 'ALTER TABLE public.' || quote_ident(tbl) || ' ' || alters;
      RAISE NOTICE '081: converted naive timestamp columns on %', tbl;
    ELSE
      RAISE NOTICE '081: % already timestamptz, nothing to convert', tbl;
    END IF;
  END LOOP;

  -- STEP 3. Recreate the dropped views. Retry loop so a view built on another
  -- view comes back once its dependency exists, with no hardcoded ordering.
  UPDATE _v081 SET done = TRUE
   WHERE name IN (
     SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'v' AND n.nspname = 'public'
   );

  LOOP
    progressed := FALSE;
    FOR v IN SELECT name, def FROM _v081 WHERE NOT done LOOP
      BEGIN
        EXECUTE 'CREATE OR REPLACE VIEW public.' || quote_ident(v.name)
             || ' WITH (security_invoker = true) AS ' || v.def;
        UPDATE _v081 SET done = TRUE WHERE name = v.name;
        progressed := TRUE;
        RAISE NOTICE '081: recreated view %', v.name;
      EXCEPTION WHEN OTHERS THEN
        NULL;  -- dependency not back yet; retry on the next pass
      END;
    END LOOP;
    SELECT count(*) INTO remaining FROM _v081 WHERE NOT done;
    EXIT WHEN remaining = 0 OR NOT progressed;
  END LOOP;

  IF remaining > 0 THEN
    RAISE EXCEPTION '081: % view(s) could not be recreated - rolling back', remaining;
  END IF;

  -- STEP 4. Restore the 072 hardening. CREATE OR REPLACE VIEW does not carry
  -- grants, and orders_active must never be readable by the Supabase
  -- anon / authenticated roles.
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'v' AND n.nspname = 'public' AND c.relname = 'orders_active'
  ) THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE 'REVOKE SELECT ON public.orders_active FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE 'REVOKE SELECT ON public.orders_active FROM authenticated';
    END IF;
  END IF;
END $$;
