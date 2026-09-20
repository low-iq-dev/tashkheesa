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
      // Fix round 2026-09-20 (spec review A6/S1): the seed script wrote
      // accept_by_at from a hardcoded 120 minutes — a fifth inline duration,
      // shipped by the very commit banning them. It now goes through the
      // single source like every live writer.
      ['scripts/seed_demo_doctor.js', /require\(['"]\.\.\/src\/acceptance_window['"]\)/],
    ];
    for (const [rel, re] of writers) {
      if (!re.test(stripComments(read(rel)))) return rel + ' no longer imports acceptance_window';
    }
    const seed = stripComments(read('scripts/seed_demo_doctor.js'));
    if (!/acceptanceDeadlineIso\(acceptanceMinutesForOrder\(/.test(seed)) {
      return 'the seed script no longer derives accept_by_at from acceptance_window';
    }
    if (/\b120\s*\*\s*60\s*\*\s*1000\b/.test(seed)) {
      return 'the seed script still carries an inline acceptance duration';
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

  check('(2) the superadmin reassign routes through the canonical lifecycle writers — no bare doctor_id UPDATE', () => {
    const src = stripComments(read('src/routes/superadmin.js'));
    const i = src.indexOf("router.post('/superadmin/orders/:id/reassign'");
    if (i < 0) return 'the superadmin reassign route is gone';
    const body = src.slice(i, src.indexOf('\nrouter.', i + 10));
    if (!/caseLifecycle\.reassignCase\(/.test(body)) return 'the reassign no longer calls caseLifecycle.reassignCase';
    // Fix round (adversarial X1): an unassigned order is a FIRST assignment
    // and goes through assignDoctor — reassignCase refuses a PAID status.
    if (!/caseLifecycle\.assignDoctor\(/.test(body)) return 'the unassigned-order branch no longer calls assignDoctor';
    if (/UPDATE orders\s+SET doctor_id/.test(norm(body))) return 'a bare `UPDATE orders SET doctor_id` survives in the reassign route';
    if (!/pending_approval/.test(body)) return 'the target-doctor eligibility read lost the pending_approval predicate';
    // Fix round (adversarial X1): ?error= is the spelling the order page's
    // flashError banner actually renders; ?reassign= rendered nowhere.
    if (!/error=reassign_failed/.test(body)) return 'a lifecycle failure is no longer surfaced through the flashError banner';
    if (!/error=reassign_ineligible/.test(body)) return 'an ineligible pick is no longer surfaced through the flashError banner';
    // Fix round (adversarial X2): the pause counter must not count operator
    // reassigns — both belts: the admin_manual% reason prefix doctor_pause
    // excludes, and the operatorInitiated flag reassignCase honours.
    if (!/admin_manual_superadmin/.test(body)) return "the reassign reason no longer matches doctor_pause's admin_manual% exclusion";
    if (!/operatorInitiated:\s*true/.test(body)) return 'operatorInitiated: true is no longer passed — an operator reassign would feed the auto-pause counter';
    const view = read('src/views/superadmin_order_detail.ejs');
    if (!/reassign_failed/.test(view) || !/reassign_ineligible/.test(view)) {
      return 'superadmin_order_detail.ejs no longer renders the reassign failure codes — the operator would see nothing';
    }
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
    if (!/SET doctor_id = NULL,\s*status = COALESCE\(\$4, 'PAID'\),\s*acceptance_deadline_at = \$1/.test(flat)) {
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
    const MSG = R('routes/messaging.js'); const NOTIFY = R('notify.js'); const AUDIT = R('audit.js');
    let realPg, realLife, realMsg, realNotify, realAudit;
    try { realPg = require(PG); realLife = require(LIFE); realMsg = require(MSG); realNotify = require(NOTIFY); realAudit = require(AUDIT); require(SA); }
    catch (e) { t.fail('(2b) routes/superadmin.js loads hermetically', e); return; }
    const swapped = [PG, LIFE, MSG, NOTIFY, AUDIT, SA];
    const saved = {};
    for (const p of swapped) saved[p] = require.cache[p];
    const restore = () => { for (const p of swapped) { if (saved[p]) require.cache[p] = saved[p]; else delete require.cache[p]; } };

    const rec = { reassigns: [], assigns: [], executes: [] };
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
      assignDoctor: async (orderId, doctorId) => {
        rec.assigns.push({ orderId, doctorId });
        if (scn.assignThrows) throw new Error('simulated assign failure');
        return { ok: true };
      },
    }));
    // Fix round (adversarial X10): the driven handler reaches
    // ensureConversation and the notification queue after a successful
    // (re)assign; unstubbed they attempt a REAL pg connection from this
    // hermetic test and the unhandled rejection killed the node process
    // after the passes had printed.
    fakeModule(MSG, Object.assign({}, realMsg, {
      ensureConversation: async () => null,
    }));
    fakeModule(NOTIFY, Object.assign({}, realNotify, {
      queueNotification: async () => null,
      queueMultiChannelNotification: async () => null,
      notifyAdmins: async () => null,
    }));
    fakeModule(AUDIT, Object.assign({}, realAudit, { logOrderEvent: () => {} }));

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
      scn = s; rec.reassigns = []; rec.assigns = []; rec.executes = [];
      const req = { params: { id: s.order ? s.order.id : 'ord-a6' }, body: { doctor_id: s.pickId || 'doc-new' }, user: { id: 'sa-1', role: 'superadmin' }, originalUrl: '/superadmin/orders/x/reassign', method: 'POST', requestId: 'req-a6', query: {} };
      let redirected = null;
      const res = { locals: {}, redirect(u) { redirected = u; return res; }, status() { return res; }, send() { return res; }, render() { return res; }, json() { return res; } };
      let threw = null;
      try { await handler(req, res, (e) => { if (e) threw = e; }); } catch (e) { threw = e; }
      return { redirected, threw, reassigns: rec.reassigns.slice(), assigns: rec.assigns.slice(), executes: rec.executes.slice() };
    }
    const baseOrder = (over) => Object.assign({ id: 'ord-a6', status: 'in_review', doctor_id: 'doc-old', doctor_name: 'Dr Old', service_id: 'svc-1', patient_id: 'pat-1' }, over || {});

    try {
      await checkAsync('(2b) a valid reassign calls caseLifecycle.reassignCase with the pause-safe reason and operatorInitiated — no direct doctor_id UPDATE', async () => {
        const r = await drive({ order: baseOrder(), newDoctor: { id: 'doc-new', name: 'Dr New' } });
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        if (r.reassigns.length !== 1) return 'reassignCase called ' + r.reassigns.length + ' times';
        if (r.assigns.length) return 'assignDoctor ran for a case that already has a doctor';
        const c = r.reassigns[0];
        if (c.orderId !== 'ord-a6' || c.doctorId !== 'doc-new') return 'reassignCase called with ' + JSON.stringify(c);
        // Fix round (adversarial X2): admin_manual% is what doctor_pause
        // excludes, and operatorInitiated suppresses the pause check outright.
        if (!c.opts || c.opts.reason !== 'admin_manual_superadmin') return 'reassign reason is ' + JSON.stringify(c.opts);
        if (!c.opts.operatorInitiated) return 'operatorInitiated not passed — the auto-pause counter would count this operator action';
        if (r.executes.some((s) => /UPDATE orders SET doctor_id/.test(s))) return 'the handler still writes doctor_id directly: ' + r.executes.join(' | ');
        return null;
      });
      await checkAsync('(2b) an UNASSIGNED (paid, pool) order is a FIRST assignment: assignDoctor, not reassignCase', async () => {
        const r = await drive({ order: baseOrder({ doctor_id: null, doctor_name: null, status: 'paid' }), newDoctor: { id: 'doc-new', name: 'Dr New' } });
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        if (r.assigns.length !== 1) return 'assignDoctor called ' + r.assigns.length + ' times (reassignCase would throw on a PAID status)';
        if (r.reassigns.length) return 'reassignCase ran for an unassigned order';
        if (r.assigns[0].orderId !== 'ord-a6' || r.assigns[0].doctorId !== 'doc-new') return 'assignDoctor called with ' + JSON.stringify(r.assigns[0]);
        return null;
      });
      await checkAsync('(2b) an ineligible pick (query answers no row) redirects with ?error=reassign_ineligible without touching the lifecycle or orders', async () => {
        const r = await drive({ order: baseOrder(), newDoctor: null });
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        if (r.reassigns.length || r.assigns.length) return 'the lifecycle ran for an ineligible doctor';
        if (r.executes.length) return 'orders written for an ineligible doctor: ' + r.executes.join(' | ');
        if (!/error=reassign_ineligible/.test(String(r.redirected))) return 'redirected to ' + r.redirected;
        return null;
      });
      await checkAsync('(2b) a lifecycle failure surfaces as ?error=reassign_failed (the code the order page renders) and does NOT bump the counter', async () => {
        const r = await drive({ order: baseOrder(), newDoctor: { id: 'doc-new', name: 'Dr New' }, reassignThrows: true });
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        if (!/error=reassign_failed/.test(String(r.redirected))) return 'redirected to ' + r.redirected;
        if (r.executes.some((s) => /reassigned_count/.test(s))) return 'the display counter was bumped although the reassignment failed';
        return null;
      });
    } finally {
      restore();
    }
  })();

  if (typeof t.report === 'function') t.report();
})();
