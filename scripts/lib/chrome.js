'use strict';

// Locating a headless Chrome for the local-only scripts (mobile-shots,
// generate-portal-icons). Nothing here runs in the app or in the test suite.

const fs = require('fs');
const os = require('os');
const path = require('path');

function loadPuppeteer() {
  const tries = [
    'puppeteer-core',
    process.env.PUPPETEER_CORE_DIR,
    path.join(os.homedir(), 'mobile_audit', 'node_modules', 'puppeteer-core')
  ].filter(Boolean);
  for (const t of tries) {
    try { return require(t); } catch (_) { /* next */ }
  }
  throw new Error('puppeteer-core not found. Install it (npm i -D puppeteer-core) or set PUPPETEER_CORE_DIR.');
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const dir = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
  const versions = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const num = (v) => (v.split('-')[1] || '').split('.').map((n) => Number(n) || 0);
  versions.sort((a, b) => {
    const x = num(a); const y = num(b);
    for (let i = 0; i < 4; i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
    return 0;
  });
  for (const v of versions) {
    const candidates = [
      path.join(dir, v, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      path.join(dir, v, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      path.join(dir, v, 'chrome-linux64', 'chrome')
    ];
    const hit = candidates.find((c) => fs.existsSync(c));
    if (hit) return hit;
  }
  throw new Error('No Chrome for Testing under ' + dir + ' — set CHROME_PATH.');
}

module.exports = { loadPuppeteer, findChrome };
