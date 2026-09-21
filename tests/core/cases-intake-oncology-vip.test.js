// tests/core/cases-intake-oncology-vip.test.js
//
// A7/S1 follow-up, decided by Ziad 2026-09-21: there is no 24-hour tier and
// never was. slaConfigForTestType gave every oncology intake a live
// sla_type 'priority_24h' / sla_hours 24 — a fourth tier outside
// Standard 48h / VIP 18h / Urgent 4h. The comment's intent was "tighter than
// standard", and the real tier that means that is VIP: 18 hours, written with
// the canonical tier value the rest of the codebase uses ('vip'), not a new
// string. The non-oncology branch keeps the stored-enum name 'standard_72h'
// (which really returns 48h) — renaming stored enum values touches historical
// rows, needs a migration, and is Batch B ledger work.
//
// What this file pins, driving the REAL POST /intake handler (plucked off
// router.stack, fake pg client, hermetic — no DATABASE_URL):
//   (1) an oncology intake writes orders.sla_hours = 18 and
//       cases.sla_type = 'vip', the cases.sla_deadline it derives is 18 hours
//       out, and 'priority_24h' appears nowhere in what is written;
//   (2) a non-oncology intake (ct_mri) still writes 48 / 'standard_72h' —
//       the retained legacy enum value, unchanged until the Batch B rename.

'use strict';

const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n🧪 cases_intake — oncology is the real VIP tier (18h), not a 24h fourth tier\n');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const R = (p) => require.resolve(path.join(SRC, p));
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// Exported promise: the runner awaits it (2026-08-16 serialisation), so the
// require.cache fakes below are restored before the next test file loads.
module.exports = (async function run() {
  const DB = R('db.js');
  const LOGGER = R('logger.js');
  const EMAIL = R('services/emailService.js');
  const ANALYTICS = R('services/analytics.js');
  const INTAKE = R('routes/api/cases_intake.js');
  const swapped = [DB, LOGGER, EMAIL, ANALYTICS, INTAKE];
  const saved = {};
  for (const p of swapped) saved[p] = require.cache[p];
  const restore = () => { for (const p of swapped) { if (saved[p]) require.cache[p] = saved[p]; else delete require.cache[p]; } };
  const fakeModule = (p, exports) => { require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

  // Recording fake pg client — answers exactly the existing-patient path:
  // BEGIN → SELECT user → enrichment UPDATE → orders INSERT → CREATE SEQUENCE
  // → nextval → cases INSERT → COMMIT.
  const rec = { queries: [] };
  const client = {
    query: async (sql, params) => {
      const s = norm(sql);
      rec.queries.push({ sql: s, params: params || [] });
      if (/^SELECT id FROM users WHERE LOWER\(email\)/.test(s)) return { rows: [{ id: 'user-1' }] };
      if (/^SELECT nextval/.test(s)) return { rows: [{ n: 7 }] };
      return { rows: [], rowCount: 1 };
    },
    release: function () {},
  };
  fakeModule(DB, { pool: { connect: async () => client } });
  fakeModule(LOGGER, { logErrorToDb: function () {} });
  fakeModule(EMAIL, { notifyCaseReceived: async function () {} });
  fakeModule(ANALYTICS, { captureSignup: function () {} });

  let handler = null;
  try {
    delete require.cache[INTAKE];
    const router = require(INTAKE);
    const layer = router.stack.find((l) => l.route && l.route.path === '/intake' && l.route.methods.post);
    handler = layer ? layer.route.stack[layer.route.stack.length - 1].handle : null;
    if (!handler) throw new Error('POST /intake not on router.stack');
    t.pass('(0) POST /intake handler plucked off router.stack');
  } catch (e) {
    t.fail('(0) POST /intake handler plucked off router.stack', e);
    restore();
    return;
  }

  async function intake(test_type) {
    rec.queries = [];
    let status = 200, body = null;
    const req = {
      body: { full_name: 'Test Lead', email: 'lead@example.com', test_type: test_type },
      originalUrl: '/api/cases/intake',
      method: 'POST',
    };
    const res = {
      status: function (c) { status = c; return this; },
      json: function (b) { body = b; return this; },
    };
    await handler(req, res);
    return {
      status: status,
      body: body,
      orders: rec.queries.find((q) => /^INSERT INTO orders/.test(q.sql)),
      cases: rec.queries.find((q) => /^INSERT INTO cases/.test(q.sql)),
      queries: rec.queries.slice(),
    };
  }

  try {
    // ═══ (1) oncology → the real VIP tier ════════════════════════════════
    await (async function oncology() {
      const r = await intake('oncology');
      const why = (function () {
        if (r.status !== 200 || !r.body || r.body.success !== true) {
          return 'intake did not succeed: status ' + r.status + ' body ' + JSON.stringify(r.body);
        }
        if (!r.orders) return 'no orders INSERT captured';
        if (!r.cases) return 'no cases INSERT captured';
        const hours = r.orders.params[6];
        if (hours !== 18) return 'orders.sla_hours is ' + hours + ', wanted 18 (VIP) — 24 is not a tier';
        const slaType = r.cases.params[2];
        if (slaType !== 'vip') return "cases.sla_type is '" + slaType + "', wanted the canonical 'vip', not a new enum string";
        const deadline = new Date(r.cases.params[3]).getTime();
        const wanted = Date.now() + 18 * 3600 * 1000;
        if (!(Math.abs(deadline - wanted) < 5 * 60 * 1000)) {
          return 'cases.sla_deadline is not 18 hours out: ' + r.cases.params[3];
        }
        const leaked = r.queries.some((q) =>
          /priority_24h/.test(q.sql) || q.params.some((p) => String(p).indexOf('priority_24h') !== -1));
        if (leaked) return "'priority_24h' is still written somewhere on the oncology path";
        return null;
      })();
      if (why) t.fail('(1) oncology intake writes VIP 18h with the canonical tier value', new Error(why));
      else t.pass('(1) oncology intake writes VIP 18h with the canonical tier value');
    })();

    // ═══ (2) non-oncology untouched (the Batch B boundary) ═══════════════
    await (async function ctMri() {
      const r = await intake('ct_mri');
      const why = (function () {
        if (r.status !== 200) return 'intake did not succeed: status ' + r.status;
        if (!r.orders || !r.cases) return 'INSERTs not captured';
        if (r.orders.params[6] !== 48) return 'orders.sla_hours is ' + r.orders.params[6] + ', wanted 48';
        if (r.cases.params[2] !== 'standard_72h') {
          return "cases.sla_type is '" + r.cases.params[2] + "' — the stored-enum rename is Batch B; keep 'standard_72h' until the migration";
        }
        return null;
      })();
      if (why) t.fail('(2) ct_mri intake still writes 48h / the retained standard_72h enum value', new Error(why));
      else t.pass('(2) ct_mri intake still writes 48h / the retained standard_72h enum value');
    })();
  } finally {
    restore();
  }
})();
