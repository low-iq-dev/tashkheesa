const crypto = require('crypto');

const MODE = (process.env.MODE || 'development').trim().toLowerCase();

const verbose = MODE === 'development'
  ? (...args) => console.log(`[${MODE}]`, ...args)
  : () => {};

const major = MODE === 'production'
  ? () => {}
  : (...args) => console.log(`[${MODE}]`, ...args);

const fatal = (...args) => console.error(`[${MODE}]`, ...args);

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
  return (req, res, next) => {
    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const end = process.hrtime.bigint();
      const ms = Number(end - start) / 1e6;

      const rid = req.requestId || '-';
      const status = res.statusCode;

      // Keep it simple and consistent with your existing terminal output.
      console.log(`${req.method} ${req.originalUrl || req.url} ${status} ${ms.toFixed(3)}ms ${rid}`);
    });

    next();
  };
}

/**
 * Logs an error with a generated error id for easy user support correlation.
 * Returns the errorId so routes can display it.
 */
function logError(err, context = {}) {
  const errorId = makeId('err');
  const rid = context.requestId || context.req?.requestId || '-';

  console.error(`[${MODE}] ❌ ERROR ${errorId} (req ${rid})`, {
    message: err?.message,
    name: err?.name,
    stack: err?.stack,
    context
  });

  return errorId;
}

/**
 * Persist error to the error_logs database table (fire-and-forget).
 * Never crashes if DB write fails — silently degrades to console.
 */
function logErrorToDb(err, context = {}) {
  const errorId = context.errorId || makeId('err');
  try {
    // Lazy-require db to avoid circular dependency at module load time
    const { db } = require('./db');
    if (!db) return errorId;

    // Check table exists before writing
    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='error_logs'").get();
    if (!tableCheck) return errorId;

    const id = makeId('elog');
    const message = err && err.message ? String(err.message).slice(0, 2000) : String(err || 'Unknown error').slice(0, 2000);
    const stack = err && err.stack ? String(err.stack).slice(0, 8000) : null;
    const level = context.level || 'error';
    const requestId = context.requestId || context.req?.requestId || null;
    const userId = context.userId || context.req?.user?.id || null;
    const url = context.url || context.req?.originalUrl || null;
    const method = context.method || context.req?.method || null;

    // Strip sensitive fields before storing context
    const safeContext = {};
    const skipKeys = new Set(['req', 'res', 'password', 'password_hash', 'token', 'authorization', 'cookie', 'errorId', 'level']);
    Object.keys(context).forEach(k => {
      if (!skipKeys.has(k)) safeContext[k] = context[k];
    });

    db.prepare(
      `INSERT INTO error_logs (id, error_id, level, message, stack, context, request_id, user_id, url, method)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, errorId, level, message, stack, JSON.stringify(safeContext), requestId, userId, url, method);
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
