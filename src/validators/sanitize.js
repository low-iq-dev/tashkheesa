// src/validators/sanitize.js
// Input sanitization utilities

/**
 * Strip dangerous HTML (script tags, event handlers, dangerous attributes).
 * Not a full HTML sanitizer — strips tags entirely for text-only fields.
 */
function sanitizeHtml(input) {
  if (!input || typeof input !== 'string') return '';
  var s = input;
  // Remove null bytes
  s = s.replace(/\0/g, '');
  // Remove script tags and content
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  // Remove event handler attributes
  s = s.replace(/\s*on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, '');
  // Remove javascript: protocol
  s = s.replace(/javascript\s*:/gi, '');
  // Remove style tags (can contain expressions)
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  // Remove iframe/object/embed tags
  s = s.replace(/<\s*\/?\s*(iframe|object|embed|applet|form)\b[^>]*>/gi, '');
  // Remove data: URIs in attributes
  s = s.replace(/\bdata\s*:\s*[^,;\s"']+/gi, '');
  return s.trim();
}

/**
 * Sanitize a plain string: trim, limit length, strip null bytes.
 */
function sanitizeString(input, maxLen) {
  if (!input || typeof input !== 'string') return '';
  var s = input.replace(/\0/g, '').trim();
  if (maxLen && s.length > maxLen) {
    s = s.slice(0, maxLen);
  }
  return s;
}

/**
 * Normalize phone to digits + optional leading +.
 */
function sanitizePhone(input) {
  if (!input || typeof input !== 'string') return '';
  var s = input.replace(/\0/g, '').trim();
  // Keep only digits, +, spaces, dashes (then normalize)
  s = s.replace(/[^\d+\-\s()]/g, '');
  // Strip everything except digits and leading +
  var hasPlus = s.startsWith('+');
  s = s.replace(/\D/g, '');
  if (hasPlus) s = '+' + s;
  return s;
}

/**
 * Validate email format (basic).
 */
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  // Simple pattern: something@something.something
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

module.exports = {
  sanitizeHtml,
  sanitizeString,
  sanitizePhone,
  isValidEmail
};
