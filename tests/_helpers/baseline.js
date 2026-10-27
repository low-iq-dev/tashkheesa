// tests/_helpers/baseline.js
//
// 2026-10-27 — the no-database failure baseline (tests/baseline-nodb-failures.txt).
//
// One line per failing test: `<file> :: <test name>`, where <file> is the path
// tests/run.js prints after 📋. No durations, no error text: the key has to be
// the same on every machine and every run. A test that fails twice under one
// name appears twice. Lines starting with # are comments.
//
// The baseline is a ledger of known failures, not a waiver: tests/run.js still
// exits non-zero while any of them fails. What it buys is the difference
// between "the same N known failures" and "a NEW failure" — the gate in
// tests/lint/nodb-baseline-gate.test.js fails on the latter.

'use strict';

const fs   = require('fs');
const path = require('path');

const BASELINE_PATH = path.join(__dirname, '..', 'baseline-nodb-failures.txt');

const HEADER = [
  '# Known failures of `npm test` with no usable database (tests/run.js no-database mode).',
  '# One line per failing test: <file> :: <test name>. Regenerate with:',
  '#   node tests/run.js --update-baseline',
  '# This is a ledger, not a waiver: the suite still exits non-zero while any line here fails.',
  '# tests/lint/nodb-baseline-gate.test.js fails on any failure NOT listed here.',
];

function failureKey(file, name) {
  return file + ' :: ' + String(name).replace(/\s+/g, ' ').trim();
}

function parse(text) {
  return String(text).split('\n').map((l) => l.trim()).filter((l) => l && l[0] !== '#');
}

function read(p) {
  return parse(fs.readFileSync(p || BASELINE_PATH, 'utf8'));
}

function format(keys) {
  return HEADER.concat(keys.slice().sort()).join('\n') + '\n';
}

// Multiset difference: every occurrence in `a` not matched by one in `b`.
function minus(a, b) {
  const left = new Map();
  b.forEach((k) => left.set(k, (left.get(k) || 0) + 1));
  const out = [];
  a.forEach((k) => {
    const n = left.get(k) || 0;
    if (n > 0) left.set(k, n - 1); else out.push(k);
  });
  return out.sort();
}

function compare(baseline, current) {
  return {
    known: minus(current, minus(current, baseline)).length,
    fresh: minus(current, baseline),     // failing now, not in the baseline
    passing: minus(baseline, current),   // in the baseline, not failing now
  };
}

module.exports = { BASELINE_PATH, failureKey, parse, read, format, compare };
