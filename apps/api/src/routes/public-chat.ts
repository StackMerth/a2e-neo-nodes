/**
 * Public chat assistant — Claude Haiku 4.5 backed.
 *
 * POST /v1/public/chat
 *   body: { message: string, history?: Array<{role:'user'|'assistant',content:string}> }
 *   returns: { reply: string, escalate?: boolean }
 *
 * Constrained to short replies (50-200 chars) via system prompt + a
 * 100-token `max_tokens` cap. Model is claude-haiku-4-5 — cheapest
 * Claude tier ($1 input / $5 output per MTok). Prompt caching on the
 * system block cuts the input cost on repeat requests further.
 *
 * Anti-abuse: rate limit 30 req/min/IP via the existing M1 rate-limit
 * plugin. Per-request body cap on `message` is 500 chars. `history`
 * length capped at 8 turns so a malicious client can't bloat the
 * context window.
 *
 * The chat widget reads NEXT_PUBLIC_SUPPORT_TELEGRAM and
 * NEXT_PUBLIC_SUPPORT_EMAIL to render the Contact Support fallback;
 * that's a client-side concern, this route only emits text.
 */

import type { FastifyInstance } from 'fastify'
import Anthropic from '@anthropic-ai/sdk'

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const MODEL = 'claude-haiku-4-5'
const MAX_HISTORY = 8
const MAX_INPUT_CHARS = 500
const MAX_OUTPUT_TOKENS = 100 // ~200 chars in English

// Site-facts system prompt. Editorial: this is what the bot knows
// about TokenOS DeAI. Add or trim here when the marketing copy changes.
// Kept under ~2KB so it caches efficiently on the Anthropic side.
const SYSTEM_PROMPT = `You are the support assistant for TokenOS DeAI, a public marketplace for GPU compute.

WHAT TOKENOS DEAI IS
- A marketplace where buyers rent GPU compute by the minute and operators earn for hosting GPUs.
- Three pricing tiers: ON_DEMAND (full price, never preempted), SPOT (40% off, preemptible with 90 seconds notice), RESERVED (10% off, commitment 7/30/90 days, never preempted).
- Per-minute billing with prorated refunds for unused minutes if a buyer stops early.
- Settlement on Solana, median 11 seconds.
- Operators are reputation-scored: 60% uptime, 25% buyer ratings, 15% completed-job volume. Tiers Bronze, Silver, Gold, Platinum.
- GPU tiers supported: H100, H200, B200, B300, GB300. Sample H100 rate: ~$5.84/hr on-demand.
- Auto-allocator picks an idle GPU and mints an ephemeral SSH credential. Pay-to-SSH median: under 60 seconds.
- Buyers sign up at the portal (user.tokenos.ai). Operators run the install script on their GPU machine.
- Public surfaces: marketplace catalog, leaderboard, stats page (live network numbers), operator profiles. All at market.tokenos.ai.
- Referral program: operators get a unique invite code worth 10% of their referee's network earnings for 365 days.

RULES
- Always reply in 50 to 200 characters. No exceptions.
- Be direct and factual. No marketing fluff, no exclamation marks, no emoji.
- If you do not know something, say so and suggest the visitor click Contact support.
- Do not invent prices, dates, features, or roadmap items. If a question depends on something not in the facts above, escalate.
- If the visitor asks to talk to a human, escalate.
- Never claim to be human. Never claim to be Claude. You are the TokenOS DeAI assistant.
- Reply in plain text. No markdown, no code blocks.`

interface ChatRequestBody {
  message?: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
}

// Lazy-initialized so a missing env var doesn't crash the API boot.
let _client: Anthropic | null = null
function getClient(): Anthropic | null {
  if (!ANTHROPIC_API_KEY) return null
  if (!_client) _client = new Anthropic({ apiKey: ANTHROPIC_API_KEY })
  return _client
}

export async function publicChatRoutes(fastify: FastifyInstance) {
  fastify.post('/v1/public/chat', {
    schema: {
      tags: ['Public'],
      summary: 'TokenOS DeAI assistant chat (Claude Haiku 4.5)',
      description: 'Short-form Q&A for marketplace visitors. Replies capped at ~200 chars. Returns escalate:true when the assistant cannot answer.',
    },
  }, async (request, reply) => {
    const client = getClient()
    if (!client) {
      return reply.code(503).send({
        error: 'Chat assistant not configured',
        message: 'Set ANTHROPIC_API_KEY on the API service to enable chat.',
      })
    }

    const body = (request.body ?? {}) as ChatRequestBody
    const message = (body.message ?? '').trim()
    if (!message) return reply.code(400).send({ error: 'message is required' })
    if (message.length > MAX_INPUT_CHARS) {
      return reply.code(400).send({ error: `message must be <= ${MAX_INPUT_CHARS} chars` })
    }

    // Sanitize history: cap length, drop non-strings, enforce role alphabet.
    const rawHistory = Array.isArray(body.history) ? body.history : []
    const history = rawHistory
      .slice(-MAX_HISTORY)
      .filter(h =>
        h
        && (h.role === 'user' || h.role === 'assistant')
        && typeof h.content === 'string'
        && h.content.length <= MAX_INPUT_CHARS,
      )

    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            // Cache the system prompt so we only pay full cost on the
            // first request in a 5-min window.
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          ...history.map(h => ({ role: h.role, content: h.content })),
          { role: 'user', content: message },
        ],
      })

      // Extract the first text block. Haiku rarely returns multiple in
      // a 100-token reply, but we coalesce just in case.
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('')
        .trim()

      if (!text) {
        // Model returned no text content. Tell the client to escalate.
        return reply.send({
          reply: 'I cannot answer that right now. Try Contact support below.',
          escalate: true,
        })
      }

      // Detect explicit escalation language in the reply.
      const lc = text.toLowerCase()
      const escalate = lc.includes('contact support') || lc.includes('i do not know') || lc.includes("i don't know")

      return reply.send({ reply: text, escalate })
    } catch (err) {
      fastify.log.warn({ err }, 'Chat assistant call failed')
      return reply.code(502).send({
        error: 'Chat assistant unavailable',
        message: 'Please try again or click Contact support.',
      })
    }
  })
}
