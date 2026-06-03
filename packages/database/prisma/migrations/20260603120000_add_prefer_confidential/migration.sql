-- T7: add preferConfidential flag to ComputeRequest so buyers can
-- explicitly request hardware-attested TEE compute (Intel TDX / AMD
-- SEV-SNP / NVIDIA Hopper CC). Allocator filters to confidential-only
-- suppliers (VoltageGPU, Phala, io.net allow-listed) when true;
-- WAITING_ON_CAPACITY when no confidential supplier has stock,
-- instead of silently downgrading to Lambda/RunPod.

ALTER TABLE "ComputeRequest" ADD COLUMN "preferConfidential" BOOLEAN NOT NULL DEFAULT false;
