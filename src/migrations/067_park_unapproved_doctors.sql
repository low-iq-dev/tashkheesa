-- 067_park_unapproved_doctors.sql
--
-- Park doctors who should not yet receive auto-assignments. Per the
-- launch audit (2026-06-01), two groups are in the assignment pool but
-- cannot service cases:
--
--   GROUP A — 8 bulk-inserted doctors (4 OB/GYN + 4 ortho, all created
--             2026-05-18 08:33:54). pending_approval=false and
--             is_active=true (so auto_assign.js will match them) but
--             password_hash IS NULL → they cannot log in, accept cases,
--             or submit reports. The intent at insert time appears to
--             have been "pre-approved, pending credential setup", but
--             the current state silently sends them real cases that
--             will SLA-breach.
--
--   GROUP B — Dr. Ahmed Hassan, UUID id 75334fe8-fb43-4202-ab18-...
--             (not the doc_* convention used elsewhere), specialty_id
--             IS NULL, is_active=true. With NULL specialty_id, auto-
--             assignment can't match him anyway (auto_assign.js joins
--             on specialty_id), so impact today is zero — but he
--             pollutes broadcasts and admin dashboards. Parking him is
--             defensive; if he turns out to be a real practising doctor
--             the revert is: UPDATE users SET is_active=true WHERE id =
--             '75334fe8-fb43-4202-ab18-3b87b8a325e2';
--
-- Why is_active=false (not pending_approval=true): the existing
-- approve-doctor flow at src/routes/superadmin.js:3186 flips both flags
-- together. Doctors in Group A already passed that step intentionally;
-- moving them back to pending_approval=true would erase that signal.
-- is_active is the assignment-pool gate (auto_assign.js:29,128 both
-- filter on COALESCE(is_active, true) = true), so flipping just that
-- removes them from matching without rewriting approval history.
--
-- Reactivation path for Group A: once a doctor sets a password (e.g.
-- via the magic-login flow in src/routes/auth.js:354), an admin should
-- run UPDATE users SET is_active=true WHERE id=$1 from the superadmin
-- UI. No code change needed.
--
-- End state: 9 user rows flipped to is_active=false. No other columns
-- touched. Idempotent — re-running is a no-op.

BEGIN;

-- ─── GROUP A: 8 bulk-inserted doctors (4 OB/GYN + 4 ortho). ─────────
UPDATE users
   SET is_active = false
 WHERE role = 'doctor'
   AND id IN (
     'doc_khaled_sultan_obgyn',
     'doc_mohamed_eldars_obgyn',
     'doc_taher_abulaban_obgyn',
     'doc_hassan_abdelmaged_obgyn',
     'doc_ahmed_borghout_ortho',
     'doc_mahmoud_helwa_ortho',
     'doc_ibrahim_hammad_ortho',
     'doc_mohammed_jamaleddin_ortho'
   )
   AND password_hash IS NULL;

-- ─── GROUP B: orphan doctor with NULL specialty_id. ─────────────────
UPDATE users
   SET is_active = false
 WHERE role = 'doctor'
   AND id = '75334fe8-fb43-4202-ab18-3b87b8a325e2'
   AND specialty_id IS NULL;

-- ─── Post-condition guards (atomic — failure rolls back the txn). ───
DO $$
DECLARE
  group_a_active INT;
  group_b_active INT;
  group_a_total INT;
BEGIN
  -- All 8 Group A doctors should now be inactive (or never existed).
  SELECT COUNT(*) INTO group_a_active
    FROM users
   WHERE role = 'doctor'
     AND id IN (
       'doc_khaled_sultan_obgyn','doc_mohamed_eldars_obgyn',
       'doc_taher_abulaban_obgyn','doc_hassan_abdelmaged_obgyn',
       'doc_ahmed_borghout_ortho','doc_mahmoud_helwa_ortho',
       'doc_ibrahim_hammad_ortho','doc_mohammed_jamaleddin_ortho'
     )
     AND COALESCE(is_active, true) = true
     AND password_hash IS NULL;
  IF group_a_active != 0 THEN
    RAISE EXCEPTION 'Migration 067 post-condition failed: expected 0 still-active password-less Group A doctors, got %', group_a_active;
  END IF;

  -- Sanity: confirm we actually found the Group A rows (catches typos
  -- in the id list against a fresh DB).
  SELECT COUNT(*) INTO group_a_total
    FROM users
   WHERE role = 'doctor'
     AND id IN (
       'doc_khaled_sultan_obgyn','doc_mohamed_eldars_obgyn',
       'doc_taher_abulaban_obgyn','doc_hassan_abdelmaged_obgyn',
       'doc_ahmed_borghout_ortho','doc_mahmoud_helwa_ortho',
       'doc_ibrahim_hammad_ortho','doc_mohammed_jamaleddin_ortho'
     );
  IF group_a_total != 8 THEN
    RAISE EXCEPTION 'Migration 067 post-condition failed: expected to find 8 Group A doctor rows by id, found %', group_a_total;
  END IF;

  -- Group B: if the orphan still exists with NULL specialty_id, he
  -- must now be inactive.
  SELECT COUNT(*) INTO group_b_active
    FROM users
   WHERE role = 'doctor'
     AND id = '75334fe8-fb43-4202-ab18-3b87b8a325e2'
     AND specialty_id IS NULL
     AND COALESCE(is_active, true) = true;
  IF group_b_active != 0 THEN
    RAISE EXCEPTION 'Migration 067 post-condition failed: orphan doctor 75334fe8 still is_active=true with NULL specialty_id';
  END IF;
END $$;

COMMIT;
