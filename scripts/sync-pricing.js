#!/usr/bin/env node
/**
 * One-time pricing sync script.
 * Run on Render Shell: node scripts/sync-pricing.js
 * Reads data/pricing_export.csv and upserts into service_regional_prices.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.PORTAL_DB_PATH || path.join(__dirname, '..', 'data', 'portal.db');
const csvPath = path.join(__dirname, '..', 'scripts', 'pricing_export.csv');

if (!fs.existsSync(dbPath)) {
  console.error('DB not found at', dbPath);
  process.exit(1);
}
if (!fs.existsSync(csvPath)) {
  console.error('CSV not found at', csvPath);
  process.exit(1);
}

const db = new Database(dbPath);
const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');

console.log(`Found ${lines.length} pricing rows to sync`);

// Clear existing and re-insert
db.exec('DELETE FROM service_regional_prices');

const insert = db.prepare(`
  INSERT INTO service_regional_prices (id, service_id, country_code, currency, hospital_cost, tashkheesa_price, doctor_commission, status, notes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const tx = db.transaction(() => {
  let count = 0;
  for (const line of lines) {
    const parts = line.split(',');
    if (parts.length < 8) continue;
    const [id, service_id, country_code, currency, hospital_cost, tashkheesa_price, doctor_commission, status, ...notesParts] = parts;
    const notes = notesParts.join(',') || null;
    insert.run(
      id,
      service_id,
      country_code,
      currency,
      hospital_cost ? parseFloat(hospital_cost) : null,
      tashkheesa_price ? parseFloat(tashkheesa_price) : null,
      doctor_commission ? parseFloat(doctor_commission) : null,
      status || 'active',
      notes
    );
    count++;
  }
  return count;
});

const count = tx();
console.log(`✅ Synced ${count} pricing rows`);

db.close();
