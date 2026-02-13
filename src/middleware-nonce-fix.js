// Add this at the top of middleware.js, after the imports

const crypto = require('crypto');

function generateNonce() {
  return crypto.randomBytes(16).toString('base64');
}

// Middleware to add nonce to res.locals
function addNonceMiddleware(req, res, next) {
  res.locals.nonce = generateNonce();
  next();
}

module.exports = { generateNonce, addNonceMiddleware };
