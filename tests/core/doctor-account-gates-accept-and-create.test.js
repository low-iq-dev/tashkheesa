// tests/core/doctor-account-gates-accept-and-create.test.js
//
// Launch gates 2026-09-15, Task 1 — a paused, pending, rejected or deactivated
// doctor must not take a NEW case, either by accepting one from the open pool
// or by being hand-picked on POST /superadmin/orders.
//
// What was wrong on d255cf4b:
//   * POST /portal/doctor/case/:caseId/accept read no account state. requireRole
//     blocks is_active=false / pending through the access_revocation cache,
//     which fails open and lags up to 60 s, and never blocks is_paused (by
//     design: pause is not a lockout). So a doctor auto-paused for three SLA
//     breaches kept accepting open-pool cases.
//   * POST /superadmin/orders looked the picked doctor up by role only and
//     created the order 'accepted' on them whatever their account state.
//
// What this file pins:
//   (1) the one JS rule (doctor_eligibility.doctorNewCaseBlockReason) over the
//       whole is_active × is_paused × pending_approval × rejection_reason table,
//       and the reason it names: rejected > pending > inactive > paused, so the
//       row shapes live flows write (all is_active = false) are named correctly;
//   (2) it agrees with the account predicates of main's SQL eligibility clause
//       (eligibleDoctorClause) wherever that clause has a column for the flag;
//   (3) pause is still not a login or request gate;
//   (4) the REAL accept handler (plucked off router.stack, fake pg): refusals
//       for paused / pending / deactivated / rejected, NULL paused and a stale
//       reason on an active account allowed, a read failure fails closed and is
//       logged, a case already assigned to the doctor untouched; the check runs
//       after the specialty gate, before capacity and before withTransaction;
//       and the case page renders bilingual Egyptian-register copy;
//   (5) pickDoctorForOrder (the auto path) already excludes the four states;
//   (6) the REAL create-order handler: a refused pick re-renders 400 through the
//       REAL view with patient / specialty / service still selected, the doctor
//       picker empty, no INSERT, nothing hostile reflected; an unknown doctor id
//       keeps today's behaviour.
//
// Hermetic: no DATABASE_URL needed, nothing is written anywhere.

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n🚪 Launch gates T1 — doctor account state at pool accept and manual order creation\n');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function code(rel) { return stripComments(read(rel)); }
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const ARABIC = /[؀-ۿ]/;
const EGYPTIAN = /(مش|دلوقتي|لسه|كلّم|كلم|ليك|تاني|علشان|عشان|هنبلغك|مقدرناش)/;

function check(name, fn) {
  try { const why = fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}
async function checkAsync(name, fn) {
  try { const why = await fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}
function fakeModule(p, exports) { require.cache[p] = { id: p, filename: p, loaded: true, exports }; }
function routeBody(src, decl) {
  const start = src.indexOf(decl);
  if (start < 0) return '';
  const after = src.slice(start);
  const next = after.indexOf('\nrouter.', decl.length);
  return next > 0 ? after.slice(0, next) : after;
}

// The brief's definition, restated independently of the implementation.
function specBlocked(r) {
  if (!r) return true;
  if (r.is_active === false) return true;
  if (r.is_paused === true) return true;
  if (r.pending_approval === true) return true;
  const reason = r.rejection_reason == null ? '' : String(r.rejection_reason).trim();
  if (reason !== '' && r.is_active !== true) return true;
  return false;
}
function truthRows() {
  const out = [];
  for (const is_active of [true, false, null]) {
    for (const is_paused of [true, false, null]) {
      for (const pending_approval of [true, false, null]) {
        for (const rejection_reason of [null, '', '   ', 'Not approved']) {
          out.push({ role: 'doctor', is_active, is_paused, pending_approval, rejection_reason, onboarding_complete: false });
        }
      }
    }
  }
  return out;
}
// A4/A5 (fix plan 2026-09-15): the accept handler reads ONE live users row
// carrying specialty, tier support and the per-doctor caps alongside the
// account flags, so the fixture carries them too. The defaults are a doctor
// the pool order matches: right specialty, all tiers, caps of 4/8 (so the
// old capacity expectations — refuse at count 99, pass at 0 — still hold).
const doctorRow = (over) => Object.assign({ role: 'doctor', is_active: true, is_paused: false, pending_approval: false, onboarding_complete: true, rejection_reason: null, specialty_id: 'spec-1', sla_tiers_supported: ['standard', 'vip', 'urgent'], max_active_cases: 4, max_active_cases_urgent: 8 }, over || {});

// The row shapes the live flows actually write (fix round 1, review I2). Every
// one carries is_active = false, which is why the reason precedence matters:
//   * doctor signup, routes/auth.js INSERT: pending_approval, is_active,
//     onboarding_complete = true, false, true;
//   * both reject flows, services/admin_doctor_reject.js and POST
//     /superadmin/doctors/:id/reject: pending_approval = false, is_active =
//     false, rejection_reason = the reason;
//   * the superadmin deactivate action and the is_active toggle: is_active =
//     false, reason and pending untouched.
const LIVE = Object.freeze({
  signupPending: { is_active: false, pending_approval: true, onboarding_complete: true, is_paused: false, rejection_reason: null },
  rejected: { is_active: false, pending_approval: false, is_paused: false, rejection_reason: 'Not approved' },
  deactivated: { is_active: false, pending_approval: false, is_paused: false, rejection_reason: null },
});

// The case page's refusal copy, lifted out of routes/doctor.js source (the
// router module exports no helper for it). Returns poolAcceptRefusalMessage, or
// null when the copy table or the function is not found.
function loadPoolCopy(raw) {
  const mCopy = raw.match(/const POOL_ACCEPT_REFUSAL_COPY = Object\.freeze\(\{[\s\S]*?\n\}\);/);
  const mFn = raw.match(/function poolAcceptRefusalMessage\s*\([\s\S]*?\n\}/);
  if (!mCopy || !mFn) return null;
  // eslint-disable-next-line no-eval
  return eval('(function () { ' + mCopy[0] + '\n return (' + mFn[0] + '); })()');
}

module.exports = (async function run() {
  let E = null;
  try { E = require(path.join(SRC, 'services', 'doctor_eligibility')); } catch (e) { t.fail('doctor_eligibility loads', e); }
  const helper = E && typeof E.doctorNewCaseBlockReason === 'function' ? E.doctorNewCaseBlockReason : null;

  // ═══ (1) the one JS rule ═════════════════════════════════════════════════
  check('(1) doctor_eligibility.doctorNewCaseBlockReason implements the rule over is_active × is_paused × pending_approval × rejection_reason (blank / whitespace reasons do not count; is_active = true overrides a stale reason; onboarding is not required)', () => {
    if (!helper) return 'doctorNewCaseBlockReason is not exported from src/services/doctor_eligibility.js';
    const failures = [];
    for (const r of truthRows()) {
      const js = helper(r) !== null;
      if (js !== specBlocked(r)) failures.push(JSON.stringify(r) + ' → JS blocked=' + js);
    }
    if (failures.length) return failures.length + ' disagreement(s), e.g. ' + failures.slice(0, 3).join('; ');
    return null;
  });
  check('(1) doctorNewCaseBlockReason names each state distinctly: paused, pending_approval, inactive, rejected, not_found', () => {
    if (!helper) return 'doctorNewCaseBlockReason is not exported';
    const B = E.DOCTOR_ACCOUNT_BLOCK || {};
    const want = { PAUSED: 'paused', PENDING_APPROVAL: 'pending_approval', INACTIVE: 'inactive', REJECTED: 'rejected', NOT_FOUND: 'not_found' };
    for (const [k, v] of Object.entries(want)) if (B[k] !== v) return 'DOCTOR_ACCOUNT_BLOCK.' + k + ' is ' + JSON.stringify(B[k]) + ', want ' + JSON.stringify(v);
    const cases = [
      [doctorRow({ is_paused: true }), 'paused'],
      [doctorRow({ pending_approval: true }), 'pending_approval'],
      [doctorRow({ is_active: false }), 'inactive'],
      [doctorRow({ is_active: null, rejection_reason: 'Not approved' }), 'rejected'],
      [doctorRow({ is_active: false, rejection_reason: 'Not approved' }), 'rejected'],
      [null, 'not_found'],
      [doctorRow({ is_paused: null }), null],
      [doctorRow({ is_active: true, rejection_reason: 'old reason' }), null],
      [doctorRow({ is_active: null, is_paused: null, pending_approval: null, onboarding_complete: null }), null],
    ];
    for (const [row, exp] of cases) {
      const got = helper(row);
      if (got !== exp) return JSON.stringify(row) + ' → ' + JSON.stringify(got) + ', want ' + JSON.stringify(exp);
    }
    return null;
  });

  check('(1) reason precedence is rejected > pending_approval > inactive > paused, so the shapes live flows write (all is_active = false) are named for what they are: signup pending → pending_approval, rejected by a reject flow → rejected, deactivated → inactive', () => {
    if (!helper) return 'doctorNewCaseBlockReason is not exported';
    const cases = [
      ['signup pending (is_active false + pending_approval)', LIVE.signupPending, 'pending_approval'],
      ['rejected by a reject flow (is_active false + reason)', LIVE.rejected, 'rejected'],
      ['deactivated (is_active false, no reason, not pending)', LIVE.deactivated, 'inactive'],
      ['every flag set', { is_active: false, is_paused: true, pending_approval: true, rejection_reason: 'Not approved' }, 'rejected'],
      ['a reason with pending still true', { is_active: false, is_paused: false, pending_approval: true, rejection_reason: 'Not approved' }, 'rejected'],
      ['pending + inactive + paused', { is_active: false, is_paused: true, pending_approval: true, rejection_reason: null }, 'pending_approval'],
      ['pending + paused on an active account', { is_active: true, is_paused: true, pending_approval: true, rejection_reason: null }, 'pending_approval'],
      ['inactive + paused, blank reason', { is_active: false, is_paused: true, pending_approval: false, rejection_reason: '   ' }, 'inactive'],
      ['paused with a stale reason on an active account', { is_active: true, is_paused: true, pending_approval: false, rejection_reason: 'old reason' }, 'paused'],
    ];
    for (const [label, over, exp] of cases) {
      const got = helper(doctorRow(over));
      if (got !== exp) return label + ': ' + JSON.stringify(over) + ' → ' + JSON.stringify(got) + ', want ' + JSON.stringify(exp);
    }
    return null;
  });

  // ═══ (2) JS ⇔ main's SQL eligibility clause ══════════════════════════════
  check('(2) doctorNewCaseBlockReason agrees with the account predicates of eligibleDoctorClause (is_active / is_paused / pending_approval, with its COALESCE defaults) on every row the clause can see', () => {
    if (!helper) return 'doctorNewCaseBlockReason is not exported';
    const clause = E.eligibleDoctorClause({ alias: 'u', serviceIdParam: '$1' });
    const preds = [...clause.matchAll(/COALESCE\(u\.(\w+), (true|false)\) = (true|false)/g)]
      .map((m) => ({ col: m[1], dflt: m[2] === 'true', want: m[3] === 'true' }));
    const cols = preds.map((p) => p.col);
    for (const c of ['is_active', 'is_paused', 'pending_approval']) if (cols.indexOf(c) === -1) return 'eligibleDoctorClause has no COALESCE predicate on ' + c;
    const unknown = cols.filter((c) => ['is_active', 'is_paused', 'pending_approval', 'onboarding_complete'].indexOf(c) === -1);
    if (unknown.length) return 'eligibleDoctorClause gained account predicate(s) the JS rule does not model: ' + unknown.join(', ');
    const account = preds.filter((p) => p.col !== 'onboarding_complete'); // onboarding is not part of the new-case rule
    const sqlEligible = (r) => account.every((p) => (r[p.col] == null ? p.dflt : r[p.col]) === p.want);
    const failures = [];
    // The clause has no rejection_reason column, so it can only speak for rows
    // without one; with a reason the JS rule is stricter by design (the
    // rejected rule), which (1) pins.
    for (const r of truthRows().filter((x) => x.rejection_reason == null)) {
      if ((helper(r) === null) !== sqlEligible(r)) failures.push(JSON.stringify(r) + ': SQL ' + (sqlEligible(r) ? 'eligible' : 'excluded') + ', JS ' + (helper(r) === null ? 'eligible' : helper(r)));
    }
    return failures.length ? failures.length + ' disagreement(s), e.g. ' + failures.slice(0, 3).join('; ') : null;
  });

  // ═══ (3) pause stays out of sign-in ══════════════════════════════════════
  check('(3) is_paused is still not a login or request gate: loginBlockReason ignores it; login_gate, access_revocation, requireRole (middleware.js), src/auth.js, the web and API login handlers (routes/auth.js, routes/api/auth.js) and routes/doctor.js\'s own router.use middleware neither read is_paused nor call the new-case rule', () => {
    const { loginBlockReason } = require(path.join(SRC, 'services', 'login_gate'));
    if (loginBlockReason(doctorRow({ is_paused: true })) !== null) return 'loginBlockReason blocks a paused doctor';
    for (const rel of ['src/services/login_gate.js', 'src/services/access_revocation.js']) {
      const c = code(rel);
      if (/is_paused/.test(c)) return rel + ' now reads is_paused';
      if (/doctorNewCaseBlockReason|doctor_eligibility/.test(c)) return rel + ' now uses the new-case rule';
    }
    const mw = code('src/middleware.js');
    const i = mw.indexOf('function requireRole');
    const body = i >= 0 ? mw.slice(i, mw.indexOf('\nmodule.exports', i)) : '';
    if (!body) return 'requireRole not found';
    if (/is_paused|doctorNewCaseBlockReason|doctor_eligibility/.test(body)) return 'requireRole now gates on pause / the new-case rule';
    // Fix round 1 (review N3): the other places a pause gate could land.
    for (const rel of ['src/auth.js', 'src/routes/auth.js', 'src/routes/api/auth.js']) {
      const c = code(rel);
      if (/is_paused/.test(c)) return rel + ' now reads is_paused';
      if (/doctorNewCaseBlockReason|doctor_eligibility/.test(c)) return rel + ' now uses the new-case rule';
    }
    const doc = code('src/routes/doctor.js');
    const uses = [];
    for (let k = doc.indexOf('\nrouter.use('); k !== -1; k = doc.indexOf('\nrouter.use(', k + 1)) {
      const end = doc.indexOf('\n});', k);
      uses.push(end === -1 ? doc.slice(k) : doc.slice(k, end));
    }
    if (uses.length < 3) return 'expected routes/doctor.js\'s own router.use middleware (3 on main), found ' + uses.length;
    const gated = uses.find((u) => /is_paused|doctorNewCaseBlockReason/.test(u));
    if (gated) return 'a routes/doctor.js router.use middleware now gates on pause / the new-case rule: ' + norm(gated).slice(0, 140);
    return null;
  });

  // ═══ (4a) pool accept — placement in source ══════════════════════════════
  const doctorRaw = read('src/routes/doctor.js');
  const doctorSrc = stripComments(doctorRaw);
  check('(4a) accept handler: the account check sits inside the unassigned-pool branch, after the specialty gate, before the capacity check and before withTransaction', () => {
    const body = routeBody(doctorSrc, "router.post('/portal/doctor/case/:caseId/accept'");
    if (!body) return 'accept handler not found';
    const iSpec = body.indexOf('msg=specialty');
    const iAcct = body.indexOf('doctorNewCaseBlockReason(');
    const iCap = body.indexOf('countActiveCasesForDoctor(');
    const iTx = body.indexOf('withTransaction(');
    if (iAcct < 0) return 'accept handler does not call doctorNewCaseBlockReason';
    if (iSpec < 0 || iCap < 0 || iTx < 0) return 'landmarks missing (specialty ' + iSpec + ', capacity ' + iCap + ', tx ' + iTx + ')';
    if (!(iSpec < iAcct)) return 'the account check runs before the specialty gate';
    if (!(iAcct < iCap)) return 'the account check runs after the capacity check';
    if (!(iAcct < iTx)) return 'the account check runs after withTransaction';
    const open = body.lastIndexOf('if (!assignedDoctorId) {', iAcct);
    if (open < 0) return 'the account check is not inside an `if (!assignedDoctorId)` block';
    let depth = 0; let close = -1;
    for (let k = body.indexOf('{', open); k < body.length; k++) {
      if (body[k] === '{') depth++;
      else if (body[k] === '}') { depth--; if (depth === 0) { close = k; break; } }
    }
    if (!(close > iAcct)) return 'the account check is not inside the `if (!assignedDoctorId)` block';
    if (!/doctor\.accept_account_check/.test(body)) return 'a read failure is not logged as doctor.accept_account_check';
    return null;
  });

  // ═══ (4b) pool accept — the real handler ═════════════════════════════════
  await (async function acceptHarness() {
    const R = (p) => require.resolve(path.join(SRC, p));
    const PG = R('pg.js'); const LOGGER = R('logger.js'); const AUDIT = R('audit.js'); const LIFE = R('case_lifecycle.js'); const DOC = R('routes/doctor.js');
    const swapped = [PG, LOGGER, AUDIT, LIFE, DOC];
    let realPg, realLogger, realLife;
    try { realPg = require(PG); realLogger = require(LOGGER); realLife = require(LIFE); require(AUDIT); require(DOC); }
    catch (e) { t.fail('(4b) routes/doctor.js loads hermetically', e); return; }
    const saved = {};
    for (const p of swapped) saved[p] = require.cache[p];
    const restore = () => { for (const p of swapped) { if (saved[p]) require.cache[p] = saved[p]; else delete require.cache[p]; } };

    const rec = { seq: [], accountReads: [], errors: [] };
    let scn = null;
    fakeModule(PG, Object.assign({}, realPg, {
      queryOne: async (sql, params) => {
        const s = norm(sql);
        if (/^SELECT \* FROM orders_active WHERE id = \$1$/.test(s)) { rec.seq.push('order'); return scn.order; }
        if (/^SELECT specialty_id FROM users WHERE id = \$1$/.test(s)) { rec.seq.push('specialty'); return { specialty_id: scn.order.specialty_id }; }
        if (/FROM users WHERE id = \$1/.test(s) && /is_paused/.test(s)) {
          rec.seq.push('account');
          rec.accountReads.push({ sql: s, params: params || [] });
          if (scn.throwAccount) throw new Error('simulated users read failure');
          return scn.doctor;
        }
        // A4/A5: the load count carries the canonical doctorLoadSql predicate
        // and a table alias now, so match the head of the statement only.
        if (/COUNT\(\*\) AS c FROM orders_active/.test(s)) { rec.seq.push('capacity'); return { c: scn.capacity == null ? 99 : scn.capacity }; }
        if (/FROM users u WHERE LOWER\(COALESCE\(u\.role/.test(s)) { rec.seq.push('next_doctor'); return null; }
        rec.seq.push('other_read');
        return null;
      },
      queryAll: async () => [],
      execute: async () => { rec.seq.push('execute'); return { rowCount: 0 }; },
      withTransaction: async () => { rec.seq.push('tx'); return null; },
    }));
    fakeModule(LOGGER, Object.assign({}, realLogger, { logErrorToDb: (err, ctx) => { rec.errors.push({ message: err && err.message, ctx }); } }));
    fakeModule(AUDIT, Object.assign({}, saved[AUDIT].exports, { logOrderEvent: () => {} }));
    fakeModule(LIFE, Object.assign({}, realLife, {
      assignDoctor: async () => { rec.seq.push('assign'); },
      reassignCase: async () => { rec.seq.push('reassign'); },
    }));

    let handler = null;
    try {
      delete require.cache[DOC];
      const router = require(DOC);
      const layer = router.stack.find((l) => l.route && l.route.path === '/portal/doctor/case/:caseId/accept' && l.route.methods.post);
      handler = layer ? layer.route.stack[layer.route.stack.length - 1].handle : null;
      if (!handler) throw new Error('accept handler not on router.stack');
    } catch (e) {
      t.fail('(4b) accept handler plucked off router.stack', e);
      restore();
      return;
    }

    async function accept(s) {
      scn = s; rec.seq = []; rec.accountReads = []; rec.errors = [];
      const req = { params: { caseId: s.order.id }, user: { id: 'doc-1', role: 'doctor' }, originalUrl: '/portal/doctor/case/' + s.order.id + '/accept', method: 'POST', requestId: 'req-t1', query: {}, body: {} };
      let redirected = null;
      const res = { locals: {}, redirect(u) { redirected = u; return res; }, status() { return res; }, send() { return res; }, render() { return res; }, json() { return res; } };
      let threw = null;
      try { await handler(req, res, (e) => { if (e) threw = e; }); } catch (e) { threw = e; }
      return { redirected, threw, seq: rec.seq.slice(), accountReads: rec.accountReads.slice(), errors: rec.errors.slice() };
    }
    const poolOrder = (over) => Object.assign({ id: 'ord-t1', status: 'PAID', payment_status: 'paid', doctor_id: null, specialty_id: 'spec-1' }, over || {});
    const WORK = ['capacity', 'next_doctor', 'assign', 'reassign', 'tx', 'execute'];
    const refusedWith = (r, msg) => {
      if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
      if (r.redirected !== '/portal/doctor/case/ord-t1?msg=' + msg) return 'redirected to ' + r.redirected + ', want ?msg=' + msg + ' (sequence ' + r.seq.join(' → ') + ')';
      const went = r.seq.filter((x) => WORK.indexOf(x) !== -1);
      if (went.length) return 'the refusal let the handler go on: ' + r.seq.join(' → ');
      return null;
    };
    const passedGuard = (r) => {
      if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
      if (r.accountReads.length !== 1) return 'expected one live account read, saw ' + r.accountReads.length;
      if (r.seq.indexOf('capacity') === -1) return 'the handler never reached the capacity check (redirect ' + r.redirected + ', sequence ' + r.seq.join(' → ') + ')';
      if (r.redirected !== '/portal/doctor/case/ord-t1?msg=capacity') return 'redirected to ' + r.redirected;
      return null;
    };

    try {
      await checkAsync('(4b) accept, PAUSED doctor on an unassigned pool case → ?msg=paused; ONE live users read keyed on the doctor, carrying specialty, account, tier and cap columns together; no capacity, assignment or transaction work', async () => {
        const r = await accept({ order: poolOrder(), doctor: doctorRow({ is_paused: true }) });
        if (r.accountReads.length !== 1) return 'expected ONE live users read carrying the account columns, saw ' + r.accountReads.length + ' (sequence ' + r.seq.join(' → ') + ')';
        const cols = r.accountReads[0].sql;
        // A4/A5 (fix plan 2026-09-15): guardrails 3b/3c/3d/4 share one live
        // read, so it must carry all four gates' columns.
        for (const c of ['specialty_id', 'is_active', 'is_paused', 'pending_approval', 'rejection_reason', 'sla_tiers_supported', 'max_active_cases', 'max_active_cases_urgent']) {
          if (!new RegExp('\\b' + c + '\\b').test(cols)) return 'the live users read does not select ' + c + ': ' + cols;
        }
        if (JSON.stringify(r.accountReads[0].params) !== JSON.stringify(['doc-1'])) return 'the users read is not keyed on the requesting doctor: ' + JSON.stringify(r.accountReads[0].params);
        return refusedWith(r, 'paused');
      });
      await checkAsync('(4b) accept, is_paused NULL (and onboarding incomplete) → not refused; the handler goes on to the capacity check', async () => {
        return passedGuard(await accept({ order: poolOrder(), doctor: doctorRow({ is_paused: null, onboarding_complete: false }) }));
      });
      await checkAsync('(4b) accept, PENDING approval → ?msg=pending_approval', async () => {
        return refusedWith(await accept({ order: poolOrder(), doctor: doctorRow({ pending_approval: true }) }), 'pending_approval');
      });
      await checkAsync('(4b) accept, DEACTIVATED (is_active false) → ?msg=account_inactive', async () => {
        return refusedWith(await accept({ order: poolOrder(), doctor: doctorRow({ is_active: false }) }), 'account_inactive');
      });
      await checkAsync('(4b) accept, REJECTED (reason set, is_active NULL) → ?msg=account_inactive', async () => {
        return refusedWith(await accept({ order: poolOrder(), doctor: doctorRow({ is_active: null, rejection_reason: 'Not approved' }) }), 'account_inactive');
      });
      await checkAsync('(4b) accept, the shapes live flows write → the doctor is told the right reason in English and Egyptian Arabic: signup pending (is_active false + pending_approval) → ?msg=pending_approval "awaiting approval"; rejected by a reject flow (is_active false + reason) and deactivated → ?msg=account_inactive "isn\'t active"', async () => {
        const msgFor = loadPoolCopy(doctorRaw);
        if (!msgFor) return 'POOL_ACCEPT_REFUSAL_COPY / poolAcceptRefusalMessage not found in routes/doctor.js';
        const cases = [
          ['signup pending', LIVE.signupPending, 'pending_approval', /awaiting approval/i, 'مستني الموافقة'],
          ['rejected by a reject flow', LIVE.rejected, 'account_inactive', /isn't active/i, 'مش مفعّل'],
          ['deactivated', LIVE.deactivated, 'account_inactive', /isn't active/i, 'مش مفعّل'],
        ];
        for (const [label, over, wantMsg, en, ar] of cases) {
          const r = await accept({ order: poolOrder(), doctor: doctorRow(over) });
          const why = refusedWith(r, wantMsg);
          if (why) return label + ': ' + why;
          const enCopy = msgFor(wantMsg, false); const arCopy = msgFor(wantMsg, true);
          if (!en.test(String(enCopy))) return label + ': English copy for ?msg=' + wantMsg + ' is ' + JSON.stringify(enCopy);
          if (String(arCopy).indexOf(ar) === -1) return label + ': Arabic copy for ?msg=' + wantMsg + ' is ' + JSON.stringify(arCopy);
        }
        return null;
      });
      await checkAsync('(4b) accept, stale rejection_reason on an is_active = true account → allowed (operator re-activation wins)', async () => {
        return passedGuard(await accept({ order: poolOrder(), doctor: doctorRow({ is_active: true, rejection_reason: 'old reason' }) }));
      });
      await checkAsync('(4b) accept, ACTIVE doctor with room → goes all the way: one live read → capacity → assignDoctor → withTransaction', async () => {
        const r = await accept({ order: poolOrder(), doctor: doctorRow(), capacity: 0 });
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        // A4/A5: the separate specialty read merged into the single live read.
        const want = ['order', 'account', 'capacity', 'assign', 'tx'];
        if (r.seq.join('|') !== want.join('|')) return 'sequence ' + r.seq.join(' → ') + ', want ' + want.join(' → ');
        if (/msg=/.test(String(r.redirected))) return 'redirected with a message: ' + r.redirected;
        return null;
      });
      await checkAsync('(4b) accept, the users row is MISSING → ?msg=account_inactive (fail closed)', async () => {
        return refusedWith(await accept({ order: poolOrder(), doctor: null }), 'account_inactive');
      });
      await checkAsync('(4b) accept, the users read THROWS → fail closed: ?msg=account_check_failed, logged via logErrorToDb as doctor.accept_account_check', async () => {
        const r = await accept({ order: poolOrder(), doctor: doctorRow(), throwAccount: true });
        const why = refusedWith(r, 'account_check_failed');
        if (why) return why;
        if (!r.errors.some((e) => e.ctx && e.ctx.context === 'doctor.accept_account_check' && e.ctx.category === 'doctor_case' && e.ctx.orderId === 'ord-t1')) return 'failure not logged: ' + JSON.stringify(r.errors);
        return null;
      });
      await checkAsync('(4b) accept, pool case with NO specialty → ?msg=case_unroutable for EVERY doctor, with its own bilingual copy (A5: an unroutable case is nobody\'s to take, whatever their account state)', async () => {
        // A5 (fix plan 2026-09-15): the old 3b SKIPPED the check when the case
        // carried no specialty, so any doctor holding the link could take it.
        // Blank-on-either-side now refuses. Fix round (spec review A5/S1): the
        // refusal carries its OWN code — the ?msg=specialty copy ("update your
        // profile") is false here; only an operator routing the case fixes it.
        const clean = refusedWith(await accept({ order: poolOrder({ specialty_id: null }), doctor: doctorRow() }), 'case_unroutable');
        if (clean) return 'eligible doctor: ' + clean;
        const paused = refusedWith(await accept({ order: poolOrder({ specialty_id: null }), doctor: doctorRow({ is_paused: true }) }), 'case_unroutable');
        if (paused) return 'paused doctor: ' + paused;
        const msgFor = loadPoolCopy(doctorRaw);
        if (!msgFor) return 'POOL_ACCEPT_REFUSAL_COPY / poolAcceptRefusalMessage not found in routes/doctor.js';
        if (!/specialty/i.test(String(msgFor('case_unroutable', false)))) return 'no English copy for ?msg=case_unroutable';
        if (!ARABIC.test(String(msgFor('case_unroutable', true)))) return 'no Arabic copy for ?msg=case_unroutable';
        return null;
      });
      await checkAsync('(4b) accept, doctor whose specialty is BLANK on a specialty pool case → ?msg=specialty (blank matches nothing)', async () => {
        return refusedWith(await accept({ order: poolOrder(), doctor: doctorRow({ specialty_id: null }) }), 'specialty');
      });
      await checkAsync('(4b) accept, doctor who does not support the case\'s TIER → ?msg=tier_not_supported, with bilingual copy (A5 Guardrail 3d)', async () => {
        const r = await accept({ order: poolOrder({ urgency_tier: 'urgent' }), doctor: doctorRow({ sla_tiers_supported: ['standard'] }) });
        const why = refusedWith(r, 'tier_not_supported');
        if (why) return why;
        const msgFor = loadPoolCopy(doctorRaw);
        if (!msgFor) return 'POOL_ACCEPT_REFUSAL_COPY / poolAcceptRefusalMessage not found in routes/doctor.js';
        if (!/tier/i.test(String(msgFor('tier_not_supported', false)))) return 'no English copy for ?msg=tier_not_supported';
        if (!String(msgFor('tier_not_supported', true)).trim()) return 'no Arabic copy for ?msg=tier_not_supported';
        return null;
      });
      await checkAsync('(4b) accept, NULL sla_tiers_supported reads as standard-only: a standard case is accepted, a VIP case is refused', async () => {
        const std = await accept({ order: poolOrder(), doctor: doctorRow({ sla_tiers_supported: null }), capacity: 0 });
        if (std.threw) return 'standard case threw: ' + (std.threw.message || std.threw);
        if (/msg=/.test(String(std.redirected))) return 'standard case refused: ' + std.redirected;
        return refusedWith(await accept({ order: poolOrder({ urgency_tier: 'vip' }), doctor: doctorRow({ sla_tiers_supported: null }) }), 'tier_not_supported');
      });
      await checkAsync('(4b) accept, the load count EXCLUDES the case being accepted (fix round X3: an assigned case sits inside its own count, so counting it refused the accept that filled the last slot)', async () => {
        const body = routeBody(doctorSrc, "router.post('/portal/doctor/case/:caseId/accept'");
        if (!/countActiveCasesForDoctor\(doctorId,\s*orderId\)/.test(body)) {
          return 'the accept handler no longer excludes the subject case from its load count';
        }
        const def = doctorSrc.slice(doctorSrc.indexOf('async function countActiveCasesForDoctor'), doctorSrc.indexOf('async function countActiveCasesForDoctor') + 900);
        if (!/o\.id <> \$2/.test(def)) return 'countActiveCasesForDoctor lost its excludeOrderId predicate';
        return null;
      });
      await checkAsync('(4b) accept, capacity is the PER-DOCTOR tier-aware cap: refused at their own max_active_cases, an urgent case measured against max_active_cases_urgent, and cap 0/NULL means no cap', async () => {
        // At their own (small) cap: 2 active vs max_active_cases 2 → capacity path.
        const at = await accept({ order: poolOrder(), doctor: doctorRow({ max_active_cases: 2 }), capacity: 2 });
        if (at.threw) return 'at-cap threw: ' + (at.threw.message || at.threw);
        if (!/msg=capacity/.test(String(at.redirected))) return 'at their own cap, got ' + at.redirected + ' (sequence ' + at.seq.join(' → ') + ')';
        // Under the same cap → proceeds.
        const under = await accept({ order: poolOrder(), doctor: doctorRow({ max_active_cases: 2 }), capacity: 1 });
        if (/msg=/.test(String(under.redirected))) return 'under their cap the doctor was refused: ' + under.redirected;
        // Urgent case measures against max_active_cases_urgent, not max_active_cases.
        const urgent = await accept({ order: poolOrder({ urgency_tier: 'urgent' }), doctor: doctorRow({ max_active_cases: 2, max_active_cases_urgent: 8 }), capacity: 5 });
        if (/msg=/.test(String(urgent.redirected))) return 'an urgent case was measured against the standard cap: ' + urgent.redirected;
        // No cap configured (NULL) → the check is skipped, assign_case semantics.
        const nocap = await accept({ order: poolOrder(), doctor: doctorRow({ max_active_cases: null }), capacity: 99 });
        if (/msg=/.test(String(nocap.redirected))) return 'a NULL cap refused the doctor: ' + nocap.redirected;
        return null;
      });
      await checkAsync('(4b) accept, a case ALREADY assigned to this (paused) doctor → no pool refusal; proceeds to capacity and the transaction', async () => {
        const r = await accept({ order: poolOrder({ doctor_id: 'doc-1', status: 'ASSIGNED' }), doctor: doctorRow({ is_paused: true }), capacity: 0 });
        if (r.threw) return 'handler threw: ' + (r.threw.message || r.threw);
        // A4/A5: the single live read now also feeds the capacity cap, so it
        // runs for assigned accepts too — what must NOT happen is a refusal.
        if (/msg=/.test(String(r.redirected))) return 'redirected with a message: ' + r.redirected;
        if (r.seq.indexOf('tx') === -1) return 'the assigned case did not reach the transaction: ' + r.seq.join(' → ');
        return null;
      });
    } finally {
      restore();
    }
  })();

  // ═══ (4c) pool accept — the case page copy ═══════════════════════════════
  check('(4c) the doctor case page renders distinct bilingual copy (Egyptian register) for paused, pending_approval, account_inactive and account_check_failed, and nothing for unknown or prototype keys', () => {
    const msgFor = loadPoolCopy(doctorRaw);
    if (!msgFor) return 'POOL_ACCEPT_REFUSAL_COPY / poolAcceptRefusalMessage not found in routes/doctor.js';
    const seen = new Set();
    for (const k of ['paused', 'pending_approval', 'account_inactive', 'account_check_failed']) {
      const en = msgFor(k, false); const ar = msgFor(k, true);
      if (!en || ARABIC.test(en)) return k + ': no English copy';
      if (!ar || !ARABIC.test(ar)) return k + ': no Arabic copy';
      if (!EGYPTIAN.test(ar)) return k + ': Arabic copy is not in Egyptian register: ' + ar;
      if (seen.has(en)) return k + ': English copy is not distinct';
      seen.add(en);
    }
    if (!/paused/i.test(msgFor('paused', false))) return 'the paused copy does not say the account is paused';
    if (!/approv/i.test(msgFor('pending_approval', false))) return 'the pending copy does not mention approval';
    if (!/active/i.test(msgFor('account_inactive', false))) return 'the inactive copy does not say the account is not active';
    for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'capacity', '']) {
      if (msgFor(bad, false) !== null) return 'poolAcceptRefusalMessage(' + JSON.stringify(bad) + ') is not null';
    }
    const get = routeBody(doctorSrc, "router.get('/portal/doctor/case/:caseId'");
    if (!get || get.indexOf('poolAcceptRefusalMessage(msg, isAr)') === -1) return 'GET /portal/doctor/case/:caseId does not use poolAcceptRefusalMessage(msg, isAr)';
    if (!/errorMessage: capacityMessage/.test(get)) return 'the case page no longer passes the message to the view as errorMessage';
    if (!/<%= _errMsg %>/.test(read('src/views/portal_doctor_case.ejs'))) return 'portal_doctor_case.ejs does not render errorMessage escaped';
    return null;
  });

  // ═══ (5) the auto path ═══════════════════════════════════════════════════
  check('(5) pickDoctorForOrder (the auto path of POST /superadmin/orders) already excludes paused, pending, deactivated and rejected doctors (strict is_active = true also drops a rejected row whose is_active is not true)', () => {
    const src = code('src/assign.js');
    const i = src.indexOf('async function pickDoctorForOrder');
    const body = i >= 0 ? src.slice(i, src.indexOf('\nmodule.exports', i)) : '';
    if (!body) return 'pickDoctorForOrder not found';
    if (!/u\.is_active = true/.test(body)) return 'pickDoctorForOrder no longer requires is_active = true';
    if (!/COALESCE\(u\.is_paused, false\) = false/.test(body)) return 'pickDoctorForOrder no longer excludes paused doctors';
    if (!/COALESCE\(u\.pending_approval, false\) = false/.test(body)) return 'pickDoctorForOrder no longer excludes pending doctors';
    return null;
  });

  // ═══ (6) POST /superadmin/orders — the real handler and view ═════════════
  await (async function createOrderHarness() {
    const R = (p) => require.resolve(path.join(SRC, p));
    const PG = R('pg.js'); const WEB = R('routes/superadmin.js');
    let realPg;
    try { realPg = require(PG); require(WEB); }
    catch (e) { t.fail('(6) routes/superadmin.js loads hermetically', e); return; }
    const saved = { [PG]: require.cache[PG], [WEB]: require.cache[WEB] };
    const restore = () => { for (const p of [PG, WEB]) { if (saved[p]) require.cache[p] = saved[p]; else delete require.cache[p]; } };
    let scn = null;
    const rec = { writes: [], insertParams: null };
    const INSERT_REACHED = new Error('INSERT INTO orders reached');
    // Keep only the columns the handler's SELECT names, so a SELECT that forgets
    // a flag hands the rule an undefined for it.
    const project = (row, sql) => {
      const out = {};
      for (const k of Object.keys(row)) if (new RegExp('\\b' + k + '\\b').test(sql)) out[k] = row[k];
      return out;
    };
    fakeModule(PG, Object.assign({}, realPg, {
      queryOne: async (sql) => {
        const s = norm(sql);
        if (/FROM users WHERE id = \$1 AND role = 'doctor'/.test(s)) return scn.doctor ? project(scn.doctor, s.split(/\bFROM\b/)[0]) : null;
        if (/^SELECT \* FROM services WHERE id = \$1$/.test(s)) return { id: 'svc-1', base_price: 1000, doctor_fee: 300, payment_link: null, currency: 'EGP' };
        return null;
      },
      queryAll: async (sql) => {
        const s = norm(sql);
        if (/FROM users WHERE role = 'patient'/.test(s)) return [{ id: 'pat-0', name: 'Other Patient', email: 'o@example.com' }, { id: 'pat-1', name: 'Pat One', email: 'p1@example.com' }];
        if (/FROM users WHERE role = 'doctor'/.test(s)) return [{ id: 'doc-x', name: 'Dr X', email: 'x@example.com', specialty_id: 'spec-1' }, { id: 'doc-y', name: 'Dr Y', email: 'y@example.com', specialty_id: 'spec-1' }];
        if (/FROM specialties/.test(s)) return [{ id: 'spec-0', name: 'Aaa' }, { id: 'spec-1', name: 'Cardiology' }];
        if (/FROM services/.test(s)) return [{ id: 'svc-0', specialty_id: 'spec-0', code: 'A1', name: 'Aaa read' }, { id: 'svc-1', specialty_id: 'spec-1', code: 'ECG', name: 'ECG read' }];
        return [];
      },
      execute: async (sql, params) => {
        const s = norm(sql);
        rec.writes.push(s);
        if (/^INSERT INTO orders/.test(s)) { rec.insertParams = params || []; throw INSERT_REACHED; }
        return { rowCount: 1 };
      },
    }));
    let handler = null;
    try {
      delete require.cache[WEB];
      const { router } = require(WEB);
      const layer = router.stack.find((l) => l.route && l.route.path === '/superadmin/orders' && l.route.methods.post);
      handler = layer ? layer.route.stack[layer.route.stack.length - 1].handle : null;
      if (!handler) throw new Error('POST /superadmin/orders not on router.stack');
    } catch (e) {
      t.fail('(6) POST /superadmin/orders plucked off router.stack', e);
      restore();
      return;
    }
    async function create(s) {
      scn = s; rec.writes = []; rec.insertParams = null;
      const body = Object.assign({ patient_id: 'pat-1', doctor_id: 'doc-x', specialty_id: 'spec-1', service_id: 'svc-1', sla_hours: '48' }, s.body || {});
      const req = { body, user: { id: 'sa-1', role: 'superadmin' }, query: {}, session: {} };
      const out = { status: 200, view: null, locals: null, threw: null };
      const res = { locals: { lang: s.lang || 'en' }, status(c) { out.status = c; return res; }, render(v, l) { out.view = v; out.locals = l; return res; }, redirect(u) { out.redirect = u; return res; }, send() { return res; }, json() { return res; } };
      try { await handler(req, res, () => {}); } catch (e) { out.threw = e; }
      out.inserted = out.threw === INSERT_REACHED;
      out.writes = rec.writes.slice();
      out.insertParams = rec.insertParams;
      return out;
    }
    const full = (over) => Object.assign({ id: 'doc-x', name: 'Dr X', email: 'x@example.com', phone: null }, doctorRow(over));
    const refused = (r) => {
      if (r.inserted || r.writes.length) return 'a write happened on a refused pick: ' + JSON.stringify(r.writes);
      if (r.threw) return 'handler threw: ' + r.threw.message;
      if (r.status !== 400 || r.view !== 'superadmin_order_new') return 'status ' + r.status + ' view ' + r.view;
      return null;
    };
    try {
      await checkAsync('(6) hand-picked PAUSED doctor → 400 re-render of superadmin_order_new naming the pause (English and Arabic), no INSERT', async () => {
        const en = await create({ doctor: full({ is_paused: true }) });
        const why = refused(en);
        if (why) return why;
        if (!/paused/i.test(String(en.locals.error))) return 'the error does not name the pause: ' + en.locals.error;
        const ar = await create({ doctor: full({ is_paused: true }), lang: 'ar' });
        if (refused(ar)) return 'ar: ' + refused(ar);
        if (!ARABIC.test(String(ar.locals.error))) return 'no Arabic error for an Arabic operator: ' + ar.locals.error;
        return null;
      });
      await checkAsync('(6) hand-picked PENDING / DEACTIVATED / REJECTED (is_active NULL) doctors are refused with their own reason (English and Arabic), no INSERT', async () => {
        const cases = [
          [{ pending_approval: true }, /approv/i],
          [{ is_active: false }, /deactivat/i],
          [{ is_active: null, rejection_reason: 'Not approved' }, /reject/i],
        ];
        const seen = new Set();
        for (const [over, re] of cases) {
          const r = await create({ doctor: full(over) });
          const why = refused(r);
          if (why) return JSON.stringify(over) + ': ' + why;
          if (!re.test(String(r.locals.error))) return JSON.stringify(over) + ': error does not name the reason: ' + r.locals.error;
          if (seen.has(r.locals.error)) return JSON.stringify(over) + ': reason is not distinct';
          seen.add(r.locals.error);
          const ar = await create({ doctor: full(over), lang: 'ar' });
          if (refused(ar) || !ARABIC.test(String(ar.locals.error))) return JSON.stringify(over) + ': no Arabic refusal';
        }
        return null;
      });
      await checkAsync('(6) the shapes live flows write are refused with THEIR reason, not "deactivated" (English and Arabic), no INSERT: signup pending (is_active false + pending_approval) → awaiting approval; rejected by a reject flow (is_active false + reason) → rejected; deactivated → deactivated; every flag set → rejected', async () => {
        const cases = [
          ['signup pending', LIVE.signupPending, /awaiting approval/i, 'مستني الموافقة'],
          ['rejected by a reject flow', LIVE.rejected, /was rejected/i, 'اترفض'],
          ['deactivated', LIVE.deactivated, /is deactivated/i, 'مش مفعّل'],
          ['every flag set', { is_active: false, is_paused: true, pending_approval: true, rejection_reason: 'Not approved' }, /was rejected/i, 'اترفض'],
        ];
        for (const [label, over, en, ar] of cases) {
          const r = await create({ doctor: full(over) });
          const why = refused(r);
          if (why) return label + ': ' + why;
          if (!en.test(String(r.locals.error))) return label + ': the English error names the wrong reason: ' + r.locals.error;
          const a = await create({ doctor: full(over), lang: 'ar' });
          const awhy = refused(a);
          if (awhy) return label + ' (ar): ' + awhy;
          if (String(a.locals.error).indexOf(ar) === -1) return label + ': the Arabic error names the wrong reason: ' + a.locals.error;
        }
        return null;
      });
      await checkAsync('(6) an eligible pick (clean, not onboarded; or a stale reason on an active account) is NOT refused: the order is written accepted on that doctor', async () => {
        for (const over of [{ onboarding_complete: false }, { is_active: true, rejection_reason: 'old reason' }]) {
          const r = await create({ doctor: full(over) });
          if (!r.inserted) return JSON.stringify(over) + ': not written (status ' + r.status + ', error ' + (r.locals && r.locals.error) + (r.threw ? ', threw ' + r.threw.message : '') + ')';
          if (r.insertParams[2] !== 'doc-x' || r.insertParams[6] !== 'accepted') return JSON.stringify(over) + ': INSERT doctor/status ' + r.insertParams[2] + '/' + r.insertParams[6];
        }
        return null;
      });
      await checkAsync('(6) an UNKNOWN doctor id keeps today\'s behaviour: the order is written unassigned (doctor NULL, status new)', async () => {
        const r = await create({ doctor: null, body: { doctor_id: 'doc-nope' } });
        if (!r.inserted) return 'not written (status ' + r.status + ', error ' + (r.locals && r.locals.error) + (r.threw ? ', threw ' + r.threw.message : '') + ')';
        if (r.insertParams[2] !== null || r.insertParams[6] !== 'new') return 'INSERT doctor/status ' + r.insertParams[2] + '/' + r.insertParams[6];
        return null;
      });
      await checkAsync('(6) a refused pick re-renders through the REAL view with the submitted patient, specialty and service still selected and the doctor picker EMPTY; price, fee and notes kept; hostile submitted values never reflected raw', async () => {
        const ejs = require('ejs');
        const VIEW = path.join(SRC, 'views', 'superadmin_order_new.ejs');
        const STUB = /partials\/superadmin\/(header|page_header|footer)$/;
        const renderView = (locals) => ejs.renderFile(VIEW, Object.assign({ lang: 'en', csrfField: () => '' }, locals), {
          includer: (p) => (STUB.test(p) ? { template: '' } : undefined),
        });
        const selectedIn = (html, name) => {
          const m = html.match(new RegExp('<select[^>]*name="' + name + '"[^>]*>([\\s\\S]*?)</select>'));
          if (!m) return null;
          return [...m[1].matchAll(/<option value="([^"]*)"( selected)?>/g)].filter((o) => o[2]).map((o) => o[1]);
        };
        const r = await create({ doctor: full({ is_paused: true }), body: { price: '900', doctor_fee: '300', notes: 'call first' } });
        const why = refused(r);
        if (why) return why;
        const d = (r.locals && r.locals.defaults) || {};
        const submitted = { patient_id: 'pat-1', specialty_id: 'spec-1', service_id: 'svc-1' };
        const lost = Object.keys(submitted).filter((k) => d[k] !== submitted[k]);
        if (lost.length) return 're-render defaults dropped the operator\'s ' + lost.join(', ') + ' (defaults: ' + JSON.stringify(d) + ')';
        if (String(d.doctor_id == null ? '' : d.doctor_id) !== '') return 'the refused doctor is carried back into the picker (doctor_id ' + JSON.stringify(d.doctor_id) + ')';
        const html = await renderView(r.locals);
        const want = { patient_id: ['pat-1'], specialty_id: ['spec-1'], service_id: ['svc-1'], doctor_id: [''] };
        for (const [name, exp] of Object.entries(want)) {
          const got = selectedIn(html, name);
          if (JSON.stringify(got) !== JSON.stringify(exp)) return 'rendered <select name="' + name + '"> selected ' + JSON.stringify(got) + ', expected ' + JSON.stringify(exp);
        }
        if (!/value="900"/.test(html) || !/value="300"/.test(html) || !/call first/.test(html)) return 'price / doctor fee / notes were not kept';
        if (!/class="flash err"/.test(html) || !/paused/i.test(html)) return 'the refusal is not shown on the page';
        const evil = '"><img src=x onerror=alert(1)>';
        const x = await create({ doctor: full({ is_paused: true }), body: { patient_id: evil, doctor_id: evil, specialty_id: evil, service_id: evil, notes: '</textarea><script>alert(1)</script>', price: evil } });
        const xwhy = refused(x);
        if (xwhy) return 'hostile body: ' + xwhy;
        if (String(x.locals.error).indexOf('<') !== -1) return 'the refusal message carries markup: ' + x.locals.error;
        const xhtml = await renderView(x.locals);
        if (/<img src=x/i.test(xhtml) || /<script>alert/i.test(xhtml)) return 'a submitted value was reflected into the page unescaped';
        return null;
      });
      await checkAsync('(6) a refused pick whose patient / specialty / service arrive as a qs array or object → the re-render defaults drop them to \'\' (only plain strings are kept); no INSERT', async () => {
        const r = await create({ doctor: full({ is_paused: true }), body: { patient_id: ['pat-1'], specialty_id: { a: 'b' }, service_id: ['svc-1', 'svc-0'] } });
        const why = refused(r);
        if (why) return why;
        const d = (r.locals && r.locals.defaults) || {};
        const carried = ['patient_id', 'specialty_id', 'service_id'].filter((k) => d[k] !== '');
        if (carried.length) return 'non-string value(s) carried into the re-render defaults: ' + carried.map((k) => k + '=' + JSON.stringify(d[k])).join(', ');
        return null;
      });
    } finally {
      restore();
    }
  })();
})();
