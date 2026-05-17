"""C4 wave 1: workspace benchmark — matmul TFLOPS + VRAM bandwidth.

Single Python entry. Runs both benchmarks, normalizes against per-tier
baselines, prints a single JSON line on stdout. Exits non-zero on any
failure so the agent's job-executor reports a clean FAILED status.

Output shape (single line, parseable by the agent's reportBenchmarkResult):

    {"matmulTflops": 312.4, "vramBandwidthGbs": 1980.5, "score": 87.2,
     "gpuName": "NVIDIA H100 80GB HBM3", "iterations": 10}

Score is composite 0-100, weighted 60% matmul + 40% bandwidth against
tier baselines. Anything >100 is clamped down — a 4090 outscoring an
H100 doesn't make physical sense and would just confuse operators.

The tier baselines below are conservative averages from public spec
sheets. They're tunable via env (BENCH_MATMUL_BASE, BENCH_BW_BASE)
without rebuilding the image, so admin can recalibrate post-launch.
"""

import json
import os
import sys
import time

try:
    import torch
except ImportError as e:
    print(json.dumps({"error": f"PyTorch not available: {e}"}), flush=True)
    sys.exit(1)

# -- Tier baselines ---------------------------------------------------
# (matmul TFLOPS, VRAM bandwidth GB/s). Used to normalize the score
# so an H100 and a 4090 both land in a sensible 0-100 range. Tier name
# is derived from the GPU name via substring match; unknowns fall back
# to a generic baseline.
TIER_BASELINES = {
    "H100":  (300.0, 2000.0),
    "H200":  (350.0, 4800.0),
    "B200":  (450.0, 8000.0),
    "B300":  (500.0, 9000.0),
    "GB300": (600.0, 10000.0),
    "RTX 4090": (80.0, 1000.0),
    "RTX 3090": (35.0, 936.0),
    "A100":  (150.0, 1555.0),
    "A6000": (38.0, 768.0),
    "L40":   (90.0, 864.0),
}
GENERIC_BASELINE = (50.0, 500.0)


def detect_tier(gpu_name: str) -> tuple[float, float]:
    """Match a substring of the GPU name to a tier baseline."""
    for key, baseline in TIER_BASELINES.items():
        if key.lower() in gpu_name.lower():
            return baseline
    return GENERIC_BASELINE


def matmul_benchmark(iterations: int = 10) -> float:
    """Returns sustained FP16 matmul TFLOPS over `iterations` runs.

    8192x8192 is a sweet spot: large enough to amortize launch overhead
    on H100-class hardware, small enough that even a 4090 (24 GB) can
    hold two of them comfortably. FP16 matches modern inference / training
    precision; fp32 would underutilize tensor cores and report misleading
    low numbers.
    """
    n = 8192
    dtype = torch.float16
    device = torch.device("cuda")

    a = torch.randn(n, n, dtype=dtype, device=device)
    b = torch.randn(n, n, dtype=dtype, device=device)

    # Warm-up so the first kernel-launch overhead doesn't skew the
    # measurement. 2 iterations is enough to populate caches + JIT.
    for _ in range(2):
        c = a @ b
    torch.cuda.synchronize()

    start = time.perf_counter()
    for _ in range(iterations):
        c = a @ b
    torch.cuda.synchronize()
    elapsed = time.perf_counter() - start

    # FLOPs per matmul = 2 * n^3 (n^3 multiplies + n^3 adds)
    total_flops = 2 * (n ** 3) * iterations
    tflops = total_flops / elapsed / 1e12
    return round(tflops, 2)


def bandwidth_benchmark(iterations: int = 20) -> float:
    """Returns sustained device-to-device copy GB/s.

    Device-to-device because that's what real workloads see — HBM/GDDR
    sustained throughput. Host->device (PCIe) would measure the wrong
    thing entirely.
    """
    size_bytes = 1 << 30  # 1 GiB
    n_elements = size_bytes // 4
    device = torch.device("cuda")

    src = torch.randn(n_elements, dtype=torch.float32, device=device)
    dst = torch.empty_like(src)

    # Warm-up
    for _ in range(2):
        dst.copy_(src)
    torch.cuda.synchronize()

    start = time.perf_counter()
    for _ in range(iterations):
        dst.copy_(src)
    torch.cuda.synchronize()
    elapsed = time.perf_counter() - start

    total_bytes = size_bytes * iterations
    gbs = total_bytes / elapsed / 1e9
    return round(gbs, 2)


def main() -> None:
    if not torch.cuda.is_available():
        print(json.dumps({"error": "CUDA not available — no GPU detected"}), flush=True)
        sys.exit(2)

    gpu_name = torch.cuda.get_device_name(0)
    iterations = int(os.environ.get("BENCH_MATMUL_ITERATIONS", "10"))

    try:
        matmul_tflops = matmul_benchmark(iterations=iterations)
        bandwidth_gbs = bandwidth_benchmark(iterations=20)
    except Exception as e:
        print(json.dumps({"error": f"Benchmark execution failed: {e}"}), flush=True)
        sys.exit(3)

    # Tier-aware normalization. Env overrides let admin recalibrate
    # post-launch without rebuilding the image.
    base_matmul, base_bw = detect_tier(gpu_name)
    base_matmul = float(os.environ.get("BENCH_MATMUL_BASE", base_matmul))
    base_bw = float(os.environ.get("BENCH_BW_BASE", base_bw))

    matmul_pct = min(100.0, (matmul_tflops / base_matmul) * 100.0)
    bw_pct = min(100.0, (bandwidth_gbs / base_bw) * 100.0)
    score = round(0.6 * matmul_pct + 0.4 * bw_pct, 1)

    result = {
        "matmulTflops": matmul_tflops,
        "vramBandwidthGbs": bandwidth_gbs,
        "score": score,
        "gpuName": gpu_name,
        "iterations": iterations,
    }
    # Single-line JSON output — the agent matches on the last line of
    # stdout that parses as a JSON object with "score" in it.
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
