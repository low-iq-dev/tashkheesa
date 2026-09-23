// tests/notifications/final-audit-notification-routing.test.js
//
// Final-audit batch (2026-09-23):
//   N-6  case_expired_unpaid_patient routed to 'payment' in push but to the
//        case in the in-app list. Same event, one destination now.
//   N-3  a doctor's reply never opened the chat thread: the web send
//        (routes/messaging.js) queued new_message without conversation_id,
//        and the in-app list never looked for one. Both surfaces now open the
//        thread, and fall back to the case when there is none.

'use strict';

// Route modules keep ONE module-level Router and register handlers on it each
// time their factory runs, so a factory called by an earlier test file in the
// same runner would answer first. Load a private copy, then put back whatever
// the cache held.
function freshRequire(rel) {
  const p = require.resolve(rel);
  const prev = require.cache[p];
  delete require.cache[p];
  try { return require(p); } finally { if (prev) require.cache[p] = prev; else delete require.cache[p]; }
}

const t = global._testRunner || {
  pass: (n) => console.log('  \x1b[32m✅\x1b[0m ' + n),
  fail: (n, e) => { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n🔔 final audit — notification tap targets (N-3, N-6)\n');

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const http = require('http');
const express = require('express');
const { stripComments } = require('../_helpers/strip-comments');

const ROOT = path.join(__dirname, '..', '..');

(function sourcePins() {
  try {
    const msg = stripComments(fs.readFileSync(path.join(ROOT, 'src/routes/messaging.js'), 'utf8'));
    const i = msg.indexOf("template: 'new_message'");
    const block = msg.slice(i, i + 700);
    if (!/conversation_id:\s*conversationId/.test(block)) throw new Error('web message send does not queue conversation_id');
    t.pass('N-3: the web message send queues conversation_id in the new_message payload');
  } catch (e) { t.fail('N-3: the web message send queues conversation_id in the new_message payload', e); }
  try {
    const { PUSH_TEMPLATES } = require('../../src/services/patient_push');
    assert.strictEqual(PUSH_TEMPLATES.case_expired_unpaid_patient.screen, 'payment');
    t.pass('N-6: push routes case_expired_unpaid_patient to payment (the in-app list must agree)');
  } catch (e) { t.fail('N-6: push routes case_expired_unpaid_patient to payment', e); }
})();

const ROWS = [
  { id: 'n1', type: 'case_expired_unpaid_patient', template: 'case_expired_unpaid_patient', title: 't', message: 'm', read: false, orderId: 'case-1', response: '{}', data: null, createdAt: '2026-09-23T10:00:00Z' },
  { id: 'n2', type: 'new_message', template: 'new_message', title: 't', message: 'm', read: false, orderId: 'case-1', response: JSON.stringify({ conversation_id: 'conv-A', messagePreview: 'secret' }), data: null, createdAt: '2026-09-23T10:00:00Z' },
  { id: 'n3', type: 'new_message', template: 'new_message', title: 't', message: 'm', read: false, orderId: 'case-2', response: '{"ok":true}', data: null, createdAt: '2026-09-23T10:00:00Z' },
  { id: 'n4', type: 'new_message', template: 'new_message', title: 't', message: 'm', read: false, orderId: 'case-3', response: '{"ok":true}', data: null, createdAt: '2026-09-23T10:00:00Z' },
];
const convoLookups = [];
const helpers = {
  safeAll: async (sql, p) => {
    if (/FROM notifications/.test(sql)) return ROWS.map((r) => Object.assign({}, r));
    if (/FROM conversations/.test(sql)) {
      convoLookups.push(p);
      return p[1].includes('case-2') ? [{ id: 'conv-B', order_id: 'case-2' }] : [];
    }
    throw new Error('unexpected SQL ' + sql.slice(0, 80));
  },
  safeGet: async () => ({ lang: 'en' }),
  safeRun: async () => ({ rowCount: 0 }),
};

const app = express();
app.use(require('../../src/middleware/apiResponse'));
app.use((req, _res, next) => { req.user = { id: 'pat-1', role: 'patient' }; next(); });
app.use('/notifications', freshRequire('../../src/routes/api/notifications')(null, helpers));

(async () => {
  const server = await new Promise((resolve) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const r = await fetch('http://127.0.0.1:' + server.address().port + '/notifications');
    const body = await r.json();
    const by = Object.fromEntries(body.data.map((n) => [n.id, n]));
    const cases = [
      ['N-6: the in-app case_expired_unpaid_patient row opens payment', () => assert.deepStrictEqual(by.n1.data, { screen: 'payment', caseId: 'case-1' })],
      ['N-3: a message row whose payload names the thread opens that thread', () => assert.deepStrictEqual(by.n2.data, { screen: 'chat', caseId: 'case-1', conversationId: 'conv-A' })],
      ['N-3: a row the worker already marked sent resolves the patient\'s thread from the case', () => {
        assert.deepStrictEqual(by.n3.data, { screen: 'chat', caseId: 'case-2', conversationId: 'conv-B' });
        assert.strictEqual(convoLookups[0][0], 'pat-1', 'lookup scoped to the patient');
      }],
      ['N-3: no thread at all → the case, as the push falls back', () => assert.deepStrictEqual(by.n4.data, { screen: 'case-detail', caseId: 'case-3' })],
      ['the raw payload (message preview) is never returned', () => assert.ok(body.data.every((n) => !('response' in n)))],
    ];
    for (const [name, fn] of cases) {
      try { fn(); t.pass(name); } catch (e) { t.fail(name, e); }
    }
  } catch (e) {
    t.fail('notification routing request', e);
  } finally {
    server.close();
  }
})();
