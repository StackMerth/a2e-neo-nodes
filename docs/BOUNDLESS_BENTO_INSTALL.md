# Boundless Bento install runbook

## What Bento is

Bento is the proving-cluster software from the canonical [boundless-xyz/boundless](https://github.com/boundless-xyz/boundless) Rust repo. It runs on each operator's GPU node and does the actual STARK proving work. Our broker (the central Rust service on Render) dispatches jobs to Bento agents, collects the proofs, and submits them on Base.

For our ZK-UBI feature, every operator who opts in (`NodeUbiOptIn.status = ACTIVE`, `protocol = BOUNDLESS`) needs Bento running on their node so they can earn from the pool.

## Install model decided 2026-06-14

**Separate post-opt-in install, NOT bundled with node-agent.**

Reasoning:
- Bento is a Rust binary with CUDA dependencies (~hundreds of MB). Bundling with the existing Node.js-based node-agent install would bloat every operator's install whether they want ZK-UBI or not.
- ZK-UBI is opt-in by design (operators can decline). Forcing the binary on non-opted-in operators is wasted disk + bandwidth.
- Bento updates on its own cadence (RISC Zero releases). Tying it to our node-agent release cycle slows both.

Install flow:
1. Operator opts in via portal (M3) → `NodeUbiOptIn` row created with status ACTIVE
2. Server pushes a `bento-install` command in the next heartbeat-response to the operator's node-agent
3. Node-agent runs the install script (this doc's `install-bento.sh`)
4. Bento self-registers with our broker via `BOUNDLESS_BROKER_URL` env
5. Bento starts proving; heartbeat back to node-agent reports `bentoStatus = RUNNING`
6. Our server records `bentoLastSeenAt` per node in the existing Node row when heartbeats arrive

## install-bento.sh outline

```sh
#!/usr/bin/env bash
# Install Boundless Bento agent on an operator GPU node.
# Requires Ubuntu 24.04, NVIDIA driver + CUDA toolkit already installed
# by node-agent prerequisites. Idempotent — re-running is safe.
set -euo pipefail

BENTO_VERSION="${BENTO_VERSION:-v2.0.2}"
BENTO_INSTALL_DIR="${BENTO_INSTALL_DIR:-/opt/a2e/bento}"
BROKER_URL="${BOUNDLESS_BROKER_URL:?BOUNDLESS_BROKER_URL env required}"
PROVER_ADDRESS="${BOUNDLESS_PROVER_ADDRESS:?BOUNDLESS_PROVER_ADDRESS env required}"
NODE_ID="${A2E_NODE_ID:?A2E_NODE_ID env required}"

# 1. Pull the Bento binary from the canonical release
mkdir -p "$BENTO_INSTALL_DIR"
curl -fsSL "https://github.com/boundless-xyz/boundless/releases/download/${BENTO_VERSION}/bento-linux-x86_64.tar.gz" \
  | tar -xz -C "$BENTO_INSTALL_DIR"

# 2. Generate per-node config that points at our broker + identifies this operator
cat > "$BENTO_INSTALL_DIR/bento.toml" <<EOF
[broker]
url = "$BROKER_URL"
prover_address = "$PROVER_ADDRESS"

[node]
# Used by the broker to attribute cycles back to this operator for
# our internal proportional payout split.
node_id = "$NODE_ID"

[gpu]
# Auto-detect by default; override only if the operator has multiple
# GPUs and wants to reserve some for non-UBI work.
device_ids = "auto"

EOF

# 3. Install as a systemd service so it survives reboots and the
#    node-agent can manage it via systemctl.
cat > /etc/systemd/system/a2e-bento.service <<EOF
[Unit]
Description=A2E Boundless Bento prover
After=network.target

[Service]
Type=simple
ExecStart=$BENTO_INSTALL_DIR/bento --config $BENTO_INSTALL_DIR/bento.toml
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable a2e-bento.service
systemctl start a2e-bento.service

echo "Bento installed at $BENTO_INSTALL_DIR, broker $BROKER_URL"
```

## Node-agent integration

When the agent's heartbeat-response carries a `bento-install` command:

```ts
// apps/node-agent/src/commands/bento.ts (NEW, M3 era)
async function handleBentoInstall(args: { brokerUrl: string; proverAddress: string }) {
  await execCommand('bash /opt/a2e/scripts/install-bento.sh', {
    env: {
      BOUNDLESS_BROKER_URL: args.brokerUrl,
      BOUNDLESS_PROVER_ADDRESS: args.proverAddress,
      A2E_NODE_ID: getNodeId(),
    },
  })
  // Report back so server tracks bentoLastSeenAt
  await reportBentoStatus({ status: 'INSTALLED', timestamp: new Date() })
}
```

## Uninstall (operator opts out)

`NodeUbiOptIn.status` flips to `OPTED_OUT` → server pushes `bento-uninstall` command → agent runs:

```sh
systemctl stop a2e-bento.service
systemctl disable a2e-bento.service
rm -rf /opt/a2e/bento /etc/systemd/system/a2e-bento.service
```

## Testing without real Bento

The simulator (`apps/api/src/services/ubi/simulator.ts`) lets you exercise the full flow without installing Bento on any real node. See `docs/UBI_TESTING_RUNBOOK.md`.

## Open M2 items still pending

- M2.1 Treasury / capital decision (broker can't deploy without ZKC stake)
- M2.2 Broker deployment on Render (without broker, the install script's BROKER_URL is null)
- M2.4 Auth between Bento and broker (currently the script trusts a bearer token in the config — need to confirm Bento supports this in v2.0.2 or use a different auth scheme)

Until M2.1 + M2.2 + M2.4 close, this install path is documented but not invoked. The simulator stands in.
