// tests/admin/kpi-fail-loud-behaviour.test.js
//
// AUDIT-KPI-HONESTY (2026-08-29) — the behavioural half of the fix.
//
// tests/lint/kpi-endpoints-fail-loud.test.js asserts the SHAPE of the code (no
// money endpoint reads through a swallowing helper). This file asserts the
// CONSEQUENCE: mount the real router with a strict helper that rejects the way
// a statement timeout does, and prove the response is a 500 the app can render
// an error state from — not a 200 full of zeros.
//
// The failure being simulated is the real one. src/pg.js sets
// statement_timeout = 30000; exceeding it raises SQLSTATE 57014. safeGet caught
// it, logged one line, returned null, and GET /pulse answered
//   200 {"kpis":{"activeCases":0, …}}
// On GET /payouts the same path produced "EGP 0 owed" — the founder's largest
// liability reported as settled, with no error anywhere.
//
// Written in the _testRunner style (not node:test) so the results are COUNTED by
// tests/run.js. Hermetic: no database, no network beyond a loopback port.

'use strict';

const path = require('path');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-kpi-fail-loud';
process.env.SUPERADMIN_EMAIL = process.env.SUPERADMIN_EMAIL || 'ziad.wahsh@shifaegypt.com';

const jwt = require('jsonwebtoken');
const apiResponse = require('../../src/middleware/apiResponse');
const makeAdminRouter = require('../../src/routes/api/admin');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n🚨 A failed KPI query must be a 500, never a 200 full of zeros\n');

const SUPERADMIN = {
  id: 'su-1',
  email: process.env.SUPERADMIN_EMAIL,
  role: 'superadmin',
  name: 'Ziad',
};

// The exact shape node-postgres surfaces when statement_timeout fires.
function statementTimeout() {
  const err = new Error('canceling statement due to statement timeout');
  err.code = '57014';
  return err;
}

// Every endpoint under test, with the code its own catch block returns. The
// codes are part of the contract: the app branches on them.
const CASES = [
  ['/pulse', 'PULSE_ERROR'],
  ['/refunds', 'REFUNDS_ERROR'],
  ['/revenue?scope=today', 'REVENUE_ERROR'],
  ['/cases', 'CASES_ERROR'],
  ['/cases/ord-1', 'CASE_DETAIL_ERROR'],
  ['/doctors', 'DOCTORS_ERROR'],
  ['/payment-events', 'PAYMENT_EVENTS_ERROR'],
  ['/breach-cost', 'BREACH_COST_ERROR'],
  ['/manual-queue', 'MANUAL_QUEUE_ERROR'],
  ['/payouts', 'PAYOUTS_ERROR'],
];

function makeApp(helperOverrides) {
  const helpers = Object.assign({
    safeGet: async () => null,
    safeAll: async () => [],
    safeRun: async () => ({ rowCount: 0 }),
    mustGet: async () => null,
    mustAll: async () => [],
  }, helperOverrides || {});
  const pool = { totalCount: 1, idleCount: 1, waitingCount: 0 };
  const deploy = { gitSha: 'test', startedAt: Date.now(), startedAtIso: new Date().toISOString(), version: '0', mode: 'test' };
  const notifiers = {
    ensureConversation: async () => 'c',
    queueMultiChannelNotification: async () => ({ ok: true, results: {} }),
    notifyCaseAssigned: async () => ({ ok: true }),
  };
  const app = express();
  app.use(apiResponse);
  app.use(express.json());
  app.use('/api/v1/admin', makeAdminRouter(pool, helpers, deploy, notifiers));
  const server = app.listen(0);
  return { server, base: 'http://127.0.0.1:' + server.address().port };
}

async function get(base, route) {
  const res = await fetch(base + '/api/v1/admin' + route, {
    headers: {
      Accept: 'application/json',
      Authorization: 'Bearer ' + jwt.sign(SUPERADMIN, process.env.JWT_SECRET, { expiresIn: '15m' }),
    },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function pass(name) { t.pass(fileTag + ': ' + name); }
function fail(name, msg) { t.fail(fileTag + ': ' + name, new Error(msg)); }

module.exports = (async function () {
  // ── 1. A strict-read failure surfaces as 500 on every money/KPI endpoint ──
  {
    const app = makeApp({
      mustGet: async () => { throw statementTimeout(); },
      mustAll: async () => { throw statementTimeout(); },
    });
    try {
      for (const [route, code] of CASES) {
        const name = 'GET ' + route + ' → 500 ' + code + ' when its query times out';
        let r;
        try {
          r = await get(app.base, route);
        } catch (e) {
          fail(name, 'request threw: ' + e.message);
          continue;
        }
        if (r.status === 200) {
          fail(name,
            'answered 200 with ' + JSON.stringify(r.body && r.body.data).slice(0, 160) +
            '. The query failed and the endpoint reported success — every number in that payload ' +
            'is fabricated, and the app has no way to know.');
          continue;
        }
        if (r.status !== 500) { fail(name, 'expected 500, got ' + r.status); continue; }
        const got = r.body && (r.body.code || (r.body.error && r.body.error.code));
        if (code && got && got !== code) {
          fail(name, 'expected error code ' + code + ', got ' + got);
          continue;
        }
        pass(name);
      }
    } finally { app.server.close(); }
  }

  // ── 2. The soft helpers are NOT the ones these endpoints use ─────────────
  // If a strict read were quietly swapped back to safeGet/safeAll, the throwing
  // stub below would never be reached and the endpoint would answer 200. This
  // is the runtime mirror of the source-level lint.
  {
    const app = makeApp({
      safeGet: async () => { throw new Error('a soft helper must not be reached by a KPI endpoint'); },
      safeAll: async () => { throw new Error('a soft helper must not be reached by a KPI endpoint'); },
      mustGet: async () => ({}),
      mustAll: async () => [],
    });
    try {
      for (const [route] of CASES) {
        // /cases/:id legitimately reads files / AI / timeline through the soft
        // helpers, so it is excluded from this half only.
        if (route.indexOf('/cases/ord-1') === 0) continue;
        const name = 'GET ' + route + ' reaches no soft helper at runtime';
        const r = await get(app.base, route);
        if (r.status === 200) pass(name);
        else fail(name, 'expected 200 with strict reads stubbed out, got ' + r.status +
          ' — the endpoint still routes a query through safeGet/safeAll.');
      }
    } finally { app.server.close(); }
  }

  // ── 3. A soft-read failure still degrades gracefully where that is right ──
  {
    const app = makeApp({
      safeGet: async () => null,
      safeAll: async () => [],
      mustGet: async (sql) => (/COUNT\(\*\)/i.test(sql) ? { total: 0 } : { id: 'ord-1', status: 'paid', price: 1600 }),
      mustAll: async () => [],
    });
    try {
      const name = 'GET /cases/:id still renders when only the ancillary reads are empty';
      const r = await get(app.base, '/cases/ord-1');
      if (r.status === 200 && r.body && r.body.data && r.body.data.files && r.body.data.files.length === 0) {
        pass(name);
      } else {
        fail(name, 'expected 200 with an empty file list; got ' + r.status +
          '. Files, the AI classification and the timeline are genuinely optional — making them ' +
          'strict would take a whole case detail down over a missing attachment.');
      }
    } finally { app.server.close(); }
  }
})();
