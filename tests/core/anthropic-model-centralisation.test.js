// tests/core/anthropic-model-centralisation.test.js
//
// Theme 9 Sub-issue D — regression guard for the model-centralisation rule.
//
// Rule: every Anthropic model literal (anything matching /claude-[a-z0-9-]+/)
// in src/ must live in exactly one file: src/config/anthropic.js. Every other
// call site must read the model id by calling one of the three exported
// helpers (modelSonnet, modelHaiku, modelVision).
//
// Failure mode this catches: a future PR hardcodes a new `claude-…` literal
// next to a `messages.create({ model: '...' })` call instead of importing
// modelSonnet/Haiku/Vision. That literal will silently survive the next
// Anthropic model rotation until someone notices the API returning 4xx.
//
// Forensic context: prior to Theme 9, three call sites embedded
// `claude-sonnet-4-20250514` directly. That literal was deprecated
// 2026-04-14 with a retirement date of 2026-06-15. The audit caught it 35
// days before retirement; this test ensures the lesson sticks.

'use strict';

const fs = require('fs');
const path = require('path');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n🤖 Theme 9 Sub-issue D — Anthropic model literals only in src/config/anthropic.js\n');

const SRC_ROOT = path.join(__dirname, '..', '..', 'src');
const CONFIG_FILE = path.join(SRC_ROOT, 'config', 'anthropic.js');
const MODEL_LITERAL = /['"](claude-[a-z0-9.-]+)['"]/g;

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      out.push.apply(out, walk(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(SRC_ROOT);
const violations = [];
let modelsFoundInConfig = 0;

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  MODEL_LITERAL.lastIndex = 0;
  let m;
  while ((m = MODEL_LITERAL.exec(content)) !== null) {
    if (file === CONFIG_FILE) {
      modelsFoundInConfig++;
      continue;
    }
    // line number of this match (1-indexed)
    const upTo = content.slice(0, m.index);
    const line = upTo.split('\n').length;
    const rel = path.relative(path.join(__dirname, '..', '..'), file);
    violations.push(rel + ':' + line + ' hardcodes ' + m[1]);
  }
}

// ── Assertion 1: no model literals outside config/anthropic.js ──
try {
  if (violations.length > 0) {
    throw new Error(
      'Found ' + violations.length + ' hardcoded Claude model literal(s) outside src/config/anthropic.js:\n  ' +
      violations.join('\n  ') +
      '\n\nFix: import modelSonnet/modelHaiku/modelVision from src/config/anthropic.js' +
      '\nSee Theme 9 Sub-issue D for context (commit centralising the literals).'
    );
  }
  t.pass(fileTag + ': no hardcoded claude-* model literals outside src/config/anthropic.js');
} catch (e) {
  t.fail(fileTag + ': hardcoded model literal detected', e);
}

// ── Assertion 2: src/config/anthropic.js has at least 2 model literals (sanity) ──
// (3 helpers × 1 default each, but Sonnet + Vision can share — so floor is 2.)
try {
  if (modelsFoundInConfig < 2) {
    throw new Error(
      'src/config/anthropic.js has only ' + modelsFoundInConfig + ' claude-* literal(s); ' +
      'expected ≥ 2 (one default per model class, with Sonnet+Vision allowed to share). ' +
      'The test regex may have regressed.'
    );
  }
  t.pass(fileTag + ': src/config/anthropic.js holds ' + modelsFoundInConfig + ' model literal(s) (sanity floor met)');
} catch (e) {
  t.fail(fileTag + ': model-literal floor in src/config/anthropic.js', e);
}

// ── Assertion 3: each call site that previously hardcoded the deprecated model now imports from config ──
const CONSUMERS = [
  ['src/case-intelligence.js',  /require\(['"]\.\/config\/anthropic['"]\)/, 'modelSonnet'],
  ['src/routes/ai_assistant.js', /require\(['"]\.\.\/config\/anthropic['"]\)/, 'modelSonnet'],
  ['src/ai_image_check.js',     /require\(['"]\.\/config\/anthropic['"]\)/, 'modelVision'],
  ['src/routes/patient.js',     /require\(['"]\.\.\/config\/anthropic['"]\)/, 'modelHaiku'],
];

for (const [rel, requireRe, helper] of CONSUMERS) {
  const abs = path.join(__dirname, '..', '..', rel);
  try {
    const content = fs.readFileSync(abs, 'utf8');
    if (!requireRe.test(content)) {
      throw new Error(rel + ' does not require src/config/anthropic.js — regression');
    }
    if (!content.includes(helper + '(')) {
      throw new Error(rel + ' does not call ' + helper + '() — regression');
    }
    t.pass(fileTag + ': ' + rel + ' imports + uses ' + helper + '()');
  } catch (e) {
    t.fail(fileTag + ': ' + rel + ' consumer wiring', e);
  }
}
