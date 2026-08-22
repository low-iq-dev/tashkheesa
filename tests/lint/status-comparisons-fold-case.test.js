// tests/lint/status-comparisons-fold-case.test.js
//
// AUDIT 2026-08-17 — orders.status is stored in BOTH cases.
//
// The canonical writer (case_lifecycle.updateCase → assertCanonicalDbStatus)
// stores the UPPERCASE key: 'PAID', 'ASSIGNED', 'IN_REVIEW', 'SLA_BREACH'.
// Several raw-SQL writers store lowercase: 'in_progress', 'expired_unpaid',
// 'completed', 'draft'. Production contains both conventions today. That is a
// fact about the data, not a preference, and it is not going to be true of
// only one of them any time soon.
//
// Postgres string comparison is case-sensitive, so any comparison against
// orders.status that does not fold case is a coin flip on which writer touched
// the row last.
//
// Not hypothetical. `GET /api/v1/admin/pulse` — the Command app's entire
// dashboard — compared against a lowercase list with no LOWER():
//
//     status IN ('paid','in_progress','submitted','assigned')
//
// while the assign endpoint in the same file wrote `status = 'ASSIGNED'`.
// Verified against production Postgres: `'ASSIGNED' IN (...)` is FALSE. So
// assigning a case from the phone did not move it between dashboard tiles — it
// vanished from every one of them, while the Cases queue (which does fold case)
// went on showing it correctly. Two screens, same data, different answers, and
// no error anywhere.
//
// SCOPE. This lint is deliberately narrow, because a broad version drowns in
// false positives: every table in this schema has a `status` column, and most
// of them (notifications, appointments, campaigns, refunds, worker liveness)
// have a single writer and no casing hazard. So it only inspects SQL that
// actually touches `orders`, and only READ comparisons — a write like
// `SET status = 'REFUNDED'` is establishing the value, not testing it.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
  skip: function (n, r) { console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')'); }
};

console.log('\n🔤 orders.status comparisons must fold case\n');

const SRC = path.join(__dirname, '..', '..');

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

// Pull out every SQL-looking string literal: backtick templates, and single or
// double quoted strings. Only those that reference the orders table are of
// interest.
function sqlLiterals(src) {
  const out = [];
  const re = /`([^`\\]*(?:\\.[^`\\]*)*)`|'([^'\\\n]*(?:\\.[^'\\\n]*)*)'|"([^"\\\n]*(?:\\.[^"\\\n]*)*)"/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const body = m[1] || m[2] || m[3] || '';
    if (body.length < 12) continue;
    out.push({ body: body, index: m.index });
  }
  return out;
}

// AUDIT-2026-08-22 — the matcher used to be
//   /\b(?:FROM|JOIN|UPDATE|INTO)\s+orders(?:_active)?\b/i
// i.e. a LITERAL table name only. src/case_lifecycle.js — the file that owns
// the case state machine — writes every one of its queries as
// `FROM ${CASE_TABLE}` / `UPDATE ${CASE_TABLE}` (CASE_TABLE = 'orders', line
// 69). So this lint admitted 2 of that file's 11 orders-touching literals and
// skipped 9, including BOTH unpaid-sweep selects, BOTH destructive HARD-STOP
// updates, updateCase's universal writer, markCasePaid's SELECT … FOR UPDATE
// and sweepSlaBreaches. The 40-literal sanity floor sailed through on the
// other 405 literals in the codebase, so the file went green over the hole —
// and there was a live unfolded comparison inside it the whole time
// (`AND status NOT IN ('completed','expired_unpaid')` in the 24h expiry
// UPDATE, now fixed).
//
// The interpolation arm accepts `${IDENT}` where IDENT is either ALL-CAPS (the
// convention for a table constant: CASE_TABLE, ORDERS_TABLE) or contains
// "table" (`${table}`, `${tableName}`). Restricting the shape keeps prose
// strings out: "Cannot transition from ${from} to ${to}" contains the word
// FROM followed by an interpolation and would otherwise be scanned as SQL.
// Note the alternation puts the \b INSIDE the literal arm — a trailing \b
// after `}` never matches, because `}` and the following space are both
// non-word characters.
//
// AUDIT-2026-08-22 — SPLIT IN TWO, because the `/i` flag applied to the whole
// pattern and therefore to `[A-Z][A-Z0-9_]*` as well. Case-insensitively that
// class matches ANY identifier, so the "ALL-CAPS table constant only"
// restriction the comment above describes did not exist: `${anything}` was
// admitted, and the very prose string named as the counter-example
// ("Cannot transition from ${from} to ${to}") was being scanned as SQL. The
// lint still passed, but its 40-literal sanity floor was padded with prose —
// exactly the "green tick over an empty sample" failure this file's own
// comments keep warning about.
//
// The keyword alternation stays case-insensitive (spelled out per character,
// since JS has no per-group flags); only the identifier shape is now
// case-SENSITIVE, which is what was always intended.
const SQL_KEYWORD_CI = '(?:[Ff][Rr][Oo][Mm]|[Jj][Oo][Ii][Nn]|[Uu][Pp][Dd][Aa][Tt][Ee]|[Ii][Nn][Tt][Oo])';
const TOUCHES_ORDERS_LITERAL = new RegExp('\\b' + SQL_KEYWORD_CI + '\\s+orders(?:_active)?\\b', 'i');
const TOUCHES_ORDERS_INTERP = new RegExp(
  '\\b' + SQL_KEYWORD_CI + '\\s+\\$\\{\\s*(?:[A-Z][A-Z0-9_]*|\\w*[Tt]able\\w*)\\s*\\}'
);
function touchesOrders(body) {
  return TOUCHES_ORDERS_LITERAL.test(body) || TOUCHES_ORDERS_INTERP.test(body);
}

// KNOWN BLIND SPOTS, left in deliberately rather than widened into noise:
//
//   * Bound parameters. `WHERE status = $1` and
//     `WHERE COALESCE(status,'') NOT IN ($1,$2,$3)` carry no quoted literal, so
//     READ_COMPARISON cannot see them and the casing hazard lives in the JS
//     that builds the array instead. The convention that protects those sites
//     is case_lifecycle.dbStatusValuesFor(), which expands a canonical key into
//     EVERY spelling ever written — both cases included. Matching them here
//     would mean flagging every parameterised status filter in the codebase,
//     including the correct ones, with no way to tell them apart.
//   * WHERE fragments built by string concatenation
//     (`cond.push("LOWER(o.status) = " + ph())`) — the literal reaching this
//     scanner is a fragment with no FROM/UPDATE in it, so it is never even
//     admitted. Folding those is enforced by review, not by this file.

// Index of the last standalone occurrence of a SQL keyword, or -1. Word
// boundaries so `SET` does not match inside `OFFSET`/`asset` and so the
// keyword is still found when the surrounding whitespace is a newline.
function lastIndexOfKeyword(s, keyword) {
  const re = new RegExp('\\b' + keyword + '\\b', 'gi');
  let last = -1;
  let m;
  while ((m = re.exec(s)) !== null) last = m.index;
  return last;
}

// A read comparison against a status column: `status = '...'`, `o.status IN (...)`,
// `status != '...'`. Excludes `SET status = ...` (a write).
const READ_COMPARISON = /(?:^|[\s(,])((?:[a-z_]+\.)?status)\s*(?:=|!=|<>|\bIN\b\s*\(|\bNOT\s+IN\b\s*\()\s*'/gi;

// An ALREADY-FOLDED comparison: LOWER(status), LOWER(COALESCE(o.status, ''))…
//
// Counted separately and deliberately. The offender scan's own counter only
// sees comparisons that still match READ_COMPARISON, and folding a site puts a
// `,` between the column and the operator so it stops matching — meaning the
// pass line read "1 checked" once the codebase was fixed. A guard that reports
// a near-zero sample while passing is exactly the shape that hides a broken
// regex: if READ_COMPARISON silently stopped matching anything, this file would
// still go green. Counting the folded sites gives the pass line a real number
// and a floor to sit above.
const FOLDED_COMPARISON = /\b(?:LOWER|UPPER)\s*\(\s*(?:COALESCE\s*\(\s*)?(?:[a-z_]+\.)?status\b/gi;

const offenders = [];
let scannedFiles = 0;
let scannedLiterals = 0;
let scannedComparisons = 0;
let foldedComparisons = 0;

for (const full of walk(SRC, [])) {
  const rel = path.relative(SRC, full);
  if (rel.startsWith('tests' + path.sep)) continue;
  if (!rel.startsWith('src' + path.sep)) continue;

  const src = fs.readFileSync(full, 'utf8');
  scannedFiles++;

  for (const lit of sqlLiterals(src)) {
    if (!touchesOrders(lit.body)) continue;
    scannedLiterals++;

    FOLDED_COMPARISON.lastIndex = 0;
    foldedComparisons += (lit.body.match(FOLDED_COMPARISON) || []).length;

    READ_COMPARISON.lastIndex = 0;
    let m;
    while ((m = READ_COMPARISON.exec(lit.body)) !== null) {
      const columnRef = m[1];

      // Skip other tables' status columns that happen to appear in a query
      // that also touches orders (refunds r.status, appointments a.status …).
      const alias = columnRef.includes('.') ? columnRef.split('.')[0].toLowerCase() : null;
      if (alias && !['o', 'ord', 'orders'].includes(alias)) continue;

      // `SET status = '...'` is a write establishing the value, not a test of
      // it, so casing there is the writer's choice and not a matching hazard.
      // Also covers a later column in a multi-column SET list
      // (`SET doctor_id = $1, status = 'ASSIGNED'`), which is why this looks
      // backwards for a SET that is not yet closed by a WHERE.
      //
      // The exclusion used to search for the padded literal ' SET ', but
      // READ_COMPARISON opens with `(?:^|[\s(,])`, so m.index lands on the
      // separator *before* the column and `upToMatch` therefore ends at
      // "…UPDATE orders SET" — with no trailing space. ' SET ' never matched
      // whenever status was the FIRST column of the SET list, so single-column
      // writes (`UPDATE orders SET status = 'cancelled' WHERE id = $1`) were
      // reported as unfolded reads. Match on word boundaries instead.
      const upToMatch = lit.body.slice(0, m.index);
      const lastSet = lastIndexOfKeyword(upToMatch, 'SET');
      const lastWhere = lastIndexOfKeyword(upToMatch, 'WHERE');
      if (lastSet !== -1 && lastSet > lastWhere) continue;

      scannedComparisons++;

      // Already folded? LOWER(status), LOWER(COALESCE(status, ''))…
      const preceding = lit.body.slice(Math.max(0, m.index - 40), m.index + (m[0].indexOf(columnRef) >= 0 ? m[0].indexOf(columnRef) : 0));
      if (/\b(LOWER|UPPER)\s*\(\s*(COALESCE\s*\(\s*)?$/i.test(preceding)) continue;

      const line = src.slice(0, lit.index).split('\n').length +
                   lit.body.slice(0, m.index).split('\n').length - 1;
      const snippet = lit.body.slice(Math.max(0, m.index - 10), m.index + 90).replace(/\s+/g, ' ').trim();

      // Line-level opt-out for a comparison that is provably single-writer.
      const srcLine = src.split('\n')[line - 1] || '';
      if (/case-fold-ok/.test(srcLine)) continue;

      offenders.push({ file: rel, line: line, text: snippet });
    }
  }
}

// Sanity floor. If the scan finds almost no orders-touching SQL, the extractor
// has broken and a pass here would mean nothing.
try {
  if (scannedLiterals < 40) {
    throw new Error(
      'only found ' + scannedLiterals + ' SQL literals touching `orders` across ' +
      scannedFiles + ' files — the extractor is broken, so a pass proves nothing'
    );
  }
  t.pass('scanned ' + scannedLiterals + ' orders-touching SQL literals in ' + scannedFiles + ' files');
} catch (e) { t.fail('status-case-lint: scan sanity', e); }

try {
  if (offenders.length > 0) {
    throw new Error(
      'found ' + offenders.length + ' orders.status comparison(s) that do not fold case.\n' +
      'orders.status is written in BOTH cases (see this file\'s header), so an unfolded\n' +
      'comparison silently matches only one writer\'s rows. Wrap the column in LOWER(),\n' +
      'or add a `case-fold-ok` comment on the line if it is provably single-writer:\n' +
      offenders.map((o) => '  ' + o.file + ':' + o.line + '  ' + o.text).join('\n')
    );
  }
  t.pass(
    'every orders.status read comparison folds case (' + foldedComparisons +
    ' folded, ' + scannedComparisons + ' unfolded-but-excluded, 0 offenders)'
  );
} catch (e) { t.fail('status-case-lint: unfolded comparison', e); }

// Floor on the folded count. Without this the file passes even if
// FOLDED_COMPARISON and READ_COMPARISON both stop matching — a green tick over
// an empty sample, which is the failure mode this whole audit kept finding.
try {
  if (foldedComparisons < 20) {
    throw new Error(
      'only ' + foldedComparisons + ' case-folded orders.status comparisons found across ' +
      scannedLiterals + ' orders-touching SQL literals. There were 23 after the 2026-08-17 ' +
      'sweep, so either the folding was reverted or this lint has stopped seeing the code.'
    );
  }
  t.pass('folded-comparison sample is healthy (' + foldedComparisons + ' sites)');
} catch (e) { t.fail('status-case-lint: folded sample floor', e); }
