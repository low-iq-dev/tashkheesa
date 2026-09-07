'use strict';
// tests/core/analytics-signup-tracking.test.js
//
// PostHog `user_signed_up`. Three properties are worth holding, and none of
// them is "the event fires" — that is the easy part.
//
//   1. It cannot break a registration. Analytics sits in the request path of
//      the single most valuable action on the platform.
//   2. It cannot leak PII. This is a medical platform; the vendor gets an
//      opaque id, a method and a role, and nothing else — ever.
//   3. It counts SIGNUPS, not sign-ins. Two of the five paths are shared with
//      login and use ON CONFLICT DO NOTHING, so "the branch ran" is not the
//      same as "an account was created". Only RETURNING can tell them apart.
//
// (3) is the one that would rot silently: with the guard removed the numbers
// stay plausible, just wrong, and nobody notices until a funnel is built on
// them months later.

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const tag = 'analytics-signup';

console.log('\n📈 PostHog signup tracking\n');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
function assert(cond, label, detail) {
  if (cond) t.pass(tag + ': ' + label);
  else t.fail(tag + ': ' + label, new Error(detail || 'assertion failed'));
}

// ── 1. The module is safe with analytics switched OFF ──────────────────
// This is how local, CI and this very suite run, so it must be the quiet path.
{
  const saved = process.env.POSTHOG_PROJECT_TOKEN;
  delete process.env.POSTHOG_PROJECT_TOKEN;
  delete require.cache[require.resolve(path.join(ROOT, 'src/services/analytics.js'))];
  const a = require(path.join(ROOT, 'src/services/analytics.js'));

  let threw = null;
  try {
    a.captureSignup({ userId: 'u1', signupMethod: 'password_web', role: 'patient', surface: 'web' });
    a.captureSignup({});                       // no id at all
    a.captureSignup({ userId: null });         // null id
    a.captureSignup();                         // no argument
  } catch (e) { threw = e; }
  assert(!threw, 'captureSignup never throws when PostHog is disabled', threw && threw.message);
  assert(a.analyticsStatus().enabled === false, 'analyticsStatus reports disabled with no token');

  if (saved === undefined) delete process.env.POSTHOG_PROJECT_TOKEN;
  else process.env.POSTHOG_PROJECT_TOKEN = saved;
}

// ── 2. No PII can leave, even if a caller hands over a whole row ───────
{
  delete require.cache[require.resolve(path.join(ROOT, 'src/services/analytics.js'))];
  const a = require(path.join(ROOT, 'src/services/analytics.js'));
  const out = a._sanitizeProps({
    signup_method: 'password_web',
    role: 'patient',
    surface: 'web',
    // Everything below is what a tired caller might spread in by accident.
    name: 'Ahmed Hassan',
    email: 'ahmed@example.com',
    phone: '+201001234567',
    national_id_encrypted: 'x',
    password_hash: 'y',
    date_of_birth: '1990-01-01',
    specialty_id: 'spec-cardiology',
    signup_notes: 'chest pain, 3 weeks'
  });
  const keys = Object.keys(out).sort();
  assert(
    JSON.stringify(keys) === JSON.stringify(['role', 'signup_method', 'surface']),
    'sanitizeProps keeps ONLY the allow-listed properties',
    'got: ' + JSON.stringify(keys)
  );
  for (const leak of ['name', 'email', 'phone', 'national_id_encrypted', 'password_hash', 'date_of_birth', 'signup_notes']) {
    assert(!(leak in out), 'sanitizeProps drops ' + leak);
  }
  // An object value is a caller handing over a nested row.
  const nested = a._sanitizeProps({ role: { id: 1 }, signup_method: 'ok' });
  assert(!('role' in nested), 'sanitizeProps drops object values');

  // The allow-list itself must never grow to hold an identifier.
  const FORBIDDEN = /name|email|phone|nationa|passw|birth|dob|address|note|medical|diagnos|specialty/i;
  const bad = [...a._ALLOWED_PROPS].filter((k) => FORBIDDEN.test(k));
  assert(bad.length === 0, 'the property allow-list contains no identifier-shaped key', 'suspicious: ' + bad.join(', '));
}

// ── 3. Every signup route is wired, and the shared ones are GUARDED ────
// Source-text, because the thing being protected is a conditional that no unit
// test can reach without a live Postgres and a real OTP.
{
  const authWeb = read('src/routes/auth.js');
  const authApi = read('src/routes/api/auth.js');
  const intake  = read('src/routes/api/cases_intake.js');

  const EXPECTED = [
    ['src/routes/auth.js',             authWeb, 'password_web'],
    ['src/routes/auth.js',             authWeb, 'otp_web'],
    ['src/routes/auth.js',             authWeb, 'doctor_signup_web'],
    ['src/routes/api/auth.js',         authApi, 'password_mobile'],
    ['src/routes/api/auth.js',         authApi, 'otp_mobile'],
    ['src/routes/api/cases_intake.js', intake,  'case_intake'],
  ];
  for (const [file, src, method] of EXPECTED) {
    assert(src.indexOf("'" + method + "'") !== -1, file + ' captures ' + method);
  }

  // THE important one. Both OTP inserts are reached on every OTP verify —
  // including a returning patient's — and both use ON CONFLICT DO NOTHING.
  // Without RETURNING there is nothing to branch on, and every OTP LOGIN would
  // be recorded as a signup.
  for (const [label, src] of [['web', authWeb], ['mobile', authApi]]) {
    const re = /INSERT INTO users[\s\S]{0,400}?ON CONFLICT \(phone\)[\s\S]{0,120}?DO NOTHING\s*\n?\s*RETURNING id/;
    assert(re.test(src),
      label + ' OTP insert uses ON CONFLICT … DO NOTHING RETURNING id',
      'Without RETURNING the route cannot tell a new account from a returning ' +
      'patient, and every OTP sign-in is counted as a signup.');
    assert(/created\s*&&\s*created\.rows\s*&&\s*created\.rows\.length/.test(src),
      label + ' OTP capture is gated on a row actually being returned');
  }

  // Intake commits by hand, so the capture must sit after COMMIT and behind
  // the same flag the ON CONFLICT check sets.
  const afterCommit = intake.slice(intake.indexOf("client.query('COMMIT')"));
  assert(afterCommit.indexOf('captureSignup') !== -1,
    'case_intake captures AFTER COMMIT, not before');
  assert(/if \(accountCreated\)/.test(intake),
    'case_intake capture is gated on this request having created the account');

  // The doctor path must fire after withTransaction resolves, never inside it.
  const txStart = authWeb.indexOf('await withTransaction(async (client) => {');
  const docCapture = authWeb.indexOf("signupMethod: 'doctor_signup_web'");
  assert(txStart !== -1 && docCapture > txStart, 'doctor signup capture appears after the transaction block');
  const txBody = authWeb.slice(txStart, docCapture);
  const closes = (txBody.match(/\}\);/g) || []).length;
  assert(closes > 0, 'doctor signup capture is outside the transaction callback');
}

// ── 4. Nothing counts a LOGIN or a failed registration ─────────────────
{
  const authWeb = read('src/routes/auth.js');
  const authApi = read('src/routes/api/auth.js');
  // A capture must never appear inside a handler that only authenticates.
  // Cheap proxy: no capture may sit within 400 chars after a password check.
  for (const [label, src] of [['web', authWeb], ['mobile', authApi]]) {
    let bad = false;
    const re = /(check\(|bcrypt\.compare\()/g;
    let m;
    while ((m = re.exec(src))) {
      if (src.slice(m.index, m.index + 400).indexOf('captureSignup') !== -1) bad = true;
    }
    assert(!bad, label + ': no captureSignup near a password comparison (that would count logins)');
  }
}

// ── 5. Shutdown flushes ────────────────────────────────────────────────
{
  const server = read('src/server.js');
  const gs = server.slice(server.indexOf('function gracefulShutdown'));
  assert(gs.indexOf('shutdownAnalytics') !== -1, 'gracefulShutdown flushes PostHog');
  assert(/await analyticsFlushed/.test(gs), 'the flush is awaited before the process exits');
  assert(/Promise\.race/.test(gs),
    'the flush is capped by a race — a hung vendor socket must not push shutdown ' +
    'into the 10s force-exit path');
}

// ── 6. The dependency is declared compatibly ───────────────────────────
{
  const pj = JSON.parse(read('package.json'));
  const range = pj.dependencies['posthog-node'];
  assert(!!range, 'posthog-node is a declared dependency');
  // posthog-node 5.x requires Node >=20/22; this repo declares >=18. Pinning to
  // 4.x keeps `npm ci` honest on whatever Node Render gives us.
  assert(/^\^?4\./.test(String(range)),
    'posthog-node is pinned to 4.x, which satisfies this repo\'s engines: ' + JSON.stringify(pj.engines),
    'got ' + range + ' — 5.x needs Node >=20 and package.json says >=18');
  const lock = JSON.parse(read('package-lock.json'));
  assert(!!lock.packages['node_modules/posthog-node'], 'posthog-node is in package-lock.json (npm ci would fail otherwise)');
}

// ── 7. `role` is always present, because the report filters on it ──────
// The signup report shows patients only — it is a `role = 'patient'` filter in
// PostHog, not a narrower capture. Doctors are still captured on purpose so the
// two can be compared. That arrangement has exactly one failure mode: an event
// that carries no role at all silently disappears from the filtered number
// instead of showing up as something wrong. So role must never be optional.
{
  const analytics = read('src/services/analytics.js');
  assert(/role \|\| ''/.test(analytics) && /'unknown'/.test(analytics),
    'captureSignup falls back to an explicit role rather than omitting the property',
    'a missing role would drop the event out of the patients-only report');
  assert(analytics.indexOf('role: safeRole') !== -1,
    'the sanitized role — not the raw argument — is what gets sent');

  // Every call site names a role explicitly. A site that forgot would still
  // emit 'unknown' rather than nothing, but it would be wrong in the report,
  // and the fallback exists for the impossible case, not as the normal path.
  const sites = [
    ['src/routes/auth.js', 3],
    ['src/routes/api/auth.js', 2],
    ['src/routes/api/cases_intake.js', 1],
  ];
  for (const [rel, expected] of sites) {
    const src = read(rel);
    const calls = src.split('captureSignup(').length - 1 - (src.indexOf('require(') !== -1 ? 1 : 0);
    const withRole = (src.match(/captureSignup\(\{[\s\S]{0,300}?role:/g) || []).length;
    assert(withRole === expected,
      rel + ': all ' + expected + ' capture sites pass an explicit role',
      'found ' + withRole + ' of ' + expected + ' (calls seen: ' + calls + ')');
  }

  // Patients and doctors both get captured — the split is made in the report,
  // not here. If someone "fixes" this by dropping doctors, the doctor funnel
  // becomes unrecoverable, because the events were never sent.
  const web = read('src/routes/auth.js');
  assert(/role: 'doctor'/.test(web),
    'doctor signups are still captured (the patients-only view is a report filter, not a capture filter)');
}
