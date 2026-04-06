# Tashkheesa Mobile API — Integration Guide

## How to connect the API layer to your existing portal

This guide shows you exactly what to add to your existing `src/server.js`
to enable the `/api/v1/` endpoints for the patient mobile app.

**Nothing existing changes.** All portal routes, views, and middleware
continue working exactly as before.

---

## Step 1: Copy files into your project

Copy these files/folders into your `tashkheesa-portal` project:

```
tashkheesa-portal/
├── src/
│   ├── middleware/
│   │   ├── apiResponse.js          ← NEW
│   │   ├── requireJWT.js           ← NEW
│   │   └── push.js                 ← NEW
│   ├── routes/
│   │   ├── api_v1.js               ← NEW (main API router)
│   │   └── api/
│   │       ├── auth.js             ← NEW
│   │       ├── cases.js            ← NEW
│   │       ├── services.js         ← NEW
│   │       ├── conversations.js    ← NEW
│   │       ├── notifications.js    ← NEW
│   │       └── profile.js          ← NEW
│   └── migrate_mobile_api.js       ← NEW
```

## Step 2: Run the database migration

Add this to your `src/server.js` right after the existing `migrate()` call:

```javascript
// After: try { migrate(); }
// Add:
try {
  const { migrateForMobileApi } = require('./migrate_mobile_api');
  migrateForMobileApi(db);
} catch (err) {
  console.error('[migrate] Mobile API migration failed:', err.message);
}
```

## Step 3: Mount the API router

Add this to `src/server.js` AFTER all existing route mounts
but BEFORE the 404 handler:

```javascript
// ─── Mobile API ────────────────────────────────────────────
// Mounts /api/v1/* for the React Native patient app.
// Does NOT affect any existing portal routes.

const apiV1 = require('./routes/api_v1')(db, {
  safeGet: (sql, params) => {
    try { return db.prepare(sql).get(...(params || [])); }
    catch (e) { console.error('[api] safeGet error:', e.message); return null; }
  },
  safeAll: (sql, params) => {
    try { return db.prepare(sql).all(...(params || [])); }
    catch (e) { console.error('[api] safeAll error:', e.message); return []; }
  },
  safeRun: (sql, params) => {
    try { return db.prepare(sql).run(...(params || [])); }
    catch (e) { console.error('[api] safeRun error:', e.message); return null; }
  },
  // Reuse your existing Twilio sender if available
  sendOtpViaTwilio: typeof sendWhatsApp === 'function' ? sendWhatsApp : null,
  // Reuse your existing email sender if available
  sendEmail: typeof sendMail === 'function' ? sendMail : null,
});

app.use('/api/v1', apiV1);
```

**Important:** The `safeGet`, `safeAll`, `safeRun` helpers above are
thin wrappers. If your existing code already has these functions
(check your `src/db.js`), just pass those directly instead:

```javascript
const { safeGet, safeAll } = require('./db');
const apiV1 = require('./routes/api_v1')(db, { safeGet, safeAll, ... });
```

## Step 4: Set environment variable

Add `JWT_SECRET` to your `.env` file:

```
JWT_SECRET=your-secure-random-string-at-least-32-chars
```

If not set, it falls back to `SESSION_SECRET`, then a default (not safe for production).

## Step 5: Test the API

Start your server and test:

```bash
# Health check
curl http://localhost:3000/api/v1/health

# Register a test patient
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Patient","email":"test@test.com","phone":"01234567890","password":"testtest123","country":"Egypt"}'

# Login
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"testtest123"}'

# Use the returned accessToken for authenticated requests:
curl http://localhost:3000/api/v1/specialties \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"

curl http://localhost:3000/api/v1/cases \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

## Step 6: Connect the React Native app

In the React Native app, update `constants/api.ts`:

```typescript
export const API_BASE_URL = __DEV__
  ? 'http://YOUR_LOCAL_IP:3000/api/v1'  // Use your machine's IP, not localhost
  : 'https://portal.tashkheesa.com/api/v1';
```

Then:
```bash
cd tashkheesa-app
npm install
npx expo start
```

Scan the QR code with Expo Go on your phone.

---

## What's new vs what's reused

| Component | Status |
|---|---|
| User authentication (bcrypt, JWT) | **New** API layer, existing user table |
| Case submission | **New** API route, existing orders table |
| Services & pricing | **New** API route, existing services/regional_prices tables |
| Messaging | **New** API route, existing conversations/messages tables |
| Notifications | **New** API route, existing notifications table |
| Push notifications | **New** (Expo Push API) |
| File uploads | **Reused** (Uploadcare, direct from app) |
| Payment flow | **Reused** (Paymob links shown in app WebView) |
| Case lifecycle | **Reused** (untouched — same status transitions) |
| SLA watcher | **Reused** (untouched — same background job) |
| Doctor portal | **Untouched** |
| Admin portal | **Untouched** |

---

## Database changes summary

New tables:
- `otp_codes` (phone, code, expires_at)
- `order_files` (id, order_id, uploadcare_uuid, filename, mime_type, size, ai_quality_status)
- `order_timeline` (id, order_id, status, description, actor)

New columns on existing tables:
- `users`: push_token, refresh_token, reset_token, reset_token_expires
- `orders`: reference_id, clinical_question, medical_history, country, base_price, currency, sla_deadline, urgent, completed_at
- `messages`: read
- `notifications`: data, read
- `payments`: payment_link, method, paid_at

All added safely with `ALTER TABLE ... ADD COLUMN` (skips if already exists).
