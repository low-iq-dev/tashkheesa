// tests/core/theme7b-superadmin-refund-actions.test.js
//
// Theme 7b Phase 3 — superadmin approve/deny/mark-paid action regression guard.
// Source-grep style.

'use strict';
const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n💸 Theme 7b Phase 3 — superadmin refund actions\n');

const SUPER = path.join(__dirname, '..', '..', 'src', 'routes', 'superadmin.js');
const src = fs.readFileSync(SUPER, 'utf8');

function sliceRoute(text, verb, pathSubstring) {
  const escaped = pathSubstring.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
  const m = text.match(new RegExp(
    'router\\.' + verb + "\\(\\s*['\"][^'\"]*" + escaped + "[^'\"]*['\"]"
  ));
  if (!m) return null;
  const start = m.index;
  const after = text.slice(start);
  const next = after.slice(50).search(/\nrouter\.(?:get|post|put|delete|patch|all)\(/);
  return next > 0 ? after.slice(0, next + 50) : after;
}

const approveBody = sliceRoute(src, 'post', '/superadmin/refunds/:id/approve');
const denyBody = sliceRoute(src, 'post', '/superadmin/refunds/:id/deny');
const paidBody = sliceRoute(src, 'post', '/superadmin/refunds/:id/mark-paid');

// ── Approve route ─────────────────────────────────────────────
try {
  if (!approveBody) throw new Error('approve route not found');
  if (!/requireSuperadmin/.test(approveBody)) throw new Error('approve missing requireSuperadmin');
  // Validates approved_amount: > 0 and <= requested_amount
  if (!/approvedAmountRaw\s*<=\s*0/.test(approveBody)) throw new Error('approve does not reject amount <= 0');
  if (!/approvedAmountRaw\s*>\s*requestedAmount/.test(approveBody)) {
    throw new Error('approve does not reject amount > requested_amount (no upgrades)');
  }
  // UPDATE re-validates state for concurrency (WHERE status IN ('pending','auto_approved'))
  if (!/UPDATE refunds[\s\S]+?WHERE id = \$\d AND status IN \('pending','auto_approved'\)/.test(approveBody)) {
    throw new Error('approve UPDATE does not re-validate status for concurrency');
  }
  // Sets reviewed_by + reviewed_at
  if (!/reviewed_by\s*=\s*\$/.test(approveBody)) throw new Error('approve does not set reviewed_by');
  if (!/reviewed_at\s*=\s*NOW\(\)/.test(approveBody)) throw new Error('approve does not set reviewed_at = NOW()');
  // Audit + patient notification
  if (!/label:\s*['"]superadmin_refund_approved['"]/.test(approveBody)) {
    throw new Error('approve missing audit label superadmin_refund_approved');
  }
  if (!/template:\s*['"]patient_refund_approved['"]/.test(approveBody)) {
    throw new Error('approve missing patient notification template patient_refund_approved');
  }
  if (!/channels:\s*\[\s*['"]internal['"]\s*,\s*['"]email['"]\s*\]/.test(approveBody)) {
    throw new Error('approve patient notification not multi-channel internal+email');
  }
  t.pass('approve: requireSuperadmin + amount validation (>0, <=requested) + concurrency-safe UPDATE + audit + patient internal+email');
} catch (e) { t.fail('approve action', e); }

// ── Deny route ────────────────────────────────────────────────
try {
  if (!denyBody) throw new Error('deny route not found');
  if (!/requireSuperadmin/.test(denyBody)) throw new Error('deny missing requireSuperadmin');
  // denial_reason required + max 1000
  if (!/denialReason\.length\s*<\s*1\s*\|\|\s*denialReason\.length\s*>\s*1000/.test(denyBody)) {
    throw new Error('deny does not enforce denial_reason length 1-1000');
  }
  // UPDATE re-validates state for concurrency
  if (!/UPDATE refunds[\s\S]+?WHERE id = \$\d AND status IN \('pending','auto_approved'\)/.test(denyBody)) {
    throw new Error('deny UPDATE does not re-validate status for concurrency');
  }
  // Sets denial_reason + reviewed_by + reviewed_at
  if (!/denial_reason\s*=\s*\$/.test(denyBody)) throw new Error('deny does not set denial_reason');
  if (!/reviewed_by\s*=\s*\$/.test(denyBody)) throw new Error('deny does not set reviewed_by');
  // Audit + notification
  if (!/label:\s*['"]superadmin_refund_denied['"]/.test(denyBody)) {
    throw new Error('deny missing audit label');
  }
  if (!/template:\s*['"]patient_refund_denied['"]/.test(denyBody)) {
    throw new Error('deny missing patient notification template');
  }
  t.pass('deny: requireSuperadmin + denial_reason 1-1000 + concurrency-safe UPDATE + audit + patient notification');
} catch (e) { t.fail('deny action', e); }

// ── Mark-paid route ───────────────────────────────────────────
try {
  if (!paidBody) throw new Error('mark-paid route not found');
  if (!/requireSuperadmin/.test(paidBody)) throw new Error('mark-paid missing requireSuperadmin');
  // instapay_reference required + max 100
  if (!/reference\.length\s*<\s*1\s*\|\|\s*reference\.length\s*>\s*100/.test(paidBody)) {
    throw new Error('mark-paid does not enforce instapay_reference length 1-100');
  }
  // Status precondition: approved or auto_approved
  if (!/status IN \('approved','auto_approved'\)/.test(paidBody)) {
    throw new Error('mark-paid does not gate on status IN (approved, auto_approved)');
  }
  // amount_egp = approved_amount (or requested_amount fallback for auto_approved direct path)
  if (!/refund\.approved_amount\s*!=\s*null\s*\?\s*refund\.approved_amount\s*:\s*refund\.requested_amount/.test(paidBody)) {
    throw new Error('mark-paid does not compute finalAmount = approved_amount ?? requested_amount');
  }
  if (!/amount_egp\s*=\s*\$/.test(paidBody)) throw new Error('mark-paid does not set amount_egp on UPDATE');
  if (!/paid_at\s*=\s*NOW\(\)/.test(paidBody)) throw new Error('mark-paid does not set paid_at = NOW()');
  // Concurrency-safe UPDATE
  if (!/UPDATE refunds[\s\S]+?WHERE id = \$\d AND status IN \('approved','auto_approved'\)/.test(paidBody)) {
    throw new Error('mark-paid UPDATE does not re-validate status for concurrency');
  }
  // Audit
  if (!/label:\s*['"]superadmin_refund_marked_paid['"]/.test(paidBody)) {
    throw new Error('mark-paid missing audit label');
  }
  // Notification
  if (!/template:\s*['"]patient_refund_paid['"]/.test(paidBody)) {
    throw new Error('mark-paid missing patient notification template');
  }
  // Earnings hook deviation: explicitly NOT calling recomputeOnBreach.
  // We assert the comment-block is in place documenting this.
  if (!/recomputeOnBreach/.test(paidBody) || !/intentionally do NOT call/.test(paidBody)) {
    throw new Error('mark-paid is missing the documented earnings_writer deviation comment (Phase 3 must skip recomputeOnBreach because it hardcodes upliftAmount=0)');
  }
  t.pass('mark-paid: requireSuperadmin + ref 1-100 + status precondition + amount_egp from approved/requested + paid_at + concurrency-safe + audit + notification + earnings deviation documented');
} catch (e) { t.fail('mark-paid action', e); }

// ── Notification templates registered ─────────────────────────
try {
  const TEMPLATES = path.join(__dirname, '..', '..', 'src', 'notify', 'templates.js');
  const tpl = fs.readFileSync(TEMPLATES, 'utf8');
  for (const k of ['PATIENT_REFUND_APPROVED', 'PATIENT_REFUND_DENIED', 'PATIENT_REFUND_PAID']) {
    if (!new RegExp('\\b' + k + '\\b').test(tpl)) {
      throw new Error('templates.js missing constant ' + k);
    }
  }
  const TITLES = path.join(__dirname, '..', '..', 'src', 'notify', 'notification_titles.js');
  const tit = fs.readFileSync(TITLES, 'utf8');
  for (const k of ['patient_refund_approved', 'patient_refund_denied', 'patient_refund_paid']) {
    if (!new RegExp('\\b' + k + ':[\\s\\S]{0,200}en:[\\s\\S]{0,80}ar:').test(tit)) {
      throw new Error('notification_titles missing bilingual entry for ' + k);
    }
  }
  const WORKER = path.join(__dirname, '..', '..', 'src', 'notification_worker.js');
  const w = fs.readFileSync(WORKER, 'utf8');
  for (const [k, v] of [
    ['patient_refund_approved', 'patient-refund-approved'],
    ['patient_refund_denied', 'patient-refund-denied'],
    ['patient_refund_paid', 'patient-refund-paid']
  ]) {
    const re = new RegExp(k + ':\\s*[\'"]' + v + '[\'"]');
    if (!re.test(w)) throw new Error('TEMPLATE_TO_EMAIL missing ' + k + ' → ' + v);
  }
  t.pass('3 new templates registered: constants + bilingual titles + email-template mappings');
} catch (e) { t.fail('templates registry', e); }

// ── Email .hbs files exist (en + ar × 3) ──────────────────────
try {
  const dirs = ['en', 'ar'];
  const names = ['patient-refund-approved', 'patient-refund-denied', 'patient-refund-paid'];
  for (const d of dirs) for (const n of names) {
    const p = path.join(__dirname, '..', '..', 'src', 'templates', 'email', d, n + '.hbs');
    if (!fs.existsSync(p)) throw new Error(d + '/' + n + '.hbs missing');
  }
  t.pass('6 email .hbs templates exist (en+ar × approved/denied/paid)');
} catch (e) { t.fail('email .hbs files', e); }
