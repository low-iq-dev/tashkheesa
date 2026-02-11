/**
 * Sanitize sensitive data in logs
 */

function maskSensitiveData(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  const sensitive = [
    'password', 'password_hash', 'token', 'secret', 'jwt',
    'api_key', 'payment_link', 'payment_method', 'credit_card',
    'phone', 'ssn'
  ];

  const copy = JSON.parse(JSON.stringify(obj));

  function mask(obj) {
    for (const key in obj) {
      const lowerKey = String(key).toLowerCase();
      if (sensitive.some(s => lowerKey.includes(s))) {
        obj[key] = '***REDACTED***';
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        mask(obj[key]);
      }
    }
  }

  mask(copy);
  return copy;
}

module.exports = { maskSensitiveData };
