#!/usr/bin/env node
'use strict';

/**
 * Renders the consultant-portal app icons referenced by
 * public/manifest.webmanifest from the existing brand icon
 * (public/assets/brand/tashkheesa-icon.svg). Local-only; the PNGs are
 * committed. Re-run if the brand icon changes:
 *
 *   node scripts/generate-portal-icons.js
 */

const fs = require('fs');
const path = require('path');
const { loadPuppeteer, findChrome } = require('./lib/chrome');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'public', 'assets', 'brand', 'tashkheesa-icon.svg');
const OUT = path.join(ROOT, 'public', 'icons');

(async function main() {
  const svg = fs.readFileSync(SRC);
  const puppeteer = loadPuppeteer();
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    for (const size of [192, 512]) {
      await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
      await page.setContent(
        '<!doctype html><html><body style="margin:0;background:transparent">' +
        '<img alt="" style="display:block;width:' + size + 'px;height:' + size + 'px" src="data:image/svg+xml;base64,' +
        svg.toString('base64') + '"></body></html>'
      );
      await page.evaluate(() => document.images[0].decode());
      const file = path.join(OUT, 'portal-' + size + '.png');
      await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
      console.log('wrote', path.relative(ROOT, file));
    }
  } finally {
    await browser.close();
  }
})().catch((err) => { console.error(err); process.exit(1); });
