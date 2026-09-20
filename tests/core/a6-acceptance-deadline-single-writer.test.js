'use strict';
// A6 (fix plan 2026-09-15) — one acceptance deadline.
//
// Three promises, each pinned here:
//
//   1. SINGLE SOURCE — every writer of doctor_assignments.accept_by_at or
//      orders.acceptance_deadline_at gets its duration from
//      src/acceptance_window.js (directly or via acceptByIsoForOrder). No
//      writer carries an inline minutes table.
//   2. BOTH COLUMNS — assignDoctor computes ONE value (acceptByAt) and writes
//      it to orders.acceptance_deadline_at AND doctor_assignments.accept_by_at;
//      the superadmin reassign no longer bypasses it with a bare doctor_id
//      UPDATE (the never-expiring orphan the 2026-09-20 audit ranked P0).
//   3. NO SILENT NEVER-EXPIRES — assignDoctor's doctor_assignments INSERT is
//      no longer swallowed by an empty catch: on failure the claim is ROLLED
//      BACK to the sweepable pool shape (doctor NULL, prior status, deadline
//      reset to now) and the failure is thrown, logged, and written to
//      case_events under the registered ASSIGNMENT_MIRROR_FAILED label.
//
// Style: _testRunner sections, hermetic (no DB), source assertions on the
// stripped tree plus a behavioral drive of the superadmin reassign handler
// with a fake pg and a fake case_lifecycle.

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');
const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  report: function () {},
};

console.log('\n⏱️  A6 — one acceptance deadline: single source, both columns, no silent never-expires\n');

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function check(name, fn) {
  try {
    const why = fn();
    if (why) t.fail(name, new Error(why)); else t.pass(name);
  } catch (e) { t.fail(name, e); }
}
async function checkAsync(name, fn) {
  try {
    const why = await fn();
    if (why) t.fail(name, new Error(why)); else t.pass(name);
  } catch (e) { t.fail(name, e); }
}
function fakeModule(p, exports) { require.cache[p] = { id: p, filename: p, loaded: true, exports }; }
function norm(sql) { return String(sql).replace(/\s+/g, ' ').trim(); }

module.exports = (async function run() {

  // ═══ (1) single source ═════════════════════════════════════════════════
  check('(1) every acceptance-window writer resolves its minutes through src/acceptance_window.js', () => {
    const writers = [
      ['src/case_lifecycle.js', /require\(['"]\.\/acceptance_window['"]\)/],
      ['src/notify/broadcast.js', /require\(['"]\.\.\/acceptance_window['"]\)/],
      ['src/workers/acceptance_watcher.js', /require\(['"]\.\.\/acceptance_window['"]\)/],
      ['src/routes/api/_assign_helpers.js', /require\(['"]\.\.\/\.\.\/acceptance_window['"]\)/],
    ];
    for (const [rel, re] of writers) {
      if (!re.test(stripComments(read(rel)))) return rel + ' no longer imports acceptance_window';
    }
    return null;
  });

  check('(1) no writer re-grows an inline acceptance-minutes table (the three-answers bug)', () => {
    // The historical shapes: an object literal mapping tiers to minutes, or a
    // bare `|| 72` / `|| 24` acceptance default, outside acceptance_window.js.
    const files = ['src/case_lifecycle.js', 'src/notify/broadcast.js',
      'src/workers/acceptance_watcher.js', 'src/routes/api/_assign_helpers.js',
      'src/services/admin_bulk_assign.js', 'src/routes/api/admin.js'];
    for (const rel of files) {
      const src = stripComments(read(rel));
      if (/ACCEPT(?:ANCE)?_(?:WINDOW_)?MINUTES(?:_BY_TIER)?\s*=\s*\{/.test(src)) {
        return rel + ' declares its own acceptance-minutes table';
      }
    }
    return null;
  });

  // ═══ (2) both columns from one value ═══════════════════════════════════
  check('(2) assignDoctor writes acceptance_deadline_at and accept_by_at from the SAME computed acceptByAt', () => {
    const src = stripComments(read('src/case_lifecycle.js'));
    const i = src.indexOf('async function assignDoctor');
    if (i < 0) return 'assignDoctor is gone';
    const body = src.slice(i, src.indexOf('\nasync function', i + 10));
    if (!/const acceptByAt = acceptanceDeadlineIso\(/.test(body)) return 'acceptByAt no longer comes from acceptanceDeadlineIso';
    if (!/assignUpdates\.acceptance_deadline_at = acceptByAt/.test(body)) return 'orders.acceptance_deadline_at is no longer written from acceptByAt';
    if (!/accept_by_at/.test(body) || !/acceptByAt,?\s*\n\s*replacedDoctorId/.test(body)) return 'doctor_assignments.accept_by_at is no longer written from the same acceptByAt';
    return null;
  });

  check('(2) the superadmin reassign routes through caseLifecycle.reassignCase — no bare doctor_id UPDATE', () => {
    const src = stripComments(read('src/routes/superadmin.js'));
    const i = src.indexOf("router.post('/superadmin/orders/:id/reassign'");
    if (i < 0) return 'the superadmin reassign route is gone';
    const body = src.slice(i, src.indexOf('\nrouter.', i + 10));
    if (!/caseLifecycle\.reassignCase\(/.test(body)) return 'the reassign no longer calls caseLifecycle.reassignCase';
    if (/UPDATE orders\s+SET doctor_id/.test(norm(body))) return 'a bare `UPDATE orders SET doctor_id` survives in the reassign route';
    if (!/pending_approval/.test(body)) return 'the target-doctor eligibility read lost the pending_approval predicate';
    if (!/reassign=failed/.test(body)) return 'a reassignCase failure is no longer surfaced to the operator';
    return null;
  });

  // ═══ (3) no silent never-expires ═══════════════════════════════════════
  check('(3) assignDoctor no longer swallows the doctor_assignments INSERT: rollback + throw + registered event', () => {
    const src = stripComments(read('src/case_lifecycle.js'));
    const i = src.indexOf('async function assignDoctor');
    const body = src.slice(i, src.indexOf('\nasync function', i + 10));
    if (/catch\s*\(\s*e\s*\)\s*\{\s*\}/.test(body)) return 'an empty catch survives in assignDoctor';
    if (!/ASSIGNMENT_ROW_FAILED/.test(body)) return 'the INSERT failure is no longer thrown as ASSIGNMENT_ROW_FAILED';
    if (!/ASSIGNMENT_MIRROR_FAILED/.test(body)) return 'the failure no longer writes the registered ASSIGNMENT_MIRROR_FAILED case event';
    if (!/case_lifecycle\.assignment_row_insert/.test(body)) return 'the failure is no longer logged to error_logs';
    // The rollback restores the sweepable shape, guarded so a concurrent
    // acceptance is never clobbered.
    const flat = norm(body);
    if (!/SET doctor_id = NULL,\s*status = COALESCE\(\$4, 'paid'\),\s*acceptance_deadline_at = \$1/.test(flat)) {
      return 'the rollback no longer restores doctor NULL + prior status + a due acceptance_deadline_at';
    }
    if (!/AND doctor_id = \$3 AND LOWER\(COALESCE\(status, ''\)\) = 'assigned' AND accepted_at IS NULL/.test(flat)) {
      return 'the rollback lost its this-doctor / still-assigned / not-accepted guards';
    }
    return null;
  });

  check('(3) ASSIGNMENT_MIRROR_FAILED is a registered SILENT_FAILURE_EVENTS label', () => {
    const life = require(path.join(SRC, 'case_lifecycle.js'));
    const reg = life.SILENT_FAILURE_EVENTS || [];
    if (reg.indexOf('ASSIGNMENT_MIRROR_FAILED') === -1) return 'label missing from the registry — /ops/silent-failures would not surface it';
    return null;
  });

  // ═══ (2b) behavioral: the superadmin reassign handler ══════════════════
  await (async function reassignHarness() {
    const R = (p) => require.resolve(path.join(SRC, p));
    const PG = R('pg.js'); const LIFE = R('case_lifecycle.js'); const SA = R('routes/superadmin.js');
    let realPg, realLife;
    try { realPg = require(PG); realLife = require(LIFE); require(SA); }
    catch (e) { t.fail('(2b) routes/superadmin.js loads hermetically', e); return; }
    const swapped = [PG, LIFE, SA];
    const saved = {};
    for (const p of swapped) saved[p] = require.cache[p];
    const restore = () => { for (const p of swapped) { if (saved[p]) require.cache[p] = saved[p]; else delete require.cache[p]; } };

    const rec = { reassigns: [], executes: [] };
    let scn = null;
    fakeModule(PG, Object.assign({}, realPg, {
      queryOne: async (sql, params) => {
        const s = norm(sql);
        if (/FROM orders_active o/.test(s) && /WHERE o\.id = \$1/.test(s)) return scn.order;
        if (/FROM users u/.test(s) && /doctor_services/.test(s)) return scn.newDoctor;
        return null;
      },
      queryAll: async () => [],
      execute: async (sql, params) => { rec.executes.push(norm(sql)); return { rowCount: 1 }; },
      withTransaction: async (fn) => null,
    }));
    fakeModule(LIFE, Object.assign({}, realLife, {
      reassignCase: async (orderId, doctorId, opts) => {
        rec.reassigns.push({ orderId, doctorId, opts });
        if (scn.reassignThrows) throw new Error('simulated reassign failure');
        return { ok: true };
      },
    }));

    let handler = null;
    try {
      delete require.cache[SA];
      const mod = require(SA);
      const router = mod && mod.router ? mod.router : mod;
      const layer = router.stack.find((l) => l.route && l.route.path === '/superadmin/orders/:id/reassign' && l.route.methods.post);
      handler = layer ? layer.route.stack[layer.route.stack.length - 1].handle : null;
      if (!handler) throw new Error('reassign handler not on router.stack');
    } catch (e) {
      t.fail('(2b) superadmin reassign handler plucked off router.stack', e);
      restore();
      return;
    }

    async function drive(s) {
      scn = s; rec.reassigns = []; rec.executes = [];
      const req = { params: { id: s.order ? s.order.id : 'ord-a6' }, body: { doctor_id: s.pickId || 'doc-new' }, user: { id: 'sa-1', role: 'superadmin' }, originalUrl: '/superadmin/orders/x/reassign', method: 'POST', requestId: 'req-a6', query: {} };
      let redirected = null;
      const res = { locals: {}, redirect(u) { redirected = u; return res; }, status() { return res; }, send() { return res; }, render() { return res; }, json() { return res; } };
      let threw = null;
      try { await handler(req, res, (e) => { if (e) threw = e; }); } catch (e) { threw = e; }
      return { redirected, threw, reassigns: rec.reassigns.slice(), executes: rec.executes.slice() };
    }
    const baseOrder = (over) => Object.assign({ id: 'ord-a6', status: 'in_review', doctor_id: 'doc-old', doctor_name: 'Dr Old', service_id: 'svc-1', patient_id: 'pat-1' }, over || {});

    try {
      await checkAsync('(2b) a valid reassign calls caseLifecycle.reassignCase with the order, the new doctor and the superadmin reason — no direct doctor_id UPDATE', async () => {
        const r = await drive({ order: baseOrder(), newDoctor: { id: 'doc-new', name: 'Dr New' } });
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        if (r.reassigns.length !== 1) return 'reassignCase called ' + r.reassigns.length + ' times';
        const c = r.reassigns[0];
        if (c.orderId !== 'ord-a6' || c.doctorId !== 'doc-new') return 'reassignCase called with ' + JSON.stringify(c);
        if (!c.opts || c.opts.reason !== 'superadmin_manual') return 'reassign reason is ' + JSON.stringify(c.opts);
        if (r.executes.some((s) => /UPDATE orders SET doctor_id/.test(s))) return 'the handler still writes doctor_id directly: ' + r.executes.join(' | ');
        return null;
      });
      await checkAsync('(2b) an ineligible pick (query answers no row) redirects without touching reassignCase or orders', async () => {
        const r = await drive({ order: baseOrder(), newDoctor: null });
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        if (r.reassigns.length) return 'reassignCase ran for an ineligible doctor';
        if (r.executes.length) return 'orders written for an ineligible doctor: ' + r.executes.join(' | ');
        return null;
      });
      await checkAsync('(2b) a reassignCase failure surfaces as ?reassign=failed and does NOT bump the counter', async () => {
        const r = await drive({ order: baseOrder(), newDoctor: { id: 'doc-new', name: 'Dr New' }, reassignThrows: true });
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        if (!/reassign=failed/.test(String(r.redirected))) return 'redirected to ' + r.redirected;
        if (r.executes.some((s) => /reassigned_count/.test(s))) return 'the display counter was bumped although the reassignment failed';
        return null;
      });
    } finally {
      restore();
    }
  })();

  if (typeof t.report === 'function') t.report();
})();
