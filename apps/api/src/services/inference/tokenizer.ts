/**
 * Track 5 / 3.A — model-family-aware tokenization for the meter.
 *
 * The meter charges by token, not by character, so we need a counter
 * that matches the model's actual tokenizer. Different model families
 * tokenize text differently:
 *
 *   - OpenAI-style (GPT-4, GPT-3.5, embeddings) use BPE via tiktoken
 *   - Llama / Mistral / Qwen use SentencePiece variants
 *   - Image models bill by pixel-count or step-count, not tokens
 *
 * Rather than try to bundle every tokenizer at the gateway (large
 * binary footprint, slow cold start), the design is pluggable: each
 * adapter implements the Tokenizer interface, and the registry maps
 * model id → adapter. For 3.A we ship one adapter — the heuristic
 * fallback — which uses the well-known "~4 characters per token"
 * approximation. Real BPE/SentencePiece adapters land in 3.B when we
 * actually route to inference workers and have a model catalog to
 * register.
 *
 * Worth noting: the inference worker itself reports the true token
 * counts in the streaming response (vLLM and TGI both emit
 * usage.prompt_tokens / completion_tokens). So in production the
 * meter prefers the worker-reported counts and only falls back to
 * the local tokenizer when the worker can't (e.g. on stream cancel
 * mid-response). The local tokenizer is the safety net, not the
 * authority.
 */

export interface TokenCount {
  inputTokens: number
  outputTokens: number
}

export interface Tokenizer {
  // Identifier the registry uses to look this adapter up. Matches
  // ModelPricing.modelId so the meter can find the right tokenizer
  // for a model in one call.
  readonly id: string
  // Returns the number of tokens the model's tokenizer would emit
  // for the given text. Implementations may approximate but must be
  // deterministic for the same input.
  countTokens(text: string): number
}

/**
 * Heuristic fallback adapter. Uses the 4-chars-per-token rule of
 * thumb that's accurate to within ~10% for English text across
 * GPT-style models. Off by more for code-heavy text or non-English,
 * but the worker-reported counts override this in production so the
 * heuristic only matters for stream-cancel edge cases and dev-mode
 * test calls.
 *
 * Ratio is configurable per construction so adapters for different
 * model families can tune without changing the implementation.
 */
class HeuristicTokenizer implements Tokenizer {
  constructor(public readonly id: string, private readonly charsPerToken = 4) {}

  countTokens(text: string): number {
    if (!text) return 0
    // Math.ceil so an empty-ish response still counts as at least 1
    // when there's any payload, matching how the metering pipeline
    // expects strictly positive token counts on non-empty responses.
    return Math.max(1, Math.ceil(text.length / this.charsPerToken))
  }
}

/**
 * Default fallback used when a model id isn't registered. Keeps the
 * meter useful in dev / test before any real model adapters land.
 */
const DEFAULT_TOKENIZER: Tokenizer = new HeuristicTokenizer('__default__', 4)

const registry = new Map<string, Tokenizer>()

/**
 * Register a tokenizer adapter for a specific model id. Called from
 * the inference service bootstrap once 3.B lands with real adapters.
 * Calling register() twice for the same id replaces the prior
 * entry — intentional, so a hot reload can swap a buggy adapter.
 */
export function register(tokenizer: Tokenizer): void {
  registry.set(tokenizer.id, tokenizer)
}

/**
 * Resolve a tokenizer for a model id. Returns the registered adapter
 * when present, otherwise a heuristic fallback keyed to the model
 * (so debug logs distinguish "no adapter for llama-3.1-70b" from
 * the truly anonymous default).
 */
export function forModel(modelId: string): Tokenizer {
  return registry.get(modelId) ?? new HeuristicTokenizer(modelId, 4)
}

/**
 * Convenience helper used by the meter for a complete request: count
 * the prompt + the response in one call and return both halves so
 * the cost math doesn't need two separate calls.
 */
export function countRequest(modelId: string, prompt: string, response: string): TokenCount {
  const t = forModel(modelId)
  return {
    inputTokens: t.countTokens(prompt),
    outputTokens: t.countTokens(response),
  }
}

/**
 * Reset for tests. Production never calls this; test suites use it
 * between cases to keep state isolated.
 */
export function _resetRegistryForTests(): void {
  registry.clear()
}

export const defaultTokenizer = DEFAULT_TOKENIZER
