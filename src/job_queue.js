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

  // AUDIT-2026-08-22 (AUDIT-BOSS-POOL-1) — PgBoss was constructed with NO
  // connection bound, so it used pg-boss v12's default of max=10. Combined with
  // src/pg.js's PG_POOL_MAX that is ~20 client connections against the 15-slot
  // Supabase Free ceiling that src/pg.js:26-33 is explicitly sized around.
  //
  // AUDIT-2026-08-22 (AUDIT-BOSS-POOL-2) — the first fix bounded it to 4 on the
  // strength of a worker count that was simply WRONG. The comment said "four
  // workers, all teamConcurrency 1". The real registration is:
  //   createQueue × 6 : case-intelligence, case-reprocess, auto-assign,
  //                     specialty-classify, sla-sweep, ai-canary
  //   boss.work   × 6 : the four below, plus sla-sweep (scheduleSlaSweep) and
  //                     ai-canary (scheduleAiCanary) — both registered from
  //                     server.js after start()
  //   teamSize 2 on THREE of them (case-intelligence, auto-assign,
  //                     specialty-classify) → up to 9 concurrent handlers
  // …plus pg-boss's own maintenance and monitor (monitorStateIntervalSeconds:30)
  // connections. Against max=4, pg-boss's fetch/complete queries queue behind
  // its own pool and surface as connection timeouts; the two SCHEDULED queues
  // (sla-sweep, auto-assign) are the ones that visibly stall, and a stalled
  // sla-sweep means breaches are not detected.
  //
  // The handlers themselves do their database work on the REQUEST pool
  // (require('./pg')), not on this one, so this bound sizes pg-boss's own
  // traffic: up to 6 concurrent queue fetches + completes + maintenance +
  // monitor. 6 covers that without queueing.
  //
  // BUDGET AGAINST THE 15-SLOT SUPABASE FREE CEILING (see src/pg.js:26-33):
  //     8  request pool          (PG_POOL_MAX, lowered from 10 to pay for this)
  //   + 6  pg-boss               (PG_BOSS_POOL_MAX, raised from 4)
  //   + 1  Supabase internals / burst
  //   = 15
  // The migration advisory-lock Client (src/db.js) is a 16th connection but it
  // exists only during boot and is closed before startJobQueue() runs, so the
  // peak is 8 + 1 = 9 at boot and 8 + 6 = 14 in steady state.
  // Raise via PG_BOSS_POOL_MAX only together with the Supabase tier, and keep
  // PG_POOL_MAX + PG_BOSS_POOL_MAX ≤ 14.
  //
  // NOTE: pg-boss connects on DATABASE_URL_DIRECT (session pooler, 5432) while
  // the request pool uses the transaction pooler (6543). Different endpoints,
  // but the same Supabase project-wide connection budget.
  var PG_BOSS_POOL_MAX = parseInt(process.env.PG_BOSS_POOL_MAX, 10) || 6;

  boss = new PgBoss({
    connectionString: connectionString,
    max: PG_BOSS_POOL_MAX,
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
  logMajor('[job-queue] pg-boss started (max=' + PG_BOSS_POOL_MAX + ' connections, ' +
           (directUrl ? 'DATABASE_URL_DIRECT' : 'DATABASE_URL fallback') + ')');

  // pg-boss v12: queues must be created explicitly before workers attach
  await boss.createQueue('case-intelligence');
  await boss.createQueue('case-reprocess');
  await boss.createQueue('auto-assign');
  await boss.createQueue('specialty-classify');
  await boss.createQueue('sla-sweep');
  await boss.createQueue('ai-canary');
  logMajor('[job-queue] Queues created: case-intelligence, case-reprocess, auto-assign, specialty-classify, sla-sweep, ai-canary');

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
// AI-health canary — singleton scheduled probe (one ping across all instances)
// ---------------------------------------------------------------------------

// Scheduled handler: ignores the job payload (empty {}), so the pg-boss v12
// array signature is irrelevant here. Skips cleanly when no key is configured.
async function handleAiCanary() {
  if (!process.env.ANTHROPIC_API_KEY) {
    logMajor('[ai-canary] skipped — no ANTHROPIC_API_KEY');
    return;
  }
  var Anthropic = require('@anthropic-ai/sdk');
  var { runCanary } = require('./services/ai_health');
  var ok = await runCanary(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
  logMajor('[ai-canary] ping ' + (ok ? 'ok' : 'failed'));
}

/**
 * Schedule the AI-health canary. Mirrors scheduleSlaSweep: a single instance
 * (singletonKey) pings Anthropic with a 1-token call every few hours
 * (AI_CANARY_CRON, default every 3h) so a billing/credit outage trips the AI
 * health flag — and the heartbeat keeps the staleness check fresh — BEFORE any
 * patient hits a dead AI call.
 *
 * @returns {boolean} true if scheduled via pg-boss, false if boss not available
 */
async function scheduleAiCanary() {
  if (!boss) return false;
  await boss.work('ai-canary', { teamSize: 1, teamConcurrency: 1 }, handleAiCanary);
  var cron = process.env.AI_CANARY_CRON || '0 */3 * * *';
  await boss.schedule('ai-canary', cron, {}, { singletonKey: 'ai-canary' });
  logMajor('[job-queue] AI-health canary scheduled via pg-boss (' + cron + ', singleton)');
  return true;
}

/**
 * Nightly handler for the classifier learning loop.
 *
 * Aggregates specialty_classification_overrides into candidate corrections. It
 * only ever produces CANDIDATES — a human accepts or rejects each one from
 * /superadmin/classifier before anything steers the model. Same reason the
 * suggestion itself never auto-selects: an automated pipeline silently
 * rewriting how cases route is not something anyone should discover from a
 * support ticket.
 *
 * Non-throwing. A learner that cannot run is a missed night of training data;
 * a learner that throws inside pg-boss is a retry storm on a queue that also
 * carries case classification.
 */
async function handleClassifierLearning() {
  try {
    var learning = require('./services/classifier_learning');
    var result = await learning.aggregateCorrections();
    logMajor('[job-queue] classifier-learning: scanned ' + result.scanned +
             ' override(s), ' + result.pairs + ' pair(s), ' +
             result.candidates + ' candidate(s) for review');
  } catch (e) {
    logMajor('[job-queue] classifier-learning failed: ' + (e && e.message ? e.message : e));
  }
}

/**
 * Schedule the classifier learning aggregation. Mirrors scheduleAiCanary.
 *
 * Nightly by default — the corpus moves on the scale of days, and running it
 * hourly would burn queries to re-derive the same numbers. Override with
 * CLASSIFIER_LEARNING_CRON.
 *
 * @returns {boolean} true if scheduled via pg-boss, false if boss unavailable
 */
async function scheduleClassifierLearning() {
  if (!boss) return false;
  await boss.work('classifier-learning', { teamSize: 1, teamConcurrency: 1 }, handleClassifierLearning);
  var cron = process.env.CLASSIFIER_LEARNING_CRON || '30 3 * * *';
  await boss.schedule('classifier-learning', cron, {}, { singletonKey: 'classifier-learning' });
  logMajor('[job-queue] classifier learning scheduled via pg-boss (' + cron + ', singleton)');
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
  scheduleAiCanary: scheduleAiCanary,
  scheduleClassifierLearning: scheduleClassifierLearning,
  enqueueCaseIntelligence: enqueueCaseIntelligence,
  enqueueCaseReprocess: enqueueCaseReprocess,
  enqueueAutoAssign: enqueueAutoAssign,
  enqueueSpecialtyClassify: enqueueSpecialtyClassify
};