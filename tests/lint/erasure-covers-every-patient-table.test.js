'use strict';
// Guard: a new table that stores something belonging to a patient must be
// accounted for by account deletion — either erased, or deliberately kept with
// a reason written down.
//
// WHY THIS EXISTS. The DELETE /api/v1/profile/account handler enumerated eight
// tables. By 2026-08 the schema had grown to hold patient rows in more than
// twenty, and nobody noticed, because nothing failed: the handler swallowed
// every error as "table might not exist" and answered "Account and all data
// permanently deleted." A patient who exercised their PDPL erasure right kept
// their medical_records, their appointments, their video calls and every file
// they had ever uploaded. The enumeration did not rot loudly; it rotted
// silently, which is why a static check is worth more here than a runtime one.
//
// The check reads CREATE TABLE statements out of src/migrations/ (the schema's
// only source of truth in this repo) and asks one question of each table that
// has a patient-shaped column: does services/account_deletion.js mention it?
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MIGRATIONS = path.join(ROOT, 'src', 'migrations');
const DELETION_SRC = fs.readFileSync(
  path.join(ROOT, 'src', 'services', 'account_deletion.js'), 'utf8'
);
// Comments in this file quote the old broken SQL verbatim so the history is
// readable at the call site. Strip them before checking what the code DOES,
// or the explanation of the bug reads as the bug.
const DELETION_CODE = DELETION_SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

// A column that ties a row to one human being.
const PATIENT_COLUMNS = ['patient_id', 'user_id', 'to_user_id', 'sender_id'];

// Tables that legitimately hold a patient-shaped column but are NOT the
// patient's to erase. Each needs a reason, and the reason has to be in
// account_deletion.js or here.
const NOT_PATIENT_OWNED = new Set([
  // Doctor-side and operator-side records. `user_id`/`sender_id` on these
  // refers to staff, not to the patient whose account is being erased.
  'doctor_earnings', 'addon_earnings', 'doctor_assignments', 'doctor_availability',
  'doctor_services', 'doctor_specialties', 'prescribed_medications_log',
  'case_annotations', 'report_exports', 'email_campaigns', 'admin_audit_log',
  'ops_push_log', 'otp_codes', 'schema_migrations',
  // Financial skeleton, kept by design and anonymised via the order row.
  'refunds', 'order_addons',
]);

function tablesWithPatientColumns() {
  const found = new Map(); // table -> Set(columns)
  for (const f of fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql'))) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
    // CREATE TABLE [IF NOT EXISTS] <name> ( ...body... );
    const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?([a-z0-9_]+)["']?\s*\(/gi;
    let m;
    while ((m = re.exec(sql)) !== null) {
      const table = m[1].toLowerCase();
      // Take the body up to the matching close paren, roughly: everything to
      // the next line that starts with ');' at column 0, or the next CREATE.
      const rest = sql.slice(m.index + m[0].length);
      const stop = rest.search(/\n\s*\)\s*;/);
      const body = stop === -1 ? rest.slice(0, 4000) : rest.slice(0, stop);
      for (const col of PATIENT_COLUMNS) {
        if (new RegExp('(^|[\\s,(])' + col + '\\s', 'i').test(body)) {
          if (!found.has(table)) found.set(table, new Set());
          found.get(table).add(col);
        }
      }
    }
    // ALTER TABLE <t> ADD COLUMN [IF NOT EXISTS] patient_id ...
    const alter = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?["']?([a-z0-9_]+)["']?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?([a-z0-9_]+)["']?/gi;
    let a;
    while ((a = alter.exec(sql)) !== null) {
      const table = a[1].toLowerCase();
      const col = a[2].toLowerCase();
      if (PATIENT_COLUMNS.includes(col)) {
        if (!found.has(table)) found.set(table, new Set());
        found.get(table).add(col);
      }
    }
  }
  return found;
}

test('every table holding a patient column is handled by account deletion', () => {
  const tables = tablesWithPatientColumns();
  assert.ok(tables.size > 5, 'migration scan found only ' + tables.size + ' tables — the parser has probably broken');

  const unhandled = [];
  for (const [table, columns] of tables) {
    if (NOT_PATIENT_OWNED.has(table)) continue;
    if (table === 'users') continue; // the account row itself
    // Checked against the CODE, not the file. Matching the whole file would
    // let a table stay "handled" purely because the comment that explains why
    // it used to be missed still names it — which is exactly what happened
    // when this assertion was first written.
    const mentioned = new RegExp("'" + table + "'|\\b" + table + "\\b").test(DELETION_CODE);
    if (!mentioned) unhandled.push(table + ' (' + [...columns].join(', ') + ')');
  }

  assert.deepEqual(
    unhandled, [],
    'these tables store patient-identifying rows but src/services/account_deletion.js\n' +
    'never mentions them. Add them to a delete list, or add them to NOT_PATIENT_OWNED\n' +
    'in this test with a reason:\n  ' + unhandled.join('\n  ')
  );
});

test('deletion does not delete the financial skeleton', () => {
  // The single most expensive mistake available here is re-introducing
  // DELETE FROM orders, which CASCADEs into refunds and order_addons and then
  // into addon_earnings. Orders must be UPDATEd, never DELETEd.
  assert.ok(
    !/DELETE\s+FROM\s+orders/i.test(DELETION_CODE),
    'account_deletion.js contains DELETE FROM orders. That CASCADEs into refunds,\n' +
    'order_addons and addon_earnings — the financial records privacy.ejs promises\n' +
    'to retain, and the doctor earnings rows. Anonymise the order row instead.'
  );
  assert.ok(
    /UPDATE orders SET patient_id = NULL/.test(DELETION_CODE),
    'expected orders to be anonymised with UPDATE orders SET patient_id = NULL'
  );
});

test('storage keys are collected before any row is deleted', () => {
  // Ordering bug with no error message: delete the rows first and the R2
  // objects become permanently unfindable, because the keys lived in the rows.
  const collectAt = DELETION_CODE.indexOf('const storageKeys = new Set()');
  const firstDelete = DELETION_CODE.search(/client\.query\(\s*'DELETE FROM/);
  assert.ok(collectAt !== -1, 'expected a storageKeys collection step');
  assert.ok(firstDelete !== -1, 'expected at least one DELETE');
  assert.ok(
    collectAt < firstDelete,
    'storage keys must be collected BEFORE the first DELETE — the keys live in the rows'
  );
});
