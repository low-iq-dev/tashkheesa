'use strict';
// 1 Oct 2026 — signup collects name + WhatsApp number (+ country) only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
test('register form asks for name, country, phone and terms only', () => {
  const v = read('src/views/register.ejs');
  for (const f of ['name="name"', 'name="country_code"', 'name="phone"', 'name="terms"']) assert.ok(v.includes(f), f);
  assert.ok(!/name="email"/.test(v), 'email field removed');
  assert.ok(!/name="password"/.test(v), 'password field removed');
});
test('POST /register no longer requires email or password', () => {
  const a = read('src/routes/auth.js');
  assert.match(a, /const passwordHash = password \? await hash\(password\) : null;/);
  assert.match(a, /if \(password && String\(password\)\.length < 8\)/);
  assert.match(a, /if \(normalizedEmail\) try \{/);
  assert.ok(!a.includes("if (!email || !password || !name || !normalizedCountry)"));
});
test('/wa redirects to Tash and is a language-prefixed public path', () => {
  assert.match(read('src/routes/static-pages.js'), /router\.get\('\/wa'/);
  assert.match(read('src/utils/public_lang_url.js'), /'\/wa'/);
});
test('auth pages use the teal background (portal-global no longer overrides it with blue)', () => {
  const css = read('public/css/portal-global.css');
  const block = css.slice(css.indexOf('.auth-page {'), css.indexOf('.auth-card {'));
  assert.ok(block.includes('#F8F5EF'));
  assert.ok(!block.includes('var(--medical-blue)'));
});
