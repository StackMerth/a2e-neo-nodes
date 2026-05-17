# Workspace benchmark image (C4)

Single-purpose container that runs CUDA matmul + VRAM bandwidth tests
and prints a JSON line on stdout. The node-agent's job-executor
launches this with `--gpus all --rm`, parses the result, and reports
the numbers back to the API.

## Build + publish

Public image; no per-tenant secrets. Recommended registry: GHCR.

```bash
docker build -t ghcr.io/stackmerth/a2e-benchmark:1.0.0 .
docker push ghcr.io/stackmerth/a2e-benchmark:1.0.0
docker tag ghcr.io/stackmerth/a2e-benchmark:1.0.0 ghcr.io/stackmerth/a2e-benchmark:latest
docker push ghcr.io/stackmerth/a2e-benchmark:latest
```

The agent's default image tag is configured via env
`BENCHMARK_IMAGE` (defaults to `ghcr.io/stackmerth/a2e-benchmark:latest`).

## Local test (any CUDA host)

```bash
docker run --gpus all --rm ghcr.io/stackmerth/a2e-benchmark:latest
```

Expected output (last line):

```json
{"matmulTflops": 312.4, "vramBandwidthGbs": 1980.5, "score": 87.2, "gpuName": "NVIDIA H100 80GB HBM3", "iterations": 10}
```

## Tunable env vars

- `BENCH_MATMUL_ITERATIONS` — default 10. Higher = more stable, slower.
- `BENCH_MATMUL_BASE` — override the per-tier baseline TFLOPS used for scoring.
- `BENCH_BW_BASE` — override the per-tier baseline GB/s used for scoring.

## Expected score ranges per tier

| GPU | Matmul TFLOPS | VRAM GB/s | Score |
|---|---|---|---|
| H100 80GB HBM3 | 280-310 | 1800-2000 | 85-100 |
| H200 | 320-360 | 4500-4800 | 90-100 |
| B200 / B300 / GB300 | 400+ | 8000+ | 90-100 |
| RTX 4090 24GB | 70-85 | 950-1010 | 80-100 |
| RTX 3090 24GB | 30-38 | 900-940 | 75-100 |

Anomaly threshold is a 20% drop vs the prior benchmark score on the
same node — see [docs/RUNBOOK_ADMIN.md](../../../docs/RUNBOOK_ADMIN.md)
"Benchmarking (C4 wave 1)" section.
