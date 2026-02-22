# PRE-LAUNCH FIXES — Everything Except Paymob & CTA

## CONTEXT
Tashkheesa launches Feb 28, 2026. The app now runs on PostgreSQL locally. These are ALL remaining issues to fix before launch. Work through them in order.

## 1. Fix .env WhatsApp bug
In `.env`, this line has TWO variables merged together:
```
WHATSAPP_API_VERSION=v22.0SLA_REMINDER_MINUTES=60
```
Split it into two separate lines:
```
WHATSAPP_API_VERSION=v22.0
SLA_REMINDER_MINUTES=60
```

## 2. Fix order status inconsistency
The orders table has mixed casing: `COMPLETED` vs `completed`, `assigned` vs `ASSIGNED`.
Normalize ALL statuses to lowercase in the database:
```sql
UPDATE orders SET status = LOWER(status);
```
Also check all code that compares status values uses lowercase consistently.

## 3. Fix Twilio API key configuration
In `.env`, the Twilio API Key and Secret are incorrectly set to the same values as the Account SID and Auth Token:
```
TWILIO_API_KEY=AC15acd4791d0d8edefd6bb42ccb4dcf6a
TWILIO_API_SECRET=37f34e1401217f809f1af048c872cbe7
```
The code that uses these needs to handle the case where proper API keys aren't configured. Check `src/routes/video.js` and any Twilio-related code — if it uses API Key for token generation, add a fallback to use Account SID + Auth Token directly, which is valid for development.

## 4. Instagram autoposter (read FIX_INSTAGRAM_AUTOPOSTER_PROMPT.md)
Read and execute the full prompt in `FIX_INSTAGRAM_AUTOPOSTER_PROMPT.md`. This creates:
- The missing `ig_scheduled_posts` table
- Campaign data with bilingual EN/AR captions (Egyptian Arabic dialect, not MSA)
- Approval workflow (pending_approval → approved → published)
- Mounts the instagram routes in server.js
- Starts the scheduler in server.js
- Fixes the superadmin instagram page

## 5. Verify email delivery works
Write a small test script `scripts/test-email.js` that sends a test email using the SMTP config in .env to verify delivery works. Run it and confirm. The script should:
- Read SMTP config from .env
- Send a test email to info@tashkheesa.com
- Log success/failure

## 6. Production environment sync
The production site on Render still runs SQLite (committed code). Do NOT push the PostgreSQL changes to production yet — that would break the live site. Instead:
- Add a comment block at the top of src/pg.js documenting what's needed to deploy PG to production:
  - Render PostgreSQL add-on
  - Set DATABASE_URL and PG_SSL env vars
  - Run migration script
  - Remove old SQLite disk

## FILES TO MODIFY
- `.env` (fixes #1, #3)
- `src/db.js` (fix #4 — ig_scheduled_posts table)
- `src/server.js` (fix #4 — mount routes, start scheduler)
- `src/instagram/scheduler.js` (fix #4 — change status filter to 'approved')
- `src/routes/superadmin.js` (fix #4 — fix instagram routes)
- `src/routes/video.js` (fix #3 — Twilio fallback)
- `src/pg.js` (fix #6 — add production deployment notes)
- New: `scripts/instagram-campaign-data.js` (fix #4)
- New: `scripts/instagram-publish-campaign.js` (fix #4)
- New: `scripts/test-email.js` (fix #5)

## DO NOT
- Touch payment/Paymob code
- Change Coming Soon / CTA buttons
- Modify patient-portal.css or doctor-portal.css
- Push PostgreSQL changes to production/Render
- Delete any test data or orders
- Hide or modify specialties
