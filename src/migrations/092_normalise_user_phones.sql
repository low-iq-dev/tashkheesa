-- 083_normalise_user_phones.sql
-- AUDIT 2026-08-25 — portal accounts and app accounts were splitting in two.
--
-- Reported as "an order I placed on the portal should show up in the app". The
-- app's case list was never at fault — it filters on patient_id and folds status
-- case correctly. The break was IDENTITY: the OTP sign-in looked up
-- `WHERE phone = <normalised E.164>` and, on no match, created a brand-new
-- account. Any row whose stored phone did not normalise byte-identically
-- produced a second, empty account, and the patient saw none of their orders.
--
-- Production held four unmatchable spellings on 2026-08-25:
--   '1277399043'      the founder's own mobile. The context-free validator read
--                     it as +1 (US); his real account was '+201277399043'.
--                     Two accounts for one person, 18 orders on one, 1 on the other.
--   '01098729248'     the ordinary way an Egyptian writes their number —
--                     REJECTED outright, so OTP sign-in was impossible.
--   '0 110 200 9886'  spaces.
--   '+2001149055838'  a '+20' dial code glued onto a local '01149…' without
--                     dropping the national trunk '0'.
--
-- The durable fix is in code: src/validators/phone_identity.js normalises with
-- COUNTRY context, and findUserByPhone resolves an existing account across all
-- legacy spellings before anything considers creating a new one. This migration
-- only repairs the rows that had already split.
--
-- The 2026-08-25 repair was applied directly to production; these statements are
-- idempotent so a rebuilt database reaches the same state.

-- 1. Egyptian local forms -> E.164. Scoped to rows whose country is Egypt,
--    because a bare national number cannot be interpreted without knowing the
--    country — guessing is precisely what produced the '+1' account above.
UPDATE users
   SET phone = '+20' || regexp_replace(regexp_replace(phone, '[^0-9]', '', 'g'), '^0+', '')
 WHERE phone IS NOT NULL
   AND phone !~ '^\+[1-9][0-9]{7,14}$'
   AND UPPER(COALESCE(country, country_code, '')) IN ('EG', 'EGYPT')
   AND length(regexp_replace(regexp_replace(phone, '[^0-9]', '', 'g'), '^0+', '')) = 10
   -- Never create a collision: the users(phone) partial unique index would
   -- reject it, and two rows sharing a number are not necessarily the same
   -- person (production has two distinct TEST accounts on '01000000000').
   AND NOT EXISTS (
     SELECT 1 FROM users x
      WHERE x.phone = '+20' || regexp_replace(regexp_replace(users.phone, '[^0-9]', '', 'g'), '^0+', '')
   );

-- 2. Repair '<dial><0><subscriber>' — a dial code concatenated onto a local
--    number without dropping the trunk digit. Egypt only, and only where the
--    result is the right length, so a real subscriber number beginning with 0
--    is never eaten.
UPDATE users
   SET phone = '+20' || substring(regexp_replace(phone, '[^0-9]', '', 'g') from 4)
 WHERE phone IS NOT NULL
   AND regexp_replace(phone, '[^0-9]', '', 'g') ~ '^200[0-9]{10}$'
   AND NOT EXISTS (
     SELECT 1 FROM users x
      WHERE x.phone = '+20' || substring(regexp_replace(users.phone, '[^0-9]', '', 'g') from 4)
   );

-- Rows deliberately left alone: any remaining non-E.164 phone either has no
-- country to interpret it with, or would collide with a different account.
-- findUserByPhone's suffix match still resolves those at sign-in, so nobody is
-- locked out — see src/validators/phone_identity.js.
