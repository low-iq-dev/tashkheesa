// tests/lint/kpi-endpoints-fail-loud.test.js
//
// AUDIT-KPI-HONESTY (2026-08-29) — a money screen must never fabricate a zero.
//
// THE BUG THIS PINS. src/sql-utils.js exports safeGet/safeAll, which catch every
// SQL error, log one line, and return null/[]. Every query in the Command app's
// admin API went through them. So a failed query did not fail: the handler ran
// on, `Number(null) || 0` became 0, and the endpoint answered HTTP 200 with a
// payload of zeros. The `catch` blocks written to return 500 — one of them
// literally commented "Honest failure over fabricated zeros" — were UNREACHABLE,
// because nothing underneath them could throw.
//
// Not theoretical. src/pg.js sets statement_timeout = 30000; exceeding it raises
// SQLSTATE 57014, safeGet swallowed it, and GET /pulse answered
//   200 {"kpis":{"activeCases":0, …}}
// with the app's error state never rendering. On GET /payouts the same failure
// mode reads as "EGP 0 owed" — the founder's largest liability, reported as
// settled.
//
// THE RULE. The endpoints listed below are the money and KPI surfaces. They must
// route every query through mustGet/mustAll (the throwing pair), so the route's
// own catch runs and the app gets the 500 it already knows how to render.
// safeGet/safeAll remain correct — and remain used — for genuinely optional
// data; this lint says only that a KPI is not optional data.
//
// SOURCE-LEVEL, deliberately: the established style in tests/lint and
// tests/core, and the only way to assert "this endpoint cannot silently
// degrade" without a live database that can be made to time out on demand.
// Comments are stripped first (tests/_helpers/strip-comments) so the prose
// explaining why safeGet is banned here does not read as a call to safeGet —
// that trap has caught three tests in this repo already.

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n💸 Command money/KPI endpoints must fail loud, not fabricate zeros\n');

const ROOT = path.join(__dirname, '..', '..');
const ADMIN = path.join(ROOT, 'src', 'routes', 'api', 'admin.js');
const SQL_UTILS = path.join(ROOT, 'src', 'sql-utils.js');

function check(name, fn) {
  try { fn(); t.pass(fileTag + ': ' + name); }
  catch (e) { t.fail(fileTag + ': ' + name, e); }
}

// Split the router source into one chunk per route handler, keyed by its path.
// A handler runs from its own `router.<verb>('<path>'` to the next one.
function handlersByPath(src) {
  const re = /router\.(?:get|post|put|patch|delete)\('([^']+)'/g;
  const marks = [];
  let m;
  while ((m = re.exec(src)) !== null) marks.push({ at: m.index, path: m[1], verb: src.slice(m.index, m.index + 40) });
  const out = new Map();
  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].at : src.length;
    const body = src.slice(mark.at, end);
    // Two verbs can share a path (GET + POST /cases/:id). Concatenate, because
    // the rule below is "no soft helper anywhere in this endpoint".
    out.set(mark.path, (out.get(mark.path) || '') + body);
  });
  return out;
}

const adminSrc = stripComments(fs.readFileSync(ADMIN, 'utf8'));
const handlers = handlersByPath(adminSrc);

// The money and KPI surfaces. Every one of these answers a question about cash,
// caseload or platform state that an operator will act on.
const STRICT_ENDPOINTS = [
  '/pulse',
  '/revenue',
  '/payouts',
  '/cases',
  '/refunds',
  '/breach-cost',
  '/payment-events',
  '/manual-queue',
  '/ai-usage',
  // Added with the same fix: an empty doctor roster and an empty candidate list
  // are the same fabrication as an EGP 0 tile — indistinguishable from the real
  // "there is nobody available", and acted on the same way.
  '/doctors',
  '/cases/:id/candidates',
];

STRICT_ENDPOINTS.forEach((route) => {
  check(`${route} routes no query through safeGet/safeAll`, function () {
    const body = handlers.get(route);
    if (!body) {
      throw new Error(
        `no handler found for ${route} in src/routes/api/admin.js. If the route was renamed, ` +
        'update STRICT_ENDPOINTS here — do NOT delete the entry, or the endpoint loses its guard.'
      );
    }
    const soft = (body.match(/\bsafe(?:Get|All)\s*\(/g) || []);
    if (soft.length) {
      throw new Error(
        `${route} still makes ${soft.length} call(s) to safeGet/safeAll. Those swallow every SQL ` +
        'error and return null/[], so the handler proceeds to res.ok() and the app renders a ' +
        'fabricated zero with a 200 on it. Use mustGet/mustAll (src/sql-utils.js) so the ' +
        "route's own catch block returns the 500 it was written to return."
      );
    }
  });
});

// The strict helpers must actually be reached — a route that makes no DB call at
// all would pass the rule above vacuously.
STRICT_ENDPOINTS.forEach((route) => {
  if (route === '/ai-usage') return; // reads through services/ai_usage (queryAll, already throwing)
  check(`${route} reads through mustGet/mustAll`, function () {
    const body = handlers.get(route) || '';
    if (!/\bmust(?:Get|All)\s*\(/.test(body)) {
      throw new Error(`${route} makes no mustGet/mustAll call — it should read its data strictly.`);
    }
  });
});

// GET /cases/:id is a mixed case and is asserted separately: its money row, the
// doctor load/SLA card and the refund row are strict, while files / AI / timeline
// stay soft on purpose (an empty file list is degraded but honest; an EGP 0
// grand total is a lie).
check('/cases/:id reads its money + doctor + refund rows strictly', function () {
  const body = handlers.get('/cases/:id') || '';
  const strictCalls = (body.match(/\bmust(?:Get|All)\s*\(/g) || []).length;
  if (strictCalls < 3) {
    throw new Error(
      `GET /cases/:id makes only ${strictCalls} strict read(s); expected at least 3 (the order ` +
      'money row, the doctor load/SLA card, the refund row). A swallowed failure on the money ' +
      'row answers 404 "Case not found" for a case that exists.'
    );
  }
});

// /ai-usage does not touch sql-utils at all — it calls services/ai_usage, whose
// readers use queryAll directly and therefore already throw. Pin that, so a
// future "make it resilient" edit cannot quietly reintroduce the swallow.
check('services/ai_usage readers do not swallow SQL errors', function () {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'services', 'ai_usage.js'), 'utf8'));
  ['usageByPurpose', 'usageDailyTotals'].forEach((fn) => {
    const start = src.indexOf('async function ' + fn);
    if (start === -1) throw new Error(`${fn} not found in services/ai_usage.js`);
    const next = src.indexOf('\nasync function ', start + 1);
    const body = src.slice(start, next === -1 ? src.length : next);
    if (/\bcatch\s*\(/.test(body) || /\bsafe(?:Get|All)\s*\(/.test(body)) {
      throw new Error(
        `${fn} now catches its own SQL error (or reads through a safe* helper). GET /ai-usage ` +
        'would answer 200 with an empty ledger, which reads as "the platform spent nothing".'
      );
    }
  });
});

// And the helpers themselves must keep their contract.
check('sql-utils exports mustGet/mustAll and neither catches', function () {
  const mod = require(SQL_UTILS);
  ['mustGet', 'mustAll'].forEach((name) => {
    if (typeof mod[name] !== 'function') {
      throw new Error(`src/sql-utils.js does not export ${name}. The money endpoints depend on it.`);
    }
    if (/\bcatch\s*\(/.test(stripComments(String(mod[name])))) {
      throw new Error(
        `${name} contains a catch block. Its entire purpose is to let the error reach the route, ` +
        'which is the only thing that turns a fabricated zero into an honest 500.'
      );
    }
  });
  // The soft pair must still exist and must still swallow — other callers rely
  // on it and this lint is not an argument for removing it.
  ['safeGet', 'safeAll'].forEach((name) => {
    if (typeof mod[name] !== 'function') throw new Error(`src/sql-utils.js no longer exports ${name}.`);
    if (!/\bcatch\s*\(/.test(String(mod[name]))) {
      throw new Error(`${name} no longer catches — dozens of optional-data call sites depend on it doing so.`);
    }
  });
});

// The wiring that makes the default correct in production: server.js injects only
// the soft three, so admin.js has to fall back to the REAL strict pair, never to
// safeGet.
check('admin.js defaults mustGet/mustAll to the real throwing helpers', function () {
  if (!/mustGet\s*=\s*helpers\.mustGet\s*\|\|/.test(adminSrc)
      || !/mustAll\s*=\s*helpers\.mustAll\s*\|\|/.test(adminSrc)) {
    throw new Error('admin.js no longer resolves mustGet/mustAll with an injectable default.');
  }
  if (/mustGet\s*=\s*helpers\.mustGet\s*\|\|\s*helpers\.safeGet/.test(adminSrc)
      || /mustAll\s*=\s*helpers\.mustAll\s*\|\|\s*helpers\.safeAll/.test(adminSrc)) {
    throw new Error(
      'admin.js falls back from mustGet/mustAll to the SWALLOWING helpers. In production '
      + '(server.js passes only safeGet/safeAll/safeRun) that silently restores the exact bug '
      + 'this guard exists to prevent. Default to require("../../sql-utils") instead.'
    );
  }
  if (!/require\('\.\.\/\.\.\/sql-utils'\)/.test(adminSrc)) {
    throw new Error('admin.js no longer requires src/sql-utils.js for the strict default.');
  }
});

// ── AUTH: a database error must never read as "not authorised" ──────────────
//
// 2026-08-30. The KPI endpoints were migrated off safeGet in the morning; the
// AUTH endpoints were not, and that is where the same bug hurt most.
//
// /auth/refresh did:
//     const user = await safeGet("... WHERE refresh_token = $2 ...");
//     if (!user) return res.fail('Refresh token revoked', 401);
//
// safeGet returns null on ANY SQL error, so a statement timeout or a saturated
// pool during a token refresh was reported to the Command app as a 401 — the
// app cleared its tokens and dropped the founder at the login screen. Because
// the app refreshes whenever the access token expires, it happened again and
// again: the "constantly signing me in and out" report.
//
// A null from safeGet means "we could not tell". On every other endpoint that
// fabricates a zero; on an auth endpoint it fabricates a REJECTION, which is
// strictly worse — it destroys state the user cannot get back without signing
// in. These two handlers must use the throwing helper and answer 5xx.
check('auth endpoints never decide identity from a swallowed SQL error', function () {
  const src = stripComments(fs.readFileSync(ADMIN, 'utf8'));

  for (const route of ['/auth/login', '/auth/refresh']) {
    const start = src.indexOf("router.post('" + route + "'");
    if (start === -1) throw new Error('routes/api/admin.js no longer defines POST ' + route);
    // The handler body, up to the next route declaration.
    const next = src.indexOf('router.', start + 10);
    const body = src.slice(start, next === -1 ? src.length : next);

    if (/\bsafeGet\s*\(|\bsafeAll\s*\(/.test(body)) {
      throw new Error(
        route + ' looks up the account with safeGet/safeAll. Those return null on a '
        + 'SQL error, and this handler turns null into a 401 — so a database blip '
        + 'signs the user out (or tells them their password is wrong). Use mustGet '
        + 'and answer 5xx so the client treats it as transient.'
      );
    }
    if (!/\bmustGet\s*\(/.test(body)) {
      throw new Error(route + ' no longer uses mustGet for its account lookup.');
    }
    if (!/\b500\b/.test(body)) {
      throw new Error(
        route + ' has no 5xx path. A lookup that could not run must not be '
        + 'reported as an authentication failure.'
      );
    }
  }
});
