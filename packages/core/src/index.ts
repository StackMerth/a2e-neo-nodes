// A²E Core Engine
// Arbitrage & Orchestration Logic

export * from './routing-engine'
export * from './rate-provider'
export * from './yield-floor'
export * from './adapter-registry'
export * from './external-simulation-config'
export * from './adapters/simulation'
// NOTE: Akash adapter intentionally NOT re-exported from this barrel.
// The @akashnetwork/chain-sdk pulls in the Cosmos SDK dependency tree
// (cosmjs/* + scure/* + noble/*) which has unresolved ESM/CJS interop
// issues that crash the Node 20 runtime at module load. Akash is also
// disabled by default (AKASH_ENABLED=false). Re-enable by importing
// directly from './adapters/akash' once the upstream SDK stabilises;
// see the M1 follow-up for a proper lazy-load wrapper.
// export * from './adapters/akash'
export * from './adapters/ionet'
export * from './adapters/vastai'
export * from './currency-rate-oracle'
