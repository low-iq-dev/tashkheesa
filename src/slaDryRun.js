// src/slaDryRun.js

const DRY_RUN = process.env.SLA_DRY_RUN === 'true';

function isDryRun() {
  return DRY_RUN;
}

function dryRunLog(message, meta = {}) {
  console.log('🧪 SLA DRY-RUN:', message, meta);
}

module.exports = {
  isDryRun,
  dryRunLog
};