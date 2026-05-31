/**
 * Track 5 / E2.2 — external-provider fallback for inference calls.
 *
 * When pickInferenceWorker() returns null (no eligible operator worker
 * for the requested model), the inference router can fall through to
 * a platform-managed external provider configured per model in
 * ModelPricing.metadata. The platform pays the external provider's
 * per-token cost out of pocket; M1.1's revenue split treats the
 * platform itself as the "operator" so treasury earns the operator
 * slice. Buyer experiences a normal /v1/chat/completions response and
 * never sees the routing decision.
 *
 * Supported providers in E2.2:
 *   - openai      — passthrough (OpenAI's request/response shape is
 *                   our public surface, so no translation needed).
 *                   API key from OPENAI_API_KEY env.
 *   - openai-compat — any OpenAI-API-compatible base URL (Together AI,
 *                   Anyscale, Groq, Fireworks, Cerebras, OpenRouter,
 *                   self-hosted vLLM, etc.). API key + base URL come
 *                   from the model's metadata.
 *
 * Anthropic, Cohere, etc. will land in E2.3+ when they require
 * format translation.
 *
 * Config shape in ModelPricing.metadata:
 *   { "externalProvider": "openai", "externalModel": "gpt-4o" }
 *   { "externalProvider": "openai-compat",
 *     "externalModel": "llama-3.1-70b",
 *     "externalBaseUrl": "https://api.together.xyz/v1",
 *     "externalApiKeyEnv": "TOGETHER_API_KEY" }
 *
 * When the env-named key is missing, the resolver returns null and
 * the route returns 503 "model temporarily unavailable" rather than
 * trying to call the provider with no auth.
 */

export type ExternalProviderKind = 'openai' | 'openai-compat'

export interface ExternalProviderConfig {
  kind: ExternalProviderKind
  /** API key resolved from env at call time (never returned to callers). */
  apiKey: string
  /** Full base URL — defaults to OpenAI's official endpoint for `kind=openai`. */
  baseUrl: string
  /** Provider-side model id we should send (vs. our internal id). */
  externalModel: string
}

/**
 * Read the model's ModelPricing.metadata block and return a usable
 * provider config, or null when:
 *   - No externalProvider configured
 *   - Configured provider kind isn't supported
 *   - Required env var (API key) isn't set
 *
 * The caller (the route handler) treats null as "no fallback
 * available" and 503s the request.
 */
export function resolveExternalProvider(
  metadata: unknown,
): ExternalProviderConfig | null {
  if (!metadata || typeof metadata !== 'object') return null
  const m = metadata as Record<string, unknown>

  const kind = m.externalProvider
  if (typeof kind !== 'string') return null

  const externalModel = typeof m.externalModel === 'string' ? m.externalModel : null
  if (!externalModel) return null

  if (kind === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY?.trim()
    if (!apiKey) return null
    const baseUrl = (typeof m.externalBaseUrl === 'string' ? m.externalBaseUrl : 'https://api.openai.com/v1').replace(/\/+$/, '')
    return { kind: 'openai', apiKey, baseUrl, externalModel }
  }

  if (kind === 'openai-compat') {
    const baseUrl = typeof m.externalBaseUrl === 'string'
      ? m.externalBaseUrl.replace(/\/+$/, '')
      : null
    const envName = typeof m.externalApiKeyEnv === 'string' ? m.externalApiKeyEnv : null
    if (!baseUrl || !envName) return null
    const apiKey = process.env[envName]?.trim()
    if (!apiKey) return null
    return { kind: 'openai-compat', apiKey, baseUrl, externalModel }
  }

  return null
}
