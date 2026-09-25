// tests/auth/practice-cases-operator-views.test.js
//
// PRACTICE-CASES — slice 0 (2026-09-25).
//
// Sibling of practice-cases-isolation.test.js, which pins the DOCTOR side
// (earnings, the doctor's own stats). This file pins the OPERATOR side: the
// Command app's /api/v1/admin and the web /superadmin dashboard. Before this
// slice not one of their ~60 orders reads excluded practice cases, and prod had
// 27 paid practice orders against 1 real one — every tile was ~96% training.
//
//   A. Reader discipline. Every string literal in src/routes/api/admin.js and
//      src/services/superadmin_dashboard.js that reads `orders`/`orders_active`
//      must either go through the one predicate (realCaseSql, or a shared
//      helper built on it, or the REAL_ORDERS_ACTIVE relation) or carry a
//      `practice-ok:` marker saying why it may see a practice case (by-id
//      reads, write paths, refund- and gateway-driven reads). A new list or
//      tile written without either fails here.
//   B. The web surfaces that do not go through a shared file: buildFilters
//      (orders list, its KPIs, the CSV export), /superadmin/analytics, events,
//      manual queue, settings readiness.
//   C. Hermetic behaviour: GET /cases always leads with the predicate, and
//      GET /cases/:id still answers for a practice case, flagged isPractice.
//   D. Fixture (needs the local DB): one practice + one real order → /pulse
//      moves by exactly 1, /cases finds exactly 1, /revenue counts exactly 1.

'use strict';

try { require('dotenv').config(); } catch (_) {}
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-practice-operator-views';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🧪 PRACTICE-CASES slice 0 — training cases are not in any operator metric or list\n');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

async function check(name, fn) {
  try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); }
}

// ── a tiny JS lexer: the source span of every string / template literal ────
// Template literals are returned whole, including their ${…} interpolations,
// so a predicate interpolated into the SQL is visible to the check.
function stringLiterals(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  function skipString(q) { // i at opening quote
    const start = i; i++;
    while (i < n && src[i] !== q) { if (src[i] === '\\') i++; i++; }
    i++;
    return { start, end: i };
  }
  function skipTemplate() { // i at opening backtick; returns span
    const start = i; i++;
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') { i += 2; skipCode('}'); i++; continue; }
      i++;
    }
    i++;
    return { start, end: i };
  }
  function skipCode(closer) { // until the matching closer at depth 0
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 2; continue; }
      if (c === '\'' || c === '"') { skipString(c); continue; }
      if (c === '`') { skipTemplate(); continue; }
      if (c === '{') depth++;
      if (c === '}') { if (depth === 0 && closer === '}') return; depth--; }
      i++;
    }
  }
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 2; continue; }
    if (c === '\'' || c === '"') { out.push(skipString(c)); continue; }
    if (c === '`') { out.push(skipTemplate()); continue; }
    i++;
  }
  return out.map((s) => ({ start: s.start, end: s.end, text: src.slice(s.start, s.end) }));
}

const ORDERS_READ = /\b(FROM|JOIN)\s+orders(_active)?\b/;
const GUARDS = [
  'realCaseSql(', 'REAL_ORDERS_ACTIVE',
  // built on realCaseSql in routes/api/_assign_helpers.js (asserted in A0)
  'activeCaseSql(', 'breachedCaseSql(', 'unassignedCaseSql(', 'doctorLoadSql(', 'slaHitRatioSql(',
  // GET /manual-queue's shared WHERE (asserted to carry realCaseSql below)
  '${QUEUE_WHERE}',
];

function unguardedReads(rel) {
  const src = read(rel);
  const lineOf = (pos) => src.slice(0, pos).split('\n').length;
  const bad = [];
  for (const lit of stringLiterals(src)) {
    if (!ORDERS_READ.test(lit.text)) continue;
    if (GUARDS.some((g) => lit.text.includes(g))) continue;
    if (/practice-ok:/.test(lit.text)) continue;
    // A JS-comment marker in the few lines just above the literal (the
    // single-quoted one-liners cannot hold an SQL comment).
    const above = src.slice(0, lit.start).split('\n').slice(-4).join('\n');
    if (/\/\/\s*practice-ok:/.test(above)) continue;
    bad.push(rel + ':' + lineOf(lit.start) + '  ' + lit.text.replace(/\s+/g, ' ').slice(0, 90));
  }
  return bad;
}

module.exports = (async function run() {
  const { realCaseSql, REAL_ORDERS_ACTIVE } = require('../../src/practice_cases');
  const H = require('../../src/routes/api/_assign_helpers');

  // ── A0. the one definition, and the shared helpers built on it ──────────
  await check('A0 realCaseSql is NULL-safe and REAL_ORDERS_ACTIVE is built from it', () => {
    assert.strictEqual(realCaseSql('o.'), 'NOT COALESCE(o.is_practice, false)');
    assert.strictEqual(realCaseSql(''), 'NOT COALESCE(is_practice, false)');
    assert.ok(REAL_ORDERS_ACTIVE.includes('FROM orders_active') && REAL_ORDERS_ACTIVE.includes(realCaseSql('')));
  });
  await check('A0 active / breached / unassigned / load / SLA-denominator all carry realCaseSql', () => {
    for (const [name, sql] of [
      ['activeCaseSql', H.activeCaseSql('o.')], ['breachedCaseSql', H.breachedCaseSql('o.')],
      ['unassignedCaseSql', H.unassignedCaseSql('o.')], ['doctorLoadSql', H.doctorLoadSql('o.')],
      ['slaHitRatioSql', H.slaHitRatioSql('o.')],
    ]) assert.ok(sql.includes(realCaseSql('o.')), name + ' lost the practice guard');
    assert.ok(/require\('\.\.\/\.\.\/practice_cases'\)/.test(read('src/routes/api/_assign_helpers.js')),
      '_assign_helpers must use the shared predicate, not its own copy');
  });

  // ── A. reader discipline on the two files that are ALL operator views ───
  await check('A the lexer sees the known reads (self-test: finds >= 30 in admin.js)', () => {
    const lits = stringLiterals(read('src/routes/api/admin.js')).filter((l) => ORDERS_READ.test(l.text));
    assert.ok(lits.length >= 30, 'only ' + lits.length + ' orders reads found — lexer broken?');
  });
  await check('A every orders read in api/admin.js is practice-guarded or marked practice-ok', () => {
    const bad = unguardedReads('src/routes/api/admin.js');
    assert.deepStrictEqual(bad, [], 'unguarded:\n    ' + bad.join('\n    '));
  });
  await check('A every orders read in services/superadmin_dashboard.js is practice-guarded', () => {
    const bad = unguardedReads('src/services/superadmin_dashboard.js');
    assert.deepStrictEqual(bad, [], 'unguarded:\n    ' + bad.join('\n    '));
  });
  await check('A GET /manual-queue\'s shared QUEUE_WHERE carries realCaseSql', () => {
    const src = read('src/routes/api/admin.js');
    const m = src.match(/const QUEUE_WHERE = `([\s\S]*?)`;/);
    assert.ok(m, 'QUEUE_WHERE not found');
    assert.ok(m[1].includes("${realCaseSql('o.')}"), 'QUEUE_WHERE lost the practice guard');
  });
  await check('A GET /cases: the practice guard is cond[0], before any filter', () => {
    const src = read('src/routes/api/admin.js');
    assert.ok(/const cond = \[realCaseSql\('o\.'\)\];/.test(src), 'GET /cases no longer seeds cond with realCaseSql');
  });
  await check('A the Payments collected tile, /revenue and the breach-cost denominator are guarded', () => {
    const src = read('src/routes/api/admin.js');
    const collected = src.match(/AS collected_mtd\s+FROM orders_active\s+WHERE[^`]*`/);
    assert.ok(collected && collected[0].includes('realCaseSql('), '/refunds collected tile');
    const rev = src.slice(src.indexOf("router.get('/revenue'"), src.indexOf("router.get('/ai-usage'"));
    assert.ok(rev.includes("${realCaseSql('o.')}"), '/revenue');
    const bc = src.slice(src.indexOf("router.get('/breach-cost'"), src.indexOf("router.get('/breach-cost'") + 12000);
    assert.ok(/AS collected,[\s\S]*?realCaseSql\('o\.'\)/.test(bc), '/breach-cost refund-rate denominator');
  });

  // ── B. web surfaces in superadmin.js ─────────────────────────────────────
  await check('B buildFilters leads with realCaseSql (orders list + KPIs + CSV export + admin console)', () => {
    const { buildFilters } = require('../../src/routes/superadmin');
    const empty = buildFilters({});
    assert.strictEqual(empty.whereSql, 'WHERE ' + realCaseSql('o.'));
    assert.strictEqual(empty.nextIdx, 1, 'the guard must not consume a parameter slot');
    const f = buildFilters({ specialty: 'cardio' });
    assert.ok(f.whereSql.startsWith('WHERE ' + realCaseSql('o.') + ' AND '));
    assert.deepStrictEqual(f.params, ['cardio']);
    assert.ok(/buildFilters\(req\.query/.test(read('src/routes/exports.js')), 'CSV export stopped using buildFilters');
  });
  await check('B /superadmin/analytics: every orders read goes through REAL_ORDERS_ACTIVE', () => {
    const src = read('src/routes/superadmin.js');
    const a = src.indexOf("router.get('/superadmin/analytics'");
    const seg = src.slice(a, src.indexOf("res.render('superadmin_analytics'", a));
    const raw = seg.match(/\b(FROM|JOIN)\s+orders(_active)?\b/g) || [];
    assert.deepStrictEqual(raw, [], 'raw orders reads in analytics: ' + raw.join(', '));
    assert.ok((seg.match(/REAL_ORDERS_ACTIVE/g) || []).length >= 15);
  });
  await check('B /superadmin/events, /superadmin/manual-queue and the settings readiness count are guarded', () => {
    const src = read('src/routes/superadmin.js');
    const ev = src.slice(src.indexOf("router.get('/superadmin/events'"), src.indexOf("router.get('/superadmin/events'") + 2000);
    assert.ok(ev.includes("where.push(realCaseSql('o.'))"), '/superadmin/events');
    const mq = src.slice(src.indexOf("router.get('/superadmin/manual-queue'"), src.indexOf("router.get('/superadmin/manual-queue'") + 2000);
    assert.ok(mq.includes("${realCaseSql('o.')}"), '/superadmin/manual-queue');
    assert.ok(/AND \$\{realCaseSql\('o\.'\)\}\s*\) AS awaiting_manual/.test(src), 'settings awaiting_manual');
  });
  await check('B the orders_active VIEW is untouched — the doctor queue needs practice rows', () => {
    const dir = path.join(ROOT, 'src', 'migrations');
    const later = fs.readdirSync(dir).filter((f) => /^\d+/.test(f) && parseInt(f, 10) > 110 && /orders_active/i.test(fs.readFileSync(path.join(dir, f), 'utf8')) && /is_practice/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    assert.deepStrictEqual(later, [], 'a later migration filters is_practice in the view: ' + later.join(', '));
  });

  // ── C. hermetic behaviour of the Command API ────────────────────────────
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const apiResponse = require('../../src/middleware/apiResponse');
  const makeAdminRouter = require('../../src/routes/api/admin');
  const token = jwt.sign({ id: 'su-1', email: 'su@x.com', role: 'superadmin', name: 'Su' }, process.env.JWT_SECRET, { expiresIn: '15m' });

  function listen(helpers) {
    const app = express();
    app.use(apiResponse);
    app.use(express.json());
    app.use('/api/v1/admin', makeAdminRouter({ totalCount: 1, idleCount: 1, waitingCount: 0 }, helpers, {}, {
      ensureConversation: async () => 'c', queueMultiChannelNotification: async () => ({ ok: true }), notifyCaseAssigned: async () => ({ ok: true }),
    }));
    const server = app.listen(0);
    return { server, base: 'http://127.0.0.1:' + server.address().port + '/api/v1/admin' };
  }
  async function get(base, p) {
    const r = await fetch(base + p, { headers: { Accept: 'application/json', Authorization: 'Bearer ' + token } });
    return { status: r.status, body: await r.json().catch(() => null) };
  }

  await check('C GET /cases: list, total and facets all carry the predicate, whatever the filter', async () => {
    const seen = [];
    const rec = async (sql) => { seen.push(sql); return /COUNT\(\*\) AS total/.test(sql) ? { total: 0 } : null; };
    const recAll = async (sql) => { seen.push(sql); return []; };
    const { server, base } = listen({ safeGet: rec, mustGet: rec, safeAll: recAll, mustAll: recAll });
    try {
      for (const q of ['', '?status=completed', '?payment=paid', '?assigned=assigned', '?q=TSH']) {
        seen.length = 0;
        const r = await get(base, '/cases' + q);
        assert.strictEqual(r.status, 200, q + ' → ' + r.status);
        assert.strictEqual(seen.length, 3, q + ': expected list, total, facets');
        seen.forEach((s) => assert.ok(s.includes(realCaseSql('o.')), q + ': unguarded ' + s.replace(/\s+/g, ' ').slice(0, 80)));
      }
    } finally { server.close(); }
  });
  await check('C GET /cases/:id answers for a practice case and says isPractice: true (additive)', async () => {
    const detail = {
      id: 'prac-1', reference_id: null, status: 'assigned', urgency_tier: 'standard', payment_status: 'paid',
      price: 0, base_price: 0, urgency_uplift_amount: 0, addons_json: null, is_practice: true,
      created_at: new Date(), doctor_id: null, sla_mins: null, patient_name: 'Training',
    };
    const one = async (sql) => (/WHERE o\.id = \$1/.test(sql) && /o\.is_practice/.test(sql) ? detail : null);
    const { server, base } = listen({ safeGet: one, mustGet: one, safeAll: async () => [], mustAll: async () => [] });
    try {
      const r = await get(base, '/cases/prac-1');
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.data.isPractice, true);
      assert.strictEqual(r.body.data.id, 'prac-1');
      detail.is_practice = false;
      const r2 = await get(base, '/cases/prac-1');
      assert.strictEqual(r2.body.data.isPractice, false);
    } finally { server.close(); }
  });

  // ── D. fixture against the local database ───────────────────────────────
  if (!process.env.DATABASE_URL) {
    t.skip('D fixture: practice + real order → /pulse, /cases, /revenue count 1', 'DATABASE_URL not set');
    return;
  }
  // Its own pool and helpers, not src/pg / src/sql-utils: other files in the
  // suite swap those modules in require.cache, and this check must not depend
  // on which ran first. Same contract as sql-utils (must* throw, safe* degrade).
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const mustAll = async (sql, params) => (await pool.query(sql, params || [])).rows;
  const mustGet = async (sql, params) => (await mustAll(sql, params))[0] || null;
  const dbHelpers = {
    mustGet, mustAll,
    safeGet: (sql, params, fb) => mustGet(sql, params).catch(() => (fb === undefined ? null : fb)),
    safeAll: (sql, params, fb) => mustAll(sql, params).catch(() => fb || []),
    safeRun: async () => ({ rowCount: 0 }),
  };
  const tag = 'PRACTEST-' + Date.now();
  const ids = [tag + '-real', tag + '-prac'];
  const { server, base } = listen(dbHelpers);
  try {
    const before = await get(base, '/pulse');
    const revBefore = await get(base, '/revenue?scope=mtd');
    assert.strictEqual(before.status, 200, 'pulse before: ' + JSON.stringify(before.body));
    for (const [id, practice] of [[ids[0], false], [ids[1], true]]) {
      await pool.query(
        `INSERT INTO orders (id, reference_id, status, payment_status, paid_at, price, base_price, created_at, updated_at, is_practice)
         VALUES ($1, $2, 'paid', 'paid', NOW(), 500, 500, NOW(), NOW(), $3)`,
        [id, id, practice]
      );
    }
    const after = await get(base, '/pulse');
    const cases = await get(base, '/cases?q=' + encodeURIComponent(tag));
    const revAfter = await get(base, '/revenue?scope=mtd');
    await check('D fixture: /pulse active + pending-assignment move by exactly 1 (the real order)', () => {
      assert.strictEqual(after.body.data.kpis.activeCases - before.body.data.kpis.activeCases, 1);
      assert.strictEqual(after.body.data.kpis.pendingAssignment - before.body.data.kpis.pendingAssignment, 1);
    });
    await check('D fixture: /cases returns exactly 1 — the real one', () => {
      assert.strictEqual(cases.status, 200);
      assert.strictEqual(cases.body.data.total, 1);
      assert.deepStrictEqual(cases.body.data.cases.map((c) => c.id), [ids[0]]);
    });
    await check('D fixture: /revenue MTD gains exactly 1 order / EGP 500', () => {
      assert.strictEqual(revAfter.body.data.total.count - revBefore.body.data.total.count, 1);
      assert.strictEqual(Math.round(revAfter.body.data.total.amount - revBefore.body.data.total.amount), 500);
    });
    const prac = await get(base, '/cases/' + ids[1]);
    await check('D fixture: the practice case still opens by id, flagged isPractice', () => {
      assert.strictEqual(prac.status, 200);
      assert.strictEqual(prac.body.data.isPractice, true);
    });
  } catch (e) {
    t.fail('D fixture', e);
  } finally {
    server.close();
    try { await pool.query('DELETE FROM orders WHERE id = ANY($1::text[])', [ids]); } catch (_) {}
    await pool.end().catch(() => {});
  }
})();
