# C4 wave 1: workspace benchmark image.
#
# Single-purpose container that runs CUDA matmul + VRAM bandwidth tests
# and prints a JSON result line on stdout. The agent's job-executor
# launches this with --gpus all --rm, parses the JSON, and reports the
# numbers back to the API.
#
# Image tag convention: a2e-benchmark:<semver>
# Recommended build + push: docker build -t ghcr.io/stackmerth/a2e-benchmark:1.0.0 .
# Public image works for every operator; no per-tenant credentials needed.

FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

# python3 + pip; --no-install-recommends keeps the image lean (no
# random dev tooling pulled in).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

# PyTorch with CUDA 12.4 runtime. CPU-only fallback is intentional
# disabled: a benchmark on a non-GPU host is meaningless and we'd
# rather fail loudly than report a misleading number.
RUN pip3 install --no-cache-dir \
      torch==2.4.1 \
      --index-url https://download.pytorch.org/whl/cu124

WORKDIR /app
COPY main.py /app/main.py

# The agent runs us with `docker run --rm <image>` — no flags, no
# args. ENTRYPOINT is the python script; CMD is empty so additional
# args (if any) pass through cleanly.
ENTRYPOINT ["python3", "/app/main.py"]
