// src/routes/verify.js
// Internal readiness snapshot endpoints (/verify, /verify.json).

var express = require('express');
var router = express.Router();

function setupVerifyRoutes(opts) {
  var MODE = opts.MODE;
  var CONFIG = opts.CONFIG;
  var GIT_SHA = opts.GIT_SHA;
  var SERVER_STARTED_AT = opts.SERVER_STARTED_AT;
  var SERVER_STARTED_AT_ISO = opts.SERVER_STARTED_AT_ISO;
  var CSRF_MODE = opts.CSRF_MODE;
  var safeAll = opts.safeAll;
  var safeGet = opts.safeGet;
  var tableExists = opts.tableExists;

  function redactKey(raw) {
    var s = String(raw || '').trim();
    if (!s) return { present: false };
    return { present: true, suffix: s.slice(-4), length: s.length };
  }

  function requireOpsRole(req, res) {
    if (!req.user) {
      return { ok: false, res: res.redirect('/login') };
    }
    var role = String(req.user.role || '').toLowerCase();
    if (role !== 'admin' && role !== 'superadmin') {
      return { ok: false, res: res.status(403).type('text/plain').send('Forbidden') };
    }
    return { ok: true };
  }

  async function buildVerifySnapshot(req) {
    var uptimeSec = Math.floor(process.uptime());

    var requiredTables = ['users', 'orders', 'order_events'];
    var tables = {};
    for (var ti = 0; ti < requiredTables.length; ti++) {
      var t = requiredTables[ti];
      try {
        tables[t] = !!(await tableExists(t));
      } catch (e) {
        tables[t] = false;
      }
    }

    var counts = {
      users: 0,
      doctors: 0,
      activeDoctors: 0,
      orders: 0,
      ordersByStatus: {}
    };

    if (tables.users) {
      counts.users = (await safeGet('SELECT COUNT(*) as c FROM users', [], { c: 0 })).c;
      counts.doctors = (await safeGet("SELECT COUNT(*) as c FROM users WHERE role='doctor'", [], { c: 0 })).c;
      counts.activeDoctors = (await safeGet(
        "SELECT COUNT(*) as c FROM users WHERE role='doctor' AND COALESCE(is_active, true) = true",
        [],
        { c: 0 }
      )).c;
    }

    if (tables.orders) {
      counts.orders = (await safeGet('SELECT COUNT(*) as c FROM orders', [], { c: 0 })).c;
      try {
        var rows = await safeAll('SELECT status, COUNT(*) as c FROM orders GROUP BY status', [], []);
        rows.forEach(function(r) {
          var k = String(r.status || 'unknown');
          counts.ordersByStatus[k] = Number(r.c || 0);
        });
      } catch (e) {
        // ignore
      }
    }

    var recentEvents = [];
    if (tables.order_events) {
      try {
        var evRows = await safeAll(
          'SELECT order_id, label, at FROM order_events ORDER BY at DESC LIMIT 10',
          [],
          []
        );
        evRows.forEach(function(r) {
          recentEvents.push({
            orderId: r.order_id,
            label: r.label,
            at: r.at
          });
        });
      } catch (e) {
        // ignore
      }
    }

    var uploadcarePublic =
      process.env.UPLOADCARE_PUBLIC_KEY ||
      process.env.UPLOADCARE_PUBLIC ||
      process.env.UPLOADCARE_KEY ||
      '';

    var RESOLVED_DB_PATH = process.env.DATABASE_URL ? '(PostgreSQL)' : null;

    var snapshot = {
      ok: true,
      requestId: req.requestId,
      startedAt: SERVER_STARTED_AT,
      startedAtIso: SERVER_STARTED_AT_ISO,
      uptimeSec: uptimeSec,
      gitSha: GIT_SHA,

      mode: MODE,
      slaMode: CONFIG.SLA_MODE,
      csrfMode: CSRF_MODE,
      port: CONFIG.PORT,
      dbPath: RESOLVED_DB_PATH,

      tables: tables,
      counts: counts,
      keys: {
        uploadcarePublicKey: redactKey(uploadcarePublic)
      },

      warnings: [
        CONFIG.SLA_MODE === 'primary'
          ? 'SLA_MODE=primary (ensure single instance only)'
          : null,
        CSRF_MODE === 'off' ? 'CSRF_MODE=off (not recommended for staging/production)' : null,
        !RESOLVED_DB_PATH ? 'DB path could not be resolved by server startup scan' : null
      ].filter(Boolean),

      recentEvents: recentEvents
    };

    return snapshot;
  }

  router.get('/verify', async function(req, res) {
    var gate = requireOpsRole(req, res);
    if (!gate.ok) return gate.res;

    var snap = await buildVerifySnapshot(req);

    res.type('text/html');
    return res.send('<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <title>Tashkheesa Verify</title>\n  <style>\n    body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial; padding:18px; line-height:1.4;}\n    .row{display:flex; gap:10px; flex-wrap:wrap; margin:10px 0 16px;}\n    .pill{display:inline-flex; align-items:center; gap:8px; padding:6px 10px; border-radius:999px; background:#f2f2f2; font-size:12px;}\n    .ok{background:#e9f7ef;}\n    .bad{background:#fdecea;}\n    code, pre{background:#f6f6f6; padding:10px; border-radius:10px; overflow:auto;}\n    table{border-collapse:collapse; width:100%; max-width:980px;}\n    th,td{border-bottom:1px solid #eee; padding:8px 10px; text-align:left; font-size:13px;}\n    .muted{color:#666;}\n  </style>\n</head>\n<body>\n  <h2 style="margin:0 0 6px;">Verify</h2>\n  <div class="muted">Read-only readiness snapshot (admin/superadmin). requestId: <code>' + snap.requestId + '</code></div>\n\n  <div class="row">\n    <span class="pill ok">MODE: <b>' + snap.mode + '</b></span>\n    <span class="pill ok">SLA_MODE: <b>' + snap.slaMode + '</b></span>\n    <span class="pill ok">CSRF_MODE: <b>' + snap.csrfMode + '</b></span>\n    <span class="pill ok">PORT: <b>' + snap.port + '</b></span>\n    <span class="pill ok">UPTIME: <b>' + snap.uptimeSec + 's</b></span>\n    <span class="pill">GIT: <b>' + (snap.gitSha || 'n/a') + '</b></span>\n  </div>\n\n  ' + (snap.warnings.length ? '<div class="pill bad" style="display:inline-flex; margin-bottom:12px;">Warnings: <b>' + snap.warnings.join(' &middot; ') + '</b></div>' : '') + '\n\n  <h3 style="margin:14px 0 8px;">DB + tables</h3>\n  <div class="muted" style="margin-bottom:8px;">DB path: <code>' + (snap.dbPath || 'n/a') + '</code></div>\n  <table>\n    <thead><tr><th>Table</th><th>Present</th></tr></thead>\n    <tbody>\n      ' + Object.keys(snap.tables).map(function(k) { return '<tr><td>' + k + '</td><td>' + (snap.tables[k] ? '&#9989;' : '&#10060;') + '</td></tr>'; }).join('') + '\n    </tbody>\n  </table>\n\n  <h3 style="margin:14px 0 8px;">Counts</h3>\n  <table>\n    <tbody>\n      <tr><td>Users</td><td><b>' + snap.counts.users + '</b></td></tr>\n      <tr><td>Doctors (active/total)</td><td><b>' + snap.counts.activeDoctors + '/' + snap.counts.doctors + '</b></td></tr>\n      <tr><td>Orders</td><td><b>' + snap.counts.orders + '</b></td></tr>\n      <tr><td>Orders by status</td><td><code>' + JSON.stringify(snap.counts.ordersByStatus) + '</code></td></tr>\n    </tbody>\n  </table>\n\n  <h3 style="margin:14px 0 8px;">Keys</h3>\n  <table>\n    <tbody>\n      <tr>\n        <td>Uploadcare public key</td>\n        <td>' + (snap.keys.uploadcarePublicKey.present ? '&#9989; present (&hellip;' + snap.keys.uploadcarePublicKey.suffix + ')' : '&#10060; missing') + '</td>\n      </tr>\n    </tbody>\n  </table>\n\n  <h3 style="margin:14px 0 8px;">Recent activity (latest 10 events)</h3>\n  ' + (snap.recentEvents.length ? '<table>\n    <thead><tr><th>At</th><th>Order</th><th>Event</th></tr></thead>\n    <tbody>\n      ' + snap.recentEvents.map(function(e) { return '<tr><td><code>' + (e.at || '') + '</code></td><td><code>' + (e.orderId || '') + '</code></td><td>' + String(e.label || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</td></tr>'; }).join('') + '\n    </tbody>\n  </table>' : '<div class="muted">No events found.</div>') + '\n\n  <div style="margin-top:16px;" class="muted">\n    Tip: JSON version at <a href="/verify.json">/verify.json</a>\n  </div>\n</body>\n</html>');
  });

  router.get('/verify.json', async function(req, res) {
    var gate = requireOpsRole(req, res);
    if (!gate.ok) return gate.res;
    return res.json(await buildVerifySnapshot(req));
  });

  return router;
}

module.exports = { setupVerifyRoutes: setupVerifyRoutes };
