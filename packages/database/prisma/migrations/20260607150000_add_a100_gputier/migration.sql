-- AlterEnum: add A100 to GpuTier
-- Vast.ai catalog confirmed verified A100 PCIE (3 hosts) + A100 SXM4
-- (5 hosts) supply on 2026-06-07 via inspect-vastai-datacenter-skus.ts.
-- Lambda + RunPod also carry A100 80GB SXM4. Daily retail rate: $24.
ALTER TYPE "GpuTier" ADD VALUE 'A100';
