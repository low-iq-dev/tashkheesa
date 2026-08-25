'use strict';

// tests/_helpers/strip-comments.js
//
// Scan CODE, not prose.
//
// This exists because the same trap has now caught three separate tests in this
// repo: a grep for a forbidden literal happily matches the COMMENT EXPLAINING
// why the literal is forbidden, and the tempting "fix" is to water down the
// explanation until the test passes. That trades a good comment for a green
// tick, which is a bad trade twice over — the next person loses the reasoning
// AND the test still is not checking what it claims to.
//
// Known casualties before this helper existed:
//   * anthropic-model-centralisation — matched its own comment
//   * case-draft-flow — two bare `status = 'DRAFT'` "violations", both prose
//   * ops-notifications — a comment saying "rather than routed through
//     pushOpsEvent" read as a call to pushOpsEvent
//
// Walks the source once, tracking string and template context so a '//' inside
// 'https://...' is not mistaken for a comment. Newlines are preserved so line
// numbers still line up with the original file.

function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;      // "'" | '"' | '`' while inside a string
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (quote) {
      out += c;
      if (c === '\\') { out += (next === undefined ? '' : next); i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }

    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; i++; continue; }

    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;                                   // the newline itself is kept below
    }

    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';         // keep line numbering honest
        i++;
      }
      i += 2;
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

// SQL comments inside a query string. `stripComments` deliberately leaves
// string contents alone, so a `-- note` inside a template-literal query
// survives — which is usually what you want, but not when asserting on the SQL
// itself.
function stripSqlComments(src) {
  return src.replace(/^\s*--.*$/gm, '');
}

module.exports = { stripComments, stripSqlComments };
