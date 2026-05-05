// External-market simulation mode toggle.
//
// Defaults to ON so that no adapter touches a real market until the client
// provides credentials and explicitly flips A2E_EXTERNAL_SIMULATION=false.
//
// Per-market overrides (A2E_VASTAI_SIMULATION / A2E_AKASH_SIMULATION /
// A2E_IONET_SIMULATION) let us flip one market live while the others stay
// safely simulated. This matters during phased go-live, where for example
// Vast.ai is ready but Akash credentials aren't.

export type ExternalMarket = 'AKASH' | 'IONET' | 'VASTAI'

const PER_MARKET_ENV: Record<ExternalMarket, string> = {
  AKASH: 'A2E_AKASH_SIMULATION',
  IONET: 'A2E_IONET_SIMULATION',
  VASTAI: 'A2E_VASTAI_SIMULATION',
}

/**
 * Returns whether the given market should run in simulation mode.
 *
 * Resolution order:
 *   1. Per-market env var (A2E_<MARKET>_SIMULATION) if set to "true" or "false"
 *   2. Global env var (A2E_EXTERNAL_SIMULATION); defaults to "true"
 *
 * Calling without a market returns the global flag.
 */
export function isSimulationMode(market?: ExternalMarket): boolean {
  if (market) {
    const override = process.env[PER_MARKET_ENV[market]]
    if (override === 'true') return true
    if (override === 'false') return false
    // Unset → fall through to global flag.
  }
  return process.env.A2E_EXTERNAL_SIMULATION !== 'false'
}
