require('dotenv').config();
const { migrate } = require('../src/db');
const { runSlaSweep } = require('../src/sla_checker');

try {
  console.log('Running SLA sweep...');
  migrate();
  runSlaSweep();
  console.log('SLA sweep complete.');
  process.exit(0);
} catch (err) {
  console.error('SLA sweep failed', err);
  process.exit(1);
}
