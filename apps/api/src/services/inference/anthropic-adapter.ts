/**
 * Track 5 / E2.3 — Anthropic Claude adapter.
 *
 * Anthropic's Messages API uses a different request/response shape
 * than OpenAI's chat completions. Buyers call our /v1/chat/completions
 * endpoint with the standard OpenAI shape; this adapter translates
 * both directions so Claude models route through the same gateway
 * as everything else without buyers needing to know.
 *
 * Translation rules
 * -----------------
 *
 * Request (OpenAI -> Anthropic):
 *   - Extract messages with role=system; concatenate their content
 *     into Anthropic's top-level `system` field. Remove from messages.
 *   - max_tokens is REQUIRED by Anthropic. Default to 4096 when caller
 *     omits it (OpenAI lets buyers send no max_tokens at all).
 *   - temperature, top_p, top_k pass through with the same semantics.
 *   - stop -> stop_sequences (string or array, normalized to array).
 *   - tools (OpenAI's function-calling shape) translates to Anthropic's
 *     tools format (name, description, input_schema).
 *   - tool_choice translates similarly (auto/required/specific tool).
 *   - Multimodal content: OpenAI's vision blocks (image_url) translate
 *     to Anthropic's image blocks (source.type=base64 or url).
 *   - Multi-content user messages with type=tool_result translate to
 *     Anthropic's user-role messages with tool_result content blocks.
 *
 * Response (Anthropic -> OpenAI):
 *   - content array concatenates: text blocks become message.content;
 *     tool_use blocks become message.tool_calls[].
 *   - stop_reason maps: end_turn -> stop, max_tokens -> length,
 *     tool_use -> tool_calls, stop_sequence -> stop.
 *   - usage.input_tokens -> usage.prompt_tokens, output_tokens ->
 *     completion_tokens, sum -> total_tokens.
 *   - Generate synthetic id (chatcmpl-...), object (chat.completion),
 *     created (current epoch). model echoes whatever the caller
 *     requested.
 *
 * Streaming (Anthropic events -> OpenAI SSE):
 *   - On message_start: emit one delta with role=assistant.
 *   - On content_block_start (text): no emit; track index.
 *   - On content_block_delta (text_delta): emit delta with content.
 *   - On content_block_start (tool_use): emit delta with tool_calls[]
 *     containing the function name + id + empty arguments.
 *   - On content_block_delta (input_json_delta): emit delta with
 *     tool_calls[].function.arguments += partial JSON.
 *   - On message_delta (stop_reason): emit final delta with
 *     finish_reason mapped.
 *   - On message_stop: emit `data: [DONE]\n\n`.
 *   - usage from message_delta is captured + appended into the FINAL
 *     usage chunk (OpenAI ships usage on a separate trailing chunk
 *     when include_usage is true).
 *
 * What this adapter does NOT support yet:
 *   - Anthropic's prompt caching (cache_control on content blocks).
 *     Caller passes through; we don't surface it specially.
 *   - Anthropic's thinking blocks (Claude 4 extended-thinking). The
 *     adapter passes thinking deltas through as empty string content
 *     for OpenAI compat — the reasoning isn't shown to buyers, but
 *     it still counts toward billing via output_tokens.
 *   - Vision input_image without base64 (i.e. URL-only) is rejected.
 *     OpenAI's image_url field can be a data URL or a regular URL;
 *     Anthropic only accepts base64 or URLs that they can reach, so
 *     we pass URLs through verbatim. Data URLs are split into base64.
 */

import Anthropic from '@anthropic-ai/sdk'

// Local copies of the types we use from the route — kept narrow on
// purpose so the adapter is decoupled from inference.ts.
export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'developer'
  content: string | Array<Record<string, unknown>> | null
  name?: string
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

export interface OpenAIChatRequest {
  model: string
  messages: OpenAIChatMessage[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  stream?: boolean
  stop?: string | string[]
  tools?: Array<{
    type: 'function'
    function: {
      name: string
      description?: string
      parameters?: Record<string, unknown>
    }
  }>
  tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } }
  user?: string
  // Anthropic-specific passthrough — buyers can set this directly
  // when they want extended-thinking on Claude 4 models.
  thinking?: { type: 'enabled' | 'disabled'; budget_tokens?: number }
  [k: string]: unknown
}

export interface OpenAIChatResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      role: 'assistant'
      content: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
  [k: string]: unknown
}

// Anthropic Messages API request shape we build. Cast through the
// SDK's permissive types because the SDK accepts our shape but its
// declared types are narrower than the runtime contract.
interface AnthropicMessagesRequest {
  model: string
  max_tokens: number
  messages: Array<{
    role: 'user' | 'assistant'
    content: string | Array<Record<string, unknown>>
  }>
  system?: string | Array<Record<string, unknown>>
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
  tools?: Array<{
    name: string
    description?: string
    input_schema: Record<string, unknown>
  }>
  tool_choice?:
    | { type: 'auto' }
    | { type: 'any' }
    | { type: 'tool'; name: string }
  thinking?: { type: 'enabled' | 'disabled'; budget_tokens?: number }
  metadata?: { user_id?: string }
}

// ---------------------------------------------------------------------
// Request translation (OpenAI -> Anthropic)
// ---------------------------------------------------------------------

/**
 * Build the Anthropic Messages API request from a parsed OpenAI chat
 * completion request. Pass in the model id Anthropic expects (which
 * may differ from the buyer-facing model id we route under).
 */
export function translateRequestToAnthropic(
  req: OpenAIChatRequest,
  anthropicModel: string,
): AnthropicMessagesRequest {
  // System messages collapse into the top-level system field. Multiple
  // system messages become a content-block array preserving order.
  const systemBlocks: Array<{ type: 'text'; text: string }> = []
  const nonSystem: OpenAIChatMessage[] = []
  for (const m of req.messages) {
    if (m.role === 'system' || m.role === 'developer') {
      const text = typeof m.content === 'string' ? m.content : ''
      if (text) systemBlocks.push({ type: 'text', text })
    } else {
      nonSystem.push(m)
    }
  }

  const out: AnthropicMessagesRequest = {
    model: anthropicModel,
    // OpenAI lets buyers omit max_tokens; Anthropic requires it.
    // 4096 is a sensible default — long enough for most replies,
    // short enough to bound runaway responses.
    max_tokens: req.max_tokens ?? 4096,
    messages: nonSystem.map((m) => translateMessageToAnthropic(m)),
  }
  if (systemBlocks.length === 1) {
    out.system = systemBlocks[0]!.text
  } else if (systemBlocks.length > 1) {
    out.system = systemBlocks
  }
  if (req.temperature !== undefined) out.temperature = req.temperature
  if (req.top_p !== undefined) out.top_p = req.top_p
  if (req.stop !== undefined) {
    out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop]
  }
  if (req.tools && req.tools.length > 0) {
    out.tools = req.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }))
  }
  if (req.tool_choice) {
    if (req.tool_choice === 'auto') out.tool_choice = { type: 'auto' }
    else if (req.tool_choice === 'required') out.tool_choice = { type: 'any' }
    else if (typeof req.tool_choice === 'object') {
      out.tool_choice = { type: 'tool', name: req.tool_choice.function.name }
    }
    // 'none' has no Anthropic equivalent; the model just won't be
    // forced to call a tool. Drop the field.
  }
  if (req.thinking) out.thinking = req.thinking
  if (req.user) out.metadata = { user_id: req.user }

  return out
}

function translateMessageToAnthropic(m: OpenAIChatMessage): {
  role: 'user' | 'assistant'
  content: string | Array<Record<string, unknown>>
} {
  // tool-role messages in OpenAI carry tool results; they translate
  // to user-role messages in Anthropic with tool_result content blocks.
  if (m.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: m.tool_call_id ?? '',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        },
      ],
    }
  }

  // assistant messages with tool_calls translate to assistant-role
  // messages with text + tool_use content blocks. Anthropic requires
  // the message to be content-block-array shape (not plain string)
  // when it contains tool_use blocks.
  if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
    const blocks: Array<Record<string, unknown>> = []
    if (typeof m.content === 'string' && m.content) {
      blocks.push({ type: 'text', text: m.content })
    }
    for (const tc of m.tool_calls) {
      let input: unknown = {}
      try {
        input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}
      } catch {
        input = { _raw: tc.function.arguments }
      }
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      })
    }
    return { role: 'assistant', content: blocks }
  }

  // Simple text or content-block-array passthrough.
  if (typeof m.content === 'string' || m.content === null) {
    return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content ?? '' }
  }

  // Content array — translate each block. Vision: image_url -> image.
  const blocks: Array<Record<string, unknown>> = []
  for (const block of m.content) {
    const t = (block as { type?: string }).type
    if (t === 'text') {
      blocks.push({ type: 'text', text: (block as { text?: string }).text ?? '' })
    } else if (t === 'image_url') {
      const url = (block as { image_url?: { url?: string } }).image_url?.url ?? ''
      // Data URL? split out the media type + base64. Otherwise URL.
      if (url.startsWith('data:')) {
        const match = /^data:([^;]+);base64,(.+)$/.exec(url)
        if (match) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: match[1], data: match[2] },
          })
        }
      } else if (url) {
        blocks.push({ type: 'image', source: { type: 'url', url } })
      }
    } else {
      // Unknown block type — pass through verbatim. Anthropic will
      // reject if it doesn't recognize, which surfaces to the buyer
      // as an upstream 4xx.
      blocks.push(block as Record<string, unknown>)
    }
  }
  return { role: m.role === 'assistant' ? 'assistant' : 'user', content: blocks }
}

// ---------------------------------------------------------------------
// Response translation (Anthropic -> OpenAI)
// ---------------------------------------------------------------------

interface AnthropicMessageResponse {
  id: string
  type: 'message'
  role: 'assistant'
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'thinking'; thinking: string }
    | { type: string; [k: string]: unknown }
  >
  model: string
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

export function translateResponseToOpenAI(
  resp: AnthropicMessageResponse,
  buyerFacingModelId: string,
): OpenAIChatResponse {
  const textParts: string[] = []
  const toolCalls: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }> = []
  for (const block of resp.content) {
    if (block.type === 'text') {
      textParts.push((block as { text: string }).text)
    } else if (block.type === 'tool_use') {
      const tb = block as { id: string; name: string; input: unknown }
      toolCalls.push({
        id: tb.id,
        type: 'function',
        function: { name: tb.name, arguments: JSON.stringify(tb.input ?? {}) },
      })
    }
    // thinking blocks deliberately drop on the floor for OpenAI compat
    // — they aren't text and aren't tool calls. Their token cost still
    // shows up in output_tokens.
  }

  const finishReason = mapStopReason(resp.stop_reason)
  const content = textParts.length > 0 ? textParts.join('') : null

  return {
    id: `chatcmpl-${resp.id}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: buyerFacingModelId,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: resp.usage.input_tokens,
      completion_tokens: resp.usage.output_tokens,
      total_tokens: resp.usage.input_tokens + resp.usage.output_tokens,
    },
  }
}

function mapStopReason(
  reason: AnthropicMessageResponse['stop_reason'],
): 'stop' | 'length' | 'tool_calls' | null {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop'
  if (reason === 'max_tokens') return 'length'
  if (reason === 'tool_use') return 'tool_calls'
  return null
}

// ---------------------------------------------------------------------
// Non-streaming call
// ---------------------------------------------------------------------

/**
 * Make a non-streaming Anthropic Messages request and return the
 * OpenAI-shaped chat completion response. Throws on upstream HTTP
 * errors so the route's existing try/catch can mark the request
 * FAILED and surface a 502.
 */
export async function callAnthropicChat(
  req: OpenAIChatRequest,
  anthropicModel: string,
  apiKey: string,
  buyerFacingModelId: string,
): Promise<OpenAIChatResponse> {
  const client = new Anthropic({ apiKey })
  const reqBody = translateRequestToAnthropic(req, anthropicModel)

  // The SDK's create() accepts our shape but its declared types are
  // narrower; we cast through unknown to keep the call site honest.
  const resp = (await client.messages.create(reqBody as never)) as unknown as AnthropicMessageResponse
  return translateResponseToOpenAI(resp, buyerFacingModelId)
}

// ---------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------

export interface AnthropicStreamResult {
  /** Async generator yielding raw OpenAI-format SSE chunks (each is a complete `data: ...\n\n` block including the terminator). */
  sseChunks: AsyncGenerator<string, void, unknown>
  /** Settled after the stream completes. Captures the final token counts so the meter can charge correctly. */
  usage: Promise<{ inputTokens: number; outputTokens: number }>
}

/**
 * Open an Anthropic streaming request and translate its event stream
 * into OpenAI-format SSE chunks. The returned generator is the body
 * the route writes to reply.raw; the usage promise resolves once the
 * stream closes so the meter can run.
 */
export function streamAnthropicChat(
  req: OpenAIChatRequest,
  anthropicModel: string,
  apiKey: string,
  buyerFacingModelId: string,
): AnthropicStreamResult {
  const client = new Anthropic({ apiKey })
  const reqBody = translateRequestToAnthropic(req, anthropicModel)

  let inputTokens = 0
  let outputTokens = 0
  let usageResolve!: (v: { inputTokens: number; outputTokens: number }) => void
  const usagePromise = new Promise<{ inputTokens: number; outputTokens: number }>((res) => {
    usageResolve = res
  })

  const generator = (async function* (): AsyncGenerator<string, void, unknown> {
    const id = `chatcmpl-${Math.random().toString(36).slice(2, 14)}`
    const created = Math.floor(Date.now() / 1000)

    // Tool-call accumulators. Anthropic emits tool args as
    // input_json_delta chunks; OpenAI's SSE expects arguments as a
    // streamed JSON string on the same tool_calls[i] index, so we
    // mirror the indexing on our side.
    const toolStateByIndex = new Map<number, { id: string; name: string; emittedHeader: boolean }>()

    // Initial role chunk so SDKs see a clean assistant turn start.
    yield sseFor({
      id, created, model: buyerFacingModelId,
      delta: { role: 'assistant', content: '' },
      finish_reason: null,
    })

    try {
      const stream = client.messages.stream(reqBody as never)
      for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
        const eventType = (event as { type?: string }).type
        if (eventType === 'message_start') {
          const m = (event as { message?: { usage?: { input_tokens?: number } } }).message
          if (m?.usage?.input_tokens != null) inputTokens = m.usage.input_tokens
          continue
        }

        if (eventType === 'content_block_start') {
          const cb = (event as { content_block?: { type?: string; id?: string; name?: string } }).content_block
          const index = (event as { index?: number }).index ?? 0
          if (cb?.type === 'tool_use' && cb.id && cb.name) {
            toolStateByIndex.set(index, { id: cb.id, name: cb.name, emittedHeader: false })
            // Emit the tool_calls[].function.name + id header chunk so
            // the SDK can attach subsequent argument deltas.
            yield sseFor({
              id, created, model: buyerFacingModelId,
              delta: {
                tool_calls: [{
                  index,
                  id: cb.id,
                  type: 'function',
                  function: { name: cb.name, arguments: '' },
                }],
              },
              finish_reason: null,
            })
            const state = toolStateByIndex.get(index)
            if (state) state.emittedHeader = true
          }
          continue
        }

        if (eventType === 'content_block_delta') {
          const delta = (event as { delta?: { type?: string; text?: string; partial_json?: string } }).delta
          const index = (event as { index?: number }).index ?? 0
          if (delta?.type === 'text_delta' && delta.text) {
            yield sseFor({
              id, created, model: buyerFacingModelId,
              delta: { content: delta.text },
              finish_reason: null,
            })
          } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            yield sseFor({
              id, created, model: buyerFacingModelId,
              delta: {
                tool_calls: [{
                  index,
                  function: { arguments: delta.partial_json },
                }],
              },
              finish_reason: null,
            })
          }
          // thinking_delta: dropped on the floor for OpenAI compat.
          continue
        }

        if (eventType === 'message_delta') {
          const d = (event as { delta?: { stop_reason?: AnthropicMessageResponse['stop_reason'] }; usage?: { output_tokens?: number } })
          if (d.usage?.output_tokens != null) outputTokens = d.usage.output_tokens
          if (d.delta?.stop_reason) {
            const finish = mapStopReason(d.delta.stop_reason)
            yield sseFor({
              id, created, model: buyerFacingModelId,
              delta: {},
              finish_reason: finish,
            })
          }
          continue
        }

        // message_stop, ping, and any unrecognized events: ignore.
      }

      yield 'data: [DONE]\n\n'
    } finally {
      usageResolve({ inputTokens, outputTokens })
    }
  })()

  return { sseChunks: generator, usage: usagePromise }
}

interface SseFrame {
  id: string
  created: number
  model: string
  delta: Record<string, unknown>
  finish_reason: 'stop' | 'length' | 'tool_calls' | null
}

function sseFor(frame: SseFrame): string {
  const payload = {
    id: frame.id,
    object: 'chat.completion.chunk',
    created: frame.created,
    model: frame.model,
    choices: [
      { index: 0, delta: frame.delta, finish_reason: frame.finish_reason },
    ],
  }
  return `data: ${JSON.stringify(payload)}\n\n`
}
