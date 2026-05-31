/**
 * Track 5 / 3.A — model-family-aware tokenization for the meter.
 *
 * The meter charges by token, not by character, so we need a counter
 * that matches the model's actual tokenizer. Different model families
 * tokenize text differently:
 *
 *   - OpenAI GPT-4 / GPT-3.5 / embedding-3 → cl100k_base BPE
 *   - OpenAI GPT-4o / GPT-5 / Meta Llama 3 → o200k_base BPE
 *   - Llama 1/2, Mistral, Qwen, Claude    → SentencePiece-style BPE
 *     (no openly available JS port; use a tuned heuristic per family)
 *   - Image models bill by pixel-count or step-count, not tokens
 *
 * M1.2 ships real adapters via js-tiktoken (pure JS, no native deps).
 * Encoding data is loaded lazily on first use of each encoding so cold
 * starts stay quick — a service that never serves a GPT-style request
 * never loads cl100k_base into memory.
 *
 * The local tokenizer remains the FALLBACK. In production the
 * inference worker (vLLM, TGI, SGLang) reports exact token counts in
 * its streaming response (usage.prompt_tokens / completion_tokens) and
 * the meter prefers those. Local counting only matters when the worker
 * can't report — stream-cancel mid-response, older worker versions,
 * dev-mode test calls.
 */

import {
  Tiktoken,
  type TiktokenBPE,
} from 'js-tiktoken'

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

// ----------------------------------------------------------------------
// Heuristic adapter (the original 3.A implementation)
// ----------------------------------------------------------------------

/**
 * Char-count / chars-per-token. Used for model families we don't have
 * a real adapter for (Llama 1/2, Mistral, Qwen, Claude) and as the
 * universal fallback. Per-family chars-per-token ratios are calibrated
 * to typical English text:
 *
 *   - GPT-style BPE (cl100k / o200k): ~4 chars/token
 *   - Llama 3 / Mistral / Qwen:       ~3.5 chars/token
 *   - Claude:                          ~3.5 chars/token
 *   - Code-heavy content:              ratios drop ~20%
 */
class HeuristicTokenizer implements Tokenizer {
  constructor(public readonly id: string, private readonly charsPerToken = 4) {}

  countTokens(text: string): number {
    if (!text) return 0
    // Math.ceil so an empty-ish response still counts as at least 1
    // when there's any payload — matches metering's strictly-positive
    // count expectation on non-empty responses.
    return Math.max(1, Math.ceil(text.length / this.charsPerToken))
  }
}

// ----------------------------------------------------------------------
// Tiktoken adapter (real BPE encoding)
// ----------------------------------------------------------------------

type TiktokenEncodingName = 'cl100k_base' | 'o200k_base'

// Cache one Tiktoken instance per encoding name. The .encode() call is
// thread-safe in V8 (single-threaded JS), so sharing across requests is
// safe and avoids the multi-megabyte rank table re-allocating per call.
const encoderCache = new Map<TiktokenEncodingName, Tiktoken>()

async function loadEncoding(name: TiktokenEncodingName): Promise<Tiktoken> {
  const cached = encoderCache.get(name)
  if (cached) return cached

  // Dynamic import so the ranks files (each ~1-2MB) only load when
  // the first request for that family arrives. Different js-tiktoken
  // versions ship the ranks file in slightly different locations;
  // tolerate both forms with the .default unwrap.
  const mod = await import(`js-tiktoken/ranks/${name}`) as { default?: TiktokenBPE } | TiktokenBPE
  const ranks = (mod as { default?: TiktokenBPE }).default ?? (mod as TiktokenBPE)
  const enc = new Tiktoken(ranks)
  encoderCache.set(name, enc)
  return enc
}

/**
 * Wraps a Tiktoken instance behind the Tokenizer interface. The
 * underlying encoder is lazy-loaded on first .countTokens() call; the
 * countTokens method itself is synchronous, so we need to pre-load
 * the encoder before the meter calls in.
 *
 * Workflow: at server bootstrap, registerTiktokenAdapters() runs to
 * register all known model ids. The Tiktoken instance loads in the
 * background as a side effect. By the time the first inference call
 * arrives, the encoder is hot.
 */
class TiktokenAdapter implements Tokenizer {
  private encoder: Tiktoken | null = null
  private fallback: HeuristicTokenizer

  constructor(
    public readonly id: string,
    private readonly encodingName: TiktokenEncodingName,
    fallbackCharsPerToken = 4,
  ) {
    this.fallback = new HeuristicTokenizer(`${id}__fallback`, fallbackCharsPerToken)
    // Kick off the async load; ignore the promise — countTokens
    // will retry the cache lookup on each call until it's hot.
    void loadEncoding(encodingName).then((enc) => {
      this.encoder = enc
    }).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(`[tokenizer] failed to preload ${encodingName} for ${id}:`, (err as Error).message)
    })
  }

  countTokens(text: string): number {
    if (!text) return 0
    // Synchronous: if the encoder hasn't loaded yet (very first call
    // before the async preload finishes), fall back to the heuristic.
    // Subsequent calls hit the real BPE counter.
    const enc = this.encoder ?? encoderCache.get(this.encodingName) ?? null
    if (!enc) {
      return this.fallback.countTokens(text)
    }
    return Math.max(1, enc.encode(text).length)
  }
}

// ----------------------------------------------------------------------
// Model-family classifier + auto-registration
// ----------------------------------------------------------------------

interface ModelFamilyRule {
  match: (modelId: string) => boolean
  adapter: (modelId: string) => Tokenizer
}

// Rules evaluate top-down; first match wins. Order matters for
// nested matches (gpt-4o must match before gpt-).
const FAMILY_RULES: ModelFamilyRule[] = [
  // OpenAI o200k_base family — GPT-4o, GPT-5, embedding-3-large.
  {
    match: (id) =>
      /^gpt-(4o|5)/i.test(id) ||
      /^o1[-]?/i.test(id) ||
      /text-embedding-3-large/i.test(id),
    adapter: (id) => new TiktokenAdapter(id, 'o200k_base', 4),
  },
  // OpenAI cl100k_base family — everything else with a "gpt-" prefix
  // plus embedding-3-small and the legacy davinci/babbage models.
  {
    match: (id) =>
      /^gpt-/i.test(id) ||
      /text-embedding-3-small/i.test(id) ||
      /text-embedding-ada-002/i.test(id) ||
      /^(davinci|babbage)-002/i.test(id),
    adapter: (id) => new TiktokenAdapter(id, 'cl100k_base', 4),
  },
  // Meta Llama 3.x — tokenizer is tiktoken-style with a similarly-
  // sized vocab (~128k); o200k_base is the closest standard encoding
  // and is accurate to within a few percent for English. Heuristic
  // fallback uses 3.5 chars/token (Llama vocab is denser than GPT).
  {
    match: (id) => /llama[-_]?3/i.test(id),
    adapter: (id) => new TiktokenAdapter(id, 'o200k_base', 3.5),
  },
  // Older Llama (1/2), Mistral, Qwen — SentencePiece variants.
  // No openly available pure-JS port; heuristic at 3.5 chars/token.
  {
    match: (id) => /^(llama|mistral|mixtral|qwen)/i.test(id),
    adapter: (id) => new HeuristicTokenizer(id, 3.5),
  },
  // Anthropic Claude — proprietary tokenizer, no public encoder.
  {
    match: (id) => /^claude/i.test(id),
    adapter: (id) => new HeuristicTokenizer(id, 3.5),
  },
]

/**
 * Build a tokenizer for an arbitrary model id by walking the
 * family-rule list. Returns a Tokenizer (never null) so callers
 * can use it without a presence check. Unknown models get the
 * default 4-char heuristic.
 */
function buildTokenizerFor(modelId: string): Tokenizer {
  for (const rule of FAMILY_RULES) {
    if (rule.match(modelId)) return rule.adapter(modelId)
  }
  return new HeuristicTokenizer(modelId, 4)
}

// ----------------------------------------------------------------------
// Public registry
// ----------------------------------------------------------------------

const registry = new Map<string, Tokenizer>()
const DEFAULT_TOKENIZER: Tokenizer = new HeuristicTokenizer('__default__', 4)

/**
 * Register a tokenizer adapter for a specific model id. The bootstrap
 * path calls this to pin specific (modelId, adapter) pairs at
 * startup; the meter can also auto-register via forModel() the first
 * time a new model is seen.
 */
export function register(tokenizer: Tokenizer): void {
  registry.set(tokenizer.id, tokenizer)
}

/**
 * Resolve a tokenizer for a model id. Returns the registered adapter
 * if present, else builds one from family rules and caches it for
 * subsequent calls (auto-registration). Result is never null.
 */
export function forModel(modelId: string): Tokenizer {
  const cached = registry.get(modelId)
  if (cached) return cached
  const built = buildTokenizerFor(modelId)
  registry.set(modelId, built)
  return built
}

/**
 * Convenience helper used by the meter for a complete request: count
 * the prompt + the response in one call and return both halves so the
 * cost math doesn't need two separate calls.
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
