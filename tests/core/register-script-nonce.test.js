'use strict';
// 1 Oct 2026: register.ejs's dial-code script had no CSP nonce, so production
// refused to run it — the phone field showed "—" and "choose your country
// first" with Egypt already selected. Pin the nonce.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
test('register.ejs inline script carries the CSP nonce', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'views', 'register.ejs'), 'utf8');
  const tags = s.match(/<script\b[^>]*>/g) || [];
  assert.ok(tags.length >= 1);
  for (const t of tags) if (!/\bsrc=/.test(t)) assert.match(t, /nonce=/);
});
