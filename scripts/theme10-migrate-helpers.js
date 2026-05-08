#!/usr/bin/env node
/*
 * Theme 10 Phase 2D — helper-signature migration.
 * Mechanical rewrite: L(en, ar) and _t(en, ar) → tt(en, en, ar).
 * Also: legacy 2-arg tt(en, ar) → tt(en, en, ar) (fixes the latent
 * EN-mode-renders-Arabic bug for 2-arg tt calls).
 *
 * Usage: node scripts/theme10-migrate-helpers.js <file> [<file>...]
 *   --dry-run    print what would change without writing
 *   --helper=L   only migrate L() calls (default: L, _t, tt-2arg)
 *   --helper=_t  only migrate _t() calls
 *   --helper=tt  only migrate 2-arg tt() calls
 */
'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const helperFlag = args.find(a => a.startsWith('--helper='));
const HELPERS = helperFlag
  ? [helperFlag.slice('--helper='.length)]
  : ['L', '_t', 'tt']; // tt only migrates 2-arg form
const FILES = args.filter(a => !a.startsWith('--'));

if (FILES.length === 0) {
  console.error('usage: node scripts/theme10-migrate-helpers.js <file> [...]');
  process.exit(2);
}

// Bracket-balanced argument splitter. Handles JS strings ('|"|`),
// nested parens/brackets/braces, and escape sequences.
function splitArgs(s) {
  const args = [];
  let depth = 0, inStr = null, escape = false, current = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) { current += c; escape = false; continue; }
    if (c === '\\' && inStr) { current += c; escape = true; continue; }
    if (inStr) {
      current += c;
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; current += c; continue; }
    if (c === '(' || c === '{' || c === '[') { depth++; current += c; continue; }
    if (c === ')' || c === '}' || c === ']') { depth--; current += c; continue; }
    if (c === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim() !== '') args.push(current.trim());
  return args;
}

// Find the index of the closing ')' for an opening '(' at openIdx.
function findCallEnd(s, openIdx) {
  let depth = 1, inStr = null, escape = false;
  for (let i = openIdx + 1; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inStr) { escape = true; continue; }
    if (inStr) { if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function migrateOne(file) {
  const original = fs.readFileSync(file, 'utf8');
  let out = '';
  let i = 0;
  let migratedL = 0, migratedTraw = 0, migratedTt2 = 0, definitionsRemoved = 0;
  const issues = [];

  while (i < original.length) {
    // Detect helper call. Helper name must be preceded by a non-identifier
    // character (so we don't match `myL(` or `_st(` or `htt(`).
    const prev = i === 0 ? '\n' : original[i - 1];
    const isWordBoundary = !/[A-Za-z0-9_$]/.test(prev);
    let matched = null;

    if (isWordBoundary && HELPERS.includes('L') && original.startsWith('L(', i)) {
      matched = { name: 'L', len: 1, kind: 'L' };
    } else if (isWordBoundary && HELPERS.includes('_t') && original.startsWith('_t(', i)) {
      matched = { name: '_t', len: 2, kind: '_t' };
    } else if (isWordBoundary && HELPERS.includes('tt') && original.startsWith('tt(', i)) {
      matched = { name: 'tt', len: 2, kind: 'tt' };
    }

    if (!matched) { out += original[i]; i++; continue; }

    // Skip function definitions: `function L(` / `function _t(`. The previous
    // non-whitespace token would be `function`. Walk back to check.
    let j = i - 1;
    while (j >= 0 && /\s/.test(original[j])) j--;
    const prevToken = original.slice(Math.max(0, j - 7), j + 1);
    if (/\bfunction$/.test(prevToken)) {
      out += original[i]; i++; continue;
    }

    // Extract args.
    const openIdx = i + matched.len;
    const closeIdx = findCallEnd(original, openIdx);
    if (closeIdx === -1) {
      issues.push({ file, offset: i, msg: 'unbalanced parens for ' + matched.name + '(' });
      out += original[i]; i++; continue;
    }
    const argsRaw = original.slice(openIdx + 1, closeIdx);
    const argList = splitArgs(argsRaw);

    if (matched.kind === 'tt') {
      // Only migrate exactly 2-arg tt calls; leave 3-arg alone.
      if (argList.length !== 2) {
        out += original[i]; i++; continue;
      }
      out += 'tt(' + argList[0] + ', ' + argList[0] + ', ' + argList[1] + ')';
      migratedTt2++;
    } else {
      // L or _t — must be 2-arg
      if (argList.length !== 2) {
        issues.push({ file, offset: i, msg: matched.name + '() with ' + argList.length + ' args (expected 2): ' + argsRaw.slice(0, 80) });
        out += original[i]; i++; continue;
      }
      out += 'tt(' + argList[0] + ', ' + argList[0] + ', ' + argList[1] + ')';
      if (matched.kind === 'L') migratedL++; else migratedTraw++;
    }
    i = closeIdx + 1;
  }

  // Remove `function L(en, ar) { return _isAr ? ar : en; }` and similar
  // definition lines. Patterns observed (all single-line):
  //   function L(en, ar) { return _isAr ? ar : en; }
  //   function L(en, ar) { return __isAr ? ar : en; }
  //   function L(en, ar) { return isAr ? ar : en; }
  //   function _t(en, ar) { return _isAr ? ar : en; }
  //   function _t(en, ar) { return isAr ? ar : en; }
  // We only delete the line if `helpers` includes the matching name.
  const lines = out.split('\n');
  const kept = [];
  const defRe = /^\s*function\s+(L|_t)\s*\(\s*en\s*,\s*ar\s*\)\s*\{\s*return\s+(?:__isAr|_isAr|isAr)\s*\?\s*ar\s*:\s*en\s*;\s*\}\s*$/;
  for (const ln of lines) {
    const m = ln.match(defRe);
    if (m && HELPERS.includes(m[1])) {
      definitionsRemoved++;
      continue;
    }
    kept.push(ln);
  }
  const finalOut = kept.join('\n');

  return { original, finalOut, migratedL, migratedTraw, migratedTt2, definitionsRemoved, issues };
}

let totalL = 0, totalT = 0, totalTt = 0, totalDef = 0;
const allIssues = [];

for (const f of FILES) {
  const result = migrateOne(f);
  if (result.issues.length) allIssues.push(...result.issues);
  if (result.original !== result.finalOut) {
    totalL += result.migratedL;
    totalT += result.migratedTraw;
    totalTt += result.migratedTt2;
    totalDef += result.definitionsRemoved;
    if (!DRY_RUN) fs.writeFileSync(f, result.finalOut);
    console.log(
      (DRY_RUN ? 'WOULD-CHANGE' : 'CHANGED') + ' ' + f +
      ' (L=' + result.migratedL +
      ' _t=' + result.migratedTraw +
      ' tt2=' + result.migratedTt2 +
      ' defs-removed=' + result.definitionsRemoved + ')'
    );
  } else {
    console.log('CLEAN        ' + f);
  }
}

console.log('---');
console.log('TOTAL: L=' + totalL + ' _t=' + totalT + ' tt2=' + totalTt + ' defs-removed=' + totalDef);
if (allIssues.length) {
  console.log('ISSUES (' + allIssues.length + '):');
  allIssues.forEach(x => console.log('  ' + x.file + ' @' + x.offset + ': ' + x.msg));
  process.exit(1);
}
