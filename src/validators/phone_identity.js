'use strict';

// src/validators/phone_identity.js
//
// AUDIT 2026-08-25 — portal accounts and app accounts were splitting in two.
//
// THE COMPLAINT: "an order I placed on the portal should show up in the app."
// The app's case list is correct — it filters on patient_id and folds status
// case. The break is IDENTITY: the same human ends up as two `users` rows.
//
// HOW. The app's OTP path does `SELECT * FROM users WHERE phone = $1` against a
// normalised E.164 string and, on no match, INSERTs a brand-new user. So any
// stored phone that does not normalise to exactly the same string produces a
// second, empty account — and the patient sees none of their portal orders.
//
// WHY THE STORED VALUES DIFFER. src/validators/phone.js normalises without any
// country context. Two consequences, both observed in production on 2026-08-25:
//
//   '1277399043'   -> '+1277399043'    a US number. This is the founder's own
//                                      Egyptian mobile; his real account is
//                                      '+201277399043'. Two accounts, 18 orders
//                                      on one and 1 on the other.
//   '01098729248'  -> REJECTED         the ordinary way an Egyptian writes their
//                                      own number. Four of twelve phone-bearing
//                                      patients were in this state, i.e. unable
//                                      to sign in by OTP at all.
//
// A third shape, '+2001149055838', comes from concatenating a '+20' dial code
// with a local '01149055838' without dropping the national trunk '0'.
//
// This module adds the missing piece: country context. A local number is only
// ambiguous until you know which country it was dialled in, and we always have
// a hint — the picker's dial code, the user's stored country, or the market.
//
// It also provides findUserByPhone, which resolves a phone to an EXISTING
// account across all the legacy spellings before anyone considers creating a
// new one. That is the actual fix for the parity complaint: the lookup, not the
// data repair. The data repair (migration 083) just cleans up what already
// split.

const { validatePhoneE164 } = require('./phone');

// Dial code -> { iso, nationalLen } where nationalLen is the length of the
// subscriber number WITHOUT the national trunk prefix. Used to tell a local
// number from an already-international one.
const DIAL_CODES = Object.freeze({
  '+20':  { iso: 'EG', nationalLen: 10 },
  '+966': { iso: 'SA', nationalLen: 9 },
  '+971': { iso: 'AE', nationalLen: 9 },
  '+965': { iso: 'KW', nationalLen: 8 },
  '+974': { iso: 'QA', nationalLen: 8 },
  '+973': { iso: 'BH', nationalLen: 8 },
  '+968': { iso: 'OM', nationalLen: 8 },
  '+44':  { iso: 'GB', nationalLen: 10 },
  '+1':   { iso: 'US', nationalLen: 10 },
});

const ISO_TO_DIAL = Object.freeze(
  Object.keys(DIAL_CODES).reduce((acc, dial) => {
    acc[DIAL_CODES[dial].iso] = dial;
    return acc;
  }, {})
);

// Longest-prefix match, so '+1' never shadows '+20' etc.
const DIALS_BY_LENGTH = Object.keys(DIAL_CODES).sort((a, b) => b.length - a.length);

function digitsOnly(v) {
  return String(v == null ? '' : v).replace(/[^0-9]/g, '');
}

/**
 * Resolve a country hint to a dial code.
 * Accepts an ISO code ('EG'), a dial code ('+20' or '20'), or null.
 */
function dialCodeFor(hint) {
  if (!hint) return null;
  const raw = String(hint).trim().toUpperCase();
  if (ISO_TO_DIAL[raw]) return ISO_TO_DIAL[raw];
  const withPlus = raw.startsWith('+') ? raw : '+' + raw.replace(/^0+/, '');
  return DIAL_CODES[withPlus] ? withPlus : null;
}

/**
 * Normalise a phone number to E.164, using a country hint to interpret a
 * LOCAL number (one written the way a person in that country writes it).
 *
 * This is deliberately separate from validatePhoneE164 rather than a change to
 * it: that function is used on paths where no country is known, and widening it
 * to guess would make the '+1' misclassification above more likely, not less.
 *
 * @param {string} input       what the user typed, or what is in the database
 * @param {string} [countryHint] ISO ('EG') or dial code ('+20')
 * @param {string} [lang]      for the error message
 * @returns {{ok: true, normalized: string} | {ok: false, error: string}}
 */
function normalizePhone(input, countryHint, lang) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return validatePhoneE164(raw, lang); // reuse the localised messages

  const hadPlus = raw.charCodeAt(0) === 43;
  let digits = digitsOnly(raw);
  if (!digits) return validatePhoneE164(raw, lang);

  const dial = dialCodeFor(countryHint);

  // 1. Already international and unambiguous — a leading '+' means the caller
  //    told us the country. Repair only the double-trunk shape below.
  if (hadPlus) {
    const repaired = _stripTrunkAfterDialCode(digits);
    return validatePhoneE164('+' + repaired, lang);
  }

  // 2. No '+'. If we have a country hint, treat the number as local: drop any
  //    national trunk prefix '0' and prepend the dial code. This is the case
  //    that used to be rejected outright or misread as a US number.
  if (dial) {
    const dialDigits = dial.slice(1);
    const spec = DIAL_CODES[dial];

    // Already carries its own country code (user typed '201012345678').
    if (digits.startsWith(dialDigits) && digits.length > spec.nationalLen) {
      const repaired = _stripTrunkAfterDialCode(digits);
      return validatePhoneE164('+' + repaired, lang);
    }
    const local = digits.replace(/^0+/, '');
    return validatePhoneE164('+' + dialDigits + local, lang);
  }

  // 3. No hint and no '+'. A leading '0' is a national trunk prefix that cannot
  //    be interpreted without knowing the country, so refuse rather than guess
  //    — guessing is exactly how '+1277399043' happened.
  if (digits.charAt(0) === '0') {
    return validatePhoneE164('0' + digits, lang); // will be rejected, with the right message
  }
  return validatePhoneE164(raw, lang);
}

/**
 * Repair '<dial><0><subscriber>' — e.g. '2001149055838', produced by pasting a
 * dial code in front of a local number without dropping the trunk '0'.
 * Returns the digits unchanged when the shape does not apply.
 */
function _stripTrunkAfterDialCode(digits) {
  for (const dial of DIALS_BY_LENGTH) {
    const dialDigits = dial.slice(1);
    if (!digits.startsWith(dialDigits)) continue;
    const rest = digits.slice(dialDigits.length);
    const spec = DIAL_CODES[dial];
    // Only strip when doing so yields exactly the expected national length —
    // otherwise a legitimate subscriber number starting with 0 would be eaten.
    if (rest.charAt(0) === '0' && rest.length === spec.nationalLen + 1) {
      return dialDigits + rest.slice(1);
    }
    return digits;
  }
  return digits;
}

/**
 * The dial code of an already-international number, by longest-prefix match.
 * Returns null for a number outside our nine markets.
 */
function dialCodeFromE164(e164) {
  const digits = digitsOnly(e164);
  if (!digits) return null;
  for (const dial of DIALS_BY_LENGTH) {
    if (digits.startsWith(dial.slice(1))) return dial;
  }
  return null;
}

/**
 * Is `storedRaw` the SAME telephone number as `normalized`, written differently?
 *
 * AUDIT 2026-09-06 (BLOCKER 2). This is the guard the suffix lookup was
 * missing. The suffix query below finds rows whose last 9 digits match; that is
 * a fine way to find CANDIDATES and a catastrophic way to decide IDENTITY,
 * because the one caller of this module mints a session from whatever row comes
 * back. Egyptian (+20) and British (+44) numbers are both 12 digits in E.164, so
 * the 9-digit key discards the country entirely: two unrelated people, one in
 * Cairo and one in London, can share it. The caller would have been signed in as
 * the other person, with their medical history — and, because the OTP handler
 * then healed the row to the caller's number, permanently.
 *
 * So: re-normalise the stored spelling and require the FULL E.164 to match.
 * A legacy local form ('01277399043') and a bare form ('1277399043') still
 * resolve to the same account, which is the whole point of the module. A
 * different country's number no longer can.
 */
function isSameNumber(storedRaw, normalized, countryHint) {
  const target = String(normalized == null ? '' : normalized).trim();
  const stored = String(storedRaw == null ? '' : storedRaw).trim();
  if (!target || !stored) return false;
  if (stored === target) return true;

  // A local spelling only has meaning inside a country. Try the caller's own
  // hint first (the dial code they picked), then the country of the number
  // being verified — a row stored in a legacy shape is overwhelmingly the same
  // country as the number now signing in.
  const hints = [countryHint, dialCodeFromE164(target)];
  for (const hint of hints) {
    if (!hint) continue;
    const r = normalizePhone(stored, hint);
    if (r && r.ok && r.normalized === target) return true;
  }
  return false;
}

/**
 * The last N significant digits of a number, used ONLY as a secondary lookup
 * key to find an account stored under a legacy spelling.
 *
 * Deliberately 9: shorter than every national subscriber number in our markets
 * (Gulf markets are 8, so 9 includes at least one country digit), long enough
 * that a collision between two real customers is implausible at our scale, and
 * stable across '+20…' / '0…' / bare-digit spellings of the same number.
 *
 * This is a RECOVERY path, not an identity rule — see findUserByPhone, which
 * only accepts a suffix match when it is unique.
 */
function significantDigits(input, n) {
  const digits = digitsOnly(input);
  const take = n || 9;
  return digits.length <= take ? digits : digits.slice(-take);
}

/**
 * Find the existing user for a phone number, tolerating the legacy spellings
 * already in the table.
 *
 * Order matters:
 *   1. exact match on the normalised E.164 form — the common, correct case
 *   2. exact match on the raw input, for rows stored before normalisation
 *   3. suffix candidates on the last 9 significant digits, each then VERIFIED
 *      to be the same full number written differently (AUDIT 2026-09-06)
 *
 * Step 3 returns null when more than one row survives verification, and null
 * when none does. Two accounts sharing a suffix is precisely the ambiguity we
 * must not resolve by guessing — silently attaching a patient to the wrong
 * medical record is far worse than asking them to sign in another way.
 *
 * @param {Function} queryFn  async (sql, params) => rows   (e.g. pg.queryAll)
 * @param {string} normalized E.164 phone
 * @param {string} [rawInput] what the user actually typed
 * @param {string} [role]     restrict to a role, e.g. 'patient'
 * @param {string} [countryHint] ISO ('EG') or dial code ('+20') — the country
 *   the caller just dialled from. Used to re-normalise legacy stored spellings
 *   during suffix verification (AUDIT 2026-09-06, BLOCKER 2). Omitting it does
 *   not weaken the guard: verification falls back to the dial code of the
 *   number being looked up, so an unhinted call still refuses a cross-country
 *   match — it just resolves fewer legacy local spellings.
 * @returns {Promise<{user: object|null, matchedBy: string, ambiguous?: boolean, suffixRejected?: boolean}>}
 */
async function findUserByPhone(queryFn, normalized, rawInput, role, countryHint) {
  // `role` accepts a single role or an array. An array is the OTP case: sign-in
  // is gated to ('patient','doctor') so that an SMS code sent to a staff number
  // can never mint a token that satisfies requireRole('superadmin').
  const roles = role == null ? null : (Array.isArray(role) ? role : [role]);
  const roleClause = roles ? ' AND role = ANY($2)' : '';
  const roleParams = roles ? [roles] : [];

  if (normalized) {
    const exact = await queryFn(
      `SELECT * FROM users WHERE phone = $1${roleClause} LIMIT 2`,
      [normalized].concat(roleParams)
    );
    if (exact && exact.length === 1) return { user: exact[0], matchedBy: 'exact' };
    if (exact && exact.length > 1) return { user: null, matchedBy: 'exact', ambiguous: true };
  }

  const raw = String(rawInput == null ? '' : rawInput).trim();
  if (raw && raw !== normalized) {
    const legacy = await queryFn(
      `SELECT * FROM users WHERE phone = $1${roleClause} LIMIT 2`,
      [raw].concat(roleParams)
    );
    if (legacy && legacy.length === 1) return { user: legacy[0], matchedBy: 'legacy_raw' };
    if (legacy && legacy.length > 1) return { user: null, matchedBy: 'legacy_raw', ambiguous: true };
  }

  // Step 3 — suffix CANDIDATES, then full-number verification.
  //
  // AUDIT 2026-09-06 (BLOCKER 2). This step used to return whatever single row
  // shared the last 9 digits, and that row was then signed in. See isSameNumber
  // above for why that is an account-takeover primitive rather than a
  // convenience. The query is unchanged — it is a good index-friendly way to
  // narrow the table — but its output is now a candidate list that every row
  // must earn its way out of by normalising to the SAME E.164 string.
  //
  // LIMIT raised 2 -> 5: with verification, extra candidates are the normal
  // case (a real collision plus the real account), and stopping at 2 would let
  // one unrelated row hide the genuine match behind a false 'ambiguous'.
  const suffix = significantDigits(normalized || raw, 9);
  if (suffix.length >= 8) {
    const bySuffix = await queryFn(
      `SELECT * FROM users
        WHERE phone IS NOT NULL
          AND RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), $1) = $2${roles ? ' AND role = ANY($3)' : ''}
        LIMIT 5`,
      [suffix.length, suffix].concat(roles ? [roles] : [])
    );
    const candidates = (bySuffix || []).filter(
      (row) => isSameNumber(row && row.phone, normalized || raw, countryHint)
    );
    if (candidates.length === 1) {
      return { user: candidates[0], matchedBy: 'suffix_verified' };
    }
    if (candidates.length > 1) {
      // Two rows that really are the same number. Duplicate identity, not a
      // collision — still refuse, for the original reason: attaching a patient
      // to the wrong medical record is worse than asking them to sign in
      // another way.
      return { user: null, matchedBy: 'suffix_verified', ambiguous: true };
    }
    if (bySuffix && bySuffix.length > 0) {
      // Rows shared the suffix and NONE of them is this number. Before today
      // one of these would have been signed in. Reported so the caller can log
      // it — this is the near-miss that used to be a takeover.
      return { user: null, matchedBy: 'suffix_rejected', suffixRejected: true };
    }
  }

  return { user: null, matchedBy: 'none' };
}

module.exports = {
  normalizePhone,
  dialCodeFor,
  dialCodeFromE164,
  isSameNumber,
  significantDigits,
  findUserByPhone,
  DIAL_CODES,
  _stripTrunkAfterDialCode,
};
