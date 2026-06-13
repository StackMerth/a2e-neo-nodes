/**
 * Registry of all live ZK-UBI adapters.
 *
 * The scheduler iterates this list each tick, calls isHealthy on
 * each, and polls work from the healthy ones. New protocols (Aleo,
 * StarkNet) plug in by adding their adapter here. No other code in
 * the UBI pipeline needs to know which protocols exist.
 */

import type { UbiProtocol } from '@a2e/database'
import type { UbiAdapter } from './types.js'
import { boundlessAdapter } from './boundless-adapter.js'

const REGISTRY: UbiAdapter[] = [
  boundlessAdapter,
  // Future: succinctAdapter, bittensorAdapter, aleoAdapter
]

export function listAdapters(): UbiAdapter[] {
  return REGISTRY
}

export function getAdapter(protocol: UbiProtocol): UbiAdapter | null {
  return REGISTRY.find((a) => a.protocol === protocol) ?? null
}
