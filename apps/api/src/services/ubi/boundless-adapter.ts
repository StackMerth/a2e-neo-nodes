/**
 * Boundless (RISC Zero / ZKC) adapter.
 *
 * Pivoted from Filecoin C2 on 2026-06-13 after the aggregator scan
 * (memory/zk_ubi_aggregator_scan_2026_06_13.md) found Filecoin
 * sealing markets are buyer-side and don't fit independent GPU
 * providers. Boundless is the opposite shape: a permissionless ZK
 * prover marketplace on Base where third-party ZK apps post proof
 * bounties in ZKC and any registered prover can claim them.
 *
 * Status: STUB. Schema, opt-in DB rows, and operator-facing UI can
 * ship behind this stub without operators doing actual work yet.
 *
 * To activate (M2):
 *   - Register a Boundless prover node binding on Base (one address
 *     per platform, multiplexed across operators via our scheduler)
 *   - Wire pollWorkAvailable to the Boundless market REST/RPC client
 *   - Wire submitProofResult to the on-chain claim flow
 *   - Set UBI_BOUNDLESS_ENABLED=true on Render
 *
 * Why no disk requirement: Boundless proofs are pure-compute
 * (zkVM execution + STARK aggregation). No sector storage, no
 * persistent state per proof. Every GPU operator on our platform is
 * eligible regardless of disk profile.
 */

import type {
  UbiAdapter,
  UbiProofAcceptance,
  UbiProofResult,
  UbiWorkItem,
} from './types.js'

const ENABLED = process.env.UBI_BOUNDLESS_ENABLED === 'true'

export const boundlessAdapter: UbiAdapter = {
  protocol: 'BOUNDLESS',

  async pollWorkAvailable(): Promise<UbiWorkItem[]> {
    if (!ENABLED) return []
    // M2: replace with Boundless market client. Returns the next
    // batch of available proof bounties matching our prover
    // capabilities. Each item: bountyId (externalProofId), the
    // zkVM program + input the proof attests to (workPayload),
    // estimated cycle budget (estimatedDurationSeconds), bounty
    // amount (will become grossTokenAtto / grossUsd on accept).
    throw new Error('Boundless market client not yet wired (M2 task)')
  },

  async submitProofResult(_result: UbiProofResult): Promise<UbiProofAcceptance> {
    if (!ENABLED) {
      return {
        accepted: false,
        grossTokenAtto: '0',
        grossUsd: 0,
        rejectionReason: 'adapter_disabled',
      }
    }
    // M2: replace with Boundless claim flow. POST the STARK proof
    // bytes to the on-chain settlement contract; settlement returns
    // ZKC reward in atto-ZKC. Adapter converts to USD at the spot
    // rate at acceptance time (locks operator's USD value).
    throw new Error('Boundless market client not yet wired (M2 task)')
  },

  async isHealthy(): Promise<boolean> {
    return ENABLED
  },
}
