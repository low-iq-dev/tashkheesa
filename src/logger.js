const crypto = require('crypto');

const MODE = (process.env.MODE || 'development').trim().toLowerCase();

const verbose = MODE === 'development'
  ? (...args) => console.log(`[${MODE}]`, ...args)
  : () => {};

const major = MODE === 'production'
  ? () => {}
  : (...args) => console.log(`[${MODE}]`, ...args);

// Theme 8 Phase 4-A — logFatal now routes Error args to error_logs.
//
// Pre-fix: bare console.error wrapper. Every logFatal call surfaced only
// on Render stdout — invisible to /ops/errors. The 33 call sites across
// server.js, case_sla_worker.js, job_queue.js, etc. all silently lost
// observability for fatal/process-killing failures.
//
// Backward-compatible across all three caller shapes:
//   logFatal(msg)                          — message only, no DB write
//   logFatal(msg, err)                     — Error at args[1], DB write fires
//   logFatal(msg, ctxId, err)              — Error at args[2] (case_sla_worker
//                                             per-candidate handlers); DB
//                                             write fires via .find(...)
//
// Crash-after-log is preserved at the CALLER — logFatal does NOT call
// process.exit(). Callers that intend to die still do `process.exit(1)`
// immediately after logFatal(). The DB write is best-effort — if the DB
// itself is unavailable, logErrorToDb's internal try/catch swallows the
// failure and the process still dies on the caller's process.exit(1).
const fatal = (msg, ...rest) => {
  console.error(`[${MODE}]`, msg, ...rest);
  // Auto-detect Error anywhere in the rest args. All three documented
  // caller shapes are covered: 1-arg (no Error → console-only),
  // 2-arg (Error at args[0] of rest), 3-arg (Error at args[1] of rest).
  const err = rest.find((a) => a instanceof Error);
  if (err) {
    // Fire-and-forget; never await. logErrorToDb has its own internal
    // try/catch around the DB write — if the DB is what just died, the
    // write fails silently and process.exit(1) at the caller still
    // happens. This is the correct ordering for unhandledRejection /
    // uncaughtException callers in server.js.
    logErrorToDb(err, {
      context: 'logFatal',
      category: 'fatal',
      level: 'fatal',
      message: typeof msg === 'string' ? String(msg).slice(0, 500) : null
    });
  }
};

/**
 * Create a short, human-friendly correlation id.
 * Example: req_2f3a9c1b
 */
function makeId(prefix = 'id') {
  // 4 bytes => 8 hex chars
  const hex = crypto.randomBytes(4).toString('hex');
  return `${prefix}_${hex}`;
}

/**
 * Express middleware: attaches a request id and returns it in the response.
 * Safe: no behavior changes to routes.
 */
function attachRequestId(req, res, next) {
  const existing = req.headers['x-request-id'];
  const requestId = (typeof existing === 'string' && existing.trim())
    ? existing.trim()
    : makeId('req');

  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}

/**
 * Express middleware: access logging with request id.
 * Example: GET /doctor/queue 200 32.8ms req_ab12cd34
 */
function accessLogger() {
  // Regex to strip sensitive query params from logged URLs
  const sensitiveParamPattern = /([?&])(token|key|secret|access_token|api_key|authorization)=[^&]*/gi;

  return (req, res, next) => {
    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const end = process.hrtime.bigint();
      const ms = Number(end - start) / 1e6;

      const rid = req.requestId || '-';
      const status = res.statusCode;

      // Strip sensitive query params before logging
      let logUrl = req.originalUrl || req.url;
      logUrl = logUrl.replace(sensitiveParamPattern, '$1$2=[REDACTED]');

      console.log(`${req.method} ${logUrl} ${status} ${ms.toFixed(3)}ms ${rid}`);
    });

    next();
  };
}

/**
 * Logs an error with a generated error id for easy user support correlation.
 * Auto-masks sensitive fields in context before logging.
 * Returns the errorId so routes can display it.
 */
function logError(err, context = {}) {
  const errorId = makeId('err');
  const rid = context.requestId || context.req?.requestId || '-';

  // Mask sensitive data in context before logging
  let safeContext = context;
  try {
    const { maskObject } = require('./utils/mask');
    safeContext = maskObject(context);
  } catch (e) {
    // mask module not loaded yet, log raw (safe fallback)
  }

  console.error(`[${MODE}] ❌ ERROR ${errorId} (req ${rid})`, {
    message: err?.message,
    name: err?.name,
    stack: err?.stack,
    context: safeContext
  });

  return errorId;
}

/**
 * Persist error to the error_logs database table (fire-and-forget).
 * Never crashes if DB write fails — silently degrades to console.
 */
async function logErrorToDb(err, context = {}) {
  const errorId = context.errorId || makeId('err');
  try {
    // Lazy-require pg to avoid circular dependency at module load time
    const { execute, queryOne } = require('./pg');

    // Check table exists before writing
    const tableCheck = await queryOne(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'error_logs'"
    );
    if (!tableCheck) return errorId;

    const id = makeId('elog');
    const message = err && err.message ? String(err.message).slice(0, 2000) : String(err || 'Unknown error').slice(0, 2000);
    const stack = err && err.stack ? String(err.stack).slice(0, 8000) : null;
    const level = context.level || 'error';
    const requestId = context.requestId || context.req?.requestId || null;
    const userId = context.userId || context.req?.user?.id || null;
    const url = context.url || context.req?.originalUrl || null;
    const method = context.method || context.req?.method || null;
    // Theme 8 Phase 1 — populate the category column added by migration 035.
    // Pre-fix the canonical INSERT omitted this column, so the partial index
    // idx_error_logs_category was unused for ~99% of rows and /ops/errors
    // filter-by-category yielded no results for any caller routing through
    // this helper. Pulling from context.category (null-by-default) lets
    // existing callers pass category without re-shaping every catch site.
    const category = context.category || null;

    // Strip sensitive fields (and category — surfaced as its own column above)
    // before storing context.
    const skipKeys = new Set(['req', 'res', 'errorId', 'level', 'category']);
    const filteredContext = {};
    Object.keys(context).forEach(k => {
      if (!skipKeys.has(k)) filteredContext[k] = context[k];
    });
    let safeContext = filteredContext;
    try {
      const { maskObject } = require('./utils/mask');
      safeContext = maskObject(filteredContext);
    } catch (e) {
      // mask module not available yet
    }

    await execute(
      `INSERT INTO error_logs (id, error_id, level, category, message, stack, context, request_id, user_id, url, method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, errorId, level, category, message, stack, JSON.stringify(safeContext), requestId, userId, url, method]
    );
  } catch (e) {
    // Fire-and-forget: never crash if DB write fails
    console.error('[logErrorToDb] DB write failed:', e.message);
  }
  return errorId;
}

module.exports = {
  MODE,
  verbose,
  major,
  fatal,
  makeId,
  attachRequestId,
  accessLogger,
  logError,
  logErrorToDb
};
