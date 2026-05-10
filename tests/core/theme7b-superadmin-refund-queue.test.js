// tests/core/theme7b-superadmin-refund-queue.test.js
//
// Theme 7b Phase 3 — superadmin refund queue regression guard.
// Source-grep style.

'use strict';
const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n💸 Theme 7b Phase 3 — superadmin refund queue\n');

const SUPER = path.join(__dirname, '..', '..', 'src', 'routes', 'superadmin.js');
const VIEW = path.join(__dirname, '..', '..', 'src', 'views', 'superadmin_refunds.ejs');
const src = fs.readFileSync(SUPER, 'utf8');
const view = fs.readFileSync(VIEW, 'utf8');

// 1. GET route exists with requireSuperadmin
try {
  const re = /router\.get\(\s*['"]\/superadmin\/refunds['"]\s*,\s*requireSuperadmin/;
  if (!re.test(src)) throw new Error('GET /superadmin/refunds with requireSuperadmin not found');
  t.pass('GET /superadmin/refunds is requireSuperadmin-gated');
} catch (e) { t.fail('GET route', e); }

// 2. Queue loads three buckets in priority order (pending FIFO, awaiting FIFO, recent newest)
try {
  if (!/WHERE r\.status = 'pending'[\s\S]{0,80}ORDER BY r\.refunded_at ASC/.test(src)) {
    throw new Error('pending bucket is not ordered FIFO (refunded_at ASC)');
  }
  if (!/WHERE r\.status IN \('auto_approved','approved'\)[\s\S]{0,80}ORDER BY r\.refunded_at ASC/.test(src)) {
    throw new Error('awaiting payment bucket missing or not ordered FIFO');
  }
  if (!/WHERE r\.status IN \('paid','denied'\)[\s\S]{0,200}ORDER BY r\.refunded_at DESC/.test(src)) {
    throw new Error('recent bucket missing or not ordered DESC');
  }
  t.pass('queue loads three buckets: pending FIFO, awaiting payment FIFO, recent newest-first');
} catch (e) { t.fail('queue priority order', e); }

// 3. Recent bucket is filtered to last 30 days + reason='patient_request'
try {
  if (!/refunded_at\s*>\s*NOW\(\)\s*-\s*INTERVAL\s*'30 days'/.test(src)) {
    throw new Error('recent bucket is not filtered to last 30 days');
  }
  if (!/reason = 'patient_request'/.test(src)) {
    throw new Error('recent bucket does not filter to reason=patient_request (would surface system rows)');
  }
  t.pass('recent bucket: 30-day window + reason=patient_request filter');
} catch (e) { t.fail('recent bucket filters', e); }

// 4. View renders 3 sections + status badges + per-status action buttons
try {
  if (!/section\.pending/.test(view)) throw new Error('view missing pending section');
  if (!/section\.awaiting_payment/.test(view)) throw new Error('view missing awaiting_payment section');
  if (!/section\.recent/.test(view)) throw new Error('view missing recent section');
  // Status badges
  if (!/admin-status--/.test(view)) throw new Error('view missing per-status admin-status-- class for badges');
  // Action buttons
  if (!/action="\/superadmin\/refunds\/<%= r\.id %>\/approve"/.test(view)) {
    throw new Error('view missing approve form');
  }
  if (!/action="\/superadmin\/refunds\/<%= r\.id %>\/deny"/.test(view)) {
    throw new Error('view missing deny form');
  }
  if (!/action="\/superadmin\/refunds\/<%= r\.id %>\/mark-paid"/.test(view)) {
    throw new Error('view missing mark-paid form');
  }
  t.pass('view renders 3 sections, status badges, approve/deny/mark-paid forms');
} catch (e) { t.fail('view shape', e); }

// 5. CSRF tokens present in all forms; bilingual via tt()
try {
  if (!/csrfField/.test(view)) throw new Error('view missing csrfField()');
  // Each of approve/deny/mark-paid should have csrfField call:
  const csrfCount = (view.match(/csrfField/g) || []).length;
  if (csrfCount < 3) {
    throw new Error('view should have csrfField in all 3 action forms (got ' + csrfCount + ')');
  }
  if (!/tt\(/.test(view)) throw new Error('view does not use tt() i18n helper');
  t.pass('view: CSRF tokens in all 3 forms + tt() bilingual');
} catch (e) { t.fail('CSRF + i18n', e); }

// 6. prefill_order param surfaces a "redirected from legacy" banner
try {
  if (!/prefill_order/.test(src)) throw new Error('GET handler does not read prefill_order');
  if (!/prefillOrder/.test(view)) throw new Error('view does not render prefillOrder banner');
  t.pass('prefill_order param surfaces legacy-redirect banner');
} catch (e) { t.fail('prefill_order banner', e); }
