'use strict';

// Public /apply route — hermetic (factory + injected fake pool/client + mailer
// stub; no real DB, no network beyond the throwaway loopback server). Mirrors
// the harness in tests/admin/admin_command_api.test.js.
//
// Proves: invalid → 400 (no DB hit); honeypot → success with NO insert + NO
// email; valid + a mailer that THROWS → still success AND the insert is
// committed (post-commit best-effort email never rolls back).
//
// Run: node --test tests/integration/apply_route.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');

const makeApplyRouter = require('../../src/routes/apply');

function makeApp(over = {}) {
  const calls = [];
  const client = {
    query: async (sql) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push(s);
      if (/^INSERT/i.test(s)) {
        return { rows: [{ id: 'app-uuid-1', status: 'new', source: 'web_apply', created_at: new Date('2026-06-24T10:00:00Z') }] };
      }
      return { rows: [] };
    },
    release() { calls.push('RELEASE'); },
  };
  const pool = { connect: async () => { calls.push('CONNECT'); return client; } };
  const sendMail = over.sendMail || (async () => { calls.push('SENDMAIL'); return { ok: true }; });

  const lang = over.lang || 'en';
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  // Locals the real app installs via global middleware (middleware.js / csrf.js).
  app.use((req, res, next) => {
    res.locals.lang = lang;
    res.locals.dir = lang === 'ar' ? 'rtl' : 'ltr';
    res.locals.isAr = lang === 'ar';
    res.locals.tt = (k, en, ar) => (lang === 'ar' ? (ar || en) : en);
    res.locals.csrfField = () => '<input type="hidden" name="_csrf" value="test">';
    res.locals.cspNonce = '';
    res.locals.currentUrl = req.originalUrl;
    next();
  });
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', '..', 'src', 'views'));
  app.use('/', makeApplyRouter({ pool, sendMail }));

  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}`, calls };
}

function form(over) {
  const p = new URLSearchParams();
  const merged = Object.assign(
    { full_name: 'Dr. Sara Ali', email: 'sara@example.com', phone: '+201001234567', specialty_id: 'spec-cardiology' },
    over || {}
  );
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => p.append(k, String(x)));
    else p.append(k, String(v));
  }
  return p;
}

async function postApply(app, body) {
  return fetch(`${app.base}/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

// ─────────────────────────── GET render ───────────────────────────

test('GET /apply → 200 and renders the form (no auth gate)', async () => {
  const app = makeApp();
  try {
    const res = await fetch(`${app.base}/apply`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /name="full_name"/, 'renders the application form');
    assert.match(html, /spec-cardiology/, 'renders taxonomy specialty options');
  } finally { app.server.close(); }
});

test('GET /apply in Arabic → Arabic <title> + localized sub-specialty aria-label', async () => {
  const app = makeApp({ lang: 'ar' });
  try {
    const res = await fetch(`${app.base}/apply`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /قدّم للانضمام لتشخيصة/, 'Arabic page title is rendered');
    assert.match(html, /data-add-label="أضف تخصص فرعي"/, 'localized add-label for the JS chip input');
  } finally { app.server.close(); }
});

// ─────────────────────────── invalid → 400 ───────────────────────────

test('POST /apply invalid (missing required) → 400 with per-field errors, NO DB hit', async () => {
  const app = makeApp();
  try {
    const res = await postApply(app, form({ full_name: '', email: 'bad', phone: '', specialty_id: '' }));
    assert.equal(res.status, 400);
    assert.ok(!app.calls.includes('CONNECT'), 'must not touch the DB on invalid input');
    const html = await res.text();
    assert.match(html, /name="full_name"/, 're-renders the form for inline correction');
  } finally { app.server.close(); }
});

// ─────────────────────────── honeypot ───────────────────────────

test('POST /apply with the honeypot filled → success, NO insert, NO email', async () => {
  const app = makeApp();
  try {
    const res = await postApply(app, form({ website: 'http://spam.example' }));
    assert.equal(res.status, 200, 'followed 303 → success page');
    assert.match(res.url, /submitted=1/, 'redirected to the success state');
    assert.ok(!app.calls.includes('CONNECT'), 'no DB connection');
    assert.ok(!app.calls.some((s) => /^INSERT/i.test(s)), 'no insert');
    assert.ok(!app.calls.includes('SENDMAIL'), 'no email');
  } finally { app.server.close(); }
});

// ─────────────────────────── valid + mailer throws ───────────────────────────

test('POST /apply valid + mailer THROWS → still success AND the insert is committed (best-effort email)', async () => {
  const app = makeApp({ sendMail: async () => { app.calls.push('SENDMAIL_THREW'); throw new Error('resend down'); } });
  try {
    const res = await postApply(app, form({ sub_specialties: ['Interventional Cardiology', 'Underwater Basket Weaving'] }));
    assert.equal(res.status, 200, 'mailer failure must NOT fail the request');
    assert.match(res.url, /submitted=1/, 'redirected to success despite mailer throw');
    assert.ok(app.calls.includes('CONNECT'), 'acquired a client');
    assert.ok(app.calls.some((s) => /^INSERT INTO doctor_applications/i.test(s)), 'inserted the application');
    assert.ok(app.calls.includes('COMMIT'), 'committed the insert');
    assert.ok(!app.calls.includes('ROLLBACK'), 'mailer throw must NOT roll back the committed insert');
    assert.ok(app.calls.includes('RELEASE'), 'released the client');
    assert.ok(app.calls.includes('SENDMAIL_THREW'), 'mailer was attempted post-commit');
  } finally { app.server.close(); }
});

// ─────────────────────────── valid + mailer ok ───────────────────────────

test('POST /apply valid → inserts, commits, then sends exactly one notification email', async () => {
  const app = makeApp();
  try {
    const res = await postApply(app, form());
    assert.equal(res.status, 200);
    assert.match(res.url, /submitted=1/);
    assert.ok(app.calls.includes('COMMIT'), 'committed');
    const commitIdx = app.calls.indexOf('COMMIT');
    const mailIdx = app.calls.indexOf('SENDMAIL');
    assert.ok(mailIdx > commitIdx, 'email is sent AFTER commit (post-commit)');
    assert.equal(app.calls.filter((s) => s === 'SENDMAIL').length, 1, 'exactly one email');
  } finally { app.server.close(); }
});
