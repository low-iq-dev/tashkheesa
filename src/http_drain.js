'use strict';

// src/http_drain.js
//
// 2026-10-11 — draining an HTTP server on SIGTERM.
//
// `server.close()` stops new connections and waits for the existing ones to
// end. The connections that matter here are Render's proxy keep-alives: they
// are idle most of the time, and on an older Node they are never closed by
// close() at all, so its callback never fired and every shutdown ran into the
// force-exit timer — with the database pool and the job queue cut off rather
// than closed. On a current Node close() drops the sockets that are idle at
// that instant, but one that was mid-request then goes idle and lingers for
// the keep-alive timeout.
//
// This sweeps idle sockets until the server reports closed: an in-flight
// request is never touched (closeIdleConnections only takes sockets with no
// request on them), and the moment its response is written the socket is
// idle and goes on the next sweep. Pair it with a `Connection: close` header
// on responses sent while draining (src/server.js) so well-behaved clients
// hang up by themselves.
//
// Resolves true once the server has closed. It never rejects and never times
// out by itself — the caller owns the hard deadline.

function drainHttpServer(server, opts) {
  var sweepMs = (opts && opts.sweepMs) || 500;
  return new Promise(function (resolve) {
    var done = false;
    var timer = null;
    function finish(clean) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(clean);
    }
    try {
      server.close(function () { finish(true); });
    } catch (e) {
      // Not listening (boot never finished): nothing to drain.
      return finish(false);
    }
    (function sweep() {
      if (done) return;
      try {
        if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      } catch (_) { /* best effort */ }
      timer = setTimeout(sweep, sweepMs);
      if (timer.unref) timer.unref();
    })();
  });
}

module.exports = { drainHttpServer };
