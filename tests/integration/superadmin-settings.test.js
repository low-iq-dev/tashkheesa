// tests/integration/superadmin-settings.test.js
//
// Theme 14 Phase 4 piece 4 — integration coverage for the new
// /superadmin/settings page.
//
// Three-stage verification (matches the in-house pattern from
// tests/core/theme8-silent-failures-view.test.js — no supertest/express
// boot, no live DB):
//
//   STAGE A — Source-grep lint on src/routes/superadmin.js
//     Route registration (GET + POST), requireSuperadmin gate, validation
//     (finite + [0,1]), withTransaction UPSERT shape, invalidateCache()
//     after success, csrfField on the form, and a nav link in
//     src/views/layouts/portal.ejs.
//
//   STAGE B — EJS render (in-process, no DB)
//     Renders src/views/superadmin_settings.ejs with mock locals and
//     asserts the HTML shape: three named inputs, current values,
//     CSRF stub, "Last updated" rows, soft ordering warning toggles
//     correctly.
//
//   STAGE C — Handler behaviour (isolated via child_process)
//     Patches pg + admin_settings inside a fresh Node process so the
//     parent require-cache stays clean. Drives the POST handler through
//     valid + invalid + DB-error inputs; asserts the redirect target,
//     that withTransaction received the right SQL/params, and that
//     invalidateCache was called on success exactly once.

'use strict';

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n⚙️  Theme 14 Phase 4 — /superadmin/settings integration\n');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SUPERADMIN_JS = path.join(PROJECT_ROOT, 'src', 'routes', 'superadmin.js');
const SETTINGS_EJS = path.join(PROJECT_ROOT, 'src', 'views', 'superadmin_settings.ejs');
const PORTAL_LAYOUT = path.join(PROJECT_ROOT, 'src', 'views', 'layouts', 'portal.ejs');

function assert(cond, label, detail) {
  if (cond) t.pass(fileTag + ': ' + label);
  else      t.fail(fileTag + ': ' + label, new Error(detail || 'assertion failed'));
}

// ─────────────────────────────────────────────────────────────────────────
// STAGE A — Source-grep lint
// ─────────────────────────────────────────────────────────────────────────

const superadminSrc = fs.readFileSync(SUPERADMIN_JS, 'utf8');
const portalSrc = fs.readFileSync(PORTAL_LAYOUT, 'utf8');

assert(
  /router\.get\(\s*['"]\/superadmin\/settings['"],\s*requireSuperadmin/.test(superadminSrc),
  'GET /superadmin/settings registered behind requireSuperadmin'
);
assert(
  /router\.post\(\s*['"]\/superadmin\/settings['"],\s*requireSuperadmin/.test(superadminSrc),
  'POST /superadmin/settings registered behind requireSuperadmin'
);
assert(
  /CLASSIFIER_THRESHOLD_KEYS\s*=\s*Object\.freeze\(\[[\s\S]*classifier_threshold_locked[\s\S]*classifier_threshold_auto[\s\S]*classifier_threshold_minimum/.test(superadminSrc),
  'CLASSIFIER_THRESHOLD_KEYS lists all three threshold keys'
);
assert(
  /isFinite\(parsed\)/.test(superadminSrc) &&
  /parsed\s*<\s*0/.test(superadminSrc) &&
  /parsed\s*>\s*1/.test(superadminSrc),
  'POST validates: finite number in [0, 1]'
);
assert(
  /withTransaction\(\s*async\s*\(?\s*client\s*\)?\s*=>/.test(superadminSrc) &&
  /INSERT INTO admin_settings[\s\S]*ON CONFLICT \(key\) DO UPDATE/.test(superadminSrc),
  'POST writes via withTransaction with ON CONFLICT (key) DO UPDATE'
);
assert(
  /updated_by\s*=\s*EXCLUDED\.updated_by/.test(superadminSrc) &&
  /updated_at\s*=\s*EXCLUDED\.updated_at/.test(superadminSrc),
  'UPDATE branch refreshes updated_by + updated_at on every save'
);
assert(
  /adminSettings\.invalidateCache\(\)/.test(superadminSrc),
  'POST calls adminSettings.invalidateCache() after a successful write'
);
assert(
  /\?saved=1/.test(superadminSrc) && /\?err=/.test(superadminSrc),
  'POST redirects with ?saved=1 on success and ?err=… on validation/write failure'
);
assert(
  /const adminSettings = require\(['"]\.\.\/services\/admin_settings['"]\)/.test(superadminSrc),
  'superadmin.js imports the admin_settings helper'
);

// View shape
const viewSrc = fs.readFileSync(SETTINGS_EJS, 'utf8');
assert(
  /portalRole:\s*['"]superadmin['"]/.test(viewSrc) &&
  /portalActive:\s*['"]settings['"]/.test(viewSrc),
  'view is wired into the superadmin portal frame with portalActive="settings"'
);
assert(
  /name="classifier_threshold_locked"/.test(viewSrc) &&
  /name="classifier_threshold_auto"/.test(viewSrc) &&
  /name="classifier_threshold_minimum"/.test(viewSrc),
  'view has three named inputs matching the threshold keys'
);
assert(
  /method="post"/i.test(viewSrc) && /action="\/superadmin\/settings"/.test(viewSrc),
  'form POSTs back to /superadmin/settings'
);
assert(
  /csrfField/.test(viewSrc),
  'form includes csrfField()'
);

// Nav link
assert(
  /href="\/superadmin\/settings"/.test(portalSrc) &&
  /isActive\(['"]settings['"]\)/.test(portalSrc),
  'portal.ejs has Settings nav link in the superadmin sidebar with isActive("settings")'
);

// ─────────────────────────────────────────────────────────────────────────
// STAGE B — EJS render (in-process, no DB, no express)
// ─────────────────────────────────────────────────────────────────────────

const ejs = require('ejs');

function renderSettingsView(overrides) {
  const baseLocals = {
    user: { id: 'u-superadmin', role: 'superadmin', email: 'z@example.com' },
    lang: 'en',
    isAr: false,
    dir: 'ltr',
    thresholds: {
      locked:  { key: 'classifier_threshold_locked',  value: '0.95', updated_by: 'admin-1', updated_at: '2026-05-17T10:00:00Z' },
      auto:    { key: 'classifier_threshold_auto',    value: '0.85', updated_by: null,       updated_at: null },
      minimum: { key: 'classifier_threshold_minimum', value: '0.55', updated_by: 'admin-2', updated_at: '2026-05-17T11:00:00Z' }
    },
    defaults: { classifier_threshold_locked: 0.95, classifier_threshold_auto: 0.85, classifier_threshold_minimum: 0.55 },
    saved: false,
    queryErr: '',
    csrfField: function () { return '<input type="hidden" name="_csrf" value="stub-token"/>'; }
  };
  const locals = Object.assign({}, baseLocals, overrides || {});
  const tplSrc = fs.readFileSync(SETTINGS_EJS, 'utf8');
  return ejs.render(tplSrc, locals, {
    filename: SETTINGS_EJS,
    views: [path.join(PROJECT_ROOT, 'src', 'views')],
    async: false
  });
}

(function () {
  const html = renderSettingsView({});
  assert(html.indexOf('Classifier confidence thresholds') >= 0, 'view renders section heading');
  assert(html.indexOf('value="0.95"') >= 0, 'view pre-fills the locked input with current DB value');
  assert(html.indexOf('value="0.85"') >= 0, 'view pre-fills the auto input with current DB value');
  assert(html.indexOf('value="0.55"') >= 0, 'view pre-fills the minimum input with current DB value');
  assert(html.indexOf('admin-1') >= 0, 'view surfaces updated_by for the locked row');
  assert(html.indexOf('Last updated:') >= 0, 'view renders the Last updated audit line');
  assert(html.indexOf('stub-token') >= 0, 'view includes CSRF token via csrfField()');
  assert(html.indexOf('Heads up:') < 0, 'view does NOT show the ordering warning when locked > auto > minimum holds');
})();

// Soft ordering warning fires when ordering is violated
(function () {
  const html = renderSettingsView({
    thresholds: {
      locked:  { key: 'classifier_threshold_locked',  value: '0.40', updated_by: null, updated_at: null },
      auto:    { key: 'classifier_threshold_auto',    value: '0.85', updated_by: null, updated_at: null },
      minimum: { key: 'classifier_threshold_minimum', value: '0.55', updated_by: null, updated_at: null }
    }
  });
  assert(html.indexOf('Heads up:') >= 0, 'view DOES show ordering warning when locked < auto');
  // EJS <%= … %> HTML-escapes `>` → `&gt;`; assert the rendered form, not the source form.
  assert(html.indexOf('locked &gt; auto &gt; minimum') >= 0, 'warning copy names the expected ordering');
})();

// "Saved" banner fires when saved=true
(function () {
  const html = renderSettingsView({ saved: true });
  assert(html.indexOf('Saved.') >= 0,            'saved banner renders when saved=true');
  assert(html.indexOf('cache invalidated') >= 0, 'saved banner mentions cache invalidation');
})();

// Error banner fires when queryErr is set
(function () {
  const html = renderSettingsView({ queryErr: 'classifier_threshold_locked:invalid' });
  assert(html.indexOf('Save failed.') >= 0,                                'error banner renders when queryErr is set');
  assert(html.indexOf('classifier_threshold_locked:invalid') >= 0,         'error banner echoes the err code for diagnosability');
})();

// Defaults-only path (rows missing — never loaded)
(function () {
  const html = renderSettingsView({
    thresholds: { locked: null, auto: null, minimum: null }
  });
  assert(html.indexOf('value="0.95"') >= 0 && html.indexOf('value="0.85"') >= 0 && html.indexOf('value="0.55"') >= 0,
    'rows missing → view falls back to default values without crashing');
  assert(html.indexOf('Last updated:') < 0, 'no "Last updated" rendered when there are no rows');
})();

// ─────────────────────────────────────────────────────────────────────────
// STAGE C — Handler behaviour (isolated via child_process)
//
// Patches pg + admin_settings inside a fresh Node process, requires the
// superadmin router, locates the POST /superadmin/settings handler, and
// drives it through three scenarios. The child writes a JSON report on
// stdout; this test parses it and asserts.
// ─────────────────────────────────────────────────────────────────────────

const childScript = `
'use strict';

const path = require('path');
process.chdir(${JSON.stringify(PROJECT_ROOT)});

// Patch pg BEFORE requiring superadmin.js. superadmin.js destructures
// { withTransaction } at module load — so we MUST install a function
// delegator now and only swap its inner strategy per-scenario.
const pgPath = require.resolve('./src/pg');
let __currentTxStrategy = async function () { throw new Error('tx strategy not set'); };
const pgStub = {
  pool: { connect: async function () { throw new Error('pg.pool.connect not stubbed in this scenario'); } },
  queryOne: async function () { return null; },
  queryAll: async function () { return []; },
  execute:  async function () { return { rowCount: 0 }; },
  withTransaction: function (fn) { return __currentTxStrategy(fn); }
};
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: pgStub };

// Patch admin_settings to record invalidateCache calls.
const asPath = require.resolve('./src/services/admin_settings');
const adminSettingsStub = {
  DEFAULTS: { classifier_threshold_locked: 0.95, classifier_threshold_auto: 0.85, classifier_threshold_minimum: 0.55 },
  CACHE_TTL_MS: 60000,
  getThreshold: async function () { return 0.95; },
  getThresholds: async function () { return { lock: 0.95, auto: 0.85, min: 0.55 }; },
  invalidateCache: function () { adminSettingsStub.__calls = (adminSettingsStub.__calls || 0) + 1; },
  __calls: 0
};
require.cache[asPath] = { id: asPath, filename: asPath, loaded: true, exports: adminSettingsStub };

// Stub the logger so we don't try to write to error_logs.
const loggerPath = require.resolve('./src/logger');
const realLogger = require(loggerPath);
require.cache[loggerPath] = {
  id: loggerPath, filename: loggerPath, loaded: true,
  exports: Object.assign({}, realLogger, {
    logErrorToDb: async function () { return 'err-test-id'; }
  })
};

// Stub middleware so requireRole('superadmin') is a passthrough.
const mwPath = require.resolve('./src/middleware');
const realMw = require(mwPath);
require.cache[mwPath] = {
  id: mwPath, filename: mwPath, loaded: true,
  exports: Object.assign({}, realMw, {
    requireRole: function () { return function (req, res, next) { return next(); }; }
  })
};

// superadmin.js exports { router, buildFilters } — unwrap to the actual Router.
const router = require('./src/routes/superadmin').router;

// Find the POST /superadmin/settings handler by walking router.stack.
function findHandler(method, urlPath) {
  for (const layer of router.stack || []) {
    if (!layer || !layer.route) continue;
    const r = layer.route;
    const m = r.methods && r.methods[method];
    if (!m) continue;
    const p = r.path || (r.regexp && r.regexp.source) || '';
    if (p === urlPath) {
      // Last middleware on the chain is the handler.
      const stack = r.stack || [];
      return stack[stack.length - 1].handle;
    }
  }
  return null;
}

function makeReq(body, query) {
  return {
    body: body || {},
    query: query || {},
    user: { id: 'u-test-superadmin', role: 'superadmin', email: 'z@example.com' },
    originalUrl: '/superadmin/settings',
    method: 'POST',
    requestId: 'req-test-1'
  };
}
function makeRes() {
  const res = { _redirectTarget: null, _status: 200 };
  res.status = function (s) { res._status = s; return res; };
  res.redirect = function (target) { res._redirectTarget = target; return res; };
  res.render = function () { res._rendered = true; return res; };
  return res;
}

(async function main() {
  const report = { scenarios: [] };
  const post = findHandler('post', '/superadmin/settings');
  if (typeof post !== 'function') {
    process.stdout.write(JSON.stringify({ error: 'POST handler not located in router.stack' }));
    process.exit(1);
  }

  // ── Scenario 1 — happy path. Capture withTransaction calls. ──────────
  {
    adminSettingsStub.__calls = 0;
    const txCalls = [];
    __currentTxStrategy = async function (fn) {
      const client = {
        query: async function (sql, params) {
          txCalls.push({ sql: sql.replace(/\\s+/g, ' ').trim(), params: params });
          return { rowCount: 1 };
        }
      };
      return await fn(client);
    };
    const req = makeReq({
      classifier_threshold_locked:  '0.94',
      classifier_threshold_auto:    '0.84',
      classifier_threshold_minimum: '0.54'
    });
    const res = makeRes();
    await post(req, res);
    report.scenarios.push({
      name: 'happy_path',
      redirect: res._redirectTarget,
      invalidateCacheCalls: adminSettingsStub.__calls,
      txCallsCount: txCalls.length,
      txParams: txCalls.map(function (c) { return c.params; }),
      txSqlAllUpsert: txCalls.length > 0 && txCalls.every(function (c) {
        return /INSERT INTO admin_settings/.test(c.sql) && /ON CONFLICT \\(key\\) DO UPDATE/.test(c.sql);
      })
    });
  }

  // ── Scenario 2 — invalid value rejected, no write, no cache flush. ───
  {
    adminSettingsStub.__calls = 0;
    let touched = false;
    __currentTxStrategy = async function () { touched = true; return; };
    const req = makeReq({
      classifier_threshold_locked:  'not-a-number',
      classifier_threshold_auto:    '0.85',
      classifier_threshold_minimum: '0.55'
    });
    const res = makeRes();
    await post(req, res);
    report.scenarios.push({
      name: 'invalid_value',
      redirect: res._redirectTarget,
      invalidateCacheCalls: adminSettingsStub.__calls,
      withTransactionCalled: touched
    });
  }

  // ── Scenario 3 — out-of-range rejected. ──────────────────────────────
  {
    adminSettingsStub.__calls = 0;
    let touched = false;
    __currentTxStrategy = async function () { touched = true; return; };
    const req = makeReq({
      classifier_threshold_locked:  '1.5',
      classifier_threshold_auto:    '0.85',
      classifier_threshold_minimum: '0.55'
    });
    const res = makeRes();
    await post(req, res);
    report.scenarios.push({
      name: 'out_of_range',
      redirect: res._redirectTarget,
      invalidateCacheCalls: adminSettingsStub.__calls,
      withTransactionCalled: touched
    });
  }

  // ── Scenario 4 — DB write fails. ─────────────────────────────────────
  {
    adminSettingsStub.__calls = 0;
    __currentTxStrategy = async function () { throw new Error('synthetic_db_failure'); };
    const req = makeReq({
      classifier_threshold_locked:  '0.95',
      classifier_threshold_auto:    '0.85',
      classifier_threshold_minimum: '0.55'
    });
    const res = makeRes();
    await post(req, res);
    report.scenarios.push({
      name: 'db_write_fails',
      redirect: res._redirectTarget,
      invalidateCacheCalls: adminSettingsStub.__calls
    });
  }

  // Sentinel-delimited JSON so the parent can locate the report even
  // when dotenv (or any other side-effect import) writes to stdout first.
  process.stdout.write('\\n__TEST_REPORT__' + JSON.stringify(report) + '__END_TEST_REPORT__\\n');
})().catch(function (err) {
  process.stdout.write(JSON.stringify({ error: String((err && err.stack) || err) }));
  process.exit(1);
});
`;

(function runStageC() {
  let stdout;
  try {
    stdout = execFileSync(process.execPath, ['-e', childScript], {
      cwd: PROJECT_ROOT,
      env: Object.assign({}, process.env, { NODE_ENV: 'test' }),
      encoding: 'utf8',
      timeout: 20000
    });
  } catch (err) {
    t.fail(fileTag + ': stage-C child process crashed', err);
    return;
  }

  // Extract sentinel-delimited JSON; the child may print dotenv/banner
  // noise to stdout before our payload.
  const match = stdout.match(/__TEST_REPORT__([\s\S]*?)__END_TEST_REPORT__/);
  if (!match) {
    t.fail(fileTag + ': stage-C output missing sentinel', new Error(stdout.slice(-500)));
    return;
  }
  let report;
  try { report = JSON.parse(match[1]); } catch (e) {
    t.fail(fileTag + ': stage-C payload was not valid JSON', new Error(match[1].slice(0, 500)));
    return;
  }
  if (report.error) {
    t.fail(fileTag + ': stage-C child reported error', new Error(report.error));
    return;
  }

  const byName = {};
  for (const s of report.scenarios || []) byName[s.name] = s;

  // Scenario 1 — happy path
  const happy = byName.happy_path || {};
  assert(happy.redirect === '/superadmin/settings?saved=1',
    'happy path redirects to /superadmin/settings?saved=1 (got ' + happy.redirect + ')');
  assert(happy.txCallsCount === 3,
    'happy path issues exactly 3 UPSERTs (got ' + happy.txCallsCount + ')');
  assert(happy.txSqlAllUpsert === true,
    'happy path uses INSERT … ON CONFLICT (key) DO UPDATE for every row');
  assert(happy.invalidateCacheCalls === 1,
    'happy path calls invalidateCache() exactly once (got ' + happy.invalidateCacheCalls + ')');
  assert(
    Array.isArray(happy.txParams) &&
    happy.txParams.some(function (p) { return p && p[0] === 'classifier_threshold_locked'  && p[1] === '0.94' && p[2] === 'u-test-superadmin'; }) &&
    happy.txParams.some(function (p) { return p && p[0] === 'classifier_threshold_auto'    && p[1] === '0.84' && p[2] === 'u-test-superadmin'; }) &&
    happy.txParams.some(function (p) { return p && p[0] === 'classifier_threshold_minimum' && p[1] === '0.54' && p[2] === 'u-test-superadmin'; }),
    'UPSERT params carry (key, value, userId) for all 3 keys'
  );

  // Scenario 2 — invalid value (NaN)
  const invalid = byName.invalid_value || {};
  assert(invalid.withTransactionCalled === false,
    'invalid value: NO withTransaction call (no DB write)');
  assert(invalid.invalidateCacheCalls === 0,
    'invalid value: NO cache invalidation');
  assert(typeof invalid.redirect === 'string' && /\/superadmin\/settings\?err=/.test(invalid.redirect),
    'invalid value: redirects to /superadmin/settings?err=… (got ' + invalid.redirect + ')');
  assert(typeof invalid.redirect === 'string' && /classifier_threshold_locked/.test(decodeURIComponent(invalid.redirect)),
    'invalid value: err= identifies the offending key');

  // Scenario 3 — out-of-range
  const oor = byName.out_of_range || {};
  assert(oor.withTransactionCalled === false,
    'out-of-range value: NO withTransaction call');
  assert(oor.invalidateCacheCalls === 0,
    'out-of-range value: NO cache invalidation');
  assert(typeof oor.redirect === 'string' && /\/superadmin\/settings\?err=/.test(oor.redirect),
    'out-of-range value: redirects to /superadmin/settings?err=… (got ' + oor.redirect + ')');

  // Scenario 4 — DB write fails
  const dbf = byName.db_write_fails || {};
  assert(dbf.redirect === '/superadmin/settings?err=write_failed',
    'DB write failure: redirects to ?err=write_failed (got ' + dbf.redirect + ')');
  assert(dbf.invalidateCacheCalls === 0,
    'DB write failure: cache NOT invalidated (state never changed)');
})();
