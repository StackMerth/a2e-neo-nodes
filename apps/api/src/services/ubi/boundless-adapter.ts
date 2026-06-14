/**
 * Boundless (RISC Zero / ZKC) adapter.
 *
 * Pivoted from Filecoin C2 on 2026-06-13 after the aggregator scan
 * (memory/zk_ubi_aggregator_scan_2026_06_13.md). Architecture finalized
 * 2026-06-14 after reading the prover docs
 * (memory/zk_ubi_boundless_architecture_2026_06_14.md):
 *
 *   Operator GPU (Bento agent)
 *      <->
 *   Our Boundless broker (Render service)
 *      <->
 *   Base chain (Boundless Market contract)
 *      <->
 *   This adapter (Node.js — observes broker + Base events)
 *
 * Concrete contracts on Base mainnet (chain id 8453):
 *   - BoundlessMarket: 0xfd152dadc5183870710fe54f939eae3ab9f0fe82
 *   - ZKC token:       0xAA61bB7777bD01B684347961918f1E07fBbCe7CF
 *   - VerifierRouter:  0x0b144e07a0826182b6b59788c34b32bfa86fb711
 *   - SetVerifier:     0x1Ab08498CfF17b9723ED67143A050c8E8c2e3104
 *
 * Why this adapter is mostly an OBSERVER, not a primary actor:
 *
 *   The canonical `boundless` broker (Rust binary, runs as its own
 *   Render service) is the prover client. It bids on Dutch-auction
 *   orders, locks them on-chain, dispatches proving work to Bento
 *   agents on operator GPUs, aggregates results into Merkle-batched
 *   submissions, and claims PoVW ZKC rewards each epoch. We don't
 *   reimplement that logic in TypeScript.
 *
 *   Our role here is:
 *     1. Surface broker health to the scheduler so it knows whether
 *        ZK-UBI work is flowing for operators.
 *     2. Read accepted-proof events from BoundlessMarket on Base,
 *        write one UbiProof row per fulfill, attribute to the
 *        operator whose Bento did the proving.
 *     3. Convert the ETH fee + ZKC PoVW reward streams into USD
 *        at the moment of platform receipt (swap-at-accrual) and
 *        roll up into UbiEarning rows.
 *
 * Status: STUB. The broker isn't deployed yet (M2.2). The Base event
 * reader isn't wired (M2.5). The ETH/ZKC swap rail isn't wired (M2.6).
 * Until those land, isHealthy returns false, pollWorkAvailable
 * returns [], submitProofResult is a no-op.
 *
 * Env wiring (set on Render once broker is deployed):
 *   UBI_BOUNDLESS_ENABLED=true                    activate adapter
 *   BOUNDLESS_BROKER_URL=https://...              broker status endpoint
 *   BOUNDLESS_PROVER_ADDRESS=0x...                our platform wallet
 *   BASE_RPC_URL=https://mainnet.base.org         RPC for event reads
 *
 * Two income streams to wire later:
 *   - ETH per-order fees on each fulfill (immediate)
 *   - ZKC PoVW emissions per ~48h epoch (claimed manually by broker)
 */

import type {
  UbiAdapter,
  UbiProofAcceptance,
  UbiProofResult,
  UbiWorkItem,
} from './types.js'

const ENABLED = process.env.UBI_BOUNDLESS_ENABLED === 'true'

// Base mainnet (chain id 8453). Reserved for the Base event reader
// in M2.5; declared here so changing chain id is a one-line edit.
export const BOUNDLESS_BASE_CHAIN_ID = 8453
export const BOUNDLESS_MARKET_ADDRESS =
  '0xfd152dadc5183870710fe54f939eae3ab9f0fe82'
export const BOUNDLESS_ZKC_ADDRESS =
  '0xAA61bB7777bD01B684347961918f1E07fBbCe7CF'

export const boundlessAdapter: UbiAdapter = {
  protocol: 'BOUNDLESS',

  async pollWorkAvailable(): Promise<UbiWorkItem[]> {
    if (!ENABLED) return []
    // M2.5: this is "is there work flowing right now" for the
    // scheduler's health view. The actual auction-bidding is done by
    // the broker; we surface a synthetic UbiWorkItem per active
    // locked order so the scheduler dashboard reflects activity.
    // For now: empty array means "no work observed", which is the
    // correct answer until M2.2 broker deploys.
    return []
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
    // M2.5: this is intentionally a no-op for Boundless because the
    // broker submits proofs autonomously (it owns the Base wallet
    // private key). The UbiProof row gets its ACCEPTED status from
    // the Base event reader watching BoundlessMarket.fulfill logs.
    // We keep the method on the interface for protocol-symmetry with
    // adapters where the API does need to push a result.
    return {
      accepted: false,
      grossTokenAtto: '0',
      grossUsd: 0,
      rejectionReason: 'broker_owned_submission',
    }
  },

  async isHealthy(): Promise<boolean> {
    if (!ENABLED) return false
    // M2.5: real health check pings the broker's status endpoint at
    // BOUNDLESS_BROKER_URL/healthz and confirms (a) broker process
    // up, (b) at least one Bento agent connected, (c) ZKC stake > 0,
    // (d) ETH gas balance > threshold.
    return false
  },
}
