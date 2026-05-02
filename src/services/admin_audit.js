/**
 * Admin audit log — best-effort writer for superadmin financial-view
 * surfaces (payout dashboards, pricing, analytics, exports).
 *
 * Mirrors the pattern from src/services/national-id.js but with a
 * crucial difference: this is best-effort for VIEW operations.
 * The national-ID decryption helper is fail-closed (no log → no
 * plaintext) because the data is regulated PHI. Aggregate financial
 * dashboards are sensitive but not regulated to that bar — if the
 * audit-log infrastructure has a transient failure, the admin
 * dashboard should not also go down. State-changing routes that
 * mutate financial values should NOT use this helper; they should
 * fail-closed via the existing transactional write paths.
 *
 * Schema: error_logs (level='audit', category='admin_audit'). See
 * migration 035_error_logs_category.sql.
 */

'use strict';

const { randomUUID } = require('crypto');
const { execute } = require('../pg');

/**
 * Record a superadmin payout/financial-data view.
 *
 * @param {Object} args
 * @param {Object} args.req     The Express request (used for user_id, request_id, url, method)
 * @param {string} args.action  Snake-case action verb, e.g. 'viewed_payout_data'
 * @param {string} args.target  The route or surface name being audited, e.g. '/admin' or 'admin_dashboard_financials_tile'
 * @returns {Promise<void>}     Never throws — failures are swallowed and console-warned.
 */
async function logAdminAudit({ req, action, target }) {
  try {
    const userId = (req && req.user && req.user.id) || null;
    const requestId = (req && req.requestId) || null;
    const url = (req && req.originalUrl) || null;
    const method = (req && req.method) || null;

    const message = 'viewed payout data: ' + (target || url || 'unknown');

    await execute(
      `INSERT INTO error_logs
         (id, level, category, message, user_id, request_id, url, method, context)
       VALUES ($1, 'audit', 'admin_audit', $2, $3, $4, $5, $6, $7)`,
      [
        randomUUID(),
        message,
        userId,
        requestId,
        url,
        method,
        JSON.stringify({ action: action || 'view', target: target || null })
      ]
    );
  } catch (err) {
    // Best-effort: never let a failed audit-log insert block a view request.
    console.warn('[admin_audit] failed to record audit log:', err && err.message ? err.message : err);
  }
}

module.exports = { logAdminAudit };
