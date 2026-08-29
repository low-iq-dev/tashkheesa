'use strict';
// Guard: a provider webhook must verify its signature over the RAW body, fail
// closed when unconfigured, and be CSRF-exempt only because of that.
//
// The whole value of /webhooks/resend is that it decides who the platform is
// allowed to email. An endpoint that writes to email_suppressions without
// authenticating the caller lets anyone on the internet blacklist any doctor.
//
// The specific traps this locks down:
//   1. Verifying against JSON.stringify(req.body) instead of the raw bytes.
//      Key order and escaping differ, so it fails on every real delivery — and
//      the "fix" people reach for is to stop verifying.
//   2. Treating a missing secret as "skip verification". That turns an
//      unconfigured deploy into an open endpoint.
//   3. Being CSRF-exempt without a signature check, which is just unauthenticated.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ROUTE = path.join(ROOT, 'src', 'routes', 'webhooks_resend.js');
const SRC = fs.readFileSync(ROUTE, 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

test('the webhook verifies a signature before reading the body', () => {
  const verifyAt = CODE.indexOf('verifySvixSignature');
  const bodyAt = CODE.indexOf('req.body');
  assert.ok(verifyAt > 0, 'expected verifySvixSignature to be called');
  assert.ok(bodyAt > 0, 'expected req.body to be used');
  assert.ok(verifyAt < bodyAt, 'signature must be verified BEFORE req.body is read');
});

test('verification uses the raw body, never the re-serialised one', () => {
  assert.ok(/rawBody:\s*req\.rawBody/.test(CODE),
    'must verify against req.rawBody');
  assert.ok(!/JSON\.stringify\(\s*req\.body\s*\)/.test(CODE),
    'JSON.stringify(req.body) is not the bytes that were signed');
});

test('an unverified request is refused and writes nothing', () => {
  const verdictIdx = CODE.indexOf('if (!verdict.ok)');
  assert.ok(verdictIdx > 0, 'expected an explicit !verdict.ok branch');
  const branch = CODE.slice(verdictIdx, verdictIdx + 400);
  assert.ok(/return res\.status\(401\)/.test(branch), 'must answer 401');
  const firstWrite = CODE.search(/execute\(/);
  assert.ok(firstWrite === -1 || verdictIdx < firstWrite,
    'the rejection must come before any database write');
});

test('a missing secret fails closed, it does not skip verification', () => {
  const verifier = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'svix_verify.js'), 'utf8');
  assert.ok(/if \(!secret\) return \{ ok: false/.test(verifier),
    'an absent signing secret must be a verification FAILURE, not a bypass');
  assert.ok(/timingSafeEqual/.test(verifier), 'signature comparison must be constant-time');
  assert.ok(/TOLERANCE_SECONDS/.test(verifier), 'a timestamp tolerance is required or payloads replay forever');
});

test('the CSRF exemption is exact-match, not a prefix', () => {
  const csrf = fs.readFileSync(path.join(ROOT, 'src', 'middleware', 'csrf.js'), 'utf8');
  assert.ok(/p === '\/webhooks\/resend'/.test(csrf),
    "the exemption must be an exact path match — a startsWith('/webhooks') prefix would exempt future unsigned endpoints too");
  assert.ok(!/startsWith\('\/webhooks/.test(csrf),
    'no prefix exemption for /webhooks');
});

test('suppression lookups fail open', () => {
  // A suppression table that cannot be read must not stop every email on the
  // platform. Both readers catch and continue.
  assert.ok(/catch \(_\) \{[\s\S]{0,400}?return false;/.test(CODE),
    'isSuppressed must return false (sendable) when the lookup throws');
  const svc = fs.readFileSync(path.join(ROOT, 'src', 'services', 'doctor_outreach.js'), 'utf8');
  const at = svc.indexOf('FROM email_suppressions');
  assert.ok(at > 0, 'expected the outreach console to read email_suppressions');
  assert.ok(/catch \(_\) \{/.test(svc.slice(at, at + 700)),
    'the outreach suppression read must be wrapped so a DB failure does not blank the page');
});
