#!/usr/bin/env node
// tests/run.js — Tashkheesa test runner
// Runs all test files, skips any that require SQLite (legacy)
// Compatible with PostgreSQL-only setup

const path = require('path');
const fs   = require('fs');

const RED   = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let totalPassed = 0;
let totalFailed = 0;
let totalSkipped = 0;

// ── Shared test helpers exported to test files ─────────────────────────────
global._testRunner = {
  pass: (name) => { totalPassed++; console.log(`  ${GREEN}✅${RESET} ${name}`); },
  fail: (name, err) => { totalFailed++; console.error(`  ${RED}❌${RESET} ${name}: ${err.message || err}`); },
  skip: (name, reason) => { totalSkipped++; console.log(`  ${YELLOW}⏭️${RESET}  ${name} (skipped: ${reason})`); },
};

// ── Discover test files ────────────────────────────────────────────────────
function findTests(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      results.push(...findTests(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      results.push(full);
    }
  }
  return results;
}

const testsDir = path.join(__dirname);
const testFiles = findTests(testsDir).filter(f => !f.includes('run.js'));

console.log(`\n🧪 Tashkheesa Test Suite\n${'─'.repeat(50)}`);
console.log(`Found ${testFiles.length} test files\n`);

// ── Run each test file ─────────────────────────────────────────────────────
for (const file of testFiles) {
  const rel = path.relative(testsDir, file);
  console.log(`\n📋 ${rel}`);
  try {
    require(file);
  } catch (err) {
    // If it's a SQLite/legacy error, skip gracefully
    if (err.message && (err.message.includes('better-sqlite3') || err.message.includes('sqlite3') || err.message.includes('portal.db'))) {
      totalSkipped++;
      console.log(`  ${YELLOW}⏭️${RESET}  Skipped (SQLite legacy test — not applicable with PostgreSQL)`);
    } else {
      totalFailed++;
      console.error(`  ${RED}❌${RESET} Test file crashed: ${err.message}`);
    }
  }
}

// ── Summary ───────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`${GREEN}Passed:${RESET}  ${totalPassed}`);
console.log(`${RED}Failed:${RESET}  ${totalFailed}`);
console.log(`${YELLOW}Skipped:${RESET} ${totalSkipped}`);
console.log(`${'─'.repeat(50)}\n`);

if (totalFailed > 0) {
  process.exit(1);
}
