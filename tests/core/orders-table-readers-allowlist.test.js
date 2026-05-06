// tests/core/orders-table-readers-allowlist.test.js
//
// Theme 1, sub-issue D — lint guard for `FROM orders` reads outside the
// orders_active VIEW.
//
// Adoption rule (per migration 045 header): every read that should not
// see soft-deleted rows must use orders_active. Reads that DO want to
// see deleted rows (forensic, GDPR cleanup, the trash view) MUST carry
// an explicit `-- include-deleted-ok` comment OR `// include-deleted-ok`
// adjacent to the query.
//
// This test enforces that rule going forward — any new `FROM orders\b`
// must be one of:
//   1. paired with `deleted_at IS NULL` in the same query
//   2. inside a file on the ALLOWLIST below
//   3. flagged with `include-deleted-ok` somewhere in a 5-line window
//
// Pure source-grep — no DB, no boot. Fast.

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🛂 orders-table reads use orders_active (Theme 1, D)\n');

const SRC = path.join(__dirname, '..', '..', 'src');

// Files where bare `FROM orders` is a deliberate, audited choice. Every
// entry on this list has been reviewed; net-new additions require a
// matching `// include-deleted-ok` comment + a PR-level justification.
const FILE_ALLOWLIST = new Set([
  // Soft-delete sweep itself (writes deleted_at, idempotency guard
  // already in WHERE clause).
  path.join(SRC, 'case_lifecycle.js'),
  // Test-fixture teardown (DELETE FROM orders WHERE id LIKE 'test-...');
  // not a read, but the grep below catches "FROM" inside DELETE.
  path.join(SRC, 'services', 'addons', '__tests__', '_helpers.js')
]);

try {
  // Get every line of source that contains a FROM/JOIN against bare
  // `orders` (not orders_active, not order_files, not order_addons, etc.).
  const raw = execSync(
    "grep -rnE '(FROM|JOIN)\\s+orders\\b' --include='*.js' " + SRC + " || true",
    { encoding: 'utf8' }
  ).trim();

  const offenders = [];
  const lines = raw ? raw.split('\n') : [];

  for (const line of lines) {
    if (!line) continue;

    // line format: <file>:<n>:<text>
    const firstColon = line.indexOf(':');
    const secondColon = line.indexOf(':', firstColon + 1);
    if (firstColon < 0 || secondColon < 0) continue;
    const filePath = line.slice(0, firstColon);
    const text = line.slice(secondColon + 1);

    // Allow: contains orders_active (this happens when a line has both
    // `FROM orders_active` and a comment "FROM orders" — false positive).
    if (/orders_active/.test(text)) continue;

    // Allow: deleted_at IS NULL on the same line.
    if (/deleted_at\s+IS\s+NULL/i.test(text)) continue;

    // Allow: explicit include-deleted-ok comment on the same line.
    if (/include-deleted-ok/i.test(text)) continue;

    // Allow: file is on the audited allowlist.
    if (FILE_ALLOWLIST.has(filePath)) continue;

    // Otherwise this line needs justification — check whether the file has
    // an `include-deleted-ok` comment within 5 lines of this line number.
    const lineNum = parseInt(line.slice(firstColon + 1, secondColon), 10);
    if (!Number.isFinite(lineNum)) {
      offenders.push(line);
      continue;
    }
    let nearbyOk = false;
    try {
      const fileText = fs.readFileSync(filePath, 'utf8').split('\n');
      const lo = Math.max(0, lineNum - 6);
      const hi = Math.min(fileText.length, lineNum + 5);
      const window = fileText.slice(lo, hi).join('\n');
      if (/include-deleted-ok/i.test(window)) nearbyOk = true;
    } catch (_) {}

    if (!nearbyOk) offenders.push(line);
  }

  if (offenders.length) {
    throw new Error(
      'Found ' + offenders.length + " unfiltered 'FROM/JOIN orders' reads " +
        '(must use orders_active OR add `deleted_at IS NULL` OR carry an ' +
        '`include-deleted-ok` comment within 5 lines):\n' +
        offenders.join('\n')
    );
  }
  t.pass('every `FROM/JOIN orders` read either uses orders_active, filters deleted_at, or is documented include-deleted-ok');
} catch (e) { t.fail('orders-table-readers-allowlist', e); }
