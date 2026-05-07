# Runbook — `OPS_AGENT_KEY` Stage 2 Cutover

**Owner:** Ziad
**Status (as of this commit):** Stage 1 deployed — server accepts both signed and unsigned agent pings; the difference is logged. Stage 2 (required mode, unsigned rejected with 401) is a manual follow-up performed via this runbook **only after Stage 1 has been verified in production for at least 1 hour with all real agents producing `signed OK` lines**.

## Background

Theme 3 sub-issue D closed the unauth'd write surface on `POST /ops/agent/ping` and `POST /ops/agent/log-tokens` by introducing a shared-secret header `x-ops-agent-key`. Because the ops agent runs out-of-band on a Mac mini and we cannot pause the heartbeat stream, the cutover is two-staged:

| Stage | Server behavior | Agent behavior expected | Risk if mismatched |
|---|---|---|---|
| 1 (this commit) | Accept both signed and unsigned. Log `signed OK` vs `unsigned`. | Agents may be unsigned during rollout. | None — graceful. |
| 2 (manual) | Reject unsigned with 401. | All agents MUST send the header. | Heartbeats from unconfigured agents stop. /ops dashboard "agents" section goes stale within minutes. |

The server-side code that needs to flip in Stage 2 is the `requireAgentKeyOptional` helper in `src/routes/ops.js`. Look for the comment `Stage 2 (manual cutover, NOT in this commit)`.

---

## Mac mini agent context (canonical)

| Field | Value |
|---|---|
| Tailscale IP | `100.106.122.55` |
| SSH user | `macmini` |
| Codebase path | `/Users/macmini/Desktop/tashkheesa-portal` |
| Runner | `openclaw-watchdog` LaunchAgent |

To shell in:

```bash
ssh macmini@100.106.122.55
```

---

## Stage 1 — Configure the agent (do this NOW, after Stage 1 ships)

### Step 1.1 — Generate the shared secret

On any trusted box (your laptop):

```bash
openssl rand -base64 48
```

This produces a 64-ish-character base64 string. Treat it as a top-tier secret — do not paste into Slack, email, screenshots, or screen-shared windows. Copy directly to the password manager and to the two destinations below.

### Step 1.2 — Set `OPS_AGENT_KEY` on Render (server side)

Render dashboard → tashkheesa service → Environment → Add environment variable:

- **Name:** `OPS_AGENT_KEY`
- **Value:** `<the secret from Step 1.1>`
- **Service redeploy:** yes (Render does this automatically when you save).

After redeploy, the server will read the key. With no agent yet sending it, every ping will be logged `unsigned` — that's the expected pre-cutover state.

### Step 1.3 — Set `OPS_AGENT_KEY` on the Mac mini (agent side)

SSH to the Mac mini:

```bash
ssh macmini@100.106.122.55
cd /Users/macmini/Desktop/tashkheesa-portal
```

Edit the agent runner's `.env` (or whichever env file the `openclaw-watchdog` LaunchAgent loads — usually `/Users/macmini/Desktop/tashkheesa-portal/.env`):

```bash
echo "OPS_AGENT_KEY=<the same secret from Step 1.1>" >> .env
```

Confirm the variable is in the file but NOT committed:

```bash
grep OPS_AGENT_KEY .env
git status   # should show .env as ignored or modified — never staged
```

### Step 1.4 — Update the agent's HTTP client to send the header

The agent's heartbeat code lives in the same repo on the Mac mini (this repo). Whatever fetch/axios/curl call POSTs to `/ops/agent/ping` and `/ops/agent/log-tokens` must include the header:

```
x-ops-agent-key: <value of OPS_AGENT_KEY>
```

Reload the LaunchAgent so the new env is picked up:

```bash
launchctl unload ~/Library/LaunchAgents/com.tashkheesa.openclaw-watchdog.plist
launchctl load   ~/Library/LaunchAgents/com.tashkheesa.openclaw-watchdog.plist
# Optional: tail the LaunchAgent log to confirm it restarted clean.
tail -f /Users/macmini/Library/Logs/openclaw-watchdog.log
```

If the LaunchAgent loads from a different env source (e.g. `EnvironmentVariables` in the plist itself), edit the plist instead:

```xml
<key>EnvironmentVariables</key>
<dict>
  <key>OPS_AGENT_KEY</key>
  <string>...the same secret...</string>
</dict>
```

Then `launchctl unload` + `load` as above.

### Step 1.5 — Verify in production logs (the 1-hour gate)

On Render, tail the runtime log filtered for the agent prefix. Expected lines on a healthy Stage 1:

```
… agent ping signed OK agent=ops-agent
… agent log-tokens signed OK agent=ops-agent
```

If you see `unsigned` for the same agent name *after* Step 1.4 was completed, the header isn't reaching the server. Check, in order:

1. The agent process actually picked up the new env (reload the LaunchAgent again).
2. The HTTP client is setting the header — `curl -v` against `https://tashkheesa.com/ops/agent/ping` with the header and confirm Render logs `signed OK`.
3. There is no proxy or load balancer stripping `x-ops-agent-key` — Render's edge does not strip custom headers, but verify with a manual curl that includes the header.

Do **not** proceed to Stage 2 until you have seen `signed OK` for every agent name (`ops-agent`, `growth-agent`, `care-agent`, `finance-agent`, plus any ad-hoc agents you run) for **at least 1 hour**, with no `unsigned` lines in that window.

---

## Stage 2 — Flip to required (manual edit + redeploy)

### Step 2.1 — Edit `src/routes/ops.js`

Replace the body of `requireAgentKeyOptional` (it doesn't matter that the function name still says "optional" — feel free to rename to `requireAgentKey` while you're in there) so that the unsigned and wrong-key branches return 401 instead of falling through.

**Before (Stage 1, current state):**

```js
function requireAgentKeyOptional(routeLabel) {
  return function (req, res, next) {
    var expected = process.env.OPS_AGENT_KEY;
    var provided = String(req.get('x-ops-agent-key') || '');
    var verdict;
    if (!expected) {
      verdict = 'unsigned';
    } else if (!provided) {
      verdict = 'unsigned';
    } else {
      try {
        var a = Buffer.from(expected);
        var b = Buffer.from(provided);
        verdict = (a.length === b.length && crypto.timingSafeEqual(a, b))
          ? 'signed OK'
          : 'unsigned';
      } catch (_) {
        verdict = 'unsigned';
      }
    }
    var agentName = (req.body && req.body.agent_name)
      ? String(req.body.agent_name).slice(0, 80)
      : '<unknown>';
    logMajor('agent ' + routeLabel + ' ' + verdict + ' agent=' + agentName);
    return next();
  };
}
```

**After (Stage 2, required):**

```js
function requireAgentKey(routeLabel) {
  return function (req, res, next) {
    var expected = process.env.OPS_AGENT_KEY;
    if (!expected) {
      // Fail-closed: with no key configured the route is unreachable.
      logMajor('agent ' + routeLabel + ' rejected: OPS_AGENT_KEY not configured');
      return res.status(503).json({ ok: false, error: 'agent_key_not_configured' });
    }
    var provided = String(req.get('x-ops-agent-key') || '');
    if (!provided) {
      logMajor('agent ' + routeLabel + ' rejected: header missing');
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    try {
      var a = Buffer.from(expected);
      var b = Buffer.from(provided);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        logMajor('agent ' + routeLabel + ' rejected: bad key');
        return res.status(401).json({ ok: false, error: 'unauthorized' });
      }
    } catch (_) {
      logMajor('agent ' + routeLabel + ' rejected: compare failed');
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    var agentName = (req.body && req.body.agent_name)
      ? String(req.body.agent_name).slice(0, 80)
      : '<unknown>';
    logMajor('agent ' + routeLabel + ' signed OK agent=' + agentName);
    return next();
  };
}
```

If you renamed the helper, also rename its two call sites:

```js
router.post('/agent/ping',       requireAgentKey('ping'),       async function (req, res) { … });
router.post('/agent/log-tokens', requireAgentKey('log-tokens'), async function (req, res) { … });
```

### Step 2.2 — Commit + push

```bash
git checkout -b chore/ops-agent-key-stage-2
# Edit src/routes/ops.js per Step 2.1
git add src/routes/ops.js
git commit -m "chore(security): OPS_AGENT_KEY Stage 2 — unsigned agent pings now 401"
git push origin chore/ops-agent-key-stage-2
# Open PR on GitHub, merge to main when CI is green.
```

Render auto-deploys on `main`. Watch the deploy go live.

### Step 2.3 — Verify Stage 2

Within 1 minute of the new deploy serving traffic:

1. Real agents should keep producing `signed OK` lines (because they were already sending the header in Stage 1).
2. Send a deliberate unsigned probe to confirm the new behavior:

```bash
curl -i -X POST "https://tashkheesa.com/ops/agent/ping" \
  -H 'Content-Type: application/json' \
  -d '{"agent_name":"manual-probe","status":"test"}'
# Expect: HTTP/1.1 401 Unauthorized
```

3. With the correct header:

```bash
curl -i -X POST "https://tashkheesa.com/ops/agent/ping" \
  -H 'Content-Type: application/json' \
  -H "x-ops-agent-key: $OPS_AGENT_KEY" \
  -d '{"agent_name":"manual-probe","status":"test"}'
# Expect: HTTP/1.1 200 OK + {"ok":true}
```

4. The /ops dashboard `agents` table should keep updating — no `last_seen` should regress past Stage 2's deploy time.

---

## Rollback (if Stage 2 breaks heartbeats)

If, after Stage 2 ships, real agents start hitting 401 (e.g. one agent process didn't pick up the env, or a forgotten agent isn't yet configured):

### Fast rollback (preferred)

```bash
git revert <stage-2-commit-sha>
git push origin main
```

The revert reinstates `requireAgentKeyOptional`. Render redeploys; `unsigned` pings start passing again. Triage the missing agent without time pressure.

### Slow rollback (if revert is awkward)

Manually re-edit `src/routes/ops.js` to restore the Stage 1 helper and push. Same effect, more error-prone — prefer `git revert`.

### What NOT to do

Do NOT delete `OPS_AGENT_KEY` from Render env in an attempt to "open up" the gate. With the Stage 2 helper, an unset env makes the route return 503 (`agent_key_not_configured`), which still kills heartbeats. The only safe fast path back to Stage 1 is reverting the source change.

---

## Stage 3 — Bonus hardening (optional, future)

After Stage 2 has been stable for ≥ 30 days, consider:

- Rotating the `OPS_AGENT_KEY` (generate new, set on Render + Mac mini, watch logs for 1h, never the other order).
- Replacing the static shared secret with HMAC-signed payloads (timestamp + body, agent computes HMAC; server recomputes and `timingSafeEqual`s).  Same shape as the Paymob webhook handler — see `src/services/paymob-hmac.js`.
- Per-agent keys (so rotating ops-agent doesn't require rotating growth-agent). Out of scope for this runbook.

---

## Where the Stage 1 code lives (cheat sheet)

| File | Lines | Purpose |
|---|---|---|
| `src/routes/ops.js` | `requireAgentKeyOptional` (~140-180) | The Stage 1 middleware. |
| `src/routes/ops.js` | `router.post('/agent/ping', requireAgentKeyOptional('ping'), …)` | One of the two gated routes. |
| `src/routes/ops.js` | `router.post('/agent/log-tokens', requireAgentKeyOptional('log-tokens'), …)` | The other one. |
| `src/middleware/csrf.js` | `if (p === '/ops/agent/ping' || p === '/ops/agent/log-tokens') { return next(); }` | The narrow CSRF exemption — only these two stay exempt; `/ops/agent/toggle` and `/ops/agent/cleanup` now go through CSRF. |
| `src/views/ops-dashboard.ejs` | toggle form `<%- csrfField() %>` | The CSRF input the dashboard sends with the toggle action. |
| `.env.example` (TODO Stage 2 PR) | `OPS_AGENT_KEY=...` | Document the var so future deployers know to set it. |

For full Theme 3 context: `docs/audits/THEME_03_CSRF_FIX_PLAN.md` (commit `dce8374`).
