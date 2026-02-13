// src/utils/mask.js
// Sensitive data masking utilities for log output

const SENSITIVE_KEYS = new Set([
  'password', 'password_hash', 'token', 'access_token', 'api_key',
  'secret', 'authorization', 'cookie', 'credit_card', 'ssn',
  'phone', 'email', 'whatsapp_access_token'
]);

/**
 * Mask an email: z***@gmail.com
 */
function maskEmail(email) {
  if (!email || typeof email !== 'string') return '';
  var parts = email.split('@');
  if (parts.length !== 2) return '***';
  var local = parts[0];
  var domain = parts[1];
  if (local.length <= 1) return local + '***@' + domain;
  return local[0] + '***@' + domain;
}

/**
 * Mask a phone: +20***1234
 */
function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return '';
  var s = phone.replace(/\s/g, '');
  if (s.length <= 4) return '***';
  return s.slice(0, 3) + '***' + s.slice(-4);
}

/**
 * Mask a token: eyJ***...abc
 */
function maskToken(token) {
  if (!token || typeof token !== 'string') return '';
  if (token.length <= 6) return '***';
  return token.slice(0, 3) + '***' + token.slice(-3);
}

/**
 * Deep-clone an object and mask values for known sensitive keys.
 * Safe for logging — never mutates the original.
 */
function maskObject(obj, extraSensitiveKeys) {
  if (!obj || typeof obj !== 'object') return obj;

  var allKeys = new Set(SENSITIVE_KEYS);
  if (extraSensitiveKeys && Array.isArray(extraSensitiveKeys)) {
    extraSensitiveKeys.forEach(function(k) { allKeys.add(String(k).toLowerCase()); });
  }

  function mask(value, key) {
    var lk = String(key || '').toLowerCase();

    if (allKeys.has(lk)) {
      if (typeof value !== 'string') return '[REDACTED]';
      if (lk === 'email') return maskEmail(value);
      if (lk === 'phone') return maskPhone(value);
      if (lk.includes('token') || lk.includes('secret') || lk.includes('key') || lk === 'authorization' || lk === 'cookie') {
        return maskToken(value);
      }
      return '[REDACTED]';
    }

    return value;
  }

  function deepMask(input) {
    if (input === null || input === undefined) return input;
    if (typeof input !== 'object') return input;
    if (Array.isArray(input)) return input.map(deepMask);

    var result = {};
    Object.keys(input).forEach(function(key) {
      var val = input[key];
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        result[key] = deepMask(val);
      } else {
        result[key] = mask(val, key);
      }
    });
    return result;
  }

  return deepMask(obj);
}

module.exports = { maskEmail, maskPhone, maskToken, maskObject, SENSITIVE_KEYS };
