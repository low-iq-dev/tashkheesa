-- 091_backfill_doctor_specialties_mirror.sql
-- ============================================================================
-- 2026-08-25 — 18 of 31 doctors were invisible to case broadcast.
--
-- There are three parallel representations of "what does this doctor cover":
--
--     users.specialty_id     the doctor's primary specialty, set everywhere
--     doctor_specialties     the many-to-many table, written in TWO places
--     doctor_services        per-service opt-in, what assignment actually gates on
--
-- notify/broadcast.js keys entirely off the middle one. But doctor_specialties
-- is only ever written by self-signup (routes/auth.js) and create_test_doctor.js.
-- Superadmin doctor create (routes/superadmin.js), superadmin doctor edit, and
-- the doctor's own services form all write doctor_services and never mirror
-- into it.
--
-- So every doctor added by an operator — which is most of them — had a
-- specialty_id and no doctor_specialties row, and a paid case in their
-- specialty broadcast to nobody at all. Measured before this ran: Urology 0
-- reachable doctors, Cardiology 0, Radiology 0, Orthopedics 1.
--
-- The accompanying commit changes broadcast to match on users.specialty_id OR
-- doctor_specialties, so the next writer that forgets the mirror degrades
-- gracefully. This migration closes the existing gap, so the table is also
-- correct for anything else that reads it.
--
-- PRIMARY SPECIALTY ONLY. Secondary specialties live in doctor_specialties
-- alone and cannot be reconstructed from users — nothing here invents one, and
-- any secondary row already present is left untouched.
--
-- IDEMPOTENT via the NOT EXISTS: the table has no unique constraint on
-- (doctor_id, specialty_id) — only a PK on id, which is why broadcast carries
-- a GROUP BY to dedupe — so ON CONFLICT is not available and the anti-join is
-- what keeps a re-run from inserting duplicates.
-- ============================================================================

-- id is `text NOT NULL` with NO DEFAULT on this table, so it must be supplied
-- explicitly — omitting it raises 23502, which src/db.js rethrows, migrate()
-- rejects on, and src/server.js turns into process.exit(1). That is a
-- permanent boot loop on every restart, not a failed migration. Both existing
-- writers (routes/auth.js, create_test_doctor.js) pass a randomUUID(); this is
-- the SQL equivalent. gen_random_uuid() is built in on PG 13+ — production is
-- PostgreSQL 17.6, verified.
INSERT INTO doctor_specialties (id, doctor_id, specialty_id, created_at)
SELECT gen_random_uuid()::text, u.id, u.specialty_id, NOW()
  FROM users u
 WHERE u.role = 'doctor'
   AND u.specialty_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM specialties s WHERE s.id = u.specialty_id)
   AND NOT EXISTS (
         SELECT 1 FROM doctor_specialties ds
          WHERE ds.doctor_id = u.id
            AND ds.specialty_id = u.specialty_id
       );

-- Guard: every doctor with a primary specialty must now be represented.
DO $$
DECLARE unmirrored integer;
BEGIN
  SELECT count(*) INTO unmirrored
    FROM users u
   WHERE u.role = 'doctor'
     AND u.specialty_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM specialties s WHERE s.id = u.specialty_id)
     AND NOT EXISTS (
           SELECT 1 FROM doctor_specialties ds
            WHERE ds.doctor_id = u.id AND ds.specialty_id = u.specialty_id
         );
  IF unmirrored > 0 THEN
    RAISE EXCEPTION
      '091: % doctor(s) still have no doctor_specialties row for their primary specialty', unmirrored;
  END IF;
END $$;
