#!/usr/bin/env node
/**
 * Retention purge — reporting by default, writing only under two locks.
 *
 *   node scripts/retention_purge.js            # report what the rules select
 *   node scripts/retention_purge.js --apply    # still refuses without the env flag
 *   RETENTION_PURGE_ENABLED=true node scripts/retention_purge.js --apply
 *
 * The predecessor, scripts/purge_old_deleted_orders.js, needed only --apply and
 * would have hard-deleted 21 orders with no transaction, best-effort child
 * deletes that logged their own failures and carried on, and a DELETE FROM
 * orders that CASCADEs into refunds, order_addons and addon_earnings.
 *
 * Rules and reasoning live in src/services/retention_purge.js.
 */

try { require('dotenv').config(); } catch (_) {}

const { runRetentionPurge, ABANDONED_DRAFT_GRACE_DAYS, COMPLETED_CASE_RETENTION_MONTHS } = require('../src/services/retention_purge');
const { pool } = require('../src/pg');

function line(label, value) {
  console.log('  ' + String(label).padEnd(34) + value);
}

async function main() {
  const apply = process.argv.includes('--apply');

  console.log('\nRetention purge');
  console.log('─'.repeat(56));
  line('abandoned draft grace', ABANDONED_DRAFT_GRACE_DAYS + ' days');
  line('completed case retention', COMPLETED_CASE_RETENTION_MONTHS + ' months');
  line('--apply passed', apply ? 'yes' : 'no');
  line('RETENTION_PURGE_ENABLED', String(process.env.RETENTION_PURGE_ENABLED || '(unset)'));
  console.log('');

  const out = await runRetentionPurge({ apply: apply });

  if (!out.applied) {
    console.log('NOTHING WAS WRITTEN — ' + out.reason + '\n');
    line('abandoned drafts selected', out.counts.abandoned_drafts);
    line('retired cases selected', out.counts.retired_cases);
    if (out.candidates.abandoned.length) {
      console.log('\n  abandoned drafts:');
      for (const r of out.candidates.abandoned.slice(0, 40)) {
        console.log('    ' + (r.reference_id || r.id) + '  deleted_at=' + r.deleted_at);
      }
      if (out.candidates.abandoned.length > 40) console.log('    … and ' + (out.candidates.abandoned.length - 40) + ' more');
    }
    if (out.candidates.retired.length) {
      console.log('\n  completed cases past retention:');
      for (const r of out.candidates.retired.slice(0, 40)) {
        console.log('    ' + (r.reference_id || r.id) + '  completed_at=' + r.completed_at);
      }
      if (out.candidates.retired.length > 40) console.log('    … and ' + (out.candidates.retired.length - 40) + ' more');
    }
    console.log('');
    await pool.end();
    return;
  }

  console.log('APPLIED — one transaction, committed.\n');
  for (const k of Object.keys(out.counts).sort()) line(k, out.counts[k]);

  if (out.storageKeys.length) {
    console.log('\n  ' + out.storageKeys.length + ' storage object(s) are now unreferenced.');
    console.log('  This script does NOT delete them: an R2 failure part-way through a');
    console.log('  batch is unrecoverable and the database no longer holds the keys.');
    console.log('  They are listed here so the deletion is a deliberate second step.\n');
    for (const k of out.storageKeys) console.log('    ' + k);
  }
  console.log('');
  await pool.end();
}

main().catch((err) => {
  console.error('[retention-purge] fatal:', err && err.message);
  console.error('Nothing was committed — the whole pass is one transaction.');
  process.exit(1);
});
