-- T5e: add preferDedicatedTier flag to ComputeRequest. When true, the
-- allocator skips RunPod COMMUNITY tier (peer-hosted, co-tenant noise)
-- and routes only to dedicated supply: internal operators, Lambda,
-- RunPod SECURE. False (default) is the existing behavior — most
-- rentals don't care about co-tenant variance and benefit from
-- cheaper COMMUNITY tier capacity. Driven by the early tester's
-- "compute should not be shared during benchmarks" requirement
-- 2026-06-02.

ALTER TABLE "ComputeRequest"
ADD COLUMN "preferDedicatedTier" BOOLEAN NOT NULL DEFAULT false;
