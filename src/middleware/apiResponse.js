/**
 * API Response Middleware
 *
 * Adds res.ok() and res.fail() helpers to every API route.
 * Ensures all responses follow the standard format:
 *
 * Success: { success: true, data: ..., meta?: ... }
 * Error:   { success: false, error: "message", code?: "CODE" }
 */

function apiResponse(req, res, next) {
  /**
   * Send a success response.
   * @param {*} data - Response payload
   * @param {Object} [meta] - Pagination metadata { page, per_page, total }
   */
  res.ok = function (data, meta) {
    const body = { success: true, data };
    if (meta) body.meta = meta;
    return res.json(body);
  };

  /**
   * Send an error response.
   * @param {string} message - Error message
   * @param {number} [status=400] - HTTP status code
   * @param {string} [code] - Machine-readable error code
   */
  res.fail = function (message, status = 400, code) {
    const body = { success: false, error: message };
    if (code) body.code = code;
    return res.status(status).json(body);
  };

  next();
}

module.exports = apiResponse;
