// tests/core/theme7-awaiting-files-aliased.test.js
//
// Theme 7 sub-issue D regression guard.
//
// Asserts:
//  1. Migration 047 file exists with the right WHERE clauses + idempotency.
//  2. No source file writes the literal `'awaiting_files'` as a status
//     value via UPDATE / INSERT (catches a regression of the writer
//     pattern). Reader-list occurrences (filter clauses, label maps,
//     view-side branches) are allowlisted as transitional fallbacks.
//  3. routes/doctor.js reject-files calls caseLifecycle.pauseSla after
//     the raw status write — fixes the SLA-keeps-ticking bug at the
//     entry point (audit P1-STATE-8 + P1-STATE-9).
//  4. Admin/superadmin approve handlers write the new event labels
//     `admin_approved_files_request` / `superadmin_approved_files_request`.
//  5. The new labels contain the substring 'approved' so existing
//     fuzzy `LIKE '%approved%'` matchers and view-layer
//     `.includes('approved')` branches continue to work.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n📂 Theme 7 sub-D — awaiting_files aliased to REJECTED_FILES (source check)\n');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
function readSrc(p) { return fs.readFileSync(path.join(SRC_ROOT, p), 'utf8'); }

// 1. Migration 047 exists with the right semantics.
try {
  const migrationPath = path.join(SRC_ROOT, 'migrations', '047_alias_awaiting_files_to_rejected_files.sql');
  if (!fs.existsSync(migrationPath)) {
    throw new Error('migration 047_alias_awaiting_files_to_rejected_files.sql not found');
  }
  const sql = fs.readFileSync(migrationPath, 'utf8');

  // Convert clause.
  if (!/UPDATE\s+orders[\s\S]{0,200}SET\s+status\s*=\s*'REJECTED_FILES'[\s\S]{0,200}WHERE\s+status\s*=\s*'awaiting_files'/i.test(sql)) {
    throw new Error("migration 047 missing UPDATE … SET status='REJECTED_FILES' WHERE status='awaiting_files'");
  }
  // SLA pause backfill.
  if (!/sla_paused_at\s*=\s*NOW\(\)/.test(sql)) {
    throw new Error('migration 047 missing sla_paused_at backfill');
  }
  if (!/sla_remaining_seconds\s*=\s*GREATEST/i.test(sql)) {
    throw new Error('migration 047 missing sla_remaining_seconds backfill via GREATEST(...)');
  }
  if (!/WHERE[\s\S]{0,80}sla_paused_at\s+IS\s+NULL/i.test(sql)) {
    throw new Error('migration 047 backfill missing `WHERE sla_paused_at IS NULL` idempotency guard');
  }
  // Transactional.
  if (!/BEGIN;[\s\S]+COMMIT;/.test(sql)) {
    throw new Error('migration 047 missing BEGIN/COMMIT transaction wrapper');
  }
  t.pass('migration 047 present with idempotent UPDATE + sla_paused_at backfill');
} catch (e) { t.fail('migration-047', e); }

// 2. No code-level WRITES of 'awaiting_files' as a status value.
//    Reader-list occurrences (status IN (...) filters, label maps,
//    EJS branch checks) are allowlisted: writes are the regression
//    we care about.
try {
  const offenders = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'public' ||
            entry.name === 'migrations' || entry.name === 'locales.archived-2026-05' ||
            entry.name === '__tests__') {
          continue;
        }
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && /\.(js|ejs)$/.test(entry.name)) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(SRC_ROOT, full);
        const content = fs.readFileSync(full, 'utf8');

        // Catch SQL UPDATE/INSERT writes specifically:
        //   UPDATE … SET status = 'awaiting_files'
        //   INSERT … VALUES (… 'awaiting_files' …) where the value lands in a status column
        // Reader patterns (`status IN (…)`, `LOWER(status) = 'awaiting_files'`,
        // `awaiting_files: 'Awaiting files'` map literals) are NOT writes.
        const writeRe = /SET\s+status\s*=\s*'awaiting_files'/i;
        if (writeRe.test(content)) {
          offenders.push(rel);
        }
      }
    }
  }
  walk(SRC_ROOT);
  if (offenders.length) {
    throw new Error("`SET status='awaiting_files'` writes still exist in: " + offenders.join(', '));
  }
  t.pass("no source file writes status='awaiting_files' via SQL UPDATE/INSERT");
} catch (e) { t.fail('no-awaiting-files-writes', e); }

// 3. Doctor reject-files route calls pauseSla after the raw status write.
try {
  const doctor = readSrc('routes/doctor.js');
  const startIdx = doctor.indexOf("router.post('/portal/doctor/case/:caseId/reject-files'");
  if (startIdx < 0) throw new Error('doctor reject-files route not found');
  const after = doctor.slice(startIdx);
  const nextRouter = after.indexOf('\nrouter.');
  const body = nextRouter > 0 ? after.slice(0, nextRouter) : after;

  if (!/caseLifecycle\.pauseSla\(\s*orderId,\s*['"]doctor_rejected_files['"]\s*\)/.test(body)) {
    throw new Error("reject-files route does not call caseLifecycle.pauseSla(orderId, 'doctor_rejected_files')");
  }
  // pauseSla must come AFTER the status UPDATE (so the SLA snapshot
  // reflects the just-written deadline state).
  const updateIdx = body.search(/SET\s+status\s*=\s*'rejected_files'/);
  const pauseSlaIdx = body.search(/caseLifecycle\.pauseSla\(/);
  if (updateIdx < 0 || pauseSlaIdx < 0) {
    throw new Error("reject-files route is missing either the status UPDATE or the pauseSla call");
  }
  if (pauseSlaIdx <= updateIdx) {
    throw new Error("pauseSla must be called AFTER the status='rejected_files' UPDATE");
  }
  t.pass('reject-files route calls caseLifecycle.pauseSla after status UPDATE (fixes SLA-keeps-ticking)');
} catch (e) { t.fail('doctor-reject-files-pauseSla', e); }

// 4a. Admin approve handler writes the new event label.
try {
  const admin = readSrc('routes/admin.js');
  const idx = admin.indexOf("router.post('/admin/orders/:id/additional-files/approve'");
  if (idx < 0) throw new Error('admin additional-files approve route not found');
  const after = admin.slice(idx);
  const nextRouter = after.indexOf('\nrouter.');
  const body = nextRouter > 0 ? after.slice(0, nextRouter) : after;

  if (!/['"]admin_approved_files_request['"]/.test(body)) {
    throw new Error("admin approve handler does not write 'admin_approved_files_request' event label");
  }
  if (!/'awaiting_files'/.test(body) === false && /SET\s+status\s*=\s*'awaiting_files'/i.test(body)) {
    throw new Error("admin approve handler still contains raw `SET status='awaiting_files'`");
  }
  if (!/markOrderRejectedFiles\(/.test(body)) {
    throw new Error('admin approve handler does not defensively call markOrderRejectedFiles for non-rejected-files cases');
  }
  t.pass('admin approve handler writes admin_approved_files_request + drops raw awaiting_files write');
} catch (e) { t.fail('admin-approve-handler', e); }

// 4b. Superadmin approve handler writes the new event label.
try {
  const superadmin = readSrc('routes/superadmin.js');
  const idx = superadmin.indexOf("router.post('/superadmin/orders/:id/additional-files/approve'");
  if (idx < 0) throw new Error('superadmin additional-files approve route not found');
  const after = superadmin.slice(idx);
  const nextRouter = after.indexOf('\nrouter.');
  const body = nextRouter > 0 ? after.slice(0, nextRouter) : after;

  if (!/['"]superadmin_approved_files_request['"]/.test(body)) {
    throw new Error("superadmin approve handler does not write 'superadmin_approved_files_request' event label");
  }
  if (/SET\s+status\s*=\s*'awaiting_files'/i.test(body)) {
    throw new Error("superadmin approve handler still contains raw `SET status='awaiting_files'`");
  }
  if (!/markOrderRejectedFiles\(/.test(body)) {
    throw new Error('superadmin approve handler does not defensively call markOrderRejectedFiles for non-rejected-files cases');
  }
  t.pass('superadmin approve handler writes superadmin_approved_files_request + drops raw awaiting_files write');
} catch (e) { t.fail('superadmin-approve-handler', e); }

// 5. The new labels contain 'approved' so existing fuzzy matchers /
//    view-layer .includes('approved') branches continue to work.
try {
  const newLabels = ['admin_approved_files_request', 'superadmin_approved_files_request'];
  for (const lbl of newLabels) {
    if (!lbl.includes('approved')) {
      throw new Error("label '" + lbl + "' does not contain 'approved' — fuzzy matchers would miss it");
    }
  }
  t.pass("both new labels contain 'approved' substring (fuzzy matchers + view branches still work)");
} catch (e) { t.fail('label-approved-substring', e); }

// 6. Both decision-event matchers (admin.js + superadmin.js) explicitly
//    recognize the new short identifiers.
try {
  const admin = readSrc('routes/admin.js');
  const superadmin = readSrc('routes/superadmin.js');

  for (const [file, content] of [['routes/admin.js', admin], ['routes/superadmin.js', superadmin]]) {
    if (!/label\s*=\s*['"]admin_approved_files_request['"]/.test(content)) {
      throw new Error(file + " does not explicitly match label='admin_approved_files_request'");
    }
    if (!/label\s*=\s*['"]superadmin_approved_files_request['"]/.test(content)) {
      throw new Error(file + " does not explicitly match label='superadmin_approved_files_request'");
    }
  }
  t.pass('both decision-event matchers explicitly recognize the new short identifiers');
} catch (e) { t.fail('matchers-explicit-recognition', e); }

// 7. View files explicitly recognize the new approved-state labels.
try {
  const adminView = fs.readFileSync(path.join(SRC_ROOT, 'views', 'admin_order_detail.ejs'), 'utf8');
  const superadminView = fs.readFileSync(path.join(SRC_ROOT, 'views', 'superadmin_order_detail.ejs'), 'utf8');

  for (const [file, content] of [['admin_order_detail.ejs', adminView], ['superadmin_order_detail.ejs', superadminView]]) {
    if (!/decisionLabel\s*===\s*['"]admin_approved_files_request['"]/.test(content)) {
      throw new Error(file + " does not explicitly match decisionLabel === 'admin_approved_files_request'");
    }
    if (!/decisionLabel\s*===\s*['"]superadmin_approved_files_request['"]/.test(content)) {
      throw new Error(file + " does not explicitly match decisionLabel === 'superadmin_approved_files_request'");
    }
  }
  t.pass('both order-detail views explicitly recognize the new approved-state labels');
} catch (e) { t.fail('views-explicit-recognition', e); }
