'use strict';

// src/services/access_revocation.js
//
// A4 (AUDIT 2026-09-09) — per-instance, FAIL-OPEN cache of the small set of
// accounts whose live sessions must be refused NOW rather than at cookie/token
// expiry: accounts carrying a tokens_valid_after cut (deactivate / reject /
// password change) and blocked doctors (is_active=false or a rejection_reason).
//
// Deliberately the SAME shape as the deleted_users tombstone in src/middleware.js
// — ONE query per instance per minute, answered from an in-memory map, never a
// query per request. req.user is built from verify(token) with no DB read (Phase
// 3 FIX #12), and that is right while accounts only ever appear; revocation is
// the rare, bounded case that this cache covers without paying a read on every
// request.
//
// FAILS OPEN. A lookup that cannot run — the column missing before migration 106
// applies, or the database unreachable — must NEVER log every doctor out. The
// failure it guards (a deactivated doctor keeping access for up to TTL_MS longer)
// is small and bounded; the failure it would cause (locking out the whole
// roster) is total. Every uncertain branch returns "not revoked".

const { loginBlockReason } = require('./login_gate');

const TTL_MS = 60 * 1000;
let _rows = new Map(); // id -> { tva_ms, is_active, rejection_reason, pending_approval, role }
let _at = 0;
let _inFlight = null;

function refresh() {
  if (_inFlight) return _inFlight;
  _inFlight = (async () => {
    try {
      const { queryAll } = require('../pg');
      const rows = await queryAll(
        `SELECT id, tokens_valid_after, is_active, rejection_reason, pending_approval, role
           FROM users
          WHERE tokens_valid_after IS NOT NULL
             OR is_active = false
             OR rejection_reason IS NOT NULL
             OR pending_approval = true`,
        []
      );
      const next = new Map();
      for (const r of (rows || [])) {
        next.set(String(r.id), {
          tva_ms: r.tokens_valid_after ? Date.parse(r.tokens_valid_after) : null,
          is_active: r.is_active,
          rejection_reason: r.rejection_reason,
          pending_approval: r.pending_approval,
          role: r.role,
        });
      }
      _rows = next;
      _at = Date.now();
    } catch (_) {
      // Column missing (pre-106) or DB unreachable. Back off a full TTL rather
      // than retrying every request, and leave the current map (empty at boot)
      // so the fail-open contract holds: nobody is locked out.
      _at = Date.now();
    } finally {
      _inFlight = null;
    }
  })();
  return _inFlight;
}

function _cachedRow(id) {
  if (!id) return null;
  if (Date.now() - _at > TTL_MS) {
    // Kick a refresh but answer from the current map — never block a request on
    // it. A newly-revoked id is caught on the following request at worst.
    refresh();
  }
  return _rows.get(String(id)) || null;
}

// Pure predicate — no DB, no cache. Exported for the guard's negative test.
function _isStaleRow(row, iatSeconds) {
  if (!row || row.tva_ms == null) return false;
  const iat = Number(iatSeconds);
  if (!Number.isFinite(iat)) return false; // fail open: no iat, cannot judge
  // JWT `iat` is whole SECONDS; the cut is a millisecond timestamp. Compare at
  // second granularity so a token re-issued in the SAME second the cut was
  // stamped is NOT treated as stale — otherwise the fresh session cookie a
  // password reset sets right after stamping tokens_valid_after would floor to
  // just under the cut and be revoked ~60s later (when the cache picks it up).
  // Only a token from an EARLIER second is revoked; the sub-second imprecision
  // errs toward NOT locking anyone out, which is the fail-safe direction.
  return iat < Math.floor(row.tva_ms / 1000);
}

/**
 * True when this token was minted BEFORE the account's revocation cut.
 * @param {string} userId
 * @param {number} iatSeconds  the JWT `iat` claim (seconds since epoch)
 */
function isTokenStale(userId, iatSeconds) {
  return _isStaleRow(_cachedRow(userId), iatSeconds);
}

/**
 * The reason this doctor may not hold a session (is_active=false / pending), or
 * null. Delegates to login_gate so login and per-request enforcement agree, and
 * so pause is NOT a lockout (login_gate deliberately ignores is_paused).
 * Returns null for non-doctors and for accounts not in the cache.
 */
function doctorBlockReason(userId) {
  const row = _cachedRow(userId);
  if (!row) return null;
  return loginBlockReason({
    role: row.role,
    is_active: row.is_active,
    pending_approval: row.pending_approval,
    rejection_reason: row.rejection_reason,
  });
}

module.exports = { isTokenStale, doctorBlockReason, refresh, _isStaleRow, TTL_MS };
