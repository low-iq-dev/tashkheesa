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
