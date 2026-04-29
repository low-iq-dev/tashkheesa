// src/services/recipientGuard.js
//
// Defensive guard for email recipients. Imported by emailService.js and
// invoked before every transporter.sendMail() call.
//
// Kill switch: EMAIL_GUARD_STRICT (default 'true', read at send-time)
//   - 'true'  : enforce all rules (regex, blocklist, obvious-test patterns,
//               MX lookup with 1h cache).
//   - 'false' : enforce only the hardcoded blocklist + obvious-test patterns.
//               Use if MX lookups are flaking (e.g. DNS outage).
//
// On block, throws BlockedRecipientError. Callers that cannot tolerate a
// throw (e.g. lifecycle notifications running inside a DB transaction) must
// wrap in try/catch and translate to a soft return value.

const dns = require('dns').promises;
const { fatal } = require('../logger');

class BlockedRecipientError extends Error {
  constructor(reason, email) {
    super('Blocked recipient: ' + reason + ' (' + email + ')');
    this.name = 'BlockedRecipientError';
    this.reason = reason;
    this.email = email;
  }
}

const BLOCKED_DOMAINS = new Set([
  'demo.local', 'example.com', 'example.org', 'example.net',
  'test.com', 'test.local', 'localhost', 'invalid', 'local',
]);

const BLOCKED_TLDS = ['.local', '.test', '.invalid'];

const BLOCKED_LOCAL_PREFIXES = ['test', 'demo', 'fake', 'dummy', 'noreply-test'];
const PATIENT_DEMO_PATTERN = /^p\.demo-/i;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MX_CACHE_TTL_MS = 60 * 60 * 1000;
const mxCache = new Map(); // domain -> { ok: bool, expiresAt: number }

let mxResolver = (domain) => dns.resolveMx(domain);

function _setMxResolver(fn) { mxResolver = fn; }
function _clearMxCache() { mxCache.clear(); }

function _isStrict() {
  // Read at send-time, not module-load, so toggling the env in process is honored.
  return String(process.env.EMAIL_GUARD_STRICT || 'true').toLowerCase() !== 'false';
}

function _matchesTestPrefix(local) {
  for (const prefix of BLOCKED_LOCAL_PREFIXES) {
    if (
      local === prefix ||
      local.startsWith(prefix + '.') ||
      local.startsWith(prefix + '-') ||
      local.startsWith(prefix + '_')
    ) {
      return prefix;
    }
  }
  return null;
}

async function validateRecipient(email) {
  if (email == null || typeof email !== 'string' || !email.trim()) {
    throw new BlockedRecipientError('missing_or_empty', String(email));
  }
  const addr = email.trim().toLowerCase();
  if (!EMAIL_REGEX.test(addr)) {
    throw new BlockedRecipientError('malformed', addr);
  }
  const atIdx = addr.lastIndexOf('@');
  const local = addr.slice(0, atIdx);
  const domain = addr.slice(atIdx + 1);

  if (BLOCKED_DOMAINS.has(domain)) {
    throw new BlockedRecipientError('blocked_domain', addr);
  }
  for (const tld of BLOCKED_TLDS) {
    if (domain.endsWith(tld)) {
      throw new BlockedRecipientError('blocked_tld:' + tld, addr);
    }
  }

  if (PATIENT_DEMO_PATTERN.test(local)) {
    throw new BlockedRecipientError('demo_patient_pattern', addr);
  }
  const matchedPrefix = _matchesTestPrefix(local);
  if (matchedPrefix) {
    throw new BlockedRecipientError('test_local_prefix:' + matchedPrefix, addr);
  }

  if (!_isStrict()) return true;

  const cached = mxCache.get(domain);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    if (!cached.ok) throw new BlockedRecipientError('no_mx_record', addr);
    return true;
  }
  let ok = false;
  try {
    const records = await mxResolver(domain);
    ok = Array.isArray(records) && records.length > 0;
  } catch (_err) {
    ok = false;
  }
  mxCache.set(domain, { ok, expiresAt: now + MX_CACHE_TTL_MS });
  if (!ok) {
    throw new BlockedRecipientError('no_mx_record', addr);
  }
  return true;
}

// Best-effort caller detection (no agent code changes required).
function detectCaller() {
  const stack = new Error().stack || '';
  const lines = stack.split('\n').slice(2, 10);
  for (const line of lines) {
    const m = line.match(/\(([^)]+)\)/) || line.match(/at\s+(.+)$/);
    if (!m) continue;
    const loc = m[1];
    if (loc.includes('emailService') || loc.includes('recipientGuard')) continue;
    return loc;
  }
  return 'unknown';
}

async function recordBlockedAttempt(pool, { email, reason, subject, caller }) {
  if (!pool) return;
  const atIdx = String(email || '').lastIndexOf('@');
  const domain = atIdx >= 0 ? String(email).slice(atIdx + 1).toLowerCase() : null;
  try {
    await pool.query(
      'INSERT INTO blocked_send_attempts (email, domain, reason, subject, stack_caller, agent_name, skill_name) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [
        email || null,
        domain,
        reason,
        subject || null,
        caller || null,
        process.env.AGENT_NAME || null,
        process.env.SKILL_NAME || null,
      ]
    );
  } catch (err) {
    // 42P01 = undefined_table — safety net if migration 024 hasn't run yet.
    if (err && err.code !== '42P01') {
      fatal('[recipientGuard] failed to record blocked attempt', { error: err.message });
    }
  }
}

module.exports = {
  BlockedRecipientError,
  validateRecipient,
  detectCaller,
  recordBlockedAttempt,
  _setMxResolver,
  _clearMxCache,
  BLOCKED_DOMAINS,
  BLOCKED_TLDS,
  BLOCKED_LOCAL_PREFIXES,
};
