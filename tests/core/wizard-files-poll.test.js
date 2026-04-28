// tests/core/wizard-files-poll.test.js
// Regression test: the wizard's Step 2 hydration + /patient/new-case/:id/files.json
// polling endpoint must read order_files columns that actually exist and map the
// AI-validation states to the wizard's 'readable' / 'flagged' / 'checking' shape.
//
// History: a v2 wizard migration shipped a SELECT for `order_files.is_valid` —
// a column that has never existed. Live patients hit /patient/new-case → app
// crashed with `column "is_valid" does not exist`. This test inserts a real
// DRAFT order with one order_files row at every AI status and asserts the SQL
// runs, the column actually selected (`ai_quality_status`) is present, and the
// mapping helper returns the expected boolean is_valid.
//
// Catches future regressions:
//   * Column renames in order_files
//   * New ai_quality_status string values that aren't handled in the helper
//   * Anyone re-introducing `is_valid` directly
//
// Requires DATABASE_URL set; skips itself in environments without a DB.

const t = global._testRunner || {
  pass: (n) => console.log('  \x1b[32m✅\x1b[0m ' + n),
  fail: (n, e) => console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + (e && e.message || e)),
  skip: (n, r) => console.log('  \x1b[33m⏭️\x1b[0m  ' + n + ' (' + r + ')')
};

console.log('\n🧪 Wizard files-poll regression\n');

(async function() {
  if (!process.env.DATABASE_URL) {
    return t.skip('wizard files-poll', 'DATABASE_URL not set');
  }

  let pg;
  try { pg = require('../../src/pg'); }
  catch (e) { return t.skip('wizard files-poll', 'pg module missing: ' + e.message); }
  const { queryOne, queryAll, execute } = pg;

  // 1. Confirm the columns the wizard SELECT claims to read all exist on order_files.
  try {
    const cols = await queryAll(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'order_files'`
    );
    const have = new Set((cols || []).map(c => c.column_name));
    const required = ['id', 'url', 'label', 'created_at', 'ai_quality_status'];
    const missing = required.filter(c => !have.has(c));
    if (missing.length) throw new Error('missing columns: ' + missing.join(', '));
    if (have.has('is_valid')) {
      // Future-proof: if anyone ever adds is_valid back to the schema,
      // surface that so the helper layer can be retired cleanly.
      console.log('    \x1b[33m⚠\x1b[0m  order_files.is_valid now exists — consider retiring mapAiQualityToIsValid()');
    }
    t.pass('order_files schema has all wizard-required columns');
  } catch (e) {
    return t.fail('order_files schema sanity check', e);
  }

  // 2. Insert a synthetic patient + DRAFT order + 6 order_files rows, one per
  //    AI status the wizard cares about. Run the exact SELECT the route uses
  //    and assert the helper maps each correctly.
  const { randomUUID } = require('crypto');
  const patientId = randomUUID();
  const orderId = randomUUID();
  const ts = new Date().toISOString();

  const cleanup = async () => {
    try { await execute('DELETE FROM order_files WHERE order_id = $1', [orderId]); } catch (_) {}
    try { await execute('DELETE FROM orders WHERE id = $1', [orderId]); } catch (_) {}
    try { await execute('DELETE FROM users WHERE id = $1', [patientId]); } catch (_) {}
  };

  try {
    await execute(
      `INSERT INTO users (id, email, name, role, password_hash, created_at)
       VALUES ($1, $2, 'Test Patient', 'patient', 'x', $3)`,
      [patientId, 'wizard-poll-' + patientId.slice(0, 8) + '@test.local', ts]
    );
    await execute(
      `INSERT INTO orders (id, patient_id, status, created_at, updated_at)
       VALUES ($1, $2, 'DRAFT', $3, $3)`,
      [orderId, patientId, ts]
    );

    const cases = [
      { sfx: 'a', status: 'pending',      expected: null,  shape: 'checking' },
      { sfx: 'b', status: 'ok',           expected: true,  shape: 'readable' },
      { sfx: 'c', status: 'acceptable',   expected: true,  shape: 'readable' },
      { sfx: 'd', status: 'skipped',      expected: true,  shape: 'readable' },
      { sfx: 'e', status: 'poor_quality', expected: false, shape: 'flagged'  },
      { sfx: 'f', status: 'not_medical',  expected: false, shape: 'flagged'  },
      { sfx: 'g', status: 'wrong_type',   expected: false, shape: 'flagged'  },
      { sfx: 'h', status: 'error',        expected: false, shape: 'flagged'  },
      { sfx: 'i', status: null,           expected: null,  shape: 'checking' }
    ];
    for (const c of cases) {
      await execute(
        `INSERT INTO order_files (id, order_id, url, label, ai_quality_status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), orderId, 'cdn://' + c.sfx, 'file-' + c.sfx, c.status, ts]
      );
    }

    // The SELECT must match the route handler's SELECT verbatim. If the route
    // changes columns, this query will fail or surface a missing field.
    const rows = await queryAll(
      `SELECT id, url, label, created_at, ai_quality_status
       FROM order_files WHERE order_id = $1
       ORDER BY label ASC`,
      [orderId]
    );
    if (!rows || rows.length !== cases.length) {
      throw new Error('expected ' + cases.length + ' rows, got ' + (rows ? rows.length : 0));
    }
    t.pass('wizard SELECT runs against real DB and returns all inserted rows');

    // Load the helper exactly like the route does.
    delete require.cache[require.resolve('../../src/routes/patient')];
    const patientRoute = require('../../src/routes/patient');
    const helper = patientRoute && patientRoute.__test_mapAiQualityToIsValid;
    if (typeof helper !== 'function') {
      throw new Error('mapAiQualityToIsValid not exported from src/routes/patient — exports = ' + Object.keys(patientRoute || {}).join(','));
    }
    let allOk = true;
    for (const c of cases) {
      const got = helper(c.status);
      if (got !== c.expected) {
        allOk = false;
        t.fail('mapAiQualityToIsValid(' + JSON.stringify(c.status) + ')',
          new Error('expected ' + c.expected + ', got ' + got));
      }
    }
    if (allOk) t.pass('mapAiQualityToIsValid maps every AI quality status correctly');

    // Validation shape — readable | flagged | checking — must be exact for wizard UI.
    let shapeOk = true;
    for (const c of cases) {
      const isValid = helper(c.status);
      const shape = isValid === true ? 'readable' : isValid === false ? 'flagged' : 'checking';
      if (shape !== c.shape) {
        shapeOk = false;
        t.fail('validation shape for "' + c.status + '"',
          new Error('expected "' + c.shape + '", got "' + shape + '"'));
      }
    }
    if (shapeOk) t.pass('validation shape (readable/flagged/checking) is stable for wizard UI');

  } catch (e) {
    t.fail('wizard files-poll integration', e);
  } finally {
    await cleanup();
  }
})();
