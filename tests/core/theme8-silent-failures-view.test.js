// tests/core/theme8-silent-failures-view.test.js
//
// Theme 8 Phase 5 regression guard — /ops/silent-failures view.
//
// The view is the operator-facing surface for the signals Phases 1-4
// are now generating. It consumes the SILENT_FAILURE_EVENTS registry
// in case_lifecycle.js via SQL LIKE patterns on case_events.event_type
// suffixes (_SKIPPED / _FAILED / _DROPPED / _NO_OP).
//
// Three-stage verification:
//
//   STAGE A — source-grep lint
//     Asserts the route is registered with requireOpsAuth, the view
//     file exists with the right shape, the dashboard card links to
//     /ops/silent-failures, the LIKE patterns cover all 4 registry
//     literals from Phase 3, and the suffix-convention guard exists.
//
//   STAGE B — view rendering (in-process, EJS only, no DB)
//     Renders the EJS template with empty + populated locals and
//     asserts the right HTML shape (empty-state message vs cards +
//     table; color tier classes).
//
//   STAGE C — handler behavioral test via child_process
//     Patches pg.queryAll to return mock case_events rows. Asserts the
//     handler aggregates counts correctly, parses event_payload, and
//     surfaces a totalCount. Same isolation pattern as Phase 3/4 —
//     no parent require-cache pollution.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭\xEF\xB8\x8F\x1b[0m  ' + n + ' (' + r + ')'); }
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n👁️  Theme 8 Phase 5 — /ops/silent-failures view + dashboard card\n');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const OPS_JS = path.join(PROJECT_ROOT, 'src', 'routes', 'ops.js');
const VIEW = path.join(PROJECT_ROOT, 'src', 'views', 'ops-silent-failures.ejs');
const DASHBOARD = path.join(PROJECT_ROOT, 'src', 'views', 'ops-dashboard.ejs');
const CASE_LIFECYCLE = path.join(PROJECT_ROOT, 'src', 'case_lifecycle.js');

function assert(cond, label, detail) {
  if (cond) t.pass(fileTag + ': ' + label);
  else      t.fail(fileTag + ': ' + label, new Error(detail || 'assertion failed'));
}

// ─────────────────────────────────────────────────────────────────────────
// STAGE A — Source-grep lint
// ─────────────────────────────────────────────────────────────────────────

const opsSrc = fs.readFileSync(OPS_JS, 'utf8');
const viewSrc = fs.readFileSync(VIEW, 'utf8');
const dashSrc = fs.readFileSync(DASHBOARD, 'utf8');
const lifecycleSrc = fs.readFileSync(CASE_LIFECYCLE, 'utf8');

// 1. Route is registered with requireOpsAuth.
assert(
  /router\.get\s*\(\s*['"]\/silent-failures['"]\s*,\s*requireOpsAuth\s*,/.test(opsSrc),
  "GET /silent-failures is registered with requireOpsAuth middleware",
  "expected router.get('/silent-failures', requireOpsAuth, ...) in ops.js"
);

// 2. View file exists and uses the canonical ops layout shell.
assert(
  /<title>Ops — Silent Failures<\/title>/i.test(viewSrc),
  "ops-silent-failures.ejs has the canonical <title>",
  "expected 'Ops — Silent Failures' title"
);
assert(
  /No silent failures detected in the last 7 days/i.test(viewSrc),
  "view has the empty-state message",
  "expected 'No silent failures detected in the last 7 days' in view"
);
// CSS class definitions for the tiers (matched on the .card.X CSS rules
// in the inline <style> block, not the template's dynamic `class="card
// <%= cls %>"` expression which only resolves at render time).
assert(
  /\.card\.ok\b/.test(viewSrc) &&
  /\.card\.warn\b/.test(viewSrc) &&
  /\.card\.error\b/.test(viewSrc),
  "view defines ops-dashboard color-tier CSS classes (ok / warn / error)",
  "expected '.card.ok' / '.card.warn' / '.card.error' rules in <style> block"
);
// And the EJS expression chooses among them by count threshold.
assert(
  /n\s*>=\s*50\s*\?\s*['"]error['"]/.test(viewSrc) &&
  /n\s*>=\s*5\s*\?\s*['"]warn['"]/.test(viewSrc),
  "view picks color tier by count thresholds (50+ red, 5+ amber, else green)",
  "expected `n >= 50 ? 'error' : n >= 5 ? 'warn' : 'ok'` ternary in view"
);
assert(
  /\/superadmin\/orders\//.test(viewSrc),
  "view links case IDs to /superadmin/orders/:id",
  "expected '/superadmin/orders/' link template in view"
);

// 3. Dashboard quick-link card is present.
assert(
  /href\s*=\s*['"]\/ops\/silent-failures['"]/.test(dashSrc),
  "ops-dashboard.ejs has a link to /ops/silent-failures",
  "expected href='/ops/silent-failures' in dashboard"
);
assert(
  /Silent Failures \(7d\)/.test(dashSrc),
  "ops-dashboard.ejs labels the card 'Silent Failures (7d)'",
  "expected 'Silent Failures (7d)' label in dashboard"
);

// 4. LIKE patterns cover all 4 SILENT_FAILURE_EVENTS literals from Phase 3.
//    SLA_PAUSE_SKIPPED → matches '%_SKIPPED'
//    SLA_RESUME_SKIPPED → matches '%_SKIPPED'
//    CASE_REASSIGNMENT_FAILED → matches '%_FAILED'
//    NOTIFICATION_DROPPED → matches '%_DROPPED'
const REGISTRY_LITERALS = [
  'SLA_PAUSE_SKIPPED',
  'SLA_RESUME_SKIPPED',
  'CASE_REASSIGNMENT_FAILED',
  'NOTIFICATION_DROPPED'
];
// Each LIKE pattern in the JS source is written as `'%\\_SKIPPED'` —
// at the JavaScript source-text level that's literally `%\\_SKIPPED`
// (two backslash characters). To match those bytes from a regex literal
// we need four backslashes (regex escape × 2 = source escape × 2).
const LIKE_PATTERNS = [
  { pat: /%\\\\_SKIPPED/, name: '%_SKIPPED' },
  { pat: /%\\\\_FAILED/, name: '%_FAILED' },
  { pat: /%\\\\_DROPPED/, name: '%_DROPPED' },
  { pat: /%\\\\_NO\\\\_OP/, name: '%_NO_OP' },
];
// Confirm ops.js contains all 4 LIKE patterns.
for (const lp of LIKE_PATTERNS) {
  assert(
    lp.pat.test(opsSrc),
    "ops.js silent-failures query contains LIKE '" + lp.name + "'",
    "missing LIKE pattern"
  );
}
// Confirm every registry literal would match one of the LIKE patterns.
// (Simulate the LIKE in JS — strip '%' and check suffix.)
function matchesAnyLikeSuffix(literal) {
  const suffixes = ['_SKIPPED', '_FAILED', '_DROPPED', '_NO_OP'];
  return suffixes.some(function (s) { return literal.endsWith(s); });
}
for (const lit of REGISTRY_LITERALS) {
  assert(
    matchesAnyLikeSuffix(lit),
    "registry literal '" + lit + "' is matched by at least one LIKE pattern",
    "literal does not end in a known suffix — the LIKE query would miss it"
  );
  // Also confirm the literal is actually IN the SILENT_FAILURE_EVENTS const.
  assert(
    lifecycleSrc.indexOf("'" + lit + "'") !== -1 ||
    lifecycleSrc.indexOf('"' + lit + '"') !== -1,
    "registry literal '" + lit + "' is present in case_lifecycle.SILENT_FAILURE_EVENTS",
    "literal not found in case_lifecycle.js"
  );
}

// 5. Suffix-convention guard is wired (defensive boot-time check).
assert(
  /SILENT_FAILURE_SUFFIXES/.test(opsSrc) &&
  /WARNING: registry literal/.test(opsSrc),
  "ops.js has the SILENT_FAILURE_SUFFIXES boot-time guard with a WARNING log",
  "expected SILENT_FAILURE_SUFFIXES + WARNING in ops.js"
);

// 6. SILENT_FAILURE_EVENTS is imported.
assert(
  /require\(['"]\.\.\/case_lifecycle['"]\)/.test(opsSrc) &&
  /SILENT_FAILURE_EVENTS/.test(opsSrc),
  "ops.js imports SILENT_FAILURE_EVENTS from case_lifecycle",
  "expected destructured import"
);

// ─────────────────────────────────────────────────────────────────────────
// STAGE B — View rendering (in-process EJS, no DB)
// ─────────────────────────────────────────────────────────────────────────

const ejs = require('ejs');

// B1. Empty state renders the success message.
{
  let html = '';
  try {
    html = ejs.render(viewSrc, {
      counts: [], recent: [], totalCount: 0,
      registry: REGISTRY_LITERALS
    }, { filename: VIEW });
  } catch (e) {
    t.fail(fileTag + ': empty-state EJS render throws', e);
  }
  assert(
    html.indexOf('No silent failures detected in the last 7 days') !== -1,
    "empty-state render: shows success message",
    "expected success-state message in HTML"
  );
  assert(
    html.indexOf('<table>') === -1,
    "empty-state render: does NOT render the recent table",
    "table element appeared in empty render"
  );
}

// B2. Populated state renders summary + table with correct color tiers.
{
  const counts = [
    { event_type: 'NOTIFICATION_DROPPED', c: 73 },          // 50+ → red
    { event_type: 'CASE_REASSIGNMENT_FAILED', c: 8 },       // 5-49 → amber
    { event_type: 'SLA_PAUSE_SKIPPED', c: 2 }               // <5 → green
  ];
  const recent = [
    {
      case_id: 'ord_test_abc',
      event_type: 'NOTIFICATION_DROPPED',
      event_payload: JSON.stringify({ reason: 'invalid_to_user_id', toUserId: 'x@y.com' }),
      created_at: new Date()
    },
    {
      case_id: 'ord_test_def',
      event_type: 'CASE_REASSIGNMENT_FAILED',
      event_payload: JSON.stringify({ reason: 'no_doctor_available' }),
      created_at: new Date()
    }
  ];
  // Mimic the route handler's normalization
  recent.forEach(function (r) {
    let p = null;
    try { p = JSON.parse(r.event_payload); } catch (_) {}
    r.payload_parsed = p;
    r.reason = p && p.reason ? p.reason : '';
    r.time_ago = 'just now';
  });

  let html = '';
  try {
    html = ejs.render(viewSrc, { counts, recent, totalCount: 83, registry: REGISTRY_LITERALS }, { filename: VIEW });
  } catch (e) {
    t.fail(fileTag + ': populated EJS render throws', e);
  }
  assert(html.indexOf('NOTIFICATION_DROPPED') !== -1,
    "populated render: contains the event_type label", "");
  assert(html.indexOf('card error') !== -1,
    "populated render: red tier (50+) applied via 'card error' class", "");
  assert(html.indexOf('card warn') !== -1,
    "populated render: amber tier (5-49) applied via 'card warn' class", "");
  assert(html.indexOf('card ok') !== -1,
    "populated render: green tier (<5) applied via 'card ok' class", "");
  assert(html.indexOf('/superadmin/orders/ord_test_abc') !== -1,
    "populated render: case ID links to /superadmin/orders/:id",
    "expected case-link URL in HTML");
  assert(html.indexOf('invalid_to_user_id') !== -1,
    "populated render: payload.reason surfaces in the Reason column", "");
  assert(html.indexOf('<table>') !== -1,
    "populated render: includes the recent table", "");
}

// ─────────────────────────────────────────────────────────────────────────
// STAGE C — Handler behavioral assertion via child_process
//
// Patches pg.queryAll on the real ops.js handler module to return mock
// case_events rows. Asserts the handler aggregates counts correctly,
// parses event_payload (graceful on non-JSON), and surfaces totalCount.
// ─────────────────────────────────────────────────────────────────────────

const subprocessScript = `
'use strict';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-subproc-secret';
process.env.MODE = process.env.MODE || 'development';
(async function () {
  const path = require('path');
  const projectRoot = ${JSON.stringify(PROJECT_ROOT)};

  // Patch pg BEFORE ops.js loads. ops.js uses sql-utils.safeAll (line ~70
  // in ops.js) which wraps queryAll — patching pg.queryAll at the module
  // level makes the wrapper see our fakes.
  const pg = require(path.join(projectRoot, 'src', 'pg'));
  pg.queryAll = async function (sql) {
    if (/SELECT event_type, COUNT/i.test(sql)) {
      return [
        { event_type: 'NOTIFICATION_DROPPED', c: '17' },
        { event_type: 'SLA_PAUSE_SKIPPED', c: '3' }
      ];
    }
    if (/SELECT case_id, event_type/i.test(sql)) {
      return [
        { case_id: 'ord_subproc_1', event_type: 'NOTIFICATION_DROPPED',
          event_payload: JSON.stringify({ reason: 'no_phone', toUserId: 'u_1' }),
          created_at: new Date() },
        { case_id: 'ord_subproc_2', event_type: 'SLA_PAUSE_SKIPPED',
          event_payload: 'legacy_non_json_payload',
          created_at: new Date() }
      ];
    }
    return [];
  };
  pg.queryOne = async function () { return null; };
  pg.execute = async function () { return { rowCount: 0 }; };

  // Load the router and pluck the /silent-failures route handler from
  // its stack — no express server, no supertest, no http round-trip.
  const opsRouter = require(path.join(projectRoot, 'src', 'routes', 'ops'));
  let handler = null;
  for (const layer of (opsRouter.stack || [])) {
    if (layer.route && layer.route.path === '/silent-failures') {
      // Layer.route.stack contains middlewares (requireOpsAuth, then handler).
      // The actual handler is the LAST middleware in the route stack.
      const mws = layer.route.stack || [];
      handler = mws.length ? mws[mws.length - 1].handle : null;
      break;
    }
  }
  if (!handler) {
    process.stderr.write('NO_HANDLER_FOUND\\n');
    process.exit(3);
  }

  // Build mock req/res. The handler calls res.render(view, locals);
  // we capture that.
  const req = {
    requestId: 'req_subproc',
    user: { id: 'u_ops' },
    originalUrl: '/ops/silent-failures',
    method: 'GET',
    query: {},
    get: function () { return null; }
  };
  let captured = null;
  const res = {
    render: function (view, locals) { captured = { view: view, locals: locals }; },
    status: function () { return res; },
    send: function () {},
    type: function () { return res; },
    json: function () {},
    redirect: function () {},
    setHeader: function () {}
  };

  await handler(req, res, function (err) {
    if (err) {
      process.stderr.write('HANDLER_ERR: ' + (err.stack || err) + '\\n');
      process.exit(4);
    }
  });

  // Give floating microtasks a tick to settle.
  await new Promise(function (r) { setImmediate(r); });

  process.stdout.write('THEME8_PHASE5_RESULT=' + JSON.stringify({
    view: captured && captured.view,
    countsLen: captured && captured.locals && captured.locals.counts ? captured.locals.counts.length : -1,
    totalCount: captured && captured.locals && captured.locals.totalCount,
    recentLen: captured && captured.locals && captured.locals.recent ? captured.locals.recent.length : -1,
    firstRecentReason: captured && captured.locals && captured.locals.recent && captured.locals.recent[0] ? captured.locals.recent[0].reason : null,
    secondRecentPayloadParsed: captured && captured.locals && captured.locals.recent && captured.locals.recent[1] ? captured.locals.recent[1].payload_parsed : 'absent',
    registryLen: captured && captured.locals && captured.locals.registry ? captured.locals.registry.length : -1
  }) + '\\n');
})().catch(function (err) {
  process.stderr.write('SUBPROC_ERROR: ' + (err && err.stack || err) + '\\n');
  process.exit(2);
});
`;

let subprocOut = '';
let subprocErr = null;
try {
  subprocOut = execFileSync(process.execPath, ['-e', subprocessScript], {
    encoding: 'utf8',
    timeout: 20000,
    env: Object.assign({}, process.env, { PG_SSL: 'false' })
  });
} catch (e) {
  subprocErr = e;
}

if (subprocErr) {
  t.fail(fileTag + ': subprocess exited with error',
    new Error('stderr: ' + ((subprocErr.stderr && subprocErr.stderr.toString()) || subprocErr.message)));
} else {
  const marker = 'THEME8_PHASE5_RESULT=';
  const idx = subprocOut.indexOf(marker);
  if (idx === -1) {
    t.fail(fileTag + ': subprocess did not emit THEME8_PHASE5_RESULT line',
      new Error('stdout: ' + subprocOut.slice(0, 500)));
  } else {
    const jsonLine = subprocOut.slice(idx + marker.length).split('\n')[0];
    let r;
    try { r = JSON.parse(jsonLine); }
    catch (e) {
      t.fail(fileTag + ': subprocess produced malformed JSON', new Error('line=' + jsonLine.slice(0, 200)));
      r = null;
    }
    if (r && r.skipped) {
      t.skip(fileTag + ': behavioral subprocess', r.skipped);
    } else if (r) {
      assert(r.view === 'ops-silent-failures',
        "behavioral: handler renders 'ops-silent-failures' view",
        "view=" + r.view);
      assert(r.countsLen === 2,
        "behavioral: handler aggregates 2 event_type counts (NOTIFICATION_DROPPED + SLA_PAUSE_SKIPPED)",
        "saw " + r.countsLen);
      assert(r.totalCount === 20,
        "behavioral: handler sums totalCount across counts (17 + 3 = 20)",
        "totalCount=" + r.totalCount);
      assert(r.recentLen === 2,
        "behavioral: handler passes 2 recent rows to the view",
        "recentLen=" + r.recentLen);
      assert(r.firstRecentReason === 'no_phone',
        "behavioral: handler parses event_payload.reason for display",
        "firstRecentReason=" + r.firstRecentReason);
      assert(r.secondRecentPayloadParsed === null,
        "behavioral: handler tolerates non-JSON event_payload (legacy rows) — sets payload_parsed=null",
        "secondRecentPayloadParsed=" + JSON.stringify(r.secondRecentPayloadParsed));
      assert(r.registryLen === 4,
        "behavioral: handler passes the 4-entry SILENT_FAILURE_EVENTS registry to the view",
        "registryLen=" + r.registryLen);
    }
  }
}
