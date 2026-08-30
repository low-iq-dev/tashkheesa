// tests/lint/anthropic-request-options-not-in-body.test.js
//
// The Anthropic SDK takes the message BODY as its first argument and REQUEST
// OPTIONS as its second. Anything that is not a real body field, put in the
// first argument, is forwarded to the API and rejected:
//
//   400 invalid_request_error  "timeout: Extra inputs are not permitted"
//
// routes/ai_assistant.js shipped `timeout: 30000` in the body. Every call the
// website's "Help me choose" assistant ever made was rejected — the feature had
// a 100% failure rate from the day the timeout was added.
//
// It went unnoticed because the handler's catch matched `msg.includes('timeout')`
// and answered 504 ai_timeout. The API's own rejection message begins with the
// name of the offending field, so the error handler read the words "timeout" in
// a 400 and reported a timeout. A permanent, total outage disguised itself as a
// slow network — the one failure mode nobody investigates.
//
// Two assertions, because the bug needed both halves to stay hidden.

'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('../_helpers/strip-comments');

const t = global._testRunner || {
  pass: function (n) { console.log('  \x1b[32m✅\x1b[0m ' + n); },
  fail: function (n, e) { console.error('  \x1b[31m❌\x1b[0m ' + n + ': ' + ((e && e.message) || e)); process.exitCode = 1; },
};
const fileTag = path.basename(__filename, '.test.js');

console.log('\n🔌 Anthropic request options belong in the second argument\n');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

// Every key the Messages API actually accepts in the body. Anything else in the
// first argument is a 400. Kept explicit rather than as a blocklist so a NEW
// mistake (`maxRetries`, `signal`, `httpAgent`, …) is caught too.
const BODY_FIELDS = new Set([
  'model', 'messages', 'max_tokens', 'system', 'temperature', 'top_p', 'top_k',
  'stop_sequences', 'stream', 'metadata', 'tools', 'tool_choice',
  'service_tier', 'thinking', 'container', 'mcp_servers', 'betas',
]);

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      out.push.apply(out, walk(full));
    } else if (e.isFile() && e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Pull the first-argument object literal out of a `messages.create({ … })`.
// Brace-counting rather than a regex, because the body contains nested objects
// and template literals.
function firstArgKeys(code, startIdx) {
  const open = code.indexOf('{', startIdx);
  if (open === -1) return null;
  let depth = 0, i = open, inStr = null;
  for (; i < code.length; i++) {
    const c = code[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  const body = code.slice(open + 1, i);
  // Top-level keys only — skip anything nested one level deeper.
  const keys = [];
  let d = 0, s = null;
  let token = '';
  for (let j = 0; j < body.length; j++) {
    const c = body[j];
    if (s) { if (c === '\\') { j++; continue; } if (c === s) s = null; continue; }
    if (c === "'" || c === '"' || c === '`') { s = c; continue; }
    if (c === '{' || c === '[' || c === '(') d++;
    else if (c === '}' || c === ']' || c === ')') d--;
    else if (c === ':' && d === 0) {
      const m = token.match(/([A-Za-z_$][\w$]*)\s*$/);
      if (m) keys.push(m[1]);
      token = '';
      continue;
    } else if (c === ',' && d === 0) { token = ''; continue; }
    token += c;
  }
  return keys;
}

function check(name, fn) {
  try { fn(); t.pass(fileTag + ': ' + name); }
  catch (e) { t.fail(fileTag + ': ' + name, e); }
}

// ── 1. No request option may sit in the message body ────────────────────────
check('every messages.create() body contains only real API fields', function () {
  const bad = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(ROOT, file);
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    const re = /messages\.create\s*\(/g;
    let m;
    while ((m = re.exec(code)) !== null) {
      // Twilio also exposes messages.create(); it never names a Claude model.
      const near = code.slice(Math.max(0, m.index - 600), m.index + 1200);
      if (!/model\s*:/.test(near)) continue;
      const keys = firstArgKeys(code, m.index);
      if (!keys) continue;
      for (const k of keys) {
        if (!BODY_FIELDS.has(k)) {
          bad.push(rel + ' → "' + k + '" is not a Messages API body field');
        }
      }
    }
  }
  if (bad.length) {
    throw new Error(
      'Request options found in the message BODY:\n  ' + bad.join('\n  ') +
      '\n\nThe SDK signature is create(body, options). Anything unknown in the ' +
      'body is returned as 400 "<field>: Extra inputs are not permitted", so ' +
      'EVERY call fails. Move it to the second argument.'
    );
  }
});

// ── 2. A 4xx must never be reported as a timeout ────────────────────────────
//
// The body fix alone is not enough. What made this survive was an error handler
// that decided "timeout" from message text, so an API validation error naming
// any field called `timeout` read as a network problem.
check('the assistant does not infer a timeout from message text', function () {
  const file = path.join(SRC, 'routes', 'ai_assistant.js');
  const code = stripComments(fs.readFileSync(file, 'utf8'));

  const timeoutBranch = code.match(/if\s*\([^)]*ai_timeout[\s\S]{0,200}?\)/);
  const substringTest = /includes\(\s*['"]timeout['"]\s*\)|includes\(\s*['"]Timeout['"]\s*\)/;
  if (substringTest.test(code)) {
    throw new Error(
      'routes/ai_assistant.js still decides a timeout by searching the error ' +
      'message for "timeout". That is how a permanent 400 ("timeout: Extra ' +
      'inputs are not permitted") was served as 504 ai_timeout for months. ' +
      'Key on err.code / err.name / status instead.'
    );
  }
  if (!/status\s*>=\s*400\s*&&\s*status\s*<\s*500/.test(code)) {
    throw new Error(
      'routes/ai_assistant.js no longer handles 4xx explicitly. A request the ' +
      'API rejects is our bug and must not fall through to a transport error.'
    );
  }
});
