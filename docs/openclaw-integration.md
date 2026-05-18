# OpenClaw WhatsApp Integration — Cross-System Contract

Portal-side code for this lives in:
- `src/lib/openclaw_client.js` — outbound HTTP client (portal → OpenClaw)
- `src/notify/openclawTemplates.js` — bilingual body composers
- `src/notify/whatsapp.js` — transport-branch dispatch
- `src/routes/openclaw-api.js` — inbound endpoints (OpenClaw → portal)
- `src/migrations/062_notify_whatsapp_default_true.sql` — opt-in default + bulk

This document captures the **OpenClaw-side requirements** that must be
implemented on the Mac mini gateway for the integration to work
end-to-end. They are out of repo scope but ship as part of the rollout's
acceptance criteria.

## 1. Outbound send endpoint (called by portal)

OpenClaw must expose:

```
POST  http://100.106.122.55:<PORT>/send
Header: x-openclaw-key: <OPENCLAW_SEND_KEY>
Body:   { "to": "+201xxxxxxxxx", "lang": "en"|"ar", "body": "<text>", "ref": "<order_id_or_null>" }
```

- Auth: reject requests whose `x-openclaw-key` header doesn't equal the
  shared secret. Reuse Tailscale ACLs to limit the network surface; the
  shared secret is defense-in-depth.
- `body` is free-form UTF-8 (single message, no Meta template lookup).
- `ref` is opaque — write it to OpenClaw's local log for tracing back to
  a portal `notifications.id` if needed.
- Response:
  - `200 { "sent": true, "message_id": "<opaque>" }` on success.
  - `4xx/5xx { "error": "<short_code>" }` on failure.
- Timeout budget: portal waits 10s before aborting (see
  `src/lib/openclaw_client.js`). OpenClaw should respond within that
  window or accept the dispatch async and respond immediately.

## 2. Inbound STOP / START handler

OpenClaw routes inbound WhatsApp messages to the Care agent. Before the
agent receives the message, a STOP/START preprocessor must run. When a
match fires, OpenClaw POSTs to the portal:

```
POST  https://tashkheesa.onrender.com/api/openclaw/opt-out
POST  https://tashkheesa.onrender.com/api/openclaw/opt-in
Header: x-openclaw-key: <OPENCLAW_SEND_KEY>
Body:   { "phone": "+201xxxxxxxxx" }
Response: 200 { "ok": true, "updated": <int> }
          404 { "ok": false, "error": "user_not_found", "updated": 0 }
          400 { "ok": false, "error": "invalid_phone" }
          401 { "ok": false, "error": "Unauthorized" }
```

After the portal returns 2xx, OpenClaw sends a confirmation reply to the
inbound sender (the portal does NOT send it — OpenClaw owns the SIM):

| Action | EN | AR |
|---|---|---|
| STOP confirm | "You've been unsubscribed from Tashkheesa updates. Reply START to re-enable." | "تم إلغاء اشتراكك في تنبيهات تشخيصة. أرسل START للاشتراك تاني." |
| START confirm | "You're subscribed to Tashkheesa updates again." | "تم تفعيل اشتراكك في تنبيهات تشخيصة تاني." |

Language for the confirmation: prefer the language of the inbound trigger
message (Latin chars → EN, Arabic chars → AR). Fallback to the language
of the most recent portal-sent message to that number.

### 2.1 Match rules (concrete regex)

Apply to the inbound message text after `String.trim()`. **Skip the
preprocessor entirely if the trimmed length is ≥ 30 characters** — this
prevents a user typing a sentence like "I don't want to stop using this"
from triggering a false opt-out.

Case-insensitive for Latin characters. Arabic characters are case-less.

**STOP triggers** — any match opts out:

```regex
\b(stop|stop\s+please|stop\s+now|unsubscribe|opt[-\s]?out|cancel)\b
```
plus the Arabic alternation (no word boundary — Arabic word boundaries
are unreliable across diacritics and ZWJ):
```regex
(إيقاف|ايقاف|الغاء|إلغاء|إلغاء\s+الاشتراك|الغاء\s+الاشتراك|توقف|اوقف)
```
plus the romanized-Arabic alternation:
```regex
\b(alaghy|alghaa|eqaaf|iqaf|wa2af|wa2af|alghaa\s*el\s*eshtirak)\b
```
plus the exact bare-token rule (the trimmed message text is **exactly**
one of these, no other chars):
- `لا`  (the single Arabic word "no")
- `no` (lowercase, by itself only)

**START triggers** — any match opts in:

```regex
\b(start|start\s+please|subscribe|opt[-\s]?in|resume|begin)\b
```
plus Arabic:
```regex
(اشتراك|تفعيل|بدء|ابدأ|اشترك|تفعيل\s+الاشتراك|ابدا)
```
plus romanized:
```regex
\b(eshtirak|tafeel|start|na3am|ibda2)\b
```
plus exact bare-token:
- `نعم` (Arabic "yes")
- `yes` (lowercase, by itself only)

### 2.2 Test cases (acceptance)

| Inbound text | Expected | Notes |
|---|---|---|
| `STOP` | opt-out | bare token |
| `stop please` | opt-out | phrase |
| `Stop` | opt-out | case-insensitive |
| `unsubscribe` | opt-out | word match |
| `إيقاف` | opt-out | Arabic |
| `الغاء الاشتراك` | opt-out | Arabic phrase |
| `لا` | opt-out | bare token only |
| `no thanks just curious` | NO match | "no" not bare |
| `I don't want to stop using this` | NO match | length ≥ 30 chars, preprocessor skipped |
| `START` | opt-in | bare token |
| `please start sending again` | opt-in | word "start" matches |
| `نعم` | opt-in | bare token only |
| `please don't stop yet` | NO match (length ≥ 30) | sentence, not command |
| `cancel this please` | opt-out | word "cancel" matches |
| (empty message) | NO match | skip preprocessor |

### 2.3 Failure handling

If the portal returns:
- `404 user_not_found` — OpenClaw should still send the confirmation
  reply (the user clearly expects acknowledgement). Log locally as
  "ghost opt-out — phone not in users table."
- `400 invalid_phone` — log + alert; this indicates OpenClaw passed a
  malformed number (should never happen for inbound numbers WhatsApp
  provides).
- `401 Unauthorized` — the shared secret is mismatched. Halt the
  handler and alert ops; do NOT retry-storm.
- 5xx / network error — retry with exponential backoff up to 3 attempts,
  then drop. Reply-STOP/START is best-effort.

## 3. Portal-side feature flags (recap)

For reference, here's what the portal needs configured to consume this
integration:

| Var | Required when | Notes |
|---|---|---|
| `NOTIFICATIONS_WHATSAPP_ENABLED=true` | flipping on the WhatsApp rail | Master switch |
| `NOTIFICATIONS_WHATSAPP_TRANSPORT=openclaw` | using OpenClaw | Default `meta` |
| `OPENCLAW_BASE_URL=http://100.106.122.55:<port>` | transport=openclaw | Tailscale-only |
| `OPENCLAW_SEND_KEY=<secret>` | transport=openclaw OR inbound endpoints in use | Distinct from TASH_API_KEY |
| `WHATSAPP_TEST_STUB=true` | local/dev tests | Stubs both Meta + OpenClaw paths |

The legacy `WHATSAPP_ENABLED` gates the Meta path only and is now
orthogonal to the new master flag.

## 4. Rollout order

1. Deploy portal with all flags off (no behavior change).
2. Apply migration 062 on Render boot (flips DB default + bulk opt-in).
3. Stand up OpenClaw `/send` endpoint + STOP/START handler on Mac mini.
4. Set `OPENCLAW_BASE_URL`, `OPENCLAW_SEND_KEY` on Render.
5. Set `NOTIFICATIONS_WHATSAPP_TRANSPORT=openclaw`.
6. Flip `NOTIFICATIONS_WHATSAPP_ENABLED=true`. Monitor `error_logs`
   (`category='whatsapp_send'`) for 10 minutes.
7. If clean, leave on. If noisy, flip `NOTIFICATIONS_WHATSAPP_ENABLED`
   back to false — no code change needed to roll back.

The OTP path is independent: it has its own call site outside
`src/notify/whatsapp.js` and continues to use the Meta rail regardless
of these flags.
