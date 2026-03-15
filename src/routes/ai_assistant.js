const express = require('express');
const router = express.Router();
const { queryAll } = require('../pg');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Build a compact service catalog string for the system prompt
async function buildCatalog() {
  const services = await queryAll(`
    SELECT sv.id, sv.name, sv.base_price, sv.currency, sv.sla_hours, sp.name AS specialty
    FROM services sv
    JOIN specialties sp ON sv.specialty_id = sp.id
    WHERE sv.is_visible = true AND sv.base_price > 0
    ORDER BY sp.name, sv.base_price ASC
  `, []);

  const grouped = {};
  for (const s of services) {
    if (!grouped[s.specialty]) grouped[s.specialty] = [];
    grouped[s.specialty].push(`  - ${s.name} (ID: ${s.id}) — ${s.currency || 'EGP'} ${s.base_price}, ${s.sla_hours}hr turnaround`);
  }

  return Object.entries(grouped)
    .map(([specialty, items]) => `${specialty}:\n${items.join('\n')}`)
    .join('\n\n');
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

// POST /api/help-me-choose
router.post('/api/help-me-choose', async (req, res) => {
  try {
    const { messages, lang } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ ok: false, error: 'messages_required' });
    }

    // Validate message format
    const validMessages = messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map(m => ({ role: m.role, content: String(m.content).slice(0, 2000) }));

    if (validMessages.length === 0) {
      return res.status(400).json({ ok: false, error: 'invalid_messages' });
    }

    const catalog = await buildCatalog();
    const systemPrompt = lang === 'ar' ? SYSTEM_AR(catalog) : SYSTEM_EN(catalog);

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      system: systemPrompt,
      messages: validMessages,
    });

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
    console.error('[ai-assistant] error:', err.message);
    return res.status(500).json({ ok: false, error: 'ai_error' });
  }
});

module.exports = router;
