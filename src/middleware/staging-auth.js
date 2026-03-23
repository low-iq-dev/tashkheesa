// src/middleware/staging-auth.js
// Basic Auth middleware for staging environment.

var path = require('path');
var { major: logMajor, fatal: logFatal } = require('../logger');

var EXEMPT_PATHS = new Set(['/health', '/status', '/healthz', '/__version']);
var ASSET_EXTENSIONS = new Set([
  '.css', '.js', '.png', '.jpg', '.jpeg', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.map'
]);

function isAssetRequest(reqPath) {
  if (!reqPath) return false;
  if (reqPath.startsWith('/public/') || reqPath.startsWith('/assets/')) return true;
  if (reqPath === '/favicon.ico') return true;
  var ext = path.extname(reqPath).toLowerCase();
  return ASSET_EXTENSIONS.has(ext);
}

function sendAuthChallenge(res) {
  res.set('WWW-Authenticate', 'Basic realm="Tashkheesa Staging"');
  return res.status(401).send('Authentication required');
}

function setupStagingAuth(app, opts) {
  var MODE = opts.MODE;
  var STAGING_AUTH_USER = opts.BASIC_AUTH_USER;
  var STAGING_AUTH_PASS = opts.BASIC_AUTH_PASS;

  if (MODE !== 'staging') return;

  if (!STAGING_AUTH_USER || !STAGING_AUTH_PASS) {
    logFatal('Missing BASIC_AUTH_USER/BASIC_AUTH_PASS in staging — refusing to start with empty credentials.');
    process.exit(1);
  }

  app.use(function stagingBasicAuth(req, res, next) {
    if (MODE !== 'staging') return next();
    var normalizedPath = req.path || '/';
    if (EXEMPT_PATHS.has(normalizedPath) || isAssetRequest(normalizedPath)) {
      return next();
    }
    var header = req.headers.authorization || '';
    if (!header.startsWith('Basic ')) {
      return sendAuthChallenge(res);
    }
    var credentials = Buffer.from(header.slice(6), 'base64').toString('utf8');
    var parts = credentials.split(':');
    var user = parts[0] || '';
    var pass = parts[1] || '';
    if (user === STAGING_AUTH_USER && pass === STAGING_AUTH_PASS) {
      return next();
    }
    logMajor('Staging auth failed for ' + normalizedPath);
    return sendAuthChallenge(res);
  });
}

module.exports = { setupStagingAuth: setupStagingAuth };
