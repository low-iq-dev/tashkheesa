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
 *   3. UNIQUE suffix match on the last 9 significant digits
 *
 * Step 3 returns null when it matches more than one row. Two accounts sharing a
 * suffix is precisely the ambiguity we must not resolve by guessing — silently
 * attaching a patient to the wrong medical record is far worse than asking them
 * to sign in another way.
 *
 * @param {Function} queryFn  async (sql, params) => rows   (e.g. pg.queryAll)
 * @param {string} normalized E.164 phone
 * @param {string} [rawInput] what the user actually typed
 * @param {string} [role]     restrict to a role, e.g. 'patient'
 * @returns {Promise<{user: object|null, matchedBy: string, ambiguous?: boolean}>}
 */
async function findUserByPhone(queryFn, normalized, rawInput, role) {
  const roleClause = role ? ' AND role = $2' : '';
  const roleParams = role ? [role] : [];

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

  const suffix = significantDigits(normalized || raw, 9);
  if (suffix.length >= 8) {
    const bySuffix = await queryFn(
      `SELECT * FROM users
        WHERE phone IS NOT NULL
          AND RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), $1) = $2${role ? ' AND role = $3' : ''}
        LIMIT 2`,
      [suffix.length, suffix].concat(role ? [role] : [])
    );
    if (bySuffix && bySuffix.length === 1) return { user: bySuffix[0], matchedBy: 'suffix' };
    if (bySuffix && bySuffix.length > 1) return { user: null, matchedBy: 'suffix', ambiguous: true };
  }

  return { user: null, matchedBy: 'none' };
}

module.exports = {
  normalizePhone,
  dialCodeFor,
  significantDigits,
  findUserByPhone,
  DIAL_CODES,
  _stripTrunkAfterDialCode,
};
