// tests/lint/needs-attention-134-arms.test.js
//
// Migration 134 (2 Nov 2026) replaces v_needs_attention to append two columns
// and a coverage_lead arm. It must not move anything else: every arm of 126
// is reproduced byte for byte apart from the appended columns, and
// abandoned_case's predicate only GAINS the two 134 clauses. A later edit that
// drifts an arm fails here.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)); process.exitCode = 1; },
};
function check(name, fn) { try { fn(); t.pass(name); } catch (e) { t.fail(name, e); } }

const DIR = path.join(__dirname, '..', '..', 'src', 'migrations');
function arms(file, endMarker) {
  const src = fs.readFileSync(path.join(DIR, file), 'utf8');
  const start = src.indexOf('CREATE OR REPLACE VIEW v_needs_attention AS');
  const end = src.indexOf(endMarker, start);
  return src.slice(start, end).split('\nUNION ALL\n');
}

console.log('\n🧾  v_needs_attention 134 vs 126\n');

const a126 = arms('126_needs_attention_ops_kinds.sql', ';\n\nCOMMENT ON VIEW');
const a134 = arms('134_needs_attention_recovery.sql', ';\n\nCOMMENT ON VIEW');

check('134 has every 126 arm, in order, plus coverage_lead last', () => {
  assert.strictEqual(a134.length, a126.length + 1);
  assert.ok(/'coverage_lead'/.test(a134[a134.length - 1]));
});

check('every arm except abandoned_case is 126 plus the two appended columns, nothing else', () => {
  a126.forEach((arm, i) => {
    if (/'abandoned_case'/.test(arm)) return;
    const stripped = a134[i]
      .replace(/,\n  NULL::int\s+AS nudges_sent,\n  NULL::timestamptz\s+AS last_nudge_at/, '')
      .replace(/,\n  NULL::int,\n  NULL::timestamptz/, '');
    // trimEnd: the last 126 arm is now followed by a blank line and the new arm.
    assert.strictEqual(stripped.trimEnd(), arm.trimEnd(), 'arm ' + i + ' drifted');
  });
});

check('abandoned_case: 126\'s predicate intact, plus only the resumed and coverage-lead clauses', () => {
  const i = a126.findIndex((a) => /'abandoned_case'/.test(a));
  const before = a126[i];
  const after = a134[i];
  for (const line of before.split('\n').filter((l) => /^\s*(AND|WHERE|FROM|LEFT JOIN)/.test(l))) {
    assert.ok(after.indexOf(line) !== -1, 'lost: ' + line);
  }
  assert.ok(/draft_resume_tokens t WHERE t\.order_id = o\.id/.test(after));
  assert.ok(/NOT EXISTS \(SELECT 1 FROM coverage_leads cl WHERE cl\.order_id = o\.id\)/.test(after));
});
