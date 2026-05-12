// tests/core/theme7b-notify-admins-shared.test.js
//
// Theme 7b Phase 1 — shared notifyAdmins helper regression guard.
//
// OQ-8 (per Ziad's confirmation): the per-recipient admin-fan-out
// pattern that previously had two inline copies (dispatchSlaBreach in
// notify.js + notifyAdmins in video_scheduler.js) is now factored
// into ONE canonical export at src/notify.js. Both former call sites
// route through it.
//
// Asserts:
//   1. src/notify.js exports `notifyAdmins`.
//   2. notify.js dispatchSlaBreach delegates (no own SELECT/loop).
//   3. video_scheduler.js does NOT define `notifyAdmins` locally and
//      DOES import it from ./notify.
//   4. No file in src/ (other than notify.js) reimplements the
//      "SELECT id FROM users WHERE role='superadmin' ... loop ...
//      queueNotification" admin-fan-out shape.
//
// Source-grep style — matches Theme 1/5/6/7 lint pattern.

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n📣 Theme 7b Phase 1 — shared notifyAdmins helper\n');

const SRC = path.join(__dirname, '..', '..', 'src');
const NOTIFY = path.join(SRC, 'notify.js');
const VIDEO = path.join(SRC, 'video_scheduler.js');

const notifySrc = fs.readFileSync(NOTIFY, 'utf8');
const videoSrc = fs.readFileSync(VIDEO, 'utf8');

// ── 1. notify.js exports notifyAdmins ──────────────────────────────
try {
  if (!/async\s+function\s+notifyAdmins\s*\(/.test(notifySrc)) {
    throw new Error('notify.js does not define `async function notifyAdmins(...)`');
  }
  // Check the module.exports block lists notifyAdmins as a key.
  const exportsMatch = notifySrc.match(/module\.exports\s*=\s*\{[\s\S]+?\};/);
  if (!exportsMatch || !/\bnotifyAdmins\b/.test(exportsMatch[0])) {
    throw new Error('notify.js module.exports does not include notifyAdmins');
  }
  t.pass('notify.js defines and exports `notifyAdmins`');
} catch (e) { t.fail('notifyAdmins exported from notify.js', e); }

// ── 2. dispatchSlaBreach delegates to notifyAdmins (no own loop/SELECT) ─
try {
  // Slice dispatchSlaBreach body: from its declaration to the next top-level
  // `async function `/`function ` declaration.
  const start = notifySrc.indexOf('async function dispatchSlaBreach(');
  if (start < 0) throw new Error('dispatchSlaBreach not found in notify.js');
  const after = notifySrc.slice(start);
  const nextFn = after.search(/\nasync function |\nfunction /);
  const body = nextFn > 0 ? after.slice(0, nextFn) : after;

  if (!/notifyAdmins\s*\(/.test(body)) {
    throw new Error('dispatchSlaBreach does not call notifyAdmins(...)');
  }
  // dispatchSlaBreach must NOT contain its own SELECT for superadmins.
  if (/SELECT\s+id\s+FROM\s+users\s+WHERE\s+role\s*=\s*'superadmin'/i.test(body)) {
    throw new Error('dispatchSlaBreach still contains its own SELECT for superadmins (should delegate to notifyAdmins)');
  }
  // dispatchSlaBreach must NOT contain its own for-of loop over recipients.
  if (/for\s*\(\s*const\s+r\s+of\s+recipients\s*\)/.test(body)) {
    throw new Error('dispatchSlaBreach still contains its own per-recipient loop (should delegate to notifyAdmins)');
  }
  // dispatchSlaBreach must pass channel='whatsapp' to notifyAdmins.
  if (!/channel\s*:\s*['"]whatsapp['"]/.test(body)) {
    throw new Error('dispatchSlaBreach must pass channel: \'whatsapp\' to notifyAdmins');
  }
  // dispatchSlaBreach must pass template='sla_breach'.
  if (!/template\s*:\s*['"]sla_breach['"]/.test(body)) {
    throw new Error('dispatchSlaBreach must pass template: \'sla_breach\' to notifyAdmins');
  }
  t.pass('dispatchSlaBreach delegates to notifyAdmins (channel=whatsapp, template=sla_breach)');
} catch (e) { t.fail('dispatchSlaBreach delegation', e); }

// ── 3. video_scheduler.js imports notifyAdmins from ./notify (no local def) ─
try {
  if (/^async\s+function\s+notifyAdmins\s*\(/m.test(videoSrc)) {
    throw new Error('video_scheduler.js still defines `notifyAdmins` locally — should import from ./notify');
  }
  // Local function-declaration form (also a redefinition):
  if (/^function\s+notifyAdmins\s*\(/m.test(videoSrc)) {
    throw new Error('video_scheduler.js still defines `function notifyAdmins(...)` locally');
  }
  if (!/require\s*\(\s*['"]\.\/notify['"]\s*\)[\s\S]{0,200}\bnotifyAdmins\b/.test(videoSrc) &&
      !/\bnotifyAdmins\b[\s\S]{0,200}require\s*\(\s*['"]\.\/notify['"]\s*\)/.test(videoSrc)) {
    throw new Error('video_scheduler.js does not import notifyAdmins from ./notify');
  }
  t.pass('video_scheduler.js imports `notifyAdmins` from ./notify (no local definition)');
} catch (e) { t.fail('video_scheduler.js imports shared helper', e); }

// ── 4. No file other than notify.js defines an admin fan-out shape ─
//
// "Admin fan-out shape" = a SELECT-superadmins query immediately
// followed by a per-recipient `queueNotification` loop within ~25
// lines. notify.js is the canonical owner; every other file should
// call `notifyAdmins()` instead.
//
// Sentinel-based exemption (in lieu of a path allowlist): a file
// can carry the literal string `THEME7B-LINT-EXEMPT-ADMIN-FANOUT`
// in a top-level comment to opt out. Side issue #47 (2026-05-12)
// deleted the sole user (src/sla_worker.js); the sentinel mechanism
// stays in place so future "dead code with deprecation header" files
// can opt out cleanly without a test-side allowlist edit.
const SENTINEL = 'THEME7B-LINT-EXEMPT-ADMIN-FANOUT';

try {
  const files = execSync(
    "find " + SRC + " -type f -name '*.js' " +
    "-not -path '*/node_modules/*' " +
    "-not -path '*/__tests__/*' " +
    "-not -path '*/test/*' " +
    "-not -path '*/tests/*'",
    { encoding: 'utf8' }
  ).trim().split('\n').filter(Boolean);

  const SELECT_RE = /SELECT\s+id\s+FROM\s+users\s+WHERE\s+role\s*=\s*'superadmin'/gi;
  const offenders = [];
  const exempted = [];
  for (const file of files) {
    if (file === NOTIFY) continue; // canonical owner
    const text = fs.readFileSync(file, 'utf8');
    if (text.indexOf(SENTINEL) >= 0) {
      exempted.push(file.replace(SRC + '/', 'src/'));
      continue;
    }
    SELECT_RE.lastIndex = 0;
    let m;
    while ((m = SELECT_RE.exec(text)) !== null) {
      // Within 25 lines AFTER the SELECT, look for a per-recipient
      // queueNotification call. queryOne (single result) shapes don't
      // count — they're "find one admin and notify them", not a fan-out.
      const after = text.slice(m.index, m.index + 1500);
      const isFanOut =
        /(for\s*\(\s*(?:const|let|var)\s+\w+\s+of\s+\w+\)|\.forEach\s*\()/i.test(after) &&
        /queueNotification\s*\(/.test(after);
      if (isFanOut) {
        const lineNo = text.slice(0, m.index).split('\n').length;
        offenders.push(file.replace(SRC + '/', 'src/') + ':' + lineNo);
      }
    }
  }
  if (offenders.length) {
    throw new Error(
      'Found ' + offenders.length + ' admin-fan-out shape(s) outside notify.js. ' +
      'Each should call `notifyAdmins()` from notify.js instead.\n  ' +
      offenders.join('\n  ')
    );
  }
  const exemptSummary = exempted.length === 0
    ? 'no exemptions'
    : exempted.length + ' sentinel-exempted dead-code file(s): ' + exempted.join(', ');
  t.pass('no admin fan-out shape outside notify.js (' + exemptSummary + ')');
} catch (e) { t.fail('no admin fan-outs outside notify.js', e); }
