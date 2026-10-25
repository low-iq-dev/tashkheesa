'use strict';

// src/middleware/client_ip.js
//
// 2026-10-11 — the address a per-IP rate limiter should key on.
//
// req.ip is NOT the visitor on this service. `app.set('trust proxy', 1)`
// (src/server.js) trusts one hop, and there are at least two between the
// visitor and this process: Render's edge (which is Cloudflare — every response
// carries `server: cloudflare` and a `cf-ray`, while tashkheesa.com's A record
// is Render's own 216.24.57.0/24) and Render's internal router. With one hop
// trusted, req.ip is the LAST X-Forwarded-For entry: an edge address that
// changes from request to request.
//
// Measured on production, 11 Oct 2026: fourteen anonymous requests from one
// machine inside ten seconds — eight of them on a single keep-alive
// connection — landed in at least five different 15-minute buckets
// (`ratelimit-remaining` read 299, 298, 299, 299, 299, 299, 298, 298 …; a key
// that was the caller can only count down). So every "per IP" limiter was
// really "per edge address": strangers shared a bucket, and one abuser was
// spread thinly over many.
//
// The edge sets CF-Connecting-IP to the address that connected to it
// (Cloudflare: "provides the client IP address connecting to Cloudflare to the
// origin web server"). `trust proxy` is deliberately left alone: req.secure,
// req.protocol, the secure-cookie flag and the canonical-host redirect all
// hang off it, and the hop count cannot be verified without a deploy. If the
// header is ever absent (local run, tests, a Render-internal health check)
// this falls back to req.ip — exactly today's behaviour, never worse.
//
// It cannot be forged from outside. Measured on production, 11 Oct 2026: a
// request that arrives carrying its own `CF-Connecting-IP` header never
// reaches this process — the edge answers it 403.
//
// VERIFY AFTER DEPLOY (scripts/verify-rate-limit-keying.sh): from one
// machine the anonymous `ratelimit-remaining` must only count down, and a
// request with a made-up `CF-Connecting-IP` must still be refused by the edge
// (or, if the edge ever lets it through, must not start a fresh bucket).

const net = require('net');
const { ipKeyGenerator } = require('express-rate-limit');

function headerIp(req, name) {
  const raw = req && req.headers && req.headers[name];
  if (!raw || Array.isArray(raw)) return '';
  const v = String(raw).trim();
  return net.isIP(v) ? v : '';
}

/** The visitor's address as best this process can know it. Never empty. */
function clientIp(req) {
  return (
    headerIp(req, 'cf-connecting-ip') ||
    String((req && req.ip) || (req && req.socket && req.socket.remoteAddress) || 'unknown')
  );
}

/**
 * Rate-limit key for that address. IPv6 is collapsed to its /56 (the
 * express-rate-limit default) — one subscriber owns a whole prefix, so keying
 * on the full address would hand them a fresh bucket per request.
 */
function clientIpKey(req) {
  const ip = clientIp(req);
  return net.isIP(ip) ? ipKeyGenerator(ip) : ip;
}

module.exports = { clientIp, clientIpKey };
