// tests/lint/audit-2026-08-regressions.test.js
//
// Static regression guards for the four highest-frequency defect CLASSES found
// in the 2026-08-16 full-codebase audit. Each of these shipped to production,
// each was invisible at runtime (silent skip, silent 404, silent []), and each
// is trivially detectable from source alone.
//
//   1. A notification is queued over WhatsApp with no body registered for it.
//      Real instance: notify/broadcast.js queued tashkheesa_new_case_* for
//      every doctor on a newly paid case; the key existed in neither dispatch
//      map, so every send was filed as 'skipped' — which /ops excludes from
//      its failure pill. Zero doctors notified, zero failures reported.
//
//   2. An email notification is queued with no .hbs template behind it.
//      Real instance: magic_login_link — three retries, then dead, while
//      getMagicLink cheerfully returned the URL to its caller.
//
//   3. A view or stylesheet references an asset under a URL prefix that
//      express.static never mounts. Real instance: /fonts and /icons — the
//      brand serif never loaded anywhere in the patient portal, and doctor
//      empty-state art rendered as broken images, for as long as those files
//      have existed.
//
//   4. The doctor report-submit path stops writing report_exports. The patient
//      Report tab is gated on that row, so losing it silently locks every
//      delivered report behind "Available once your specialist delivers your
//      opinion" — after the patient has already been emailed that it is ready.
//
// All four are pure source analysis: no DB, no network, no server boot.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};

console.log('\n🔎 Audit 2026-08 — silent-failure regression guards\n');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

function walk(dir, ext) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push.apply(out, walk(full, ext));
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

function rel(p) { return path.relative(ROOT, p); }

// Resolve `template: TEMPLATES.FOO` against src/notify/templates.js.
function templateConstants() {
  const src = fs.readFileSync(path.join(SRC, 'notify', 'templates.js'), 'utf8');
  const map = {};
  const re = /([A-Z0-9_]+):\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) map[m[1]] = m[2];
  return map;
}

// Every template name queued on a channel list that includes 'whatsapp',
// plus the tier templates broadcast.js queues via its TIER_CONFIG table.
function whatsappQueuedTemplates() {
  const consts = templateConstants();
  const found = new Map(); // template -> first site
  const callRe = /queue(?:Multi[Cc]hannel)?Notification\s*\(\s*\{([\s\S]*?)\}\s*\)/g;

  for (const file of walk(SRC, '.js')) {
    if (/notify[\\/](openclawTemplates|whatsappTemplateMap)\.js$/.test(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    let m;
    while ((m = callRe.exec(src)) !== null) {
      const block = m[1];
      if (!/['"]whatsapp['"]/.test(block)) continue;
      const lit = block.match(/template:\s*'([a-z0-9_]+)'/);
      const cst = block.match(/template:\s*TEMPLATES\.([A-Z0-9_]+)/);
      const name = lit ? lit[1] : (cst ? consts[cst[1]] : null);
      if (!name) continue;
      const line = src.slice(0, m.index).split('\n').length;
      if (!found.has(name)) found.set(name, rel(file) + ':' + line);
    }
  }

  // broadcast.js queues via `template: config.template` where config comes from
  // TIER_CONFIG — resolve those three explicitly rather than by regex.
  const bsrc = fs.readFileSync(path.join(SRC, 'notify', 'broadcast.js'), 'utf8');
  const tierRe = /template:\s*TEMPLATES\.([A-Z0-9_]+)/g;
  let bm;
  while ((bm = tierRe.exec(bsrc)) !== null) {
    const name = consts[bm[1]];
    if (name && !found.has(name)) found.set(name, 'src/notify/broadcast.js (TIER_CONFIG)');
  }
  return found;
}

// ── 1. Every WhatsApp-queued template has an OpenClaw body ────────────────
try {
  const ocSrc = fs.readFileSync(path.join(SRC, 'notify', 'openclawTemplates.js'), 'utf8');
  const bodies = new Set();
  const keyRe = /^\s{2}([a-z0-9_]+):\s*\{/gm;
  let km;
  while ((km = keyRe.exec(ocSrc)) !== null) bodies.add(km[1]);

  const queued = whatsappQueuedTemplates();
  const missing = [];
  for (const [name, site] of queued) {
    if (!bodies.has(name)) missing.push(name + '  (' + site + ')');
  }

  if (queued.size < 20) {
    throw new Error('sanity floor: only found ' + queued.size + ' WhatsApp-queued templates — the scanner probably stopped matching');
  }
  if (missing.length) {
    throw new Error(
      'WhatsApp templates queued with no OpenClaw body (' + missing.length + '). ' +
      'getOpenClawBody returns null for these, so the message is NOT delivered:\n  ' +
      missing.join('\n  ')
    );
  }
  t.pass('every WhatsApp-queued template has an OpenClaw body (' + queued.size + ' checked)');
} catch (e) { t.fail('whatsapp template coverage', e); }

// ── 2. Every mapped email template has a .hbs file, both languages ────────
try {
  const wsrc = fs.readFileSync(path.join(SRC, 'notification_worker.js'), 'utf8');
  const block = wsrc.slice(
    wsrc.indexOf('const TEMPLATE_TO_EMAIL = {'),
    wsrc.indexOf('};', wsrc.indexOf('const TEMPLATE_TO_EMAIL = {'))
  );
  const values = new Set();
  const vre = /:\s*'([a-z0-9-]+)'/g;
  let vm;
  while ((vm = vre.exec(block)) !== null) values.add(vm[1]);

  const missing = [];
  for (const v of values) {
    for (const lang of ['en', 'ar']) {
      const f = path.join(SRC, 'templates', 'email', lang, v + '.hbs');
      if (!fs.existsSync(f)) missing.push(lang + '/' + v + '.hbs');
    }
  }
  if (values.size < 20) throw new Error('sanity floor: only ' + values.size + ' email templates parsed');
  if (missing.length) {
    throw new Error(
      'TEMPLATE_TO_EMAIL maps to .hbs files that do not exist (' + missing.length + '). ' +
      'processEmail returns no_email_template_mapping and the email is never sent:\n  ' +
      missing.join('\n  ')
    );
  }
  t.pass('every mapped email template exists in en + ar (' + values.size + ' checked)');
} catch (e) { t.fail('email template coverage', e); }

// ── 3. Referenced static assets are actually served ───────────────────────
try {
  const serverSrc = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
  const mounts = new Map(); // url prefix -> disk dir
  const mre = /app\.use\(\s*'(\/[a-zA-Z0-9_.-]+)'\s*,\s*express\.static\(\s*path\.join\(([^)]*)\)/g;
  let mm;
  while ((mm = mre.exec(serverSrc)) !== null) {
    const urlPrefix = mm[1];
    const parts = mm[2].split(',').map((x) => x.trim().replace(/^'|'$/g, ''));
    const diskPath = path.join(ROOT, ...parts.filter((x) => x !== '__dirname' && x !== '..').map(String));
    mounts.set(urlPrefix, diskPath);
  }

  // Only audit prefixes that map to a directory of assets.
  const dirMounts = [];
  for (const [prefix, disk] of mounts) {
    if (fs.existsSync(disk) && fs.statSync(disk).isDirectory()) dirMounts.push([prefix, disk]);
  }

  const refs = new Map(); // url -> first site
  const sources = walk(path.join(SRC, 'views'), '.ejs').concat(walk(path.join(ROOT, 'public', 'css'), '.css'));
  const rre = /['"(](\/(?:fonts|icons|assets|js|css|vendor)\/[A-Za-z0-9_@\-./]+?)['")]/g;
  for (const file of sources) {
    const src = fs.readFileSync(file, 'utf8');
    let rm;
    while ((rm = rre.exec(src)) !== null) {
      const url = rm[1];
      if (url.includes('<%')) continue;          // dynamic path — cannot resolve statically
      if (!refs.has(url)) {
        refs.set(url, rel(file) + ':' + src.slice(0, rm.index).split('\n').length);
      }
    }
  }

  const unserved = [];
  for (const [url, site] of refs) {
    const prefix = '/' + url.split('/')[1];
    const mount = dirMounts.find(([p]) => p === prefix);
    if (!mount) { unserved.push(url + '  — NO express.static MOUNT for ' + prefix + '  (' + site + ')'); continue; }
    const disk = path.join(mount[1], url.slice(prefix.length));
    if (!fs.existsSync(disk)) unserved.push(url + '  — mounted but file missing on disk  (' + site + ')');
  }

  if (refs.size < 10) throw new Error('sanity floor: only ' + refs.size + ' asset references found');
  if (unserved.length) {
    throw new Error(
      'Static assets referenced but not served (' + unserved.length + '). ' +
      'These 404 for every visitor:\n  ' + unserved.join('\n  ')
    );
  }
  t.pass('every referenced static asset resolves to a mounted file (' + refs.size + ' checked)');
} catch (e) { t.fail('static asset coverage', e); }

// ── 4. The doctor report-submit path still records the export ─────────────
try {
  const docSrc = fs.readFileSync(path.join(SRC, 'routes', 'doctor.js'), 'utf8');
  if (!/INSERT INTO report_exports/.test(docSrc)) {
    throw new Error(
      'routes/doctor.js no longer writes report_exports. routes/patient.js gates the ' +
      'entire patient Report tab on that row, so every delivered report would show ' +
      'as "Locked" to the patient who was just told it is ready.'
    );
  }
  const patSrc = fs.readFileSync(path.join(SRC, 'routes', 'patient.js'), 'utf8');
  if (!/FROM report_exports WHERE case_id/.test(patSrc)) {
    throw new Error('routes/patient.js no longer reads report_exports — re-check the Report-tab gate before removing this guard');
  }
  t.pass('doctor report submission records report_exports (patient Report tab unlock)');
} catch (e) { t.fail('report delivery wiring', e); }

// ── 5. Payment webhooks decide outcome only from HMAC-signed fields ───────
try {
  const hmacSrc = fs.readFileSync(path.join(SRC, 'paymob-hmac.js'), 'utf8');
  const signed = new Set();
  const hre = /'([a-z_0-9]+)'/g;
  let hm;
  const fieldsBlock = hmacSrc.slice(hmacSrc.indexOf('const HMAC_FIELDS = ['), hmacSrc.indexOf('];'));
  while ((hm = hre.exec(fieldsBlock)) !== null) signed.add(hm[1]);
  if (!signed.has('success')) throw new Error('could not parse HMAC_FIELDS');

  for (const f of ['routes/payments.js', 'routes/video.js']) {
    const src = fs.readFileSync(path.join(SRC, f), 'utf8');
    // The specific regression: branching the paid/failed decision on an
    // unsigned `status` field taken off the webhook body.
    if (/\(txnBody\.status\s*!=\s*null\)\s*\?\s*txnBody\.status/.test(src) ||
        /const\s+normalizedStatus\s*=\s*String\(status\s*\|\|\s*''\)/.test(src)) {
      throw new Error(
        f + ' derives the payment outcome from `status`, which is NOT in the ' +
        'HMAC subject. A captured signature from a FAILED transaction can then be ' +
        'replayed as a success. Use the signed success / pending / error_occured booleans.'
      );
    }
  }
  t.pass('payment webhooks derive outcome from HMAC-signed fields only');
} catch (e) { t.fail('payment webhook signed-field guard', e); }

// ── 6. The clock contract: DB session and Node process are both UTC ───────
//
// Real instance, found 2026-08-16. orders.deadline_at / sla_deadline /
// acceptance_deadline_at are `timestamp WITHOUT time zone`, and every write to
// them is a JS .toISOString() — so the digits on disk are UTC. The pg session
// TimeZone was never pinned and inherited the prod role default, Africa/Cairo
// (UTC+2, +3 under DST). `deadline_at <= NOW()::timestamp` therefore compared
// UTC digits against a Cairo wall clock and read every deadline as 2-3h
// further past than it was.
//
// Live consequences: the SLA sweep breached and reassigned cases ~3h early and
// clawed the original doctor back to 10% partial pay for an SLA they had not
// missed; acceptance windows (10/60/240 min — all shorter than the skew) were
// expired the instant they were written, so the doctor broadcast/accept
// handshake never ran at all; and where markSlaBreach's JS re-check fell
// through, issueBreachRefund opened a real refund obligation 3h early.
//
// Two halves, both required. Remove either and the skew comes straight back.
try {
  const pgSrc = fs.readFileSync(path.join(SRC, 'pg.js'), 'utf8');
  if (!/SET TIME ZONE\s+'UTC'/i.test(pgSrc)) {
    throw new Error(
      "src/pg.js no longer pins the session with SET TIME ZONE 'UTC'. Every " +
      'deadline_at comparison in case_sla_worker.js and case_lifecycle.js uses ' +
      'NOW()::timestamp, which is the SESSION wall clock; the column holds UTC ' +
      'digits. Without the pin they disagree by the DB default offset and cases ' +
      'breach early.'
    );
  }
  if (!/pool\.on\(\s*['"]connect['"]/.test(pgSrc)) {
    throw new Error('src/pg.js SET TIME ZONE is no longer applied per-connection — a pooled client can escape it');
  }

  const srvSrc = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
  if (!/process\.env\.TZ\s*=\s*'UTC'/.test(srvSrc)) {
    throw new Error(
      'src/server.js no longer forces process.env.TZ = UTC. The JS-side halves ' +
      '(secondsUntilDeadline, sla_status.js, the doctor countdown) build Dates ' +
      'in process-local time and would drift from the DB by the process offset.'
    );
  }
  t.pass('clock contract: DB session pinned to UTC and Node process forced to UTC');
} catch (e) { t.fail('timezone clock contract', e); }

// ── 7. SLA breach reassignment only fires when a breach was actually recorded
//
// markSlaBreach declines to breach in three cases (deadline not actually
// passed, case unpaid, case terminal) and returns the case untouched.
// handleBreach ignored the return value and reassigned unconditionally, so a
// case the guard had just protected was still stripped from its doctor and
// that doctor was clawed back to 10% partial pay.
try {
  const wSrc = fs.readFileSync(path.join(SRC, 'case_sla_worker.js'), 'utf8');
  const fn = wSrc.slice(wSrc.indexOf('async function handleBreach'), wSrc.indexOf('async function handleDoctorTimeout'));
  if (!fn) throw new Error('could not locate handleBreach');
  if (!/=\s*await markSlaBreach\(/.test(fn)) {
    throw new Error(
      'handleBreach discards markSlaBreach\'s return value again. That return is ' +
      'the ONLY signal that the breach was actually recorded rather than declined ' +
      'by one of its three guards; without it, reassignCase runs on cases that ' +
      'were never breached and partial-pays their doctor.'
    );
  }
  if (!/sla_breach'\s*\)\s*\{[\s\S]{0,400}?return 0;/.test(fn) && !/return 0;/.test(fn)) {
    throw new Error('handleBreach no longer has an early return for the not-breached path');
  }
  t.pass('SLA reassignment gated on a confirmed breach');
} catch (e) { t.fail('breach-before-reassign guard', e); }

// ── 8. One acceptance window, not four ───────────────────────────────────
//
// "How long does a doctor have to accept a case?" had four independent
// answers in this codebase and none of them agreed:
//   notify/broadcast.js  urgent 10m / vip 60m / standard 240m
//   case_lifecycle.js    urgent 30m / vip  4h / standard  24h
//   case_sla_worker.js   DOCTOR_RESPONSE_TIMEOUT_HOURS = 24
//   (and acceptance_watcher set accepted_at on auto-assign, so the case
//    dropped out of the timeout sweep entirely and had NO window at all)
//
// A case broadcast under one table and assigned under another carried two live
// acceptance deadlines; which one applied depended on which worker swept first.
// Policy is now urgent 15m / vip 45m / standard 2h in src/acceptance_window.js.
try {
  const awPath = path.join(SRC, 'acceptance_window.js');
  if (!fs.existsSync(awPath)) throw new Error('src/acceptance_window.js is gone — the acceptance policy has no single source of truth');
  const aw = require(awPath);
  const expected = { urgent: 15, vip: 45, standard: 120 };
  for (const [tier, mins] of Object.entries(expected)) {
    if (aw.acceptanceMinutesForTier(tier) !== mins) {
      throw new Error(
        `acceptance window for ${tier} is ${aw.acceptanceMinutesForTier(tier)}m, policy is ${mins}m. ` +
        'If this is a deliberate policy change, update the patient-facing turnaround copy too — ' +
        'the window is added in full to the wait, because the SLA clock starts at acceptance.'
      );
    }
  }
  // Nobody may re-introduce a local table.
  for (const f of ['notify/broadcast.js', 'case_lifecycle.js', 'workers/acceptance_watcher.js']) {
    const src = fs.readFileSync(path.join(SRC, f), 'utf8');
    if (!/require\((['"])(\.\.?\/)*acceptance_window\1\)/.test(src)) {
      throw new Error(f + ' no longer reads src/acceptance_window.js — it has grown its own acceptance table again');
    }
  }
  const accSrc = fs.readFileSync(path.join(SRC, 'workers', 'acceptance_watcher.js'), 'utf8');
  if (/SET[\s\S]{0,200}?accepted_at\s*=/.test(accSrc)) {
    throw new Error(
      'acceptance_watcher sets accepted_at when auto-assigning. The doctor has NOT accepted: ' +
      'this starts the SLA clock without a human taking responsibility, and hides the case from ' +
      'the doctor-timeout sweep (which requires accepted_at IS NULL) so an ignored case is never passed on.'
    );
  }
  if (!/is_paused|eligibleDoctorClause/.test(accSrc)) {
    throw new Error('acceptance_watcher auto-assign no longer applies the doctor-eligibility gate — it can hand a paid case to a suspended or half-onboarded doctor');
  }
  t.pass('acceptance window has one source of truth (urgent 15m / vip 45m / standard 2h)');
} catch (e) { t.fail('acceptance window policy', e); }

// ── 9. Every module actually LOADS ───────────────────────────────────────
//
// Real instance, and it took production down: deleting the /order/* funnel
// removed a contiguous block of src/routes/order_flow.js that happened to
// contain `var { requireAuth } = require('../middleware');`, while leaving the
// two /api/cases/:id/intelligence routes that call requireAuth() at module
// scope. The file still PARSED — the name was simply never declared — so
// `node --check` was clean, every static test passed, and the first thing that
// noticed was Render, when `require('./routes/order_flow')` threw a
// ReferenceError and the process died before it could listen.
//
// This guard executes every module with external dependencies stubbed, which
// is the only way to see that class of defect without a full boot.
try {
  const { execFileSync } = require('child_process');
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      // src/public is browser code (window/document); server.js boots a listener.
      if (e.isDirectory()) { if (e.name !== 'public' && e.name !== 'node_modules') walk(f); }
      else if (e.name.endsWith('.js') && f !== path.join(SRC, 'server.js')) files.push(f);
    }
  })(SRC);

  const out = execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'helpers', 'stub-loader.js'), path.dirname(SRC), ...files],
    {
      encoding: 'utf8',
      maxBuffer: 1e8,
      env: Object.assign({}, process.env, {
        MODE: 'development',
        JWT_SECRET: process.env.JWT_SECRET || 'test',
        DATABASE_URL: process.env.DATABASE_URL || 'postgres://u:p@localhost:5432/d',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'test',
      }),
    }
  );

  const crashes = out.split('\n').filter((l) => l.startsWith('LOAD-CRASH'));
  if (crashes.length) {
    throw new Error(
      crashes.length + ' module(s) throw while being require()d — the server will not boot:\n  ' +
      crashes.join('\n  ')
    );
  }
  t.pass(`all ${files.length} server modules load without throwing`);
} catch (e) { t.fail('module load smoke test', e); }
