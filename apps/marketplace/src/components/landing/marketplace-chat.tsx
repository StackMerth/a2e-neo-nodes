'use client'

/*
 * Marketplace chat widget. Always-on, backed by Claude Haiku 4.5 via
 * the API's /v1/public/chat route. Editorial styling: cream surface,
 * ink type, Instrument Serif headings, mono labels. No glow effects.
 *
 * UX rules:
 *   - Replies are short (50-200 chars) — enforced server-side.
 *   - Every reply ends with a "Contact support" affordance the visitor
 *     can click; if the assistant flags `escalate`, the affordance
 *     surfaces more prominently.
 *   - Contact support opens a small modal with Telegram and Email
 *     options. URLs come from env so they swap without redeploying
 *     code.
 *   - History stays in component state; reload = fresh session. We
 *     deliberately do not persist transcripts (no PII at rest).
 */

import { useEffect, useRef, useState } from 'react'
import { MessageCircle, X, Send, LifeBuoy, ExternalLink } from 'lucide-react'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://tokenosdeai-api.onrender.com'
const SUPPORT_TELEGRAM = process.env.NEXT_PUBLIC_SUPPORT_TELEGRAM || 'https://t.me/tokenosdeai'
const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'support@tokenosdeai.com'

interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  escalate?: boolean
}

const GREETING: ChatMsg = {
  role: 'assistant',
  content: 'Hi. Ask anything about TokenOS DeAI: pricing, signup, referrals, anything. Replies stay short.',
}

export function MarketplaceChat() {
  const [open, setOpen] = useState(false)
  const [showSupport, setShowSupport] = useState(false)
  const [messages, setMessages] = useState<ChatMsg[]>([GREETING])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Auto-scroll to the bottom on new message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, open])

  async function send() {
    const text = input.trim()
    if (!text || sending) return
    setInput('')
    const userMsg: ChatMsg = { role: 'user', content: text }
    const nextHistory = [...messages, userMsg]
    setMessages(nextHistory)
    setSending(true)
    try {
      const history = nextHistory
        .slice(-9, -1) // last 8 turns before this one
        .filter(m => m.role !== 'assistant' || m.content !== GREETING.content)
        .map(m => ({ role: m.role, content: m.content }))

      const res = await fetch(`${API_URL}/v1/public/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { reply: string; escalate?: boolean }
      setMessages(prev => [...prev, { role: 'assistant', content: data.reply, escalate: data.escalate }])
    } catch {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'I cannot reach the assistant right now. Try Contact support below.',
        escalate: true,
      }])
    } finally {
      setSending(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <>
      {/* Bubble */}
      {!open && (
        <button
          aria-label="Open chat"
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-40 flex items-center gap-2 px-4 h-12 rounded-full bg-foreground text-background shadow-lg hover:opacity-90 transition-opacity"
        >
          <MessageCircle className="w-4 h-4" />
          <span className="font-mono text-xs uppercase tracking-[0.18em]">Ask</span>
        </button>
      )}

      {/* Panel */}
      {open && (
        <div
          role="dialog"
          aria-label="TokenOS DeAI assistant"
          className="fixed bottom-6 right-6 z-40 w-[min(380px,calc(100vw-2rem))] h-[min(560px,calc(100vh-3rem))] flex flex-col bg-background border border-foreground/15 shadow-2xl rounded-md overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 h-12 border-b border-foreground/10">
            <div className="flex flex-col leading-tight">
              <span className="font-display text-base text-foreground">TokenOS DeAI</span>
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Assistant</span>
            </div>
            <button
              aria-label="Close chat"
              onClick={() => setOpen(false)}
              className="p-1 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages.map((m, i) => (
              <div
                key={i}
                className={
                  m.role === 'user'
                    ? 'flex justify-end'
                    : 'flex justify-start'
                }
              >
                <div
                  className={
                    m.role === 'user'
                      ? 'max-w-[80%] bg-foreground text-background text-sm px-3 py-2 rounded-md'
                      : 'max-w-[85%] bg-foreground/5 text-foreground text-sm px-3 py-2 rounded-md border border-foreground/10'
                  }
                >
                  {m.content}
                </div>
              </div>
            ))}
            {sending && (
              <div className="flex justify-start">
                <div className="bg-foreground/5 px-3 py-2 rounded-md border border-foreground/10">
                  <span className="font-mono text-xs text-muted-foreground">…</span>
                </div>
              </div>
            )}
          </div>

          {/* Contact support strip */}
          <button
            onClick={() => setShowSupport(true)}
            className="flex items-center justify-between gap-2 px-4 py-2 border-t border-foreground/10 hover:bg-foreground/[0.02] transition-colors text-left"
          >
            <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              <LifeBuoy className="w-3 h-3" />
              Contact support
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">→</span>
          </button>

          {/* Input */}
          <div className="flex items-end gap-2 px-3 py-3 border-t border-foreground/10 bg-background">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value.slice(0, 500))}
              onKeyDown={onKeyDown}
              placeholder="Ask anything…"
              rows={1}
              className="flex-1 resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none border border-foreground/15 rounded-md px-3 py-2 focus:border-foreground transition-colors"
            />
            <button
              onClick={send}
              disabled={sending || !input.trim()}
              aria-label="Send"
              className="h-9 w-9 inline-flex items-center justify-center bg-foreground text-background rounded-md disabled:opacity-40 hover:opacity-90 transition-opacity"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Support modal */}
      {showSupport && (
        <div
          role="dialog"
          aria-label="Contact a human"
          className="fixed inset-0 z-50 flex items-center justify-center px-6 bg-foreground/40"
          onClick={() => setShowSupport(false)}
        >
          <div
            className="w-[min(440px,100%)] bg-background border border-foreground/15 shadow-2xl rounded-md overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 h-12 border-b border-foreground/10">
              <span className="font-display text-lg text-foreground">Talk to a human</span>
              <button
                onClick={() => setShowSupport(false)}
                aria-label="Close"
                className="p-1 text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-sm text-muted-foreground">
                Pick a channel. Telegram is fastest during business hours; email gets a same-day reply.
              </p>
              <a
                href={SUPPORT_TELEGRAM}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between gap-3 px-4 py-3 border border-foreground/15 hover:border-foreground hover:bg-foreground/5 transition-colors rounded-md"
              >
                <span className="flex flex-col">
                  <span className="font-display text-base text-foreground">Telegram</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {SUPPORT_TELEGRAM.replace(/^https?:\/\//, '')}
                  </span>
                </span>
                <ExternalLink className="w-4 h-4 text-muted-foreground" />
              </a>
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="flex items-center justify-between gap-3 px-4 py-3 border border-foreground/15 hover:border-foreground hover:bg-foreground/5 transition-colors rounded-md"
              >
                <span className="flex flex-col">
                  <span className="font-display text-base text-foreground">Email</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{SUPPORT_EMAIL}</span>
                </span>
                <ExternalLink className="w-4 h-4 text-muted-foreground" />
              </a>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
