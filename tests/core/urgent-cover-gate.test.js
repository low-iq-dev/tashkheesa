// tests/core/urgent-cover-gate.test.js — Urgent is sold only where a doctor covers the 4-hour tier (6 Oct 2026).
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); }
};
console.log('\n⏱️  urgent cover gate\n');
const src = (f) => fs.readFileSync(path.join(__dirname, '../../src', f), 'utf8');

(async function () {
  const uc = require('../../src/services/urgent_cover');
  try {
    let seen = null;
    uc.__setTestDeps({ pg: () => ({
      queryOne: async (sql, params) => { seen = { sql, params }; return params[1] === 'svc-covered' ? { service_id: 'svc-covered' } : null; },
      queryAll: async () => [{ service_id: 'svc-covered' }]
    }), logErrorToDb: () => {} });
    assert.strictEqual(await uc.serviceHasUrgentCover('svc-covered'), true);
    assert.strictEqual(await uc.serviceHasUrgentCover('svc-radiology'), false);
    assert.deepStrictEqual(seen.params[0], ['urgent']);
    for (const need of ["u.role = 'doctor'", 'is_active', 'is_paused', 'pending_approval', 'onboarding_complete', 'sla_tiers_supported', '\'["standard"]\'::jsonb']) {
      assert.ok(seen.sql.includes(need), 'cover query lost: ' + need);
    }
    const set = await uc.servicesWithUrgentCover();
    assert.ok(set.has('svc-covered') && !set.has('svc-radiology'));
    t.pass('cover = an active, approved, onboarded, un-paused doctor on the service who lists urgent; unconfirmed tiers read as standard-only');
  } catch (e) { t.fail('urgent-cover: rule', e); }

  try {
    uc.__setTestDeps({ pg: () => ({ queryOne: async () => { throw new Error('db down'); }, queryAll: async () => { throw new Error('db down'); } }), logErrorToDb: () => {} });
    assert.strictEqual(await uc.serviceHasUrgentCover('svc-x'), true, 'a query failure must not take Urgent off sale');
    assert.strictEqual(await uc.servicesWithUrgentCover(), null);
    t.pass('a database error fails open and is reported as unknown');
  } catch (e) { t.fail('urgent-cover: fail-open', e); }

  try {
    const intake = src('services/case_intake_pricing.js');
    assert.ok(/assertUrgentWindowOpen\(tier\);[\s\S]{0,200}serviceHasUrgentCover\(service\.id\)[\s\S]{0,120}URGENT_UNAVAILABLE/.test(intake), 'intake does not enforce urgent cover');
    const wiz = src('routes/patient.js');
    assert.ok(/serviceHasUrgentCover\(owned\.service_id\)[\s\S]{0,200}err=urgent_no_cover/.test(wiz), 'web wizard step 4 does not enforce urgent cover');
    const view = src('views/patient_new_case.ejs');
    assert.ok(/__urgentCovered \? \['standard', 'vip', 'urgent'\] : \['standard', 'vip'\]/.test(view), 'wizard still shows the Urgent tile when uncovered');
    assert.ok(/step4Err === 'urgent_no_cover'/.test(view), 'wizard has no message for urgent_no_cover');
    const api = src('routes/api/services.js');
    assert.ok(/urgentAvailable: windowOpen && \(!covered \|\| covered\.has\(String\(r\.id\)\)\)/.test(api), 'app catalogue does not stamp per-service urgent availability');
    t.pass('enforced at intake, on the web wizard (server + tile) and in the app catalogue');
  } catch (e) { t.fail('urgent-cover: wiring', e); }
})();
