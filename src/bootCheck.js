// src/bootCheck.js
const fs = require('fs');
const path = require('path');

function assert(condition, message) {
  if (!condition) {
    console.error('\n⛔ BOOT CHECK FAILED');
    console.error('➡', message, '\n');
    process.exit(1);
  }
}

// AUDIT-2026-08-22 (AUDIT-BOOT-MIGRATION-1) — STAGED assert.
//
// WHY THIS EXISTS: a NEW hard `assert` on a variable that does not exist yet is
// not a safety check, it is a scheduled outage. Both callers below (
// NATIONAL_ID_ENCRYPTION_KEY and the OPENCLAW_* pair) are `sync: false` in
// render.yaml, i.e. an operator has to type them into the Render dashboard
// before they exist. Merging this branch deploys the check BEFORE the operator
// can possibly have set them: boot fails, Render crash-loops, and the previous
// (working) deploy is already gone. There is no code path out — every retry
// runs the same check.
//
// So these two land as a LOUD WARNING for one deploy cycle. Once the variables
// are set on Render (verify from the deploy log: no `⚠️  BOOT CHECK WARNING`
// lines), set STRICT_ENV_ASSERTS=true — the same message then exits 1 exactly
// as an assert would, and a later regression cannot ship silently.
//
// The checks themselves are unchanged and CORRECT; only their severity is
// staged. Nothing else in this file uses softAssert — the pre-existing asserts
// guard variables that are already set in production and stay fatal.
function strictEnvAsserts() {
  var v = String(process.env.STRICT_ENV_ASSERTS || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function softAssert(condition, message) {
  if (condition) return true;
  if (strictEnvAsserts()) {
    assert(false, message + ' [STRICT_ENV_ASSERTS=true — fatal]');
    return false;
  }
  console.error('\n⚠️  BOOT CHECK WARNING (would be fatal with STRICT_ENV_ASSERTS=true)');
  console.error('➡', message);
  console.error('➡ Booting anyway so the deploy can complete. Set this variable on ' +
    'Render, redeploy, confirm this warning is gone, then set STRICT_ENV_ASSERTS=true ' +
    'to make it fatal.\n');
  return false;
}

function bootCheck({ ROOT, MODE }) {
  console.log('🔒 Running boot checks...');

  // 1. Environment sanity (fail-fast in staging/production; flexible in development)
  const resolvedMode = (MODE || process.env.MODE || process.env.NODE_ENV || 'development').toString().trim();
  const mode = resolvedMode;

  assert(mode, 'MODE environment variable is missing');
  assert(
    ['development', 'staging', 'production'].includes(mode),
    `Invalid MODE value: ${mode}`
  );

  // Normalize MODE so downstream code can rely on it.
  process.env.MODE = mode;

  // SLA_MODE: default to passive in development; required in staging/production.
  let slaMode = String(process.env.SLA_MODE || '').trim();
  if (!slaMode) {
    if (mode === 'development') {
      slaMode = 'passive';
      process.env.SLA_MODE = slaMode;
      console.warn('⚠️  SLA_MODE missing — defaulting to passive (development only)');
    } else {
      assert(false, 'Missing required environment variable: SLA_MODE');
    }
  }
  assert(
    ['passive', 'primary'].includes(slaMode),
    `Invalid SLA_MODE value: ${slaMode} (expected: passive | primary)`
  );

  // Guardrail: prevent accidental primary mode anywhere.
  // Primary requires an explicit runtime token.
  if (slaMode === 'primary') {
    const primaryToken = String(process.env.SLA_PRIMARY_TOKEN || '').trim();

    assert(
      primaryToken === 'YES_I_UNDERSTAND',
      'SLA_MODE=primary requires SLA_PRIMARY_TOKEN=YES_I_UNDERSTAND to proceed.'
    );
  }

  // Guardrail: prevent accidental SLA_MODE=primary in development.
  // Allow it only if explicitly acknowledged.
  if (mode === 'development' && slaMode === 'primary') {
    const allowPrimary = String(process.env.ALLOW_PRIMARY_IN_DEV || '')
      .trim()
      .toLowerCase();

    assert(
      allowPrimary === '1' || allowPrimary === 'true' || allowPrimary === 'yes',
      'SLA_MODE=primary in development is blocked by default. Set ALLOW_PRIMARY_IN_DEV=true to proceed.'
    );

    console.warn('⚠️  ALLOW_PRIMARY_IN_DEV enabled — running SLA_MODE=primary in development (token acknowledged)');
  }

  // Basic auth credentials: required for staging/production.
  //
  // AUDIT-2026-08-22 (AUDIT-ENV-ALIAS-1) — this used to read ONLY
  // BASIC_AUTH_USER / BASIC_AUTH_PASS, but src/server.js:243-244 builds CONFIG
  // from `BASIC_AUTH_USER || STAGING_USER` and `BASIC_AUTH_PASS || STAGING_PASS`.
  // The aliases are LIVE — an operator who set only STAGING_USER/STAGING_PASS
  // got a fully-configured CONFIG and then exited 1 here for a variable the app
  // did not actually need. Resolve the same way server.js does.
  if (mode !== 'development') {
    const user = String(process.env.BASIC_AUTH_USER || process.env.STAGING_USER || '').trim();
    const pass = String(process.env.BASIC_AUTH_PASS || process.env.STAGING_PASS || '').trim();

    assert(user, 'Missing required environment variable: BASIC_AUTH_USER (or its alias STAGING_USER)');
    assert(pass, 'Missing required environment variable: BASIC_AUTH_PASS (or its alias STAGING_PASS)');

    // Guardrail: prevent default/demo creds in production.
    if (mode === 'production') {
      assert(
        !(user === 'demo' && pass === 'demo123'),
        'BASIC_AUTH_USER/BASIC_AUTH_PASS (or STAGING_USER/STAGING_PASS) are still set to demo defaults — set real secrets for production'
      );
    }
  }

  // ── AUDIT-2026-08-22 (AUDIT-ENV-BOOT-1) ────────────────────────────────────
  // Boot-required-but-unvalidated variables. The canonical `prodRequired` list
  // lives in src/server.js's validateCriticalEnvVars(); these two were in
  // NEITHER list, so the app booted green and then failed at the first real use
  // — the worst possible place to discover a missing secret.
  if (mode !== 'development') {
    // NATIONAL_ID_ENCRYPTION_KEY — src/services/national-id.js:23-25 throws
    // 'NATIONAL_ID_ENCRYPTION_KEY env var is not set' on the FIRST doctor-signup
    // national-ID write and on every admin national-ID review. Doctor onboarding
    // is a day-one flow, so an unset key is a launch-blocking failure that
    // currently surfaces as a 500 on a doctor's signup form.
    // AUDIT-2026-08-22 (AUDIT-BOOT-MIGRATION-1) — softAssert, not assert. See the
    // softAssert header: this variable is `sync: false` in render.yaml and does
    // not exist on the service until an operator sets it, so a hard assert here
    // crash-loops the FIRST deploy that carries it.
    const nationalIdKey = String(process.env.NATIONAL_ID_ENCRYPTION_KEY || '').trim();
    softAssert(
      nationalIdKey,
      'Missing required environment variable: NATIONAL_ID_ENCRYPTION_KEY. ' +
        'pgcrypto pgp_sym_encrypt key for users.national_id_encrypted. Without it, ' +
        'doctor signup throws on the national-ID write and admin national-ID review ' +
        'is dead. Generate with: openssl rand -base64 48. Rotating it later requires ' +
        're-encrypting every existing row in one transaction — set it before launch.'
    );

    // OPENCLAW_* — src/lib/openclaw_client.js:60-71 returns
    // { ok:false, error:'oc_env_misconfigured' } for EVERY send when either is
    // unset. Nothing throws and nothing exits; WhatsApp simply never arrives.
    // Only enforced when WhatsApp is actually switched on with the openclaw
    // transport and not stubbed — matching src/notify/whatsapp.js's own gates,
    // so turning WhatsApp off stays a supported configuration.
    const waEnabled = String(process.env.NOTIFICATIONS_WHATSAPP_ENABLED || '').trim().toLowerCase() === 'true';
    const waTransport = String(process.env.NOTIFICATIONS_WHATSAPP_TRANSPORT || 'openclaw').trim().toLowerCase();
    const waStub = String(process.env.WHATSAPP_TEST_STUB || '').trim().toLowerCase() === 'true';

    if (waEnabled && waTransport === 'openclaw' && !waStub) {
      const ocBase = String(process.env.OPENCLAW_BASE_URL || '').trim();
      const ocKey = String(process.env.OPENCLAW_SEND_KEY || '').trim();
      // AUDIT-2026-08-22 (AUDIT-BOOT-MIGRATION-1) — softAssert, not assert.
      // Both OPENCLAW_* vars are `sync: false` in render.yaml. Same staging
      // rationale as NATIONAL_ID_ENCRYPTION_KEY above.
      softAssert(
        ocBase && ocKey,
        'NOTIFICATIONS_WHATSAPP_ENABLED=true with NOTIFICATIONS_WHATSAPP_TRANSPORT=openclaw ' +
          'requires BOTH OPENCLAW_BASE_URL and OPENCLAW_SEND_KEY' +
          (ocBase ? '' : ' — OPENCLAW_BASE_URL is missing') +
          (ocKey ? '' : ' — OPENCLAW_SEND_KEY is missing') +
          '. Without them every send returns oc_env_misconfigured and ZERO WhatsApp is ' +
          'delivered, silently, while the in-app bell keeps filling. Set them, or set ' +
          'NOTIFICATIONS_WHATSAPP_ENABLED=false to ship deliberately without WhatsApp.'
      );
    } else if (!waEnabled) {
      console.warn('⚠️  NOTIFICATIONS_WHATSAPP_ENABLED is not "true" — NO WhatsApp will be sent ' +
        'in ' + mode + '. In-app notifications and email are unaffected.');
    } else if (waStub) {
      console.warn('⚠️  WHATSAPP_TEST_STUB=true — WhatsApp sends are short-circuited and NOTHING ' +
        'reaches a real phone. This must not be set in production.');
    }
  }

  // P1-C FIX: App uses PostgreSQL (not SQLite). Validate DATABASE_URL instead of SQLite file.
  const dbUrl = String(process.env.DATABASE_URL || '').trim();
  const dbPath = dbUrl ? '(PostgreSQL via DATABASE_URL)' : null;

  if (!dbUrl) {
    if (mode === 'development') {
      console.warn('⚠️  DATABASE_URL missing — app will fail to connect to PostgreSQL (dev warning)');
    } else {
      assert(false, 'Missing required environment variable: DATABASE_URL');
    }
  }

  console.log(
    `🔧 MODE=${mode} SLA_MODE=${slaMode}` +
      (dbPath ? ` DB=${dbPath}` : '') +
      // AUDIT-2026-08-22 (AUDIT-BOOT-MIGRATION-1) — make the staging state
      // greppable. `off` means the two softAssert checks above can only warn.
      ` STRICT_ENV_ASSERTS=${strictEnvAsserts() ? 'on' : 'off'}`
  );

  // 2. Project structure
  assert(fs.existsSync(ROOT), 'Project root does not exist');
  assert(fs.existsSync(path.join(ROOT, 'src')), 'src/ directory missing');
  assert(fs.existsSync(path.join(ROOT, 'src/server.js')), 'server.js missing');

  // 3. Critical views must exist
  const viewsDir = path.join(ROOT, 'src/views');
  assert(fs.existsSync(viewsDir), 'views directory missing');

  const requiredViews = [
    'portal_doctor_dashboard.ejs',
    'portal_doctor_case.ejs',
    'login.ejs'
  ];

  requiredViews.forEach((view) => {
    const fullPath = path.join(viewsDir, view);
    assert(fs.existsSync(fullPath), `Missing required view: ${view}`);
  });

  // 4. Public assets (warn in dev; fail in staging/production)
  const publicDir = path.join(ROOT, 'public');
  const requiredPublic = ['styles.css', 'favicon.ico', 'site.webmanifest'];
  const missingPublic = requiredPublic.filter((f) => !fs.existsSync(path.join(publicDir, f)));

  if (missingPublic.length) {
    const msg = `Missing public assets: ${missingPublic.join(', ')}`;
    if (mode === 'development') {
      console.warn(`⚠️  ${msg} (dev warning)`);
    } else {
      assert(false, msg);
    }
  }

  console.log('✅ Boot checks passed\n');
}

module.exports = { bootCheck };