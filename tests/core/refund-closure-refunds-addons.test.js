// tests/core/refund-closure-refunds-addons.test.js
//
// Part B item 4 (2026-09-13) — add-on commissions on refund.
//
// services/addons/video_consult.onRefund and prescription.onRefund had ZERO
// callers. A case refunded in full left its unfulfilled add-ons at 'paid', so
// the doctor could still fulfil one afterwards and onComplete would write an
// addon_earnings row — commission on money the patient had already been
// given back. refund_closure.closeOrderIfFullyRefunded is the one place "the
// patient got everything back" is decided; it now flips every unfulfilled
// add-on through its registry class's onRefund (fulfilled ones are kept —
// the doctor did the work). Dormant while both add-on flags are off; bites
// the first day one is enabled.
//
// Pure-unit on refundUnfulfilledAddons with injected deps + structural pins.
// Verified NEGATIVELY: removing the call from the closure path fails the
// structural assertion; making onRefund skip 'paid' rows fails the unit one.

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n💸 Part B-4 — a full refund refunds the unfulfilled add-ons too\n');

const ROOT = path.join(__dirname, '..', '..');
function code(rel) { return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
function check(name, fn) {
  try { const why = fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}
async function checkAsync(name, fn) {
  try { const why = await fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}

const { refundUnfulfilledAddons } = require('../../src/services/refund_closure');
const RC = code('src/services/refund_closure.js');

function deps(rows) {
  const calls = { refunded: [], events: [], errors: [] };
  const svc = {
    async onRefund({ addon }) {
      if (addon.status === 'fulfilled') return null;    // mirrors the real classes
      calls.refunded.push(addon.id);
      return Object.assign({}, addon, { status: 'refunded', refund_pending: true });
    }
  };
  return {
    calls,
    d: {
      queryAll: async () => rows,
      execute: async (sql, params) => { calls.events.push({ sql, params }); return { rowCount: 1 }; },
      getAddon: (id) => (id === 'boom' ? { async onRefund() { throw new Error('registry exploded'); } } : (id === 'unknown' ? null : svc)),
      logErrorToDb: (e, ctx) => { calls.errors.push({ e, ctx }); }
    }
  };
}

(async () => {
  await checkAsync('unit: a paid (unfulfilled) add-on is flipped through onRefund and an ADDON_REFUNDED event is written', async () => {
    const { d, calls } = deps([{ id: 'a1', addon_service_id: 'prescription', status: 'paid' }]);
    const out = await refundUnfulfilledAddons('o1', { actorUserId: 'sa1' }, d);
    if (out.refunded !== 1) return 'expected 1 refunded, got ' + out.refunded;
    if (calls.refunded[0] !== 'a1') return 'onRefund not called for a1';
    if (!calls.events.some((ev) => /ADDON_REFUNDED'/.test(ev.sql) && ev.params[1] === 'sa1')) return 'no ADDON_REFUNDED event with the actor';
  });

  await checkAsync('unit: a fulfilled add-on is kept (the doctor did the work) and its earnings are untouched', async () => {
    const { d, calls } = deps([{ id: 'a2', addon_service_id: 'video_consult', status: 'fulfilled' }]);
    const out = await refundUnfulfilledAddons('o1', {}, d);
    if (out.keptFulfilled !== 1 || out.refunded !== 0) return JSON.stringify(out);
    if (calls.refunded.length) return 'onRefund was invoked for a fulfilled add-on';
    if (calls.events.length) return 'an event was written for a kept add-on';
  });

  await checkAsync('unit: a throwing registry class is logged + ADDON_REFUND_FAILED, and the other add-ons still flip', async () => {
    const { d, calls } = deps([
      { id: 'a3', addon_service_id: 'boom', status: 'paid' },
      { id: 'a4', addon_service_id: 'prescription', status: 'paid' }
    ]);
    const out = await refundUnfulfilledAddons('o1', {}, d);
    if (out.failed !== 1 || out.refunded !== 1) return JSON.stringify(out);
    if (!calls.errors.length) return 'failure not logged';
    if (!calls.events.some((ev) => /ADDON_REFUND_FAILED'/.test(ev.sql))) return 'no ADDON_REFUND_FAILED event';
  });

  await checkAsync('unit: an unknown add-on id is logged, never thrown', async () => {
    const { d, calls } = deps([{ id: 'a5', addon_service_id: 'unknown', status: 'paid' }]);
    const out = await refundUnfulfilledAddons('o1', {}, d);
    if (out.failed !== 1) return JSON.stringify(out);
    if (!calls.errors.length) return 'not logged';
  });

  await checkAsync('unit: a failed order_addons read is logged and returns zeros (never throws over committed money)', async () => {
    const { d, calls } = deps([]);
    d.queryAll = async () => { throw new Error('db down'); };
    const out = await refundUnfulfilledAddons('o1', {}, d);
    if (out.refunded !== 0 || out.failed !== 0) return JSON.stringify(out);
    if (!calls.errors.length) return 'not logged';
  });

  check('structural: closeOrderIfFullyRefunded calls refundUnfulfilledAddons AFTER the close UPDATE and only on the full-refund path', () => {
    const fn = RC.slice(RC.indexOf('async function closeOrderIfFullyRefunded'), RC.indexOf('async function refundUnfulfilledAddons'));
    const update = fn.indexOf("SET status = 'REFUNDED'");
    const call = fn.indexOf('await refundUnfulfilledAddons(orderId');
    if (update < 0) return 'close UPDATE not found';
    if (call < 0) return 'refundUnfulfilledAddons is not called from the closure';
    if (call < update) return 'add-ons are refunded before the case is closed';
    const partial = fn.indexOf("skipped: 'partial_refund'");
    if (partial > 0 && call < partial) return 'add-ons would be refunded on the PARTIAL path';
  });

  check('structural: the real registry classes still refuse to refund a fulfilled add-on', () => {
    const v = code('src/services/addons/video_consult.js');
    const p = code('src/services/addons/prescription.js');
    for (const [n, s] of [['video_consult', v], ['prescription', p]]) {
      const i = s.indexOf('async onRefund(');
      if (i < 0) return n + ': onRefund missing';
      if (!/if \(addon\.status === 'fulfilled'\)[\s\S]{0,200}return null;/.test(s.slice(i, i + 600))) return n + ': onRefund no longer skips fulfilled';
    }
  });
})();
