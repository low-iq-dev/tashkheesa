// src/job_queue.js
// Durable job queue backed by pg-boss.
// Wraps fire-and-forget operations so they survive crashes and restarts.

var { PgBoss } = require('pg-boss');
var { major: logMajor, fatal: logFatal } = require('./logger');

var boss = null;

// ---------------------------------------------------------------------------
// Initialization — call once after DB migration
// ---------------------------------------------------------------------------
async function startJobQueue() {
var connectionString = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
  if (!connectionString) {
    logMajor('[job-queue] DATABASE_URL not set — skipping pg-boss');
    return;
  }

  boss = new PgBoss({
    connectionString: connectionString,
    ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false },
    retryLimit: 3,
    retryDelay: 30,
    expireInSeconds: 15 * 60,
    retentionDays: 7,
    archiveCompletedAfterSeconds: 12 * 60 * 60,
    monitorStateIntervalSeconds: 30
  });

  boss.on('error', function(err) {
    logFatal('[job-queue] pg-boss error: ' + err.message);
  });

  await boss.start();
  logMajor('[job-queue] pg-boss started');

  // pg-boss v12: queues must be created explicitly before workers attach
  await boss.createQueue('case-intelligence');
  await boss.createQueue('case-reprocess');
  await boss.createQueue('auto-assign');
  logMajor('[job-queue] Queues created: case-intelligence, case-reprocess, auto-assign');

  // Register job handlers
  await boss.work('case-intelligence', { teamSize: 2, teamConcurrency: 1 }, handleCaseIntelligence);
  await boss.work('case-reprocess', { teamSize: 1, teamConcurrency: 1 }, handleCaseReprocess);
  await boss.work('auto-assign', { teamSize: 2, teamConcurrency: 1 }, handleAutoAssign);

  logMajor('[job-queue] Workers registered: case-intelligence, case-reprocess, auto-assign');
}

// ---------------------------------------------------------------------------
// Job handlers — thin wrappers around the existing functions
// ---------------------------------------------------------------------------

async function handleCaseIntelligence(job) {
  var orderId = job.data.orderId;
  logMajor('[job-queue] case-intelligence start: ' + orderId);
  var { processCaseIntelligence } = require('./case-intelligence');
  await processCaseIntelligence(orderId);
}

async function handleCaseReprocess(job) {
  var caseId = job.data.caseId;
  logMajor('[job-queue] case-reprocess start: ' + caseId);
  var { reprocessCase } = require('./case-intelligence');
  await reprocessCase(caseId);
}

async function handleAutoAssign(job) {
  var orderId = job.data.orderId;
  logMajor('[job-queue] auto-assign start: ' + orderId);
  var { autoAssignDoctor, isAutoAssignEnabled } = require('./auto_assign');
  var enabled = await isAutoAssignEnabled();
  if (!enabled) {
    logMajor('[job-queue] auto-assign skipped (disabled): ' + orderId);
    return;
  }
  await autoAssignDoctor(orderId);
}

// ---------------------------------------------------------------------------
// Enqueue helpers — used by route handlers instead of fire-and-forget
// ---------------------------------------------------------------------------

async function enqueueCaseIntelligence(orderId) {
  if (!boss) {
    // Fallback: run directly if pg-boss isn't started
    var { processCaseIntelligence } = require('./case-intelligence');
    processCaseIntelligence(orderId).catch(function(err) {
      console.error('Case intelligence failed:', err);
    });
    return;
  }
  await boss.send('case-intelligence', { orderId: orderId }, {
    singletonKey: 'ci:' + orderId,
    singletonSeconds: 60
  });
}

async function enqueueCaseReprocess(caseId) {
  if (!boss) {
    var { reprocessCase } = require('./case-intelligence');
    reprocessCase(caseId).catch(function(err) {
      console.error('Case reprocess failed:', err);
    });
    return;
  }
  await boss.send('case-reprocess', { caseId: caseId }, {
    singletonKey: 'cr:' + caseId,
    singletonSeconds: 60
  });
}

async function enqueueAutoAssign(orderId) {
  if (!boss) {
    var { autoAssignDoctor, isAutoAssignEnabled } = require('./auto_assign');
    isAutoAssignEnabled().then(function(enabled) {
      if (enabled) return autoAssignDoctor(orderId);
    }).catch(function(err) {
      console.error('[auto-assign] error:', err.message);
    });
    return;
  }
  await boss.send('auto-assign', { orderId: orderId }, {
    singletonKey: 'aa:' + orderId,
    singletonSeconds: 60
  });
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
async function stopJobQueue() {
  if (boss) {
    try {
      await boss.stop({ graceful: true, timeout: 5000 });
      logMajor('[job-queue] pg-boss stopped');
    } catch (e) {
      logFatal('[job-queue] pg-boss stop error: ' + e.message);
    }
  }
}

module.exports = {
  startJobQueue: startJobQueue,
  stopJobQueue: stopJobQueue,
  enqueueCaseIntelligence: enqueueCaseIntelligence,
  enqueueCaseReprocess: enqueueCaseReprocess,
  enqueueAutoAssign: enqueueAutoAssign
};