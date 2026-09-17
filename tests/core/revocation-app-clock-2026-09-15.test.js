// tests/core/revocation-app-clock-2026-09-15.test.js
//
// Launch gates 2026-09-15, Task 3 — revocation must run on ONE clock.
//
// What was wrong. Every users.tokens_valid_after stamp wrote the DATABASE clock
// (`tokens_valid_after = NOW()`), while a JWT's `iat` is whole seconds from the
// APP host, and src/services/access_revocation.js revokes a token when
// `iat < floor(tva_ms / 1000)`. With Postgres ahead of the app host, a
// credential minted right after a password write lands in an earlier second
// than the stored cut and is revoked on the next cache refresh: the user who
// has just changed their password is signed out. With Postgres behind, a token
// minted just before a deactivation lands at or after the cut and survives.
// Render-to-Supabase skew has never been measured, so the fix cannot rely on it
// being small.
//
// The fix. Each stamp binds `const revokedAt = new Date()`, taken immediately
// before its statement, as `$n::timestamptz`.
//
// This guard has three halves.
//   S. Source: no stamp in src/ reads a database clock; exactly the seven known
//      stamps exist, each binding $n::timestamptz from a `new Date()` taken
//      immediately before its statement; a password handler mints no session or
//      token before its stamp.
//   B. Behaviour, hermetic: the REAL handlers (web POST /set-password, web POST
//      /reset-password/:token, api POST /auth/reset-password, api PATCH
//      /profile/password, superadmin outreach deactivate, the reject service)
//      run against a fake pg whose clock is 1.5 s AHEAD of the app (password
//      paths) or 1.5 s BEHIND it (deactivate paths). The stored cut is read back
//      through the real access_revocation.refresh() and judged by the real
//      isTokenStale(): the credential from before the write is revoked, the one
//      minted right after it is not, and a doctor's existing token is revoked.
//      No password handler on this branch re-mints in the same request, so the
//      "minted right after" credential is the one the user gets next, from the
//      real minting function (src/auth.js sign() for the portal; generateTokens()
//      for /api/v1 login and refresh). If a handler ever sets a session cookie or
//      returns a token pair itself, that credential is used instead.
//   P. Real Postgres (only when DATABASE_URL is set; rolled back): each of the
//      seven stamping UPDATEs, lifted from source with its own argument order,
//      stores exactly the bound app timestamp (to the millisecond), and
//      access_revocation.refresh() reading that row on the same transaction
//      still revokes the pre-write iat and not the re-minted one.
//
// Isolation. Every check runs in a child process (`--clock-child`) that swaps
// src/pg.js in require.cache and drives the process-wide revocation cache. This
// process only relays results, and fails if the child dies early or reports a
// different number of results than this file defines.
//
// Negative-tested (fix hand-edited out → ❌ → restored); the record is in the
// commit body.

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const CHILD = process.argv.includes('--clock-child');
const CHILD_PG = process.argv.includes('--pg');

const EXPECTED_HERMETIC = 19;
const EXPECTED_PG = 7;

const RESULT = 'CLOCKRESULT ';
const NOTE = 'CLOCKNOTE ';
const DONE = 'CLOCKDONE';

const t = CHILD
  ? {
      pass: (n) => console.log(RESULT + JSON.stringify({ ok: true, name: n })),
      fail: (n, e) => console.log(RESULT + JSON.stringify({ ok: false, name: n, why: String((e && e.message) || e) })),
    }
  : (global._testRunner || {
      pass: (n) => console.log('  \x1b[32m✅\x1b[0m ' + n),
      fail: (n, e) => { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
    });

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

function code(rel) { return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
function sqlCode(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/--.*$/gm, ''); }
// Comment-stripped source for either extension, so the stamp scans can read
// .sql (data migrations) as well as .js.
function stampSource(rel) { return rel.endsWith('.sql') ? sqlCode(rel) : code(rel); }
function srcFiles(ext) {
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith(ext)) out.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
  };
  walk(SRC);
  return out.sort();
}
function check(name, fn) {
  try { const why = fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}
async function checkAsync(name, fn) {
  try { const why = await fn(); if (why) t.fail(name, new Error(why)); else t.pass(name); }
  catch (err) { t.fail(name, err); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── The seven stamps ────────────────────────────────────────────────────────

const SITES = [
  { key: 'webSetPassword', password: true, label: 'web POST /set-password', file: 'src/routes/auth.js', start: /router\.post\(\s*'\/set-password'/ },
  { key: 'webResetPassword', password: true, label: 'web POST /reset-password/:token', file: 'src/routes/auth.js', start: /router\.post\(\s*'\/reset-password\/:token'/ },
  { key: 'apiResetPassword', password: true, label: 'api POST /api/v1/auth/reset-password', file: 'src/routes/api/auth.js', start: /router\.post\(\s*'\/reset-password'\s*,/ },
  { key: 'apiProfilePassword', password: true, label: 'api PATCH /api/v1/profile/password', file: 'src/routes/api/profile.js', start: /router\.patch\(\s*'\/password'/ },
  { key: 'outreachDeactivate', password: false, label: 'superadmin outreach deactivate', file: 'src/routes/superadmin.js', start: /router\.post\(\s*'\/superadmin\/doctors\/outreach\/state'/ },
  { key: 'superadminReject', password: false, label: 'superadmin POST /superadmin/doctors/:id/reject', file: 'src/routes/superadmin.js', start: /router\.post\(\s*'\/superadmin\/doctors\/:id\/reject'/ },
  { key: 'rejectService', password: false, label: 'admin_doctor_reject service', file: 'src/services/admin_doctor_reject.js', start: /async function setDoctorRejection/, end: /\nmodule\.exports/ },
];
const EXPECTED_PER_FILE = {
  'src/routes/api/auth.js': 1,
  'src/routes/api/profile.js': 1,
  'src/routes/auth.js': 2,
  'src/routes/superadmin.js': 2,
  'src/services/admin_doctor_reject.js': 1,
};

const DB_CLOCK_RE = /tokens_valid_after\s*=\s*(?:now\s*\(\s*\)|current_timestamp|localtimestamp|transaction_timestamp\s*\(\s*\)|statement_timestamp\s*\(\s*\)|clock_timestamp\s*\(\s*\)|'now')/i;
const MINT_RE = /\b(?:sign|signUserToken|establishWebSession|refreshSessionCookie|generateTokens|generateAdminTokens)\s*\(|\bres\.cookie\(\s*SESSION_COOKIE\b/g;

// Index just past the ')' closing the '(' at openIdx, skipping string literals.
function closeParen(src, openIdx) {
  let depth = 0;
  let quote = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

function siteBody(site) {
  const src = code(site.file);
  const i = src.search(site.start);
  if (i < 0) throw new Error(site.label + ': handler not found in ' + site.file);
  const rest = src.slice(i + 1);
  const j = rest.search(site.end || /\n\s*router\.(?:get|post|put|patch|delete|use)\(/);
  return src.slice(i, j < 0 ? src.length : i + 1 + j);
}

// Locates the stamp, the statement that executes it, and the app timestamp it
// binds. Returns { error } or { n, sql, elems, callEnd, body }.
function analyse(site) {
  const b = siteBody(site);
  const assigns = [...b.matchAll(/tokens_valid_after\s*=(?!=)\s*([^,\n]*)/gi)];
  if (assigns.length !== 1) return { error: site.label + ': expected one tokens_valid_after assignment, found ' + assigns.length };
  const a = assigns[0];
  const bound = /^\$(\d+)::timestamptz\b/i.exec(a[1]);
  if (!bound) return { error: site.label + ': the stamp is `tokens_valid_after = ' + a[1].trim() + '`, not a bound $n::timestamptz' };
  const n = Number(bound[1]);

  // The SQL string literal holding the stamp.
  let sql = null;
  for (const m of b.matchAll(/`([^`]*)`|"([^"\n]*)"|'([^'\n]*)'/g)) {
    if (m.index < a.index && m.index + m[0].length > a.index) { sql = m[1] || m[2] || m[3]; break; }
  }
  if (!sql) return { error: site.label + ': the SQL literal holding the stamp was not found' };

  // The call that runs it: one whose parentheses enclose the literal, or (when
  // the SQL is assigned to a variable first) the first call passing that variable.
  let callAt = -1;
  let callEnd = -1;
  for (const m of b.matchAll(/(?:\.query|\bexecute|\bsafeRun)\s*\(/g)) {
    if (m.index > a.index) break;
    const end = closeParen(b, m.index + m[0].length - 1);
    if (end > a.index) { callAt = m.index; callEnd = end; }
  }
  if (callAt < 0) {
    const lineStart = b.lastIndexOf('\n', a.index) + 1;
    const v = /(\w+)\s*=\s*["'`][^"'`]*$/.exec(b.slice(lineStart, a.index));
    if (!v) return { error: site.label + ': the statement running the stamp was not found' };
    const re = new RegExp('(?:\\.query|\\bexecute|\\bsafeRun)\\s*\\(\\s*' + v[1] + '\\b', 'g');
    re.lastIndex = a.index;
    const m = re.exec(b);
    if (!m) return { error: site.label + ': no statement runs the `' + v[1] + '` holding the stamp' };
    callAt = m.index;
    callEnd = closeParen(b, b.indexOf('(', m.index));
  }

  const head = b.slice(0, callAt);
  const decls = [...head.matchAll(/const\s+revokedAt\s*=\s*new\s+Date\(\s*\)\s*;/g)];
  if (!decls.length) return { error: site.label + ': no `const revokedAt = new Date();` before the statement' };
  const d = decls[decls.length - 1];
  const gap = head.slice(d.index + d[0].length).replace(/(?:(?:const|let|var)\s+\w+\s*=\s*)?\bawait\s+[\w.]*$/, '');
  if (gap.trim() !== '') {
    return { error: site.label + ': revokedAt is not taken immediately before the statement; in between: ' + JSON.stringify(gap.trim().slice(0, 160)) };
  }
  const args = b.slice(callAt, callEnd);
  const arrays = [...args.matchAll(/\[([^[\]]*)\]/g)].filter((x) => /\brevokedAt\b/.test(x[1]));
  if (arrays.length !== 1) return { error: site.label + ': revokedAt is not bound in exactly one argument array of the statement' };
  const elems = arrays[0][1].split(',').map((s) => s.trim()).filter(Boolean);
  if (elems[n - 1] !== 'revokedAt') {
    return { error: site.label + ': $' + n + ' is bound to ' + JSON.stringify(elems[n - 1]) + ', not revokedAt (arguments ' + JSON.stringify(elems) + ')' };
  }
  return { n, sql, elems, callEnd, body: b };
}

// ── S. source ───────────────────────────────────────────────────────────────

function sourceChecks() {
  check('source: no tokens_valid_after stamp in src/ reads the database clock (NOW() or any spelling)', () => {
    const bad = [];
    for (const rel of srcFiles('.js')) if (DB_CLOCK_RE.test(code(rel))) bad.push(rel);
    for (const rel of srcFiles('.sql')) {
      const sql = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/--.*$/gm, '');
      if (DB_CLOCK_RE.test(sql)) bad.push(rel);
    }
    return bad.length ? 'the database clock stamps tokens_valid_after in: ' + bad.join(', ') : null;
  });

  check('source: exactly the seven known tokens_valid_after stamps exist, and each binds $n::timestamptz', () => {
    const problems = [];
    const got = {};
    // .sql as well as .js: a stamp written into a data migration is still a
    // stamp, and .js-only scanning would count it nowhere. (The database-clock
    // scan above already covers .sql.) No .sql file stamps the column today —
    // migration 106 only declares it — so EXPECTED_PER_FILE lists .js alone,
    // and a .sql stamp added later shows up here as an unexpected entry.
    for (const rel of srcFiles('.js').concat(srcFiles('.sql'))) {
      for (const m of stampSource(rel).matchAll(/tokens_valid_after\s*=(?!=)\s*([^,\n]*)/gi)) {
        got[rel] = (got[rel] || 0) + 1;
        if (!/^\$\d+::timestamptz\b/i.test(m[1])) problems.push(rel + ': `tokens_valid_after = ' + m[1].trim() + '`');
      }
    }
    // Order-independent: sorted `file=count` pairs, never stringified objects,
    // so the verdict cannot depend on key insertion order.
    const pairs = (o) => Object.keys(o).sort().map((k) => k + '=' + o[k]).join(', ');
    if (pairs(got) !== pairs(EXPECTED_PER_FILE)) {
      problems.push('stamps per file are {' + pairs(got) + '}, want {' + pairs(EXPECTED_PER_FILE) + '} (a new stamp needs a site in this guard)');
    }
    return problems.length ? problems.join('; ') : null;
  });

  for (const site of SITES) {
    check('source: ' + site.label + ' binds `const revokedAt = new Date()` taken immediately before its statement', () => {
      const r = analyse(site);
      return r.error || null;
    });
  }

  for (const site of SITES.filter((s) => s.password)) {
    check('source: ' + site.label + ' mints no session or token before its stamp', () => {
      const r = analyse(site);
      if (r.error) return r.error;
      const mints = [...r.body.matchAll(MINT_RE)];
      console.log(NOTE + site.label + ': ' + mints.length + ' session/token mint(s) in the handler');
      const early = mints.filter((m) => m.index < r.callEnd);
      return early.length ? early.map((m) => '`' + m[0] + '` runs before the stamp').join('; ') : null;
    });
  }
}

// ── B. behaviour, hermetic ──────────────────────────────────────────────────

function installFakePg() {
  const PG_PATH = require.resolve(path.join(SRC, 'pg.js'));
  const F = { skewMs: 0, users: new Map(), resetTokens: new Map(), stamps: [] };

  function stamp(sql, params) {
    const idM = /WHERE\s+id\s*=\s*\$(\d+)/i.exec(sql);
    const id = idM ? String(params[Number(idM[1]) - 1]) : null;
    let tva;
    const bound = /tokens_valid_after\s*=\s*\$(\d+)/i.exec(sql);
    if (bound) {
      const v = params[Number(bound[1]) - 1];
      // node-pg sends a Date with millisecond precision and Postgres stores it exactly.
      if (v instanceof Date && !Number.isNaN(v.getTime())) tva = new Date(v.getTime());
      else if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) tva = new Date(Date.parse(v));
      else throw new Error('tokens_valid_after bound to a non-timestamp value (' + typeof v + ')');
    } else if (DB_CLOCK_RE.test(sql)) {
      tva = new Date(Date.now() + F.skewMs); // the DATABASE clock
    } else {
      throw new Error('fake pg: unrecognised tokens_valid_after stamp: ' + sql.slice(0, 160));
    }
    F.stamps.push({ id, tva, appAt: Date.now() });
    const u = id && F.users.get(id);
    if (!u) return { rows: [], rowCount: 0 };
    u.tokens_valid_after = tva;
    return { rows: [{ id: u.id, is_active: false, pending_approval: false, rejection_reason: u.rejection_reason }], rowCount: 1 };
  }

  async function query(sql, params) {
    const s = typeof sql === 'string' ? sql : ((sql && sql.text) || '');
    const p = params || (sql && sql.values) || [];
    if (/^\s*UPDATE\s+users\b/i.test(s) && /tokens_valid_after\s*=/i.test(s)) return stamp(s, p);
    if (/FROM\s+users\b/i.test(s) && /tokens_valid_after\s+IS\s+NOT\s+NULL/i.test(s)) {
      const rows = [...F.users.values()]
        .filter((u) => u.tokens_valid_after != null || u.is_active === false || u.rejection_reason != null || u.pending_approval === true)
        .map((u) => ({
          id: u.id,
          tokens_valid_after: u.tokens_valid_after ? new Date(u.tokens_valid_after.getTime()) : null, // pg returns timestamptz as a Date
          is_active: u.is_active,
          rejection_reason: u.rejection_reason,
          pending_approval: u.pending_approval,
          role: u.role,
        }));
      return { rows, rowCount: rows.length };
    }
    if (/^\s*SELECT\b[\s\S]*\bFROM\s+password_reset_tokens\b[\s\S]*\bWHERE\s+token\s*=\s*\$1/i.test(s)) {
      const r = F.resetTokens.get(String(p[0]));
      return { rows: r ? [Object.assign({}, r)] : [], rowCount: r ? 1 : 0 };
    }
    if (/^\s*SELECT\b[\s\S]*\bFROM\s+users\s+WHERE\s+id\s*=\s*\$1\b/i.test(s)) {
      const u = F.users.get(String(p[0]));
      return { rows: u ? [Object.assign({}, u)] : [], rowCount: u ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  }

  const client = { query, release() {} };
  const exportsObj = {
    pool: { query, connect: async () => client, end: async () => {}, on() {} },
    queryOne: async (s, p) => (await query(s, p)).rows[0] || null,
    queryAll: async (s, p) => (await query(s, p)).rows,
    execute: query,
    withTransaction: async (fn) => { await query('BEGIN'); const r = await fn(client); await query('COMMIT'); return r; },
    verifyPoolSettings: () => ({}),
    preflightPool: async () => {},
  };
  require.cache[PG_PATH] = { id: PG_PATH, filename: PG_PATH, loaded: true, exports: exportsObj };
  return { F, pg: exportsObj, client };
}

function pluck(router, method, p) {
  const layer = (router.stack || []).find((l) => l.route && l.route.path === p && l.route.methods && l.route.methods[method]);
  if (!layer) throw new Error(method.toUpperCase() + ' ' + p + ' is not registered on the router');
  const hs = layer.route.stack;
  return hs[hs.length - 1].handle;
}
function fakeReq(o) {
  return Object.assign({
    body: {}, params: {}, query: {}, cookies: {}, headers: {}, ip: '127.0.0.1', method: 'POST', originalUrl: '/',
    get() { return undefined; }, header() { return undefined; },
  }, o);
}
function fakeRes() {
  const res = { statusCode: 200, cookies: {}, locals: {}, body: null, redirected: null, rendered: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.cookie = (n, v) => { res.cookies[n] = v; return res; };
  res.clearCookie = (n) => { delete res.cookies[n]; return res; };
  res.redirect = (a, b) => { res.redirected = b || a; return res; };
  res.render = (v) => { res.rendered = v; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.ok = (b) => { res.body = { ok: true, data: b }; return res; };
  res.fail = (m, s, c) => { res.statusCode = s || 400; res.body = { ok: false, message: m, code: c }; return res; };
  res.set = () => res;
  res.setHeader = () => {};
  res.header = () => res;
  return res;
}
function summary(res) {
  return { status: res.statusCode, redirect: res.redirected, render: res.rendered, body: res.body };
}

// A credential for this user that the handler itself issued (a session cookie
// or a returned access token), or null.
function sameRequestCredential(jwt, res, userId) {
  const seen = [];
  const visit = (v) => {
    if (typeof v === 'string') seen.push(v);
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) visit(v[k]);
  };
  visit(res.cookies);
  visit(res.body);
  for (const s of seen) {
    const d = jwt.decode(s);
    if (d && typeof d === 'object' && String(d.id) === String(userId) && d.type !== 'refresh') return s;
  }
  return null;
}

async function behaviourChecks() {
  const { F, pg, client } = installFakePg();
  const jwt = require('jsonwebtoken');
  const bcrypt = require('bcryptjs');
  const rev = require(path.join(SRC, 'services', 'access_revocation.js'));
  const { sign } = require(path.join(SRC, 'auth.js'));
  const { generateTokens } = require(path.join(SRC, 'middleware', 'requireJWT.js'));
  const tag = 'clk-' + process.pid + '-';
  const NEW_PW = 'new-password-123';
  const OLD_PW = 'old-password-123';

  const seedUser = (suffix, extra) => {
    const u = Object.assign({
      id: tag + suffix, email: tag + suffix + '@clock.test', name: 'Clock Guard', lang: 'en', role: 'patient',
      password_hash: 'x', is_active: true, rejection_reason: null, pending_approval: false,
      tokens_valid_after: null, specialty_id: null, phone: null, country_code: null,
    }, extra);
    F.users.set(u.id, u);
    return u;
  };
  const seedResetToken = (u) => {
    const tok = tag + 'rt-' + u.id;
    F.resetTokens.set(tok, { id: tok, token: tok, user_id: u.id, expires_at: new Date(Date.now() + 3600 * 1000), used_at: null });
    return tok;
  };

  async function passwordPath(site, u, drive, nextMint, nextMintName) {
    F.skewMs = +1500;
    const tStart = Date.now();
    const preIat = Math.floor(tStart / 1000) - 1; // a credential issued in an earlier second, before the write
    const res = await drive();
    const st = F.stamps.filter((s) => s.id === u.id).pop();
    if (!st) return 'the handler did not stamp tokens_valid_after: ' + JSON.stringify(summary(res));
    let token = sameRequestCredential(jwt, res, u.id);
    let how = 'minted in the same request';
    if (!token) { token = nextMint(); how = 'minted right after the write by ' + nextMintName; }
    const lag = Date.now() - st.appAt;
    const d = jwt.decode(token);
    const iat = d && d.iat;
    if (!Number.isInteger(iat)) return 'could not read the iat of the re-minted credential';
    // A run this slow cannot tell a 1.5 s skew apart, so it asserts nothing.
    // Returning a reason is what checkAsync turns into a ❌: the check FAILS
    // rather than passing, because a guard must never report success on a
    // comparison it did not actually make.
    if (lag >= 500) {
      return 'NOT VERIFIED, so this check FAILS rather than passing: ' + lag + ' ms elapsed between the stamp and the'
        + ' re-mint, and under 500 ms is needed to tell a 1.5 s skew apart. Nothing was asserted about the cut.'
        + ' Re-run on an idle machine.';
    }
    await rev.refresh();
    const problems = [];
    if (rev.isTokenStale(u.id, preIat) !== true) {
      problems.push('the credential issued before the write (iat ' + preIat + ') is NOT revoked; stored cut ' + st.tva.toISOString());
    }
    if (rev.isTokenStale(u.id, iat) !== false) {
      problems.push('the credential ' + how + ' (iat ' + iat + ') IS revoked: stored cut ' + st.tva.toISOString()
        + ', app clock at the statement ' + new Date(st.appAt).toISOString() + ' — the database clock set the cut');
    }
    return problems.length ? problems.join('; ') : null;
  }

  async function deactivatePath(u, drive) {
    F.skewMs = -1500;
    // Start just after a whole second so the statement lands in the same second
    // as tStart; that keeps a database-clock cut deterministically too early.
    const frac = Date.now() % 1000;
    if (frac > 150) await sleep(1000 - frac + 5);
    const tStart = Date.now();
    const justBefore = Math.floor(tStart / 1000) - 1; // the doctor's session from the second before
    const hourOld = Math.floor(tStart / 1000) - 3600;
    const res = await drive();
    const st = F.stamps.filter((s) => s.id === u.id).pop();
    if (!st) return 'the write did not stamp tokens_valid_after: ' + JSON.stringify(summary(res || {}));
    await rev.refresh();
    const problems = [];
    if (rev.isTokenStale(u.id, hourOld) !== true) problems.push('an hour-old token survives the deactivation');
    if (rev.isTokenStale(u.id, justBefore) !== true) {
      problems.push('the doctor\'s token from the second before the deactivation (iat ' + justBefore + ') survives: stored cut '
        + st.tva.toISOString() + ', app clock at the statement ' + new Date(st.appAt).toISOString() + ' — the database clock set the cut');
    }
    return problems.length ? problems.join('; ') : null;
  }

  const bySite = Object.fromEntries(SITES.map((s) => [s.key, s]));
  const AHEAD = 'behaviour (database clock 1.5 s AHEAD): ';
  const BEHIND = 'behaviour (database clock 1.5 s BEHIND): ';
  const passwordName = (s) => AHEAD + s.label + ' — the credential from before the write is revoked; the one minted right after it is not';
  const deactivateName = (s) => BEHIND + s.label + ' — the doctor\'s existing token is revoked';

  await checkAsync(passwordName(bySite.webSetPassword), async () => {
    const h = pluck(require(path.join(SRC, 'routes', 'auth.js')), 'post', '/set-password');
    const u = seedUser('setpw', { role: 'doctor', password_hash: null });
    return passwordPath(bySite.webSetPassword, u, async () => {
      const res = fakeRes();
      await h(fakeReq({ user: { id: u.id, role: 'doctor' }, body: { password: NEW_PW, confirm_password: NEW_PW } }), res);
      return res;
    }, () => sign(u), 'the portal session signer (src/auth.js sign)');
  });

  await checkAsync(passwordName(bySite.webResetPassword), async () => {
    const h = pluck(require(path.join(SRC, 'routes', 'auth.js')), 'post', '/reset-password/:token');
    const u = seedUser('webreset');
    const tok = seedResetToken(u);
    return passwordPath(bySite.webResetPassword, u, async () => {
      const res = fakeRes();
      await h(fakeReq({ params: { token: tok }, body: { password: NEW_PW, confirm_password: NEW_PW } }), res);
      return res;
    }, () => sign(u), 'the portal session signer (POST /login)');
  });

  await checkAsync(passwordName(bySite.apiResetPassword), async () => {
    const apiAuth = require(path.join(SRC, 'routes', 'api', 'auth.js'))(null, {
      safeGet: pg.queryOne, safeAll: pg.queryAll, safeRun: pg.execute, sendOtpViaTwilio: async () => ({}),
    });
    const h = pluck(apiAuth, 'post', '/reset-password');
    const u = seedUser('apireset');
    const tok = seedResetToken(u);
    return passwordPath(bySite.apiResetPassword, u, async () => {
      const res = fakeRes();
      await h(fakeReq({ body: { token: tok, password: NEW_PW } }), res);
      return res;
    }, () => generateTokens(u).accessToken, 'generateTokens (POST /api/v1/auth/login)');
  });

  await checkAsync(passwordName(bySite.apiProfilePassword), async () => {
    const prof = require(path.join(SRC, 'routes', 'api', 'profile.js'))(null, { safeGet: pg.queryOne, safeRun: pg.execute });
    const h = pluck(prof, 'patch', '/password');
    const u = seedUser('profpw', { password_hash: bcrypt.hashSync(OLD_PW, 4) });
    return passwordPath(bySite.apiProfilePassword, u, async () => {
      const res = fakeRes();
      await h(fakeReq({ method: 'PATCH', user: { id: u.id, role: 'patient' }, body: { currentPassword: OLD_PW, newPassword: NEW_PW } }), res);
      return res;
    }, () => generateTokens(u).accessToken, 'generateTokens (POST /api/v1/auth/refresh)');
  });

  await checkAsync(deactivateName(bySite.outreachDeactivate), async () => {
    const h = pluck(require(path.join(SRC, 'routes', 'superadmin.js')).router, 'post', '/superadmin/doctors/outreach/state');
    const u = seedUser('outreach', { role: 'doctor' });
    return deactivatePath(u, async () => {
      const res = fakeRes();
      await h(fakeReq({ user: { id: tag + 'admin', role: 'superadmin' }, body: { id: u.id, action: 'deactivate' } }), res);
      return res;
    });
  });

  await checkAsync(deactivateName(bySite.rejectService), async () => {
    const { setDoctorRejection } = require(path.join(SRC, 'services', 'admin_doctor_reject.js'));
    const u = seedUser('reject', { role: 'doctor', pending_approval: true });
    return deactivatePath(u, async () => {
      await setDoctorRejection(client, { doctorId: u.id, actorId: tag + 'admin' });
      return null;
    });
  });
}

// ── P. real Postgres (rolled back) ─────────────────────────────────────────

function argValue(expr, id, at) {
  if (expr === 'revokedAt') return at;
  if (/hash/i.test(expr)) return 'clock-guard-hash';
  if (/reason/i.test(expr)) return 'Not approved';
  if (/^(?:id|user\.id|req\.user\.id|doctorId)$/.test(expr)) return id;
  throw new Error('unmapped statement argument ' + JSON.stringify(expr));
}

async function pgChecks() {
  const PG_PATH = require.resolve(path.join(SRC, 'pg.js'));
  const REV_PATH = require.resolve(path.join(SRC, 'services', 'access_revocation.js'));
  delete require.cache[PG_PATH];
  const realPg = require(PG_PATH);
  const id = 'clk-pg-' + process.pid + '-' + Date.now().toString(36);
  const client = await realPg.pool.connect();
  let noted = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    const col = await client.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'tokens_valid_after'"
    );
    if (!col.rows.length) await client.query('ALTER TABLE users ADD COLUMN tokens_valid_after TIMESTAMPTZ');
    await client.query(
      `INSERT INTO users (id, email, password_hash, name, role, lang, is_active, created_at)
       VALUES ($1, $2, 'x', 'Clock Guard', 'doctor', 'en', true, NOW())`,
      [id, id + '@clock.test']
    );

    for (const site of SITES) {
      await checkAsync('real Postgres (rolled back): ' + site.label + ' stores the bound app timestamp to the millisecond; the cache still revokes the pre-write iat and not the re-minted one', async () => {
        const r = analyse(site);
        if (r.error) return r.error;
        // An app timestamp several seconds from the database's NOW(), ending in .999
        // so a lost millisecond would show up as a different whole second.
        const at = new Date(Math.floor(Date.now() / 1000) * 1000 - 7000 + 999);
        const params = r.elems.map((e) => argValue(e, id, at));
        const problems = [];
        await client.query('SAVEPOINT clk');
        try {
          await client.query(
            'UPDATE users SET tokens_valid_after = NULL, is_active = true, pending_approval = false, rejection_reason = NULL WHERE id = $1',
            [id]
          );
          const upd = await client.query(r.sql, params);
          if (upd.rowCount !== 1) problems.push('the statement updated ' + upd.rowCount + ' row(s), want 1');
          const stored = (await client.query('SELECT tokens_valid_after FROM users WHERE id = $1', [id])).rows[0].tokens_valid_after;
          if (stored == null) return problems.concat('tokens_valid_after was not stamped').join('; ');
          const storedMs = new Date(stored).getTime();
          if (storedMs !== at.getTime()) {
            problems.push('stored ' + new Date(stored).toISOString() + ', not the bound app timestamp ' + at.toISOString());
          }
          if (!noted) {
            noted = true;
            console.log(NOTE + 'pg returns timestamptz as ' + (stored instanceof Date ? 'a JS Date' : typeof stored)
              + '; Date.parse() of it keeps ' + (Date.parse(stored) % 1000) + ' of the stored ' + (storedMs % 1000)
              + ' ms, and the whole second is ' + (Math.floor(Date.parse(stored) / 1000) === Math.floor(storedMs / 1000) ? 'unchanged' : 'CHANGED'));
          }
          // Read it back through access_revocation.refresh(), on this transaction.
          const saved = require.cache[PG_PATH];
          require.cache[PG_PATH] = {
            id: PG_PATH, filename: PG_PATH, loaded: true,
            exports: { queryAll: async (s, p) => (await client.query(s, p)).rows },
          };
          delete require.cache[REV_PATH];
          let rev;
          try {
            rev = require(REV_PATH);
            await rev.refresh();
          } finally {
            require.cache[PG_PATH] = saved;
          }
          const cutSec = Math.floor(at.getTime() / 1000);
          if (rev.isTokenStale(id, cutSec - 1) !== true) problems.push('the pre-write iat (' + (cutSec - 1) + ') is not revoked');
          // The earliest re-mint: the same whole second as the stamp, after it.
          if (rev.isTokenStale(id, cutSec) !== false) problems.push('the re-minted iat (' + cutSec + ') is revoked');
        } finally {
          await client.query('ROLLBACK TO SAVEPOINT clk');
        }
        return problems.length ? problems.join('; ') : null;
      });
    }
  } finally {
    try { await client.query('ROLLBACK'); } catch (_) { /* best effort */ }
    client.release();
    try { await realPg.pool.end(); } catch (_) { /* best effort */ }
  }
}

// ── child / relay ───────────────────────────────────────────────────────────

async function runChild() {
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'revocation-app-clock-test-secret';
  sourceChecks();
  await behaviourChecks();
  if (CHILD_PG) await pgChecks();
  else console.log(NOTE + 'real-Postgres half not run: no DATABASE_URL (the local-DB suite runs it)');
}

function relay() {
  // The same view of DATABASE_URL as tests/run.js, decided HERE and passed down,
  // so a module loading dotenv inside the child cannot change the expected count.
  try { require('dotenv').config({ quiet: true }); } catch (_) { /* optional */ }
  const pgMode = !!process.env.DATABASE_URL;
  if (!CHILD) console.log('\n🕐 Revocation runs on the app clock: a password change never signs out the session minted after it\n');
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const args = [__filename, '--clock-child'].concat(pgMode ? ['--pg'] : []);
    const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* gone */ } }, 150000);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (exitCode) => {
      clearTimeout(killer);
      const lines = out.split('\n');
      let results = 0;
      for (const line of lines) {
        if (line.startsWith(NOTE)) console.log('  ' + line.slice(NOTE.length));
        if (!line.startsWith(RESULT)) continue;
        results++;
        let r = null;
        try { r = JSON.parse(line.slice(RESULT.length)); } catch (_) {
          t.fail('revocation clock guard: relay parsed a child result', new Error('unparseable: ' + line.slice(0, 200)));
          continue;
        }
        if (r.ok) t.pass(r.name); else t.fail(r.name, new Error(r.why));
      }
      if (!lines.includes(DONE)) {
        const tail = (err + out).slice(-800).replace(/postgres(ql)?:\/\/\S+/g, '[db-url]');
        t.fail('revocation clock guard: child process ran to completion', new Error('child exited ' + exitCode + ' after ' + results + ' results: ' + tail));
      } else {
        const expected = EXPECTED_HERMETIC + (pgMode ? EXPECTED_PG : 0);
        if (results !== expected) {
          t.fail('revocation clock guard: child reported every check', new Error('child reported ' + results + ' results, want ' + expected));
        }
      }
      resolve();
    });
  });
}

if (CHILD) {
  runChild().then(
    () => { console.log(DONE); },
    (e) => {
      console.log(RESULT + JSON.stringify({ ok: false, name: 'revocation clock guard: child crashed', why: String((e && e.stack) || e).replace(/postgres(ql)?:\/\/\S+/g, '[db-url]') }));
      console.log(DONE);
    }
  ).then(() => { setTimeout(() => process.exit(0), 1500).unref(); });
} else {
  module.exports = relay();
}
