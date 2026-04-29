#!/usr/bin/env node
/**
 * Tashkheesa Pricing Sync — from canonical pricing JSON
 *
 * Reads docs/pricing/tashkheesa_pricing_v2.json (generated from xlsx)
 * and upserts into:
 *   - specialties (insert missing, rename mismatched)
 *   - services    (upsert by specialty_id+name, mark unmatched as is_visible=false)
 *
 * IDEMPOTENT — safe to run multiple times.
 *
 * To regenerate the JSON from the canonical .xlsx:
 *   python3 docs/pricing/xlsx_to_json.py
 *
 * Usage:
 *   node scripts/sync_pricing_from_xlsx.js --dry-run    # preview, no writes
 *   node scripts/sync_pricing_from_xlsx.js              # apply
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const PRICING_JSON = path.resolve(__dirname, '..', 'docs', 'pricing', 'tashkheesa_pricing_v2.json');
const DRY_RUN = process.argv.includes('--dry-run');

const SPECIALTY_ID_MAP = {
  'Cardiology':                  'spec-cardiology',
  'Dermatology':                 'spec-dermatology',
  'Endocrinology':               'spec-endocrinology',
  'ENT (Ear, Nose & Throat)':    'spec-ent',
  'Gastroenterology':            'spec-gastroenterology',
  'General Surgery':             'spec-general-surgery',
  'Hematology':                  'spec-hematology',
  'Neurology':                   'spec-neurology',
  'Oncology':                    'spec-oncology',
  'Ophthalmology':               'spec-ophthalmology',
  'Orthopedics':                 'spec-orthopedics',
  'Pathology & Lab':             'lab_pathology',
  'Pediatrics':                  'spec-pediatrics',
  'Pulmonology':                 'spec-pulmonology',
  'Radiology':                   'spec-radiology',
  'Urology':                     'spec-urology',
};

function specialtyIdToCode(specialtyId) {
  return specialtyId.replace(/^spec-/, '').replace(/_/g, '-');
}

function slugify(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function main() {
  const data = JSON.parse(fs.readFileSync(PRICING_JSON, 'utf-8'));
  const spreadsheetServices = data.priced_services
    .filter(s => SPECIALTY_ID_MAP[s.specialty])
    .map(s => ({
      specialty_id: SPECIALTY_ID_MAP[s.specialty],
      name: s.name,
      base_price: s.tashkheesa_price,
      doctor_fee: s.doctor_fee,
      tier: s.tier,
    }));

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    console.log(`\n=== Tashkheesa Pricing Sync ${DRY_RUN ? '[DRY RUN]' : '[LIVE]'} ===\n`);
    console.log(`Source: ${PRICING_JSON}`);
    console.log(`Priced services: ${spreadsheetServices.length}`);
    console.log(`Unpriced services (excluded): ${data.unpriced_count}\n`);

    await client.query('BEGIN');

    // ── 1. Specialties ─────────────────────────────────────────
    console.log('Step 1: Specialties');
    const dbSpecs = await client.query('SELECT id, name FROM specialties');
    const dbSpecMap = new Map(dbSpecs.rows.map(r => [r.id, r.name]));

    let specInsert = 0, specRename = 0;
    for (const [name, id] of Object.entries(SPECIALTY_ID_MAP)) {
      if (!dbSpecMap.has(id)) {
        console.log(`  + INSERT specialty: ${id} | ${name}`);
        if (!DRY_RUN) {
          await client.query(
            'INSERT INTO specialties (id, name, is_visible) VALUES ($1, $2, true)',
            [id, name]
          );
        }
        specInsert++;
      } else if (dbSpecMap.get(id) !== name) {
        console.log(`  ~ RENAME specialty ${id}: "${dbSpecMap.get(id)}" -> "${name}"`);
        if (!DRY_RUN) {
          await client.query('UPDATE specialties SET name = $1 WHERE id = $2', [name, id]);
        }
        specRename++;
      }
    }
    console.log(`  -> ${specInsert} inserted, ${specRename} renamed\n`);

    // ── 2. Services upsert ─────────────────────────────────────
    console.log('Step 2: Services (upsert by specialty_id + name)');
    let svcUpdate = 0, svcInsert = 0, svcUnchanged = 0;
    const seenKeys = new Set();

    for (const svc of spreadsheetServices) {
      const key = `${svc.specialty_id}|${svc.name}`;
      seenKeys.add(key);

      const existing = await client.query(
        'SELECT id, base_price, doctor_fee, is_visible, currency FROM services WHERE specialty_id = $1 AND name = $2',
        [svc.specialty_id, svc.name]
      );

      if (existing.rows.length === 0) {
        const newId = `svc-${slugify(svc.specialty_id.replace(/^spec-/, ''))}-${slugify(svc.name)}`.slice(0, 200);
        const code = `${specialtyIdToCode(svc.specialty_id)}-${slugify(svc.name)}`.slice(0, 80);
        console.log(`  + INSERT  ${svc.specialty_id}/${svc.name}  base=${svc.base_price} fee=${svc.doctor_fee}`);
        if (!DRY_RUN) {
          await client.query(
            `INSERT INTO services (id, specialty_id, code, name, base_price, doctor_fee, currency, is_visible, sla_hours)
             VALUES ($1, $2, $3, $4, $5, $6, 'EGP', true, 48)`,
            [newId, svc.specialty_id, code, svc.name, svc.base_price, svc.doctor_fee]
          );
        }
        svcInsert++;
      } else {
        const cur = existing.rows[0];
        const changed = (
          Number(cur.base_price) !== svc.base_price ||
          Number(cur.doctor_fee) !== svc.doctor_fee ||
          cur.is_visible !== true ||
          cur.currency !== 'EGP'
        );
        if (changed) {
          console.log(`  ~ UPDATE  ${svc.specialty_id}/${svc.name}  base ${cur.base_price}->${svc.base_price}, fee ${cur.doctor_fee}->${svc.doctor_fee}, visible ${cur.is_visible}->true`);
          if (!DRY_RUN) {
            await client.query(
              `UPDATE services
               SET base_price = $1, doctor_fee = $2, currency = 'EGP', is_visible = true
               WHERE id = $3`,
              [svc.base_price, svc.doctor_fee, cur.id]
            );
          }
          svcUpdate++;
        } else {
          svcUnchanged++;
        }
      }
    }
    console.log(`  -> ${svcInsert} inserted, ${svcUpdate} updated, ${svcUnchanged} unchanged\n`);

    // ── 3. Hide rows not in spreadsheet ────────────────────────
    console.log('Step 3: Hide services not in spreadsheet');
    const allDb = await client.query('SELECT id, specialty_id, name, is_visible FROM services');
    let svcHidden = 0;
    for (const row of allDb.rows) {
      const key = `${row.specialty_id}|${row.name}`;
      if (seenKeys.has(key)) continue;
      if (row.is_visible === false) continue;
      console.log(`  ~ HIDE    ${row.specialty_id || '(no spec)'}/${row.name}`);
      if (!DRY_RUN) {
        await client.query('UPDATE services SET is_visible = false WHERE id = $1', [row.id]);
      }
      svcHidden++;
    }
    console.log(`  -> ${svcHidden} newly hidden\n`);

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      console.log('=== DRY RUN — nothing committed ===\n');
    } else {
      await client.query('COMMIT');
      console.log('=== COMMITTED ===\n');
    }

    // ── 4. Final state ─────────────────────────────────────────
    const final = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE is_visible = true) AS visible,
        COUNT(*) FILTER (WHERE is_visible = false) AS hidden,
        COUNT(*) FILTER (WHERE is_visible = true AND ABS((doctor_fee / NULLIF(base_price, 0)) - 0.20) < 0.01) AS visible_correct,
        COUNT(*) FILTER (WHERE is_visible = true AND ABS((doctor_fee / NULLIF(base_price, 0)) - 0.20) >= 0.01) AS visible_wrong,
        COUNT(*) FILTER (WHERE is_visible = true AND (base_price IS NULL OR doctor_fee IS NULL)) AS visible_null
      FROM services
    `);
    console.log('Final services state:');
    console.table(final.rows[0]);

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\n!!! ERROR — rolled back:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
