'use strict';
// tests/core/app-funnel-analytics.test.js
//
// App funnel 2026-09-23 — PostHog case funnel (case_draft_started →
// case_submitted → case_paid, split web/app) and app install attribution.
//
// Same three rules as user_signed_up (tests/core/analytics-signup-tracking):
// it cannot break the flow it observes, it cannot leak PII, and it counts the
// right thing. Here "the flow" includes PAYMENT, so the source pins in §4 hold
// the capture to post-commit, un-awaited, try-wrapped call sites.

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const tag = 'app-funnel-analytics';
console.log('\n📊 App funnel — PostHog case funnel + install attribution\n');

const ROOT = path.join(__dirname, '..', '..');
const ANALYTICS = path.join(ROOT, 'src', 'services', 'analytics.js');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
function assert(cond, label, detail) {
  if (cond) t.pass(tag + ': ' + label);
  else t.fail(tag + ': ' + label, new Error(detail || 'assertion failed'));
}

// A fake posthog-node, so the ENABLED path runs without a network.
const calls = { capture: [] };
function loadWithFakeClient() {
  const phPath = require.resolve('posthog-node', { paths: [path.dirname(ANALYTICS)] });
  const saved = require.cache[phPath];
  require.cache[phPath] = {
    id: phPath, filename: phPath, loaded: true,
    exports: { PostHog: function () { return { capture: function (m) { calls.capture.push(m); }, on: function () {} }; } }
  };
  const savedTok = process.env.POSTHOG_PROJECT_TOKEN;
  process.env.POSTHOG_PROJECT_TOKEN = 'phc_test';
  delete require.cache[require.resolve(ANALYTICS)];
  const a = require(ANALYTICS);
  a.analyticsStatus(); // construct the client now, while the fake is in place
  if (saved) require.cache[phPath] = saved; else delete require.cache[phPath];
  if (savedTok === undefined) delete process.env.POSTHOG_PROJECT_TOKEN; else process.env.POSTHOG_PROJECT_TOKEN = savedTok;
  delete require.cache[require.resolve(ANALYTICS)];
  return a;
}

// ── 1. Disabled: every entry point is a silent no-op ───────────────────
{
  const saved = process.env.POSTHOG_PROJECT_TOKEN;
  delete process.env.POSTHOG_PROJECT_TOKEN;
  delete require.cache[require.resolve(ANALYTICS)];
  const a = require(ANALYTICS);
  let threw = null;
  try {
    a.captureFunnel('case_paid', { userId: 'u1', platform: 'web', amountEgp: 1600 });
    a.captureFunnel('case_submitted');
    a.captureFunnel();
    a.captureAppAttribution();
    a.captureAppAttribution({ userId: 'u1', utm: { utm_source: 'x' } });
  } catch (e) { threw = e; }
  assert(!threw, 'funnel + attribution never throw when PostHog is disabled', threw && threw.message);
  if (saved !== undefined) process.env.POSTHOG_PROJECT_TOKEN = saved;
  delete require.cache[require.resolve(ANALYTICS)];
}

// ── 2. The allow-list: funnel props in, PII out ────────────────────────
{
  const a = require(ANALYTICS);
  const out = a._sanitizeProps({
    platform: 'app', tier: 'vip', country: 'EG', amount_egp: 1600,
    utm_source: 'meta', utm_campaign: 'c'.repeat(150),
    // What a hurried caller might spread in from an order or user row:
    name: 'Ahmed', email: 'a@example.com', phone: '+201001234567',
    specialty_id: 'oncology', specialty_slug: 'oncology', service_id: 'x',
    clinical_question: 'lump, 3 weeks', medical_history: 'x', notes: 'x',
    diagnosis_text: 'x', reference_id: 'TSH-2026-000001', price: 1600, patient_id: 'u'
  });
  const keys = Object.keys(out).sort();
  assert(JSON.stringify(keys) === JSON.stringify(['amount_egp', 'country', 'platform', 'tier', 'utm_campaign', 'utm_source']),
    'sanitizeProps keeps only allow-listed funnel keys', 'got ' + JSON.stringify(keys));
  assert(out.utm_campaign.length === 100, 'utm_* values are capped at 100 chars');
  const FORBIDDEN = /name|email|phone|nationa|passw|birth|dob|address|note|medical|diagnos|specialty|clinical|question|history|reference|patient/i;
  const bad = [...a._ALLOWED_PROPS].filter((k) => FORBIDDEN.test(k));
  assert(bad.length === 0, 'allow-list holds no identifier/clinical-shaped key (specialty deliberately excluded)',
    'suspicious: ' + bad.join(', '));
  assert(a._FUNNEL_EVENTS.size === 3 && a._FUNNEL_EVENTS.has('case_draft_started') &&
    a._FUNNEL_EVENTS.has('case_submitted') && a._FUNNEL_EVENTS.has('case_paid'), 'exactly the three funnel events');

  assert(a.platformFromOrderSource('patient_app_v1') === 'app', "source patient_app_v1 → 'app'");
  assert(a.platformFromOrderSource('patient_wizard_v2') === 'web', "source patient_wizard_v2 → 'web'");
  assert(a.platformFromOrderSource('website_portal') === 'unknown' && a.platformFromOrderSource(null) === 'unknown',
    "ambiguous/absent source → 'unknown'");

  const u = a._sanitizeUtm({ utm_source: '  meta\u0000 ', utm_medium: 5, utm_term: '', evil: 'x', utm_content: 'y'.repeat(300) });
  assert(JSON.stringify(Object.keys(u).sort()) === JSON.stringify(['utm_content', 'utm_source']) &&
    u.utm_source === 'meta' && u.utm_content.length === 100,
    'sanitizeUtm keeps only non-empty utm_* strings, strips control chars, caps at 100');
  delete require.cache[require.resolve(ANALYTICS)];
}

// ── 3. Enabled: what is actually sent ──────────────────────────────────
{
  const a = loadWithFakeClient();
  calls.capture.length = 0;
  a.captureFunnel('case_paid', { userId: 'user-1', platform: 'APP', tier: 'fast_track', country: 'eg', amountEgp: 1599.6 });
  a.captureFunnel('case_submitted', { userId: 'user-1', platform: 'desktop', tier: 'weird', country: 'Egypt', amountEgp: 99 });
  a.captureFunnel('case_draft_started', { userId: '', platform: 'web' });   // no id → dropped
  a.captureFunnel('user_deleted', { userId: 'user-1', platform: 'web' });    // not a funnel event → dropped
  assert(calls.capture.length === 2, 'only valid funnel events with an id are sent', 'sent ' + calls.capture.length);
  const [paid, sub] = calls.capture;
  assert(paid && paid.distinctId === 'user-1' && paid.event === 'case_paid', 'distinctId is the user id');
  assert(paid && JSON.stringify(paid.properties) === JSON.stringify({ platform: 'app', tier: 'vip', country: 'EG', amount_egp: 1600 }),
    'case_paid props normalised (platform/tier/country) and amount rounded', JSON.stringify(paid && paid.properties));
  assert(sub && JSON.stringify(sub.properties) === JSON.stringify({ platform: 'unknown' }),
    "bad platform → 'unknown'; bad tier/country dropped; amount only on case_paid", JSON.stringify(sub && sub.properties));

  calls.capture.length = 0;
  a._resetAttributionMemo();
  const first = a.captureAppAttribution({ userId: 'user-2', utm: { utm_source: 'google-play', utm_medium: 'organic', email: 'x@y.z' } });
  const again = a.captureAppAttribution({ userId: 'user-2', utm: { utm_source: 'other' } });
  assert(first === true && again === false && calls.capture.length === 1, 'attribution is captured once per user (repeats ignored)');
  const ev = calls.capture[0];
  assert(ev && ev.event === 'app_attributed' && ev.properties.utm_source === 'google-play' && !('email' in ev.properties),
    'app_attributed carries allow-listed utm_* only');
  assert(ev && ev.properties.$set_once && ev.properties.$set_once.first_utm_source === 'google-play' &&
    ev.properties.$set_once.first_utm_medium === 'organic' && Object.keys(ev.properties.$set_once).length === 2,
    'first-touch person props are set with $set_once (first_utm_*)');

}

// ── 4. Call sites: post-commit, never awaited, try-wrapped ─────────────
{
  const SITES = [
    ['src/routes/api/cases_draft.js', ["'case_draft_started'", "'case_submitted'"], 'app'],
    ['src/routes/api/cases.js', ["'case_submitted'"], 'app'],
    ['src/routes/patient.js', ["'case_draft_started'", "'case_submitted'"], 'web'],
  ];
  for (const [rel, events, platform] of SITES) {
    const src = read(rel);
    assert(!/await\s+captureFunnel\s*\(/.test(src), rel + ': captureFunnel is never awaited');
    for (const ev of events) {
      const at = src.indexOf("captureFunnel(" + ev);
      assert(at !== -1, rel + ' captures ' + ev);
      const before = src.slice(Math.max(0, at - 40), at);
      assert(/try\s*\{\s*$/.test(before), rel + ': ' + ev + ' capture sits directly inside its own try');
      assert(src.slice(at, at + 300).indexOf("platform: '" + platform + "'") !== -1,
        rel + ': ' + ev + " is tagged platform '" + platform + "'");
    }
  }
  // The draft-started capture is on the INSERT branch only (not the resume UPDATE).
  const draft = read('src/routes/api/cases_draft.js');
  assert(draft.indexOf("captureFunnel('case_draft_started'") > draft.indexOf('INSERT INTO orders'),
    'API draft_started fires after the INSERT, not on the reuse branch');
  // Submit capture only after the conditional UPDATE matched a row.
  assert(draft.indexOf("captureFunnel('case_submitted'") > draft.indexOf('result.rowCount === 0'),
    'API submit capture comes after the rowCount guard (double-submit counted once)');

  const web = read('src/routes/patient.js');
  const submitAt = web.indexOf("captureFunnel('case_submitted'");
  const catchAt = web.lastIndexOf("err=submit_failed", submitAt);
  assert(catchAt !== -1 && catchAt < submitAt, 'web submit capture comes after the submit_failed catch');

  // case_paid: one place — markCasePaid, after the transaction commits.
  const lc = read('src/case_lifecycle.js');
  const mcp = lc.slice(lc.indexOf('async function markCasePaid(caseId) {'));
  const body = mcp.slice(0, mcp.search(/\nasync function /));
  const end = body.indexOf('}); // end withTransaction');
  const cap = body.indexOf("captureFunnel('case_paid'");
  assert(end !== -1 && cap > end, 'case_paid is captured AFTER withTransaction resolves (post-commit)');
  assert(/paidTransitionApplied = true;\s*\n\s*return await getCase\(caseId, client\);/.test(body),
    'the flag is set only on the path that actually transitioned to PAID (not the idempotent return)');
  assert(/if \(paidTransitionApplied && result\) \{\s*\n\s*try \{/.test(body), 'case_paid capture is gated and try-wrapped');
  assert(!/await\s+[\w.]*captureFunnel/.test(body), 'case_paid capture is not awaited');
  const others = ['src/routes/payments.js', 'src/routes/patient.js', 'src/routes/api/cases.js']
    .filter((rel) => read(rel).indexOf("'case_paid'") !== -1);
  assert(others.length === 0, 'case_paid is captured in exactly one place', 'also in: ' + others.join(', '));

  const profile = read('src/routes/api/profile.js');
  assert(/router\.post\('\/attribution'/.test(profile), 'POST /api/v1/profile/attribution exists');
  assert(/captureAppAttribution\(/.test(profile) && !/await\s+captureAppAttribution/.test(profile),
    'attribution capture is not awaited');
  const attr = profile.slice(profile.indexOf("router.post('/attribution'"), profile.indexOf("router.post('/attribution'") + 600);
  assert(!/safeRun|safeGet|execute\(|INSERT|UPDATE/.test(attr), 'attribution route writes nothing to the database');
}
