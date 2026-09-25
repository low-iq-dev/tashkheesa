/**
 * ONE definition of "a real case" — i.e. not a doctor-onboarding practice case.
 *
 * Migration 110 added orders.is_practice: training rows seeded into a real
 * doctor's real queue, "invisible to money, to metrics and to the automated
 * machinery". The doctor side (routes/doctor.js, earnings_writer) honoured that
 * from day one; the operator side did not, so on 2026-09-25 the Command app's
 * Pulse, revenue and case list and the web /superadmin dashboard were ~96%
 * training data (27 paid practice orders vs 1 real paid order in prod).
 *
 * Every operator-facing metric or list reads through ONE of these two:
 *
 *   realCaseSql(p)       — a predicate, for queries that already have a WHERE
 *                          (and for the shared predicates in
 *                          routes/api/_assign_helpers.js, which build on it).
 *   REAL_ORDERS_ACTIVE   — a relation, for the many hand-written dashboard
 *                          queries that say `FROM orders_active`: write
 *                          `FROM ${REAL_ORDERS_ACTIVE} orders_active` (or `… o`)
 *                          and the rest of the query is untouched.
 *
 * Do NOT change the orders_active VIEW itself: the doctor queue needs practice
 * rows in it, which is the whole point of practice cases.
 *
 * A by-id read (GET /cases/:id, the web order page, every write path) keeps
 * working on a practice case — the id was handed over by something that
 * already decided the case is in scope. Such reads carry a `practice-ok:`
 * marker; tests/auth/practice-cases-operator-views.test.js enforces the split.
 */

'use strict';

// `p` is the column prefix — 'o.' when the query aliases the table, '' when it
// does not. COALESCE so a NULL (a LEFT JOIN that matched no order) counts as
// real: rows that are not about an order must not vanish.
function realCaseSql(p) {
  return `NOT COALESCE(${p || ''}is_practice, false)`;
}

const REAL_ORDERS_ACTIVE = `(SELECT * FROM orders_active WHERE ${realCaseSql('')})`;

module.exports = { realCaseSql, REAL_ORDERS_ACTIVE };
