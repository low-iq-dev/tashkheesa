// tests/notifications/draft-nudge-tap-target.test.js
//
// Patient recovery follow-up (2 Nov 2026) — what a tap on a draft nudge opens
// in the app. The installed patient app (~/tashkheesa-app) routes an in-app
// notification on data.screen ('payment' | 'chat') and otherwise opens
// data.caseId on its case screen (app/(tabs)/cases/[id].tsx). GET
// /api/v1/cases/:id serves a draft, so that screen opens — but it offers no
// way to finish one: a draft is not payable (lib/caseDisplay PAYABLE_STATUSES
// = ['submitted']) and can be cancelled only in its first 10 minutes. The
// app resumes a draft only on its new-case screen, which finds the server
// draft itself.
//
// So GET /api/v1/notifications adds, ADDITIVELY, target: 'new-case' and
// draftId to the draft-resume nudges (and the coverage notice) while the case
// is still a draft. screen and caseId are untouched: an installed build does
// exactly what it did before; a build that reads `target` opens the wizard.

'use strict';

const assert = require('assert');
const express = require('express');
const http = require('http');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.stack || e)); process.exitCode = 1; },
};
async function check(name, fn) { try { await fn(); t.pass(name); } catch (e) { t.fail(name, e); } }

const DRAFT = 'd-draft-1';
const SENT = 'd-sent-2';
const CASE = 'c-paid-3';
const rows = [
  { id: 'n1', type: 'draft_resume_1h', template: 'draft_resume_1h', title: 't', message: 'm', read: false, orderId: DRAFT, response: '{}', data: null, createdAt: '2026-11-02T10:00:00Z' },
  { id: 'n2', type: 'draft_resume_24h', template: 'draft_resume_24h', title: 't', message: 'm', read: false, orderId: SENT, response: '{}', data: null, createdAt: '2026-11-01T10:00:00Z' },
  { id: 'n3', type: 'report_ready_patient', template: 'report_ready_patient', title: 't', message: 'm', read: true, orderId: CASE, response: '{}', data: null, createdAt: '2026-10-30T10:00:00Z' },
  { id: 'n4', type: 'coverage_lead_open', template: 'coverage_lead_open', title: 't', message: 'm', read: false, orderId: DRAFT, response: '{}', data: null, createdAt: '2026-10-29T10:00:00Z' },
];
const draftQueries = [];
const helpers = {
  safeAll: async (sql, params) => {
    if (/FROM notifications/.test(sql)) return rows.map((r) => Object.assign({}, r));
    if (/FROM orders/.test(sql)) {
      draftQueries.push({ sql, params });
      return params[0].filter((id) => id === DRAFT).map((id) => ({ id }));
    }
    return [];
  },
  safeGet: async () => ({ lang: 'ar' }),
  safeRun: async () => ({ rowCount: 0 }),
};

console.log('\n👆  draft nudge tap target (patient recovery follow-up)\n');

(async () => {
  const app = express();
  app.use(require('../../src/middleware/apiResponse'));
  app.use((req, _res, next) => { req.user = { id: 'p-1', role: 'patient' }; next(); });
  app.use('/notifications', require('../../src/routes/api/notifications')(null, helpers));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const res = await fetch('http://127.0.0.1:' + server.address().port + '/notifications');
  const body = await res.json();
  server.close();
  const by = {}; body.data.forEach((n) => { by[n.id] = n; });

  await check('a nudge on a case that is still a draft: screen and caseId as before, plus target new-case and draftId', () => {
    assert.deepStrictEqual(by.n1.data, { screen: 'case-detail', caseId: DRAFT, target: 'new-case', draftId: DRAFT });
    assert.deepStrictEqual(by.n4.data, { screen: 'case-detail', caseId: DRAFT, target: 'new-case', draftId: DRAFT }, 'the coverage notice too');
  });

  await check('a nudge whose case has since been sent: no target — the case screen is right again', () => {
    assert.deepStrictEqual(by.n2.data, { screen: 'case-detail', caseId: SENT });
  });

  await check('every other notification is untouched', () => {
    assert.deepStrictEqual(by.n3.data, { screen: 'case-detail', caseId: CASE });
  });

  await check('the draft check is one query, scoped to this patient, deleted and sent cases excluded', () => {
    assert.strictEqual(draftQueries.length, 1);
    const q = draftQueries[0];
    assert.ok(/patient_id = \$2/.test(q.sql) && /deleted_at IS NULL/.test(q.sql) && /UPPER\(COALESCE\(status, ''\)\) = 'DRAFT'/.test(q.sql));
    assert.deepStrictEqual(q.params[0].slice().sort(), [DRAFT, SENT].sort());
    assert.strictEqual(q.params[1], 'p-1');
  });
})();
