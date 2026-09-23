// tests/core/final-audit-conversations-contract.test.js
//
// Final-audit batch (2026-09-23) — /api/v1/conversations:
//   * POST /:id/messages actually enforces its body validator (declared, never
//     read) → 422 VALIDATION_ERROR, nothing inserted;
//   * a closed thread still answers 400 CONVO_CLOSED;
//   * list + detail expose status as 'open' | 'closed' and caseId.

'use strict';

const t = global._testRunner || {
  pass: (n) => console.log('  \x1b[32m✅\x1b[0m ' + n),
  fail: (n, e) => { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n💬 final audit — conversations contract (validator, CONVO_CLOSED, status, caseId)\n');

const assert = require('assert');
const http = require('http');
const express = require('express');

const CONVOS = {
  'c-open': { id: 'c-open', orderId: 'case-1', order_id: 'case-1', status: 'active', patient_id: 'pat-1', doctor_id: null },
  'c-closed': { id: 'c-closed', orderId: 'case-2', order_id: 'case-2', status: 'closed', patient_id: 'pat-1', doctor_id: null },
};
const inserts = [];
const helpers = {
  safeAll: async (sql) => {
    if (/FROM conversations c/.test(sql)) return Object.values(CONVOS).map((c) => ({ id: c.id, orderId: c.orderId, status: c.status }));
    if (/FROM messages/.test(sql)) return [];
    throw new Error('unexpected SQL ' + sql.slice(0, 80));
  },
  safeGet: async (sql, p) => {
    if (/FROM conversations c/.test(sql)) {
      const c = CONVOS[p[0]];
      if (!c || c.patient_id !== p[1]) return null;
      return /SELECT c\.\*/.test(sql) ? Object.assign({}, c) : { id: c.id, orderId: c.orderId, status: c.status };
    }
    if (/FROM messages WHERE id = \$1/.test(sql)) return { id: p[0], senderId: 'pat-1', body: 'x', createdAt: 'now' };
    throw new Error('unexpected SQL ' + sql.slice(0, 80));
  },
  safeRun: async (sql, p) => { if (/INSERT INTO messages/.test(sql)) inserts.push(p); return { rowCount: 1 }; },
};

const app = express();
app.use(require('../../src/middleware/apiResponse'));
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 'pat-1', role: 'patient', name: 'P' }; next(); });
app.use('/conversations', require('../../src/routes/api/conversations')(null, helpers));

(async () => {
  const server = await new Promise((resolve) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const checks = [
    ['an empty message → 422 VALIDATION_ERROR and nothing is inserted', async () => {
      const before = inserts.length;
      const r = await call('POST', '/conversations/c-open/messages', { body: '   ' });
      assert.strictEqual(r.status, 422, JSON.stringify(r.body));
      assert.strictEqual(r.body.code, 'VALIDATION_ERROR');
      assert.strictEqual(inserts.length, before);
    }],
    ['a 2001-character message → 422 VALIDATION_ERROR', async () => {
      const r = await call('POST', '/conversations/c-open/messages', { body: 'x'.repeat(2001) });
      assert.strictEqual(r.status, 422);
    }],
    ['a closed conversation → 400 CONVO_CLOSED', async () => {
      const r = await call('POST', '/conversations/c-closed/messages', { body: 'hello' });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.code, 'CONVO_CLOSED');
    }],
    ['a valid message in an open conversation is sent', async () => {
      const r = await call('POST', '/conversations/c-open/messages', { body: 'hello doctor' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(inserts[inserts.length - 1][3], 'hello doctor');
    }],
    ['list exposes status open|closed and caseId', async () => {
      const r = await call('GET', '/conversations');
      const by = Object.fromEntries(r.body.data.map((c) => [c.id, c]));
      assert.strictEqual(by['c-open'].status, 'open');
      assert.strictEqual(by['c-closed'].status, 'closed');
      assert.strictEqual(by['c-open'].caseId, 'case-1');
    }],
    ['detail exposes status and caseId', async () => {
      const r = await call('GET', '/conversations/c-closed');
      assert.strictEqual(r.body.data.status, 'closed');
      assert.strictEqual(r.body.data.caseId, 'case-2');
    }],
  ];
  try {
    for (const [name, fn] of checks) {
      try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); }
    }
  } finally {
    server.close();
  }
})();
