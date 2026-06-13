/**
 * Filecoin C2 (Commit-2 SNARK) adapter.
 *
 * Status: STUB. The aggregator integration is M2 work — see
 * memory/zk_ubi_concept.md. Candidates being evaluated: Hoku/Recall,
 * GLIF, BeFil. Until M2 selects one and we wire the actual REST/RPC
 * client, this adapter advertises itself as unhealthy and returns
 * zero work so the scheduler skips it cleanly. The opt-in DB rows
 * and operator-facing UI can ship behind this stub without operators
 * actually doing work yet.
 *
 * To activate: pick an aggregator, swap pollWorkAvailable +
 * submitProofResult bodies for the real API calls, flip
 * UBI_FILECOIN_C2_ENABLED=true on Render.
 */

import type {
  UbiAdapter,
  UbiProofAcceptance,
  UbiProofResult,
  UbiWorkItem,
} from './types.js'

const ENABLED = process.env.UBI_FILECOIN_C2_ENABLED === 'true'

export const filecoinC2Adapter: UbiAdapter = {
  protocol: 'FILECOIN_C2',

  async pollWorkAvailable(): Promise<UbiWorkItem[]> {
    if (!ENABLED) return []
    // M2: replace with aggregator REST poll. Returns the next batch
    // of available sector seals the aggregator is offering. Each
    // item: sectorId (targetRef), sector size (requiredDiskBytes),
    // estimated C2 walltime (estimatedDurationSeconds), opaque
    // sealing inputs (workPayload).
    throw new Error('Filecoin C2 aggregator client not yet wired (M2 task)')
  },

  async submitProofResult(_result: UbiProofResult): Promise<UbiProofAcceptance> {
    if (!ENABLED) {
      return { accepted: false, grossTokenAtto: '0', grossUsd: 0, rejectionReason: 'adapter_disabled' }
    }
    // M2: replace with aggregator REST submit. POST the SNARK proof
    // bytes; aggregator verifies + returns FIL reward in atto-FIL.
    throw new Error('Filecoin C2 aggregator client not yet wired (M2 task)')
  },

  async isHealthy(): Promise<boolean> {
    return ENABLED
  },
}
