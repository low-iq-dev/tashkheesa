const express = require('express');
const router = express.Router();
const { queryAll } = require('../pg');
const Anthropic = require('@anthropic-ai/sdk');
const rateLimit = require('express-rate-limit');
const { modelSonnet } = require('../config/anthropic');
const { recordAiUsage } = require('../services/ai_usage');
const { serviceBookableClause } = require('../services/service_bookable');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- P2 #9: In-memory catalog cache (5-minute TTL) ---
let _catalogCache = { text: '', ts: 0 };
const CATALOG_TTL_MS = 5 * 60 * 1000;

// Build a compact service catalog string for the system prompt
async function buildCatalog() {
  const now = Date.now();
  if (_catalogCache.text && (now - _catalogCache.ts) < CATALOG_TTL_MS) {
    return _catalogCache.text;
  }

  // 2026-08-25: gated on sv.is_visible alone, so the assistant recommended
  // services — by name, price and id — from specialties an operator had
  // hidden. This route is mounted UNAUTHENTICATED (server.js), so those were
  // being named to anonymous visitors, and the ids it returns are what the
  // client then submits. Nephrology was 8 of the 24 affected: hidden in
  // migration 087 because it has no doctor at all.
  //
  // NOTE the 5-minute in-memory cache above: after a deploy, or after an
  // operator flips a specialty's visibility, the old catalogue can still be
  // served for up to CATALOG_TTL_MS.
  const services = await queryAll(`
    SELECT sv.id, sv.name, sv.base_price, sv.currency, sv.sla_hours, sp.name AS specialty
    FROM services sv
    JOIN specialties sp ON sv.specialty_id = sp.id
    WHERE ${serviceBookableClause('sv')} AND sv.base_price > 0
    ORDER BY sp.name, sv.base_price ASC
  `, []);

  const grouped = {};
  for (const s of services) {
    if (!grouped[s.specialty]) grouped[s.specialty] = [];
    grouped[s.specialty].push(`  - ${s.name} (ID: ${s.id}) — ${s.currency || 'EGP'} ${s.base_price}, ${s.sla_hours}hr turnaround`);
  }

  const text = Object.entries(grouped)
    .map(([specialty, items]) => `${specialty}:\n${items.join('\n')}`)
    .join('\n\n');

  _catalogCache = { text, ts: now };
  return text;
}

const SYSTEM_EN = (catalog) => `You are a friendly medical triage assistant for Tashkheesa, an Egyptian telemedicine platform specialising in specialist second opinions. Your job is to help patients identify which medical review service they need.

RULES:
- Ask short, warm, focused questions (1 at a time maximum)
- Respond in the same language the patient writes in (Arabic or English)
- After 2-3 exchanges you MUST make a recommendation — do not keep asking forever
- When recommending, output EXACTLY this JSON block at the end of your message (nothing after it):
  {"recommendation": {"service_id": "<id>", "service_name": "<name>", "specialty": "<specialty>", "reason": "<one sentence in user's language>"}}
- If nothing fits, output: {"recommendation": null}
- Never mention prices — those show automatically on the card
- Do not invent services that are not in the catalog below
- Keep messages under 60 words
- Be warm and reassuring — patients may be anxious

AVAILABLE SERVICES:
${catalog}`;

const SYSTEM_AR = (catalog) => `أنت مساعد طبي ودود في منصة تشخيصة، متخصص في مساعدة المرضى للعثور على خدمة المراجعة الطبية المناسبة لهم.

القواعد:
- اطرح أسئلة قصيرة ومحددة (سؤال واحد فقط في كل مرة)
- أجب بنفس لغة المريض (عربي أو إنجليزي)
- بعد 2-3 رسائل يجب أن تقدم توصية — لا تستمر في الأسئلة
- عند التوصية، أضف هذا الكود JSON في نهاية رسالتك تماماً:
  {"recommendation": {"service_id": "<id>", "service_name": "<name>", "specialty": "<specialty>", "reason": "<سبب بجملة واحدة>"}}
- إذا لم يكن هناك خدمة مناسبة: {"recommendation": null}
- لا تذكر الأسعار
- لا تخترع خدمات غير موجودة في القائمة
- اجعل ردودك أقل من 60 كلمة
- كن مطمئناً وودوداً

الخدمات المتاحة:
${catalog}`;

// --- P1 #5: Rate limiter (20 req/min per IP) ---
const assistantLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  validate: false,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    return res.status(429).json({ ok: false, error: 'rate_limit_exceeded' });
  },
});

// POST /api/help-me-choose
router.post('/api/help-me-choose', assistantLimiter, async (req, res) => {
  try {
    const { messages, lang } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ ok: false, error: 'messages_required' });
    }

    // --- P1 #5: Cap messages array to 10 items max ---
    if (messages.length > 10) {
      return res.status(400).json({ ok: false, error: 'too_many_messages' });
    }

    // Validate message format + cap content to 500 chars (P1 #5)
    const validMessages = messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map(m => ({ role: m.role, content: String(m.content).slice(0, 500) }));

    if (validMessages.length === 0) {
      return res.status(400).json({ ok: false, error: 'invalid_messages' });
    }

    const catalog = await buildCatalog();
    const systemPrompt = lang === 'ar' ? SYSTEM_AR(catalog) : SYSTEM_EN(catalog);

    // --- P0 #2: Anthropic call with timeout ---
    // systemPrompt embeds the cached service catalog (~2–5KB of stable text)
    // and is identical across every turn of a chat session. Wrap with
    // ephemeral cache_control so re-uses within the 5-min cache window pay
    // ~10% of the prefix-token cost. Theme 9 Sub-issue D.
    const _model = modelSonnet();
    const response = await client.messages.create({
      model: _model,
      max_tokens: 400,
      system: [
        { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }
      ],
      messages: validMessages,
    }, {
      // 2026-08-30 — `timeout` belongs in the SDK's REQUEST OPTIONS (this second
      // argument), not in the message body. It sat in the body for months, so
      // every single call was rejected:
      //
      //   400 invalid_request_error "timeout: Extra inputs are not permitted"
      //
      // and the catch below matched that message's own first word, answering
      // 504 ai_timeout. A feature that had never once succeeded reported itself
      // as a slow day. Verified against the live API before and after.
      timeout: 30000,
    });

    // Credit accounting. Every turn of a chat is its own call, so a single
    // long conversation shows up as many rows — which is the point: the
    // assistant is the one feature whose cost scales with how chatty a visitor
    // is rather than with how many cases are booked.
    recordAiUsage({ purpose: 'assistant', model: _model, usage: response && response.usage });

    const text = response.content?.[0]?.text || '';

    // Parse out recommendation JSON if present
    let recommendation = undefined;
    const jsonMatch = text.match(/\{"recommendation":\s*[\s\S]*?\}(?:\s*)$/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        recommendation = parsed.recommendation;
      } catch (_) { /* ignore parse errors */ }
    }

    // Strip the JSON block from the display text
    const displayText = text.replace(/\{"recommendation":\s*[\s\S]*?\}(?:\s*)$/, '').trim();

    return res.json({ ok: true, message: displayText, recommendation });
  } catch (err) {
    // --- P0 #2: Graceful Anthropic API error handling ---
    const msg = err.message || '';
    const status = err.status || err.statusCode || 500;

    if (status === 429 || msg.includes('rate_limit') || msg.includes('Rate limit')) {
      console.error('[ai-assistant] Anthropic rate limit:', msg);
      return res.status(503).json({ ok: false, error: 'ai_busy' });
    }
    if (status === 529 || msg.includes('overloaded')) {
      console.error('[ai-assistant] Anthropic overloaded:', msg);
      return res.status(503).json({ ok: false, error: 'ai_busy' });
    }
    // A 4xx is the API telling us the REQUEST is wrong, and it is never a
    // timeout. Checked first and on the status, because the substring test
    // below is what turned a permanent 400 into a plausible-looking 504 for
    // months: the rejection message was "timeout: Extra inputs are not
    // permitted", and matching on its own first word hid the outage. Any
    // validation error naming a field can do this again — 429 and 529 are
    // already handled above, so anything else in the 4xx range is ours to fix
    // and must be loud in the logs rather than blamed on the network.
    if (status >= 400 && status < 500) {
      console.error('[ai-assistant] Anthropic rejected the request (' + status + '):', msg);
      return res.status(500).json({ ok: false, error: 'ai_config_error' });
    }
    // Only a genuine transport timeout past this point. Keyed on the SDK's own
    // error type and the socket error codes, not on message text.
    if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED'
        || err.name === 'APIConnectionTimeoutError') {
      console.error('[ai-assistant] Anthropic timeout:', msg);
      return res.status(504).json({ ok: false, error: 'ai_timeout' });
    }

    console.error('[ai-assistant] error:', msg);
    return res.status(500).json({ ok: false, error: 'ai_error' });
  }
});

module.exports = router;
