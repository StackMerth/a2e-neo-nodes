/**
 * M1.2 — tokenizer inspector / smoke test.
 *
 * Verifies the real Tiktoken adapters and the heuristic fallbacks
 * count sensibly across model families. Useful any time someone
 * touches the family-rules table in tokenizer.ts.
 *
 * Run:   pnpm --filter @a2e/api tokenizer:inspect
 *        pnpm --filter @a2e/api tokenizer:inspect "<custom text>"
 */
import { forModel } from '../src/services/inference/tokenizer.js'

const MODELS_TO_PROBE = [
  // OpenAI o200k_base
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-5',
  'o1-mini',
  'text-embedding-3-large',
  // OpenAI cl100k_base
  'gpt-4',
  'gpt-3.5-turbo',
  'text-embedding-3-small',
  'text-embedding-ada-002',
  // Llama 3 (uses o200k_base)
  'llama-3.1-70b-instruct',
  'llama-3-8b',
  // Older Llama / Mistral / Qwen (heuristic 3.5)
  'llama-2-7b',
  'mistral-large',
  'qwen-2.5-72b',
  // Claude
  'claude-opus-4-7',
  // Unknown
  'some-unrecognized-model',
]

const FIXTURES = [
  { name: 'short',  text: 'Hello world.' },
  { name: 'medium', text: 'The quick brown fox jumps over the lazy dog. This sentence is commonly used as a typing exercise because it contains every letter of the English alphabet.' },
  { name: 'code',   text: 'function add(a: number, b: number): number {\n  return a + b\n}\n\nconst x = add(1, 2)\nconsole.log(x)' },
]

async function main(): Promise<void> {
  const customText = process.argv[2]
  const fixtures = customText
    ? [{ name: 'custom', text: customText }]
    : FIXTURES

  for (const f of fixtures) {
    console.log(`\nFixture: "${f.name}" (${f.text.length} chars)`)
    console.log(`---`)
    // Give the async Tiktoken loaders a beat to settle on the first
    // run. Each family loads its ranks file once, ~500ms cold.
    await new Promise((r) => setTimeout(r, 50))

    console.log(`  ${'model'.padEnd(30)} tokens   chars/tok`)
    for (const id of MODELS_TO_PROBE) {
      const tok = forModel(id)
      // First call may hit the heuristic fallback if the BPE load
      // hasn't finished yet; second call uses the real encoder.
      tok.countTokens(f.text)
      // Tiny wait so the async preload can flush in for the second
      // measurement on the very first iteration.
      await new Promise((r) => setTimeout(r, 30))
      const n = tok.countTokens(f.text)
      const ratio = f.text.length / Math.max(1, n)
      console.log(`  ${id.padEnd(30)} ${String(n).padStart(6)}   ${ratio.toFixed(2)}`)
    }
  }

  console.log('\nDone.')
  console.log('Expected ratios for English text:')
  console.log('  GPT-style BPE (cl100k/o200k): ~4.0 chars/token')
  console.log('  Llama 3 / Mistral / Qwen:    ~3.5 chars/token')
  console.log('  Heuristic default:           4.0 chars/token (exact)')
  console.log('  Code is denser everywhere:   ~10-20% lower than English')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
