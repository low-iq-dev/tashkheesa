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
  // Theme 5 sub-issue C. pg-boss requires a session-mode connection because
  // it relies on LISTEN/NOTIFY and Postgres advisory locks (cross-instance
  // singleton crons). On Render+Supabase, DATABASE_URL points at the
  // pgbouncer transaction-mode pooler (port 6543), which silently breaks
  // both. DATABASE_URL_DIRECT must be set to the Supabase "session pooler"
  // connection string (port 5432).
  var directUrl = process.env.DATABASE_URL_DIRECT;
  var fallbackUrl = process.env.DATABASE_URL;
  var mode = String(process.env.MODE || '').trim().toLowerCase();
  var nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase();
  var isProdLike = mode === 'production' || mode === 'staging' ||
                   nodeEnv === 'production' || nodeEnv === 'staging';

  if (isProdLike && !directUrl) {
    var msg = '[job-queue] FATAL: DATABASE_URL_DIRECT is required in ' +
      (mode || nodeEnv) + '. pg-boss needs a session-mode (port 5432) connection ' +
      'because LISTEN/NOTIFY and advisory locks do not work over the Supabase ' +
      'pgbouncer transaction-mode pooler. Set DATABASE_URL_DIRECT on Render to ' +
      'the Supabase "Session pooler" connection string (Project Settings → ' +
      'Database → Session pooler).';
    logFatal(msg);
    // Hard-exit: the calling try/catch in server.js would otherwise swallow
    // a thrown error and let the server proceed without pg-boss. process.exit
    // matches the existing JWT_SECRET / DATABASE_URL fatal pattern.
    process.exit(1);
  }

  var connectionString = directUrl || fallbackUrl;
  if (!connectionString) {
    logMajor('[job-queue] DATABASE_URL not set — skipping pg-boss');
    return;
  }
  if (!directUrl) {
    // Dev fallback. The pgbouncer URL works for basic pg-boss operation but
    // breaks cross-instance singletons + LISTEN/NOTIFY — fine for local
    // single-instance dev, never acceptable in prod/staging (gated above).
    logMajor('[job-queue] DATABASE_URL_DIRECT not set — falling back to DATABASE_URL ' +
      '(dev only). LISTEN/NOTIFY + cross-instance singletons may misbehave.');
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
  await boss.createQueue('specialty-classify');
  await boss.createQueue('sla-sweep');
  logMajor('[job-queue] Queues created: case-intelligence, case-reprocess, auto-assign, specialty-classify, sla-sweep');

  // Register job handlers
  await boss.work('case-intelligence', { teamSize: 2, teamConcurrency: 1 }, handleCaseIntelligence);
  await boss.work('case-reprocess', { teamSize: 1, teamConcurrency: 1 }, handleCaseReprocess);
  await boss.work('auto-assign', { teamSize: 2, teamConcurrency: 1 }, handleAutoAssign);
  await boss.work('specialty-classify', { teamSize: 2, teamConcurrency: 1 }, handleSpecialtyClassify);

  logMajor('[job-queue] Workers registered: case-intelligence, case-reprocess, auto-assign, specialty-classify');
}

// ---------------------------------------------------------------------------
// Job handlers — thin wrappers around the existing functions
//
// pg-boss v10+ passes an ARRAY of jobs to work() handlers (batchSize
// defaults to 1, so normally an array of one). These handlers were
// originally written against the v9 single-job signature, which made
// every data-carrying job fail with "Cannot read properties of
// undefined (reading 'orderId')". jobsArray() normalizes both shapes.
// ---------------------------------------------------------------------------

function jobsArray(jobOrBatch) {
  return Array.isArray(jobOrBatch) ? jobOrBatch : [jobOrBatch];
}

async function handleCaseIntelligence(batch) {
  var { processCaseIntelligence } = require('./case-intelligence');
  for (var job of jobsArray(batch)) {
    var orderId = job.data.orderId;
    logMajor('[job-queue] case-intelligence start: ' + orderId);
    await processCaseIntelligence(orderId);
  }
}

async function handleCaseReprocess(batch) {
  var { reprocessCase } = require('./case-intelligence');
  for (var job of jobsArray(batch)) {
    var caseId = job.data.caseId;
    logMajor('[job-queue] case-reprocess start: ' + caseId);
    await reprocessCase(caseId);
  }
}

async function handleAutoAssign(batch) {
  var { autoAssignDoctor, isAutoAssignEnabled } = require('./auto_assign');
  for (var job of jobsArray(batch)) {
    var orderId = job.data.orderId;
    logMajor('[job-queue] auto-assign start: ' + orderId);
    var enabled = await isAutoAssignEnabled();
    if (!enabled) {
      logMajor('[job-queue] auto-assign skipped (disabled): ' + orderId);
      continue;
    }
    await autoAssignDoctor(orderId);
  }
}

async function handleSpecialtyClassify(batch) {
  var { runClassification } = require('./services/classify_job');
  for (var job of jobsArray(batch)) {
    var orderId = job.data.orderId;
    logMajor('[job-queue] specialty-classify start: ' + orderId);
    await runClassification(orderId);
  }
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

async function enqueueSpecialtyClassify(orderId) {
  if (!boss) {
    var { runClassification } = require('./services/classify_job');
    runClassification(orderId).catch(function(err) {
      console.error('inline classify failed', err);
    });
    return;
  }
  await boss.send('specialty-classify', { orderId: orderId }, {
    singletonKey: 'sc:' + orderId,
    singletonSeconds: 60
  });
}

// ---------------------------------------------------------------------------
// SLA sweep — singleton scheduled job (prevents duplicate sweeps across instances)
// ---------------------------------------------------------------------------

async function handleSlaSweep() {
  logMajor('[job-queue] sla-sweep start');
  var { runCaseSlaSweep } = require('./case_sla_worker');
  var result = await runCaseSlaSweep();
  logMajor('[job-queue] sla-sweep done — breaches=' + result.breaches + ' timeouts=' + result.timeouts);
}

/**
 * Schedule the SLA sweep as a pg-boss cron job.
 * pg-boss guarantees only one instance processes the job at a time across
 * all Render instances via the singletonKey, eliminating the race condition
 * that existed with per-process setInterval.
 *
 * @returns {boolean} true if scheduled via pg-boss, false if boss not available
 */
async function scheduleSlaSweep() {
  if (!boss) return false;
  await boss.work('sla-sweep', { teamSize: 1, teamConcurrency: 1 }, handleSlaSweep);
  await boss.schedule('sla-sweep', '*/5 * * * *', {}, { singletonKey: 'sla-primary' });
  logMajor('[job-queue] SLA sweep scheduled via pg-boss (*/5 * * * *, singleton)');
  return true;
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
  scheduleSlaSweep: scheduleSlaSweep,
  enqueueCaseIntelligence: enqueueCaseIntelligence,
  enqueueCaseReprocess: enqueueCaseReprocess,
  enqueueAutoAssign: enqueueAutoAssign,
  enqueueSpecialtyClassify: enqueueSpecialtyClassify
};