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

module.exports = {
  MODE,
  verbose,
  major,
  fatal,
  makeId,
  attachRequestId,
  accessLogger,
  logError
};
