'use strict';

// 27 Sep 2026 — funnel digest, founder WhatsApp alerts, /apply dedupe and the
// short booking-path signup. Hermetic: no DB, no network (fake pool + injected
// senders). Run: node --test tests/core/funnel-alerts-short-signup.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const fw = require('../../src/services/founder_whatsapp');
const fd = require('../../src/services/funnel_digest');

test('founder phones: defaults to the two personal numbers, never the Tash number', () => {
  const prev = process.env.FOUNDER_ALERT_PHONES;
  delete process.env.FOUNDER_ALERT_PHONES;
  assert.deepEqual(fw.founderPhones(), ['447383109933', '201277399043']);
  process.env.FOUNDER_ALERT_PHONES = '+20 110 200 9886, +44 7383 109933';
  assert.deepEqual(fw.founderPhones(), ['447383109933']);
  if (prev === undefined) delete process.env.FOUNDER_ALERT_PHONES; else process.env.FOUNDER_ALERT_PHONES = prev;
});

test('founder WhatsApp: injected sender reaches every number; no sender outside production sends nothing', async () => {
  const sent = [];
  const r = await fw.sendFounderWhatsApp('hello', { send: async (m) => { sent.push(m.to); return { ok: true }; } });
  assert.equal(r.sent, 2);
  assert.equal(sent.length, 2);
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const r2 = await fw.sendFounderWhatsApp('hello');
  assert.equal(r2.skipped, 'not_production');
  process.env.NODE_ENV = prevEnv;
});

test('funnel digest: formatting, bot filter, day maths, pre-09:00 skip', async () => {
  const txt = fd.formatDigest({ day: '2026-09-26', start_view: 200, start_view_meta: 180, register_view: 40, signups: 10, drafts: 5, uploaded: 4, submitted: 2, paid: 1, paid_amount: 1500 }, { signups: 12, submitted: 2, paid: 1 });
  assert.match(txt, /Landing \/start views: 200 \(Meta 180\)/);
  assert.match(txt, /Signups: 10 \(25%\)/);
  assert.match(txt, /Paid: 1 · EGP 1,500/);
  assert.match(txt, /Since launch: 12 signups/);
  assert.ok(!/Ziad/i.test(txt));
  assert.equal(fd.isBot('facebookexternalhit/1.1'), true);
  assert.equal(fd.isBot(''), true);
  assert.equal(fd.isBot('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), false);
  assert.equal(fd.previousCairoDay(new Date('2026-09-27T06:30:00Z')), '2026-09-26');
  const early = await fd.runFunnelDigest({ now: new Date('2026-09-27T04:00:00Z') }); // 07:00 Cairo
  assert.equal(early.skipped, 'before_9');
});

test('funnel wiring: migration, /start + /register bumps, 15-min digest interval', () => {
  assert.match(read('src/migrations/122_funnel_daily_counts.sql'), /CREATE TABLE IF NOT EXISTS funnel_daily_counts/);
  assert.match(read('src/routes/static-pages.js'), /bumpStartView\(req\)/);
  assert.match(read('src/routes/auth.js'), /bumpFunnelCount\('register_view', req\)/);
  assert.match(read('src/server.js'), /runFunnelDigest\(\)/);
});

test('short signup: booking-path register skips onboarding; Step 1 asks DOB + sex when missing', () => {
  const auth = read('src/routes/auth.js');
  assert.match(auth, /\/\^\\\/patient\\\/new-case\(\?:\[\/\?\]\|\$\)\/\.test\(nextAfterRegister\)/);
  assert.match(auth, /c\.isAr && ARAB_COUNTRIES\.indexOf\(String\(detectedCountry\)\.toUpperCase\(\)\) === -1/);
  const pat = read('src/routes/patient.js');
  assert.match(pat, /async function loadDemographics\(patientId\)/);
  assert.match(pat, /validateDemographics\(body, isAr\)/);
  assert.match(pat, /UPDATE users SET date_of_birth = \$1, gender = \$2 WHERE id = \$3/);
  assert.match(pat, /needsDemographics: !!\(demographics && demographics\.missing\)/);
  const view = read('src/views/patient_new_case.ejs');
  assert.match(view, /data-testid="wizard-demographics"/);
  assert.match(view, /name="date_of_birth"/);
  assert.match(view, /name="gender"/);
});

function makeApplyApp({ duplicate }) {
  const calls = [];
  const client = {
    query: async (sql) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push(s);
      if (/^SELECT id FROM doctor_applications/i.test(s)) return { rows: duplicate ? [{ id: 'old' }] : [] };
      if (/^INSERT/i.test(s)) return { rows: [{ id: 'app-1', status: 'new', source: 'web_apply', created_at: new Date() }] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = { connect: async () => client };
  const founder = [];
  const makeApplyRouter = require('../../src/routes/apply');
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => { res.locals.lang = 'en'; res.locals.tt = (k, en) => en; res.locals.csrfField = () => ''; next(); });
  app.use('/', makeApplyRouter({
    pool,
    sendMail: async () => { calls.push('SENDMAIL'); return { ok: true }; },
    sendFounderWhatsApp: async (text) => { founder.push(text); return { sent: 2, failed: 0 }; },
  }));
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}`, calls, founder };
}

async function post(base) {
  const body = new URLSearchParams({ full_name: 'Dr. Sara Ali', email: 'sara@example.com', phone: '+201001234567', specialty_id: 'spec-cardiology' });
  return fetch(`${base}/apply`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
}

test('/apply: a new application alerts the founder on WhatsApp', async () => {
  const a = makeApplyApp({ duplicate: false });
  try {
    const res = await post(a.base);
    assert.equal(res.status, 303);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(a.calls.some((c) => /^INSERT/i.test(c)));
    assert.equal(a.founder.length, 1);
    assert.match(a.founder[0], /New doctor application/);
    assert.match(a.founder[0], /Dr\. Sara Ali/);
  } finally { a.server.close(); }
});

test('/apply: a repeat within 30 days (same email/phone) inserts nothing and alerts no one', async () => {
  const a = makeApplyApp({ duplicate: true });
  try {
    const res = await post(a.base);
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location'), /\/apply\?submitted=1$/);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(!a.calls.some((c) => /^INSERT/i.test(c)));
    assert.ok(!a.calls.includes('SENDMAIL'));
    assert.equal(a.founder.length, 0);
  } finally { a.server.close(); }
});
