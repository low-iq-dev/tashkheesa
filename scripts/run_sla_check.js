require('dotenv').config();
const { db, migrate } = require('../src/db');
const { runSlaCheck } = require('../src/sla_worker');

(async () => {
  try {
    migrate();
    runSlaCheck();
    console.log('SLA check completed');
    process.exit(0);
  } catch (err) {
    console.error('SLA check failed', err);
    process.exit(1);
  }
})();
