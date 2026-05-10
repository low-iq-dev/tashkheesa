// tests/core/theme6-graceful-shutdown.test.js
//
// Theme 6 sub-issue A regression guard — graceful shutdown coverage.
//
// Asserts that:
//   1. `intervalIds[]` exists at module scope in src/server.js
//   2. Every `setInterval(...)` call inside src/server.js is either
//      (a) assigned to `slaSweepIntervalId` (legacy, already cleared
//          on shutdown), or
//      (b) followed within ~10 lines by `intervalIds.push(<id>)`.
//   3. `gracefulShutdown` clears `intervalIds[]` AND calls
//      `clearInterval` on every entry AND nulls `igSchedulerInstance`
//      (or calls `.stop()` on it).
//
// This test prevents future regressions where someone adds a new
// `setInterval(...)` and forgets to track it for shutdown.
//
// Source-grep style — matches Theme 1/5/7 lint pattern.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🛂 Theme 6 sub-A — graceful shutdown clears all intervals (source check)\n');

const SERVER = path.join(__dirname, '..', '..', 'src', 'server.js');
const src = fs.readFileSync(SERVER, 'utf8');
const lines = src.split('\n');

// ── 1. Module-scope intervalIds[] declaration ─────────────────────
try {
  if (!/var\s+intervalIds\s*=\s*\[\s*\]\s*;/.test(src)) {
    throw new Error('module-scope `var intervalIds = [];` not found in src/server.js');
  }
  t.pass('intervalIds[] declared at module scope');
} catch (e) { t.fail('intervalIds[] declaration', e); }

// ── 2. Every setInterval call is tracked ──────────────────────────
//
// Tracking shapes accepted (pick whichever is closest in the next 10 lines):
//   slaSweepIntervalId = setInterval(...)         // legacy, cleared by name
//   var foo = setInterval(...); … intervalIds.push(foo);
//   var foo = setInterval(...); … intervalIds.push(<same name>);
//   intervalIds.push(setInterval(...))            // direct push
//
// Allowlist: setInterval calls inside string literals or jsdoc lines.
// We match `\bsetInterval(` at non-string positions.
try {
  const intervalSites = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // skip pure comments
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    if (/\bsetInterval\s*\(/.test(line) === false) continue;
    intervalSites.push({ idx: i, line: line });
  }

  if (intervalSites.length === 0) {
    throw new Error('expected at least one setInterval site in src/server.js — none found');
  }

  const offenders = [];
  for (const site of intervalSites) {
    const lo = site.idx;
    const hi = Math.min(lines.length, site.idx + 12);
    const window = lines.slice(lo, hi).join('\n');

    // Shape A — legacy slaSweepIntervalId pattern (cleared by name in
    // gracefulShutdown).
    if (/slaSweepIntervalId\s*=\s*setInterval/.test(site.line)) continue;

    // Shape B — direct intervalIds.push(setInterval(...))
    if (/intervalIds\.push\s*\(\s*setInterval/.test(site.line)) continue;

    // Shape C — assigned-then-pushed within the window.
    //  `var foo = setInterval(...)` … `intervalIds.push(foo)`
    const assignMatch = site.line.match(/(?:var|let|const)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*setInterval/);
    if (assignMatch) {
      const varName = assignMatch[1];
      const pushPattern = new RegExp('intervalIds\\.push\\s*\\(\\s*' + varName + '\\b');
      if (pushPattern.test(window)) continue;
    }

    // Shape D — bare `<name> = setInterval(...)` (no var/let/const) followed
    // by intervalIds.push of the same name.
    const reAssign = site.line.match(/^[\s\t]*([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*setInterval/);
    if (reAssign) {
      const varName = reAssign[1];
      if (varName === 'slaSweepIntervalId') continue;
      const pushPattern = new RegExp('intervalIds\\.push\\s*\\(\\s*' + varName + '\\b');
      if (pushPattern.test(window)) continue;
    }

    offenders.push('  src/server.js:' + (site.idx + 1) + ': ' + site.line.trim());
  }

  if (offenders.length > 0) {
    throw new Error(
      'Found ' + offenders.length + ' setInterval call(s) in src/server.js that are not tracked for graceful shutdown ' +
        '(must either assign to slaSweepIntervalId OR be followed by `intervalIds.push(<id>)` within 12 lines):\n' +
        offenders.join('\n')
    );
  }
  t.pass('every setInterval in src/server.js is tracked for graceful shutdown');
} catch (e) { t.fail('all setIntervals are tracked', e); }

// ── 3. gracefulShutdown clears intervalIds[] ─────────────────────
try {
  const gsStart = src.indexOf('function gracefulShutdown');
  if (gsStart < 0) throw new Error('gracefulShutdown function not found');
  const gsEnd = src.indexOf('process.on(\'SIGINT\'', gsStart);
  const gsBody = gsEnd > gsStart ? src.slice(gsStart, gsEnd) : src.slice(gsStart);

  const checks = [
    ['clearInterval(slaSweepIntervalId)',         /clearInterval\s*\(\s*slaSweepIntervalId\s*\)/],
    ['clearInterval over intervalIds',            /clearInterval\s*\(\s*intervalIds\s*\[/],
    ['intervalIds.length = 0 reset',              /intervalIds\.length\s*=\s*0/],
    ['igSchedulerInstance .stop() call',          /igSchedulerInstance(?:\s*&&)?\s*.*\.stop\s*\(\s*\)/],
    ['stopMacMiniProbe call',                     /stopMacMiniProbe\s*\(\s*\)/],
  ];
  for (const [name, re] of checks) {
    if (!re.test(gsBody)) {
      throw new Error('gracefulShutdown missing: ' + name);
    }
  }
  t.pass('gracefulShutdown clears slaSweepIntervalId, intervalIds[], igSchedulerInstance, and mac-mini probe');
} catch (e) { t.fail('gracefulShutdown shape', e); }
