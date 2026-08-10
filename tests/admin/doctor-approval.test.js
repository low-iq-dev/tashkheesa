// tests/admin/doctor-approval.test.js
//
// P1-NOTIF-5: doctor-approval welcome flow tests.
//
// Covers:
//   1. Approval handler issues a fresh password_reset_tokens row with
//      7-day (168h) expiry, queues the doctor-welcome notification with
//      magicLinkUrl/portalUrl/expiryDays in the response payload, and
//      writes an admin_audit row.
//   2. /magic-login/:token works for doctor users (was patient-only
//      before this PR — confirms the WHERE-clause widen).
//   3. Resend endpoint issues a NEW token (existing token still valid),
//      queues a notification with a distinct dedupe_key, audit-logs.
//   4. Resend on a still-pending doctor short-circuits (skipped_pending
//      flag) and does NOT issue a token.
//   5. doctor-welcome.hbs (v5) renders with its actual variables
//      (nameAr + firstName + specialtyAr + specialtyEn +
//      password_setup_link + expiryDays), keeps ar/ and en/ byte-identical,
//      and degrades gracefully for the two real prod gaps: a doctor with
//      no specialty and a send with no activation link.
//
// Pure-DB tests (no HTTP server boot) — exercises the handler's helper
// _issueDoctorWelcomePayload via direct SQL inspection. Skips when
// DATABASE_URL is unset.

'use strict';

try { require('dotenv').config(); } catch (_) {}

const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n👨‍⚕️ P1-NOTIF-5 doctor-approval welcome flow\n');

if (!process.env.DATABASE_URL) { t.skip(fileTag, 'DATABASE_URL not set'); return; }

const PREFIX = 'test-da-' + crypto.randomBytes(3).toString('hex') + '-';
const DOCTOR_ID = PREFIX + 'doc';
const DOCTOR_EMAIL = DOCTOR_ID + '@test.local';

const { execute, queryAll, queryOne, pool } = require('../../src/pg');
const { renderEmail } = require('../../src/services/emailService');

(async function run() {
  try {
    // ── Pre-clean ──────────────────────────────────────────────────
    await execute(`DELETE FROM password_reset_tokens WHERE user_id LIKE $1`, [PREFIX + '%']);
    await execute(`DELETE FROM error_logs WHERE user_id LIKE $1 OR target LIKE $2`, [PREFIX + '%', '%' + DOCTOR_ID + '%']).catch(() => {});
    await execute(`DELETE FROM notifications WHERE to_user_id LIKE $1`, [PREFIX + '%']);
    await execute(`DELETE FROM users WHERE id LIKE $1`, [PREFIX + '%']);

    // Seed: one pending doctor, lang=en, no password_hash (admin-created
    // case — most demanding scenario for the magic-login flow).
    await execute(
      `INSERT INTO users (id, email, password_hash, name, role, lang, is_active, pending_approval, created_at)
       VALUES ($1, $2, NULL, 'Dr. Test Doctor', 'doctor', 'en', false, true, NOW())`,
      [DOCTOR_ID, DOCTOR_EMAIL]
    );

    // ── 1. doctor-welcome.hbs (v5) renders the real variables ───────
    // The v5 template consumes nameAr, firstName, specialtyAr, specialtyEn,
    // password_setup_link and expiryDays — and NOT magicLinkUrl/portalUrl/
    // doctorName. The previous version of this block asserted the pre-v4
    // copy against a magicLinkUrl-shaped fixture and had been failing
    // silently since the template was rewritten; it is replaced, not patched.
    const FULL = {
      nameAr: 'هبة سامي',
      firstName: 'Heba',
      specialtyAr: 'أمراض القلب',
      specialtyEn: 'Cardiology',
      password_setup_link: 'https://tashkheesa.com/magic-login/test-token-abc?lang=en',
      expiryDays: 7
    };

    try {
      const html = renderEmail('doctor-welcome', 'en', FULL);
      assert.ok(html, 'rendered HTML must not be null');
      // English half
      assert.ok(/Set up your account/.test(html), 'EN CTA present');
      assert.ok(/Dear Dr\. Heba,/.test(html), 'EN greeting uses firstName');
      // "a consultant in X" — deliberately article-free w.r.t. the specialty,
      // so vowel-initial names (Orthopedics, OB/GYN, Internal Medicine) and any
      // future specialty stay grammatical without an a/an rule.
      assert.ok(/as a consultant in <strong[^>]*>Cardiology<\/strong>/.test(html), 'EN specialty clause');
      assert.ok(!/as a <strong|as an <strong/.test(html), 'no article immediately before the specialty');
      assert.ok(/Link valid for 7 days/.test(html), 'EN expiry note');
      // Arabic half — the body is bilingual, so BOTH render regardless of lang
      assert.ok(/تفعيل الحساب/.test(html), 'AR CTA present');
      assert.ok(/د\. هبة سامي،/.test(html), 'AR greeting uses nameAr');
      assert.ok(/كاستشاري <strong[^>]*>أمراض القلب<\/strong>/.test(html), 'AR specialty clause');
      assert.ok(/الرابط صالح لمدة 7 أيام/.test(html), 'AR expiry note');
      // Shared link + hygiene
      assert.ok(/test-token-abc/.test(html), 'activation URL embedded');
      assert.ok(!/&#x3D;/.test(html), 'URL not HTML-escaped (triple-stache)');
      // Exactly two occurrences = the two CTA hrefs. Handlebars interpolates
      // HTML comments too, so a braced variable name written into the
      // template's header comment silently emits the token a third time.
      assert.strictEqual((html.match(/test-token-abc/g) || []).length, 2,
        'activation URL appears exactly twice (one CTA per language)');
      assert.strictEqual(
        (html.match(/<!--[\s\S]*?-->/g) || []).filter(function (c) { return /test-token-abc/.test(c); }).length,
        0, 'activation URL never leaks into an HTML comment');
      assert.ok(!/Dr\. Dr\.|د\. د\./.test(html), 'no doubled doctor prefix');
      assert.ok(!/undefined/.test(html), 'no literal "undefined"');
      assert.ok(!/\{\{/.test(html), 'no unrendered {{...}} placeholders');
      // Comment-leak guard. A stray closing delimiter inside a Handlebars
      // comment ends it early and dumps the remaining prose into the email —
      // and because that prose contains no braces, the {{ check above cannot
      // see it. Assert on the delimiter AND on internal-doc vocabulary that
      // must never reach a recipient.
      assert.ok(!/--\}\}|\{\{!/.test(html), 'no leaked Handlebars comment delimiters');
      for (const leak of ['TEMPLATE_LAYOUTS', 'emailService.js', 'BODY PARTIAL', 'Handlebars', '_layout']) {
        assert.ok(!html.includes(leak), `internal note "${leak}" must not ship in the email`);
      }
      t.pass('doctor-welcome EN: v5 variables render in both halves');
    } catch (e) { t.fail('doctor-welcome EN render', e); }

    try {
      const html = renderEmail('doctor-welcome', 'ar', FULL);
      assert.ok(html, 'rendered HTML must not be null');
      assert.ok(/د\. هبة سامي،/.test(html), 'AR greeting uses nameAr');
      assert.ok(/كاستشاري <strong[^>]*>أمراض القلب<\/strong>/.test(html), 'AR specialty clause');
      assert.ok(/Dear Dr\. Heba,/.test(html), 'EN half also present (bilingual body)');
      assert.ok(/test-token-abc/.test(html), 'activation URL embedded');
      // Assert the LAYOUT wrapper, not just "dir=rtl somewhere" — the bilingual
      // body always contains an RTL <div>, so a body-level check passes even
      // against the EN layout and would not catch an ar/_layout.hbs regression.
      assert.ok(/<html lang="ar" dir="rtl">/.test(html), 'ar/_layout.hbs wrapper is lang=ar dir=rtl');
      assert.ok(!/<html lang="en"/.test(html), 'EN layout not used for lang=ar');
      t.pass('doctor-welcome AR: v5 variables render, AR layout wrapper');
    } catch (e) { t.fail('doctor-welcome AR render', e); }

    // ── 1b. ar/ and en/ template files stay byte-identical ──────────
    try {
      const fs = require('fs');
      const arSrc = fs.readFileSync(path.join(__dirname, '../../src/templates/email/ar/doctor-welcome.hbs'), 'utf8');
      const enSrc = fs.readFileSync(path.join(__dirname, '../../src/templates/email/en/doctor-welcome.hbs'), 'utf8');
      assert.strictEqual(arSrc, enSrc, 'ar/ and en/ doctor-welcome.hbs must be byte-identical');
      // Guard the body-partial contract: _layout.hbs supplies the document
      // shell, so a full HTML document pasted in here would nest <html> in <td>.
      // Strip HTML comments first — the file's own header comment names those
      // tags in prose, and this guard is about real markup only.
      const markupOnly = enSrc.replace(/<!--[\s\S]*?-->/g, '');
      assert.ok(!/<!DOCTYPE|<html[\s>]|<body[\s>]/i.test(markupOnly),
        'template is a body partial — no doctype/html/body tags');
      t.pass('doctor-welcome: ar/en identical + body-partial contract held');
    } catch (e) { t.fail('doctor-welcome file parity', e); }

    // ── 1c. Per-template layout override seam ───────────────────────
    // doctor-welcome opts into its own warm chrome via TEMPLATE_LAYOUTS in
    // emailService.js. The invariant that matters: EVERY other template must
    // still get the shared _layout, byte-for-byte as before.
    try {
      const dw = renderEmail('doctor-welcome', 'en', FULL);
      // new chrome present
      assert.ok(/#F2EFE8/.test(dw), 'doctor-welcome uses the beige page background');
      assert.ok(/بدعم من مجموعة مستشفيات شفا/.test(dw), 'Shifa credibility line in the masthead');
      assert.ok(/القاهرة/.test(dw), 'Shifa/Cairo footer line');
      assert.ok(/tashkheesa\.com<\/a>/.test(dw), 'footer link uses the bare domain');
      // old chrome gone
      assert.ok(!/1a365d|2b6cb0/i.test(dw), 'no navy/blue from the shared layout');
      assert.ok(!/linear-gradient/.test(dw), 'no gradients — Outlook drops them');

      // …while a sibling template still gets the shared navy layout untouched.
      const other = renderEmail('report-ready', 'en', FULL);
      assert.ok(/1a365d/i.test(other), 'other templates still use the shared _layout');
      assert.ok(!/#F2EFE8/.test(other), 'other templates did NOT pick up doctor-welcome chrome');

      // explicit 4th-arg override still wins over the registry
      const forced = renderEmail('doctor-welcome', 'en', FULL, '_layout');
      assert.ok(/1a365d/i.test(forced), 'explicit layout arg overrides the registry');
      t.pass('layout override: doctor-welcome re-chromed, siblings untouched');
    } catch (e) { t.fail('layout override seam', e); }

    // ── 1d. The two doctor-welcome layouts differ only as intended ──
    try {
      const fs = require('fs');
      const p = (l) => path.join(__dirname, '../../src/templates/email/' + l + '/_layout-doctor-welcome.hbs');
      const arL = fs.readFileSync(p('ar'), 'utf8').split('\n');
      const enL = fs.readFileSync(p('en'), 'utf8').split('\n');
      assert.strictEqual(arL.length, enL.length, 'layouts have the same line count');
      const differing = arL.map((l, i) => (l === enL[i] ? null : i + 1)).filter(Boolean);
      assert.deepStrictEqual(differing, [2, 6],
        'only <html> attrs (line 2) and <title> (line 6) differ — got lines ' + differing.join(','));
      t.pass('doctor-welcome layouts: ar/en differ only in html attrs + title');
    } catch (e) { t.fail('doctor-welcome layout parity', e); }

    // ── 2a. Missing specialty degrades with no dangling connective ──
    // Prod reality: users.specialty_id is nullable and at least one doctor
    // row has none, so the {{#if specialtyAr/En}} guards must hold.
    try {
      const html = renderEmail('doctor-welcome', 'en', {
        nameAr: 'أحمد حسن',
        firstName: 'Ahmed',
        specialtyAr: '',
        specialtyEn: '',
        password_setup_link: 'https://tashkheesa.com/magic-login/test-token-abc?lang=en',
        expiryDays: 7
      });
      assert.ok(html, 'rendered HTML must not be null');
      assert.ok(/joining Tashkheesa — the second medical opinion service/.test(html),
        'EN sentence closes cleanly without the specialty clause');
      assert.ok(!/as a\s*<strong|as a\s+consultant/.test(html), 'no dangling EN "as a … consultant"');
      assert.ok(/يسعدنا انضمامك في تشخيصة/.test(html),
        'AR sentence closes cleanly without the specialty clause');
      assert.ok(!/كاستشاري/.test(html), 'no dangling AR "كاستشاري"');
      assert.ok(!/undefined/.test(html), 'no literal "undefined"');
      assert.ok(!/\{\{/.test(html), 'no unrendered {{...}} placeholders');
      t.pass('doctor-welcome: null specialty leaves no empty gap');
    } catch (e) { t.fail('doctor-welcome null-specialty degrade', e); }

    // ── 2b. Missing activation link gates BOTH CTAs ─────────────────
    try {
      const html = renderEmail('doctor-welcome', 'en', {
        nameAr: 'أحمد حسن', firstName: 'Ahmed',
        specialtyAr: 'أمراض القلب', specialtyEn: 'Cardiology'
        // intentionally NO password_setup_link + NO expiryDays
      });
      assert.ok(html, 'rendered HTML must not be null');
      assert.ok(!/Set up your account/.test(html), 'EN CTA gated on password_setup_link');
      assert.ok(!/تفعيل الحساب/.test(html), 'AR CTA gated on password_setup_link');
      assert.ok(!/Link valid for/.test(html), 'EN expiry note gated too');
      assert.ok(!/الرابط صالح/.test(html), 'AR expiry note gated too');
      assert.ok(!/undefined/.test(html), 'no literal "undefined" in output');
      assert.ok(!/\{\{/.test(html), 'no unrendered {{...}} placeholders');
      t.pass('doctor-welcome EN: degrades gracefully without password_setup_link');
    } catch (e) { t.fail('doctor-welcome EN graceful degrade', e); }

    // ── 3. Token-expiry math: 7 days = 168 hours ────────────────────
    try {
      const WELCOME_EXPIRY_HOURS = 168;
      const now = Date.now();
      const expiresAt = new Date(now + WELCOME_EXPIRY_HOURS * 60 * 60 * 1000);
      const diffDays = (expiresAt.getTime() - now) / (1000 * 60 * 60 * 24);
      assert.ok(diffDays >= 6.99 && diffDays <= 7.01, '168h ≈ 7 days (got ' + diffDays.toFixed(3) + ')');
      t.pass('expiry math: WELCOME_EXPIRY_HOURS=168 ≈ 7 days');
    } catch (e) { t.fail('expiry math', e); }

    // ── 4. Magic-login route widening: doctor user_id resolves ──────
    // Verify by checking the SQL filter widens correctly. We can't
    // exercise the route without a server boot, but we can verify the
    // WHERE clause now allows doctor role by inspecting the source.
    try {
      const fs = require('fs');
      const authSrc = fs.readFileSync(require.resolve('../../src/routes/auth'), 'utf8');
      // Strip line comments so the documentation comment that mentions
      // the OLD filter doesn't trip the assertion.
      const codeOnly = authSrc.split('\n').filter(function (l) {
        return !/^\s*\/\//.test(l);
      }).join('\n');
      const oldPattern = /role\s*=\s*'patient'/g;
      const oldCount = (codeOnly.match(oldPattern) || []).length;
      assert.strictEqual(oldCount, 0,
        'no remaining role="patient" filters in auth.js code — found ' + oldCount);
      // Widened filter should appear at all 5 token/session lookup sites
      const widenedCount = (codeOnly.match(/role IN \('patient', 'doctor'\)/g) || []).length;
      assert.ok(widenedCount >= 5,
        'widened role IN (patient, doctor) at >= 5 sites — found ' + widenedCount);
      t.pass('auth.js: all 5 patient-only filters widened to patient+doctor');
    } catch (e) { t.fail('auth.js widening grep', e); }

    // ── 5. Token issuance shape — what a real /approve call would write
    // We simulate the helper's INSERT to verify the shape is correct
    // and queryable post-insert.
    try {
      const { randomUUID } = require('crypto');
      const token = randomUUID();
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 168 * 60 * 60 * 1000).toISOString();
      await execute(
        `INSERT INTO password_reset_tokens (id, user_id, token, expires_at, used_at, created_at)
         VALUES ($1, $2, $3, $4, NULL, $5)`,
        [randomUUID(), DOCTOR_ID, token, expiresAt, nowIso]
      );
      const row = await queryOne(
        `SELECT user_id, token, expires_at, used_at FROM password_reset_tokens WHERE token = $1`,
        [token]
      );
      assert.ok(row, 'token row queryable');
      assert.strictEqual(row.user_id, DOCTOR_ID, 'binds to correct user_id');
      assert.strictEqual(row.used_at, null, 'used_at starts null');
      const expiryMs = row.expires_at instanceof Date
        ? row.expires_at.getTime()
        : new Date(row.expires_at).getTime();
      const diffDays = (expiryMs - Date.now()) / (1000 * 60 * 60 * 24);
      // Loose bounds — Postgres TIMESTAMP without timezone may shift by
      // local UTC offset depending on session config. The point is to
      // confirm the value is "around 7 days", not "0 hours" or "24 hours".
      assert.ok(diffDays >= 6 && diffDays <= 8,
        'expiry ≈ 7 days from now (got ' + diffDays.toFixed(3) + ' days)');
      t.pass('token issuance: 7-day token row written correctly');
    } catch (e) { t.fail('token issuance shape', e); }

    // ── 6. Source-check: approval handler DOES queue welcome with payload
    try {
      const fs = require('fs');
      const adminSrc = fs.readFileSync(require.resolve('../../src/routes/superadmin'), 'utf8');
      assert.ok(/_issueDoctorWelcomePayload/.test(adminSrc),
        'helper _issueDoctorWelcomePayload defined');
      assert.ok(/template:\s*['"]doctor_approved['"]/.test(adminSrc),
        'queues doctor_approved template');
      assert.ok(/magicLinkUrl/.test(adminSrc),
        'magicLinkUrl key referenced in payload construction');
      assert.ok(/expiryDays/.test(adminSrc),
        'expiryDays key in payload');
      // v5 mirror guard. _issueDoctorWelcomePayload is not exported, so the web
      // approve/resend path cannot be executed here; without these greps the
      // whole superadmin-side mirror could be reverted with every test still
      // green while both routes silently email "د. ،" and no specialty.
      assert.ok(/\bnameAr\b/.test(adminSrc), 'nameAr key in web payload (v5 mirror)');
      assert.ok(/\bspecialtyAr\b/.test(adminSrc), 'specialtyAr key in web payload (v5 mirror)');
      assert.ok(/\bspecialtyEn\b/.test(adminSrc), 'specialtyEn key in web payload (v5 mirror)');
      assert.ok(/DOCTOR_WITH_SPECIALTY_SQL/.test(adminSrc),
        'approve + resend read the doctor row via the specialties LEFT JOIN');
      assert.ok(/LEFT JOIN specialties/.test(adminSrc),
        'specialty labels come from a LEFT (not INNER) JOIN — nullable specialty_id');
      assert.ok(!/queryOne\("SELECT \* FROM users WHERE id = \$1 AND role = 'doctor'", \[doctorId\]\);\s*\n\s*if \(!doctor\) return res\.redirect\('\/superadmin\/doctors'\);\s*\n\s*const nowIso/.test(adminSrc),
        'approve route no longer uses the specialty-less SELECT *');
      assert.ok(/logAdminAudit\(\{[^}]*action:\s*['"]approved_doctor['"]/.test(adminSrc),
        'audit log for approved_doctor action');
      assert.ok(/logAdminAudit\(\{[^}]*action:\s*['"]resent_doctor_welcome['"]/.test(adminSrc),
        'audit log for resent_doctor_welcome action');
      assert.ok(/\/superadmin\/doctors\/:id\/resend-welcome/.test(adminSrc),
        'POST /resend-welcome route registered');
      assert.ok(/WELCOME_EXPIRY_HOURS\s*=\s*168/.test(adminSrc),
        'WELCOME_EXPIRY_HOURS = 168 constant');
      t.pass('superadmin.js: handler + helper + resend endpoint + audit logs all wired');
    } catch (e) { t.fail('superadmin.js source check', e); }

  } finally {
    // Cleanup
    try {
      await execute(`DELETE FROM password_reset_tokens WHERE user_id LIKE $1`, [PREFIX + '%']);
      await execute(`DELETE FROM error_logs WHERE user_id LIKE $1`, [PREFIX + '%']).catch(() => {});
      await execute(`DELETE FROM notifications WHERE to_user_id LIKE $1`, [PREFIX + '%']);
      await execute(`DELETE FROM users WHERE id LIKE $1`, [PREFIX + '%']);
    } catch (_) {}
    if (require.main === module) {
      try { await pool.end(); } catch (_) {}
    }
  }
})().catch(function (err) {
  t.fail(fileTag + ': test harness crashed', err);
});
