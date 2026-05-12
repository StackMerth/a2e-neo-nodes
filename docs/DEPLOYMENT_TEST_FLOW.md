# Testing Node Deployment & Admin Approval

The platform's node-deployment flow has two entry points and supports a
**test mode** that bypasses real SSH so you can exercise the entire flow
without an actual GPU server.

## The two flows

### Flow A: Node runner requests deployment (investor flow)

This is the path a real customer takes after buying a node investment.

1. Node runner pays for a node investment (USDC on Solana).
2. Investment lands in admin queue with status `PAID`.
3. Node runner provides their preferred deployment region/notes.
4. Investment moves to `DEPLOYMENT_REQUESTED`.
5. Admin reviews, fills in SSH details for a real data-center machine.
6. Admin clicks Deploy → status `DEPLOYING`.
7. Provisioner connects via SSH, installs Docker + NVIDIA + a2e-agent,
   configures systemd, starts the agent.
8. Agent registers with the API using its baked-in API key.
9. Investment moves to `PROVISIONED`. Node appears in the runner's portal.

### Flow B: Admin manually adds a node (operator flow)

This is the path an internal ops person takes to bring a new partner-supplied
GPU online without an investment.

1. Admin: **Nodes** page → **Add Node** button.
2. Fills in SSH host, port, username, GPU tier, region.
3. Clicks Provision.
4. Same provisioning steps as above.
5. Node appears immediately in the Nodes list.

## Test mode (no real SSH required)

Both flows have a **Test Mode** checkbox in the UI. When enabled:

- Provisioner skips the SSH connection entirely.
- Skips OS detection, Docker installation, NVIDIA driver checks.
- Skips the binary download and systemd unit setup.
- Simulates each of the 7 steps with a brief delay so the progress UI animates.
- Creates a real Node row in Postgres (status `ONLINE`, marked with agent version `test-mode-1.0.0`) attached to the same node runner as the source investment.
- Marks the ProvisionJob as COMPLETED.
- Flips the linked Investment to `PROVISIONED`.

Total wall time: ~3 seconds. This lets you exercise every UI surface without needing a real GPU server.

> **Note for older builds (pre-commit `9404f7b`):** Test Mode previously only skipped GPU verification but still tried to SSH to whatever host you typed, which would hang on connect indefinitely with a fake address. If you see a deploy stuck on `CONNECTING` for more than 30 seconds, your build is older than that commit. Update Render to the latest deploy.

## How to test the admin-approval side

This is what your seed already prepared for you. Walk through these:

### Step 1: View pending deployment requests

1. Sign in as admin: `https://a2e-admin.stackforgelab.tech`
2. Open **Investments** page (or **Deployments** depending on which menu item you find first).
3. The seed created investments in 5 states. Find the one with status `DEPLOYMENT_REQUESTED` (it has note: "Please provision in us-east region").

### Step 2: Approve and provision (test mode)

1. Click into the `DEPLOYMENT_REQUESTED` investment.
2. Click **Deploy Now** (or whatever the action button is on that page).
3. SSH details modal opens. Fill in:
   - **Host**: `1.2.3.4` (anything; ignored in test mode)
   - **Port**: `22`
   - **Username**: `root`
   - **GPU Tier**: `H100`
   - **Region**: `us-east-1`
   - **Test Mode**: **CHECK THIS BOX**
4. Click Deploy.
5. The page transitions to a live progress view showing the 7 provisioning steps:
   `CONNECTING → VERIFYING → DOWNLOADING → INSTALLING → CONFIGURING → STARTING → WAITING_REGISTRATION → COMPLETED`
6. In test mode, all 7 steps log "skipped (test mode)" and complete in ~2 seconds.
7. Investment status flips to `PROVISIONED`.
8. New Node row created and visible in the Nodes page.

### Step 3: Watch the existing failed deployment

The seed also creates one ProvisionJob in `FAILED` state (`seed-pjob-failed`). Open it from:

- Admin → Nodes → click "Provisioning History" tab (or Deployments page).
- See the FAILED entry with the simulated error log.
- Click "Retry" to attempt re-provisioning. In test mode it'll succeed second try.

## How to test the node-runner side

Sign in as `noderunner@tokenos.ai` / `NodeRunner2026`.

### Step 1: Check node runner's view of investments

1. Portal sidebar → **Investments** (if visible) or **Earnings** → **History**.
2. The seed gave this account 5 investments. You should see all of them with their states.

### Step 2: Request a new deployment

1. Sidebar → **Deploy** (or **Add Node**).
2. The page shows the install command for a real node, plus a "Request Deployment" button if you have an unprovisioned investment.
3. Click Request Deployment for any investment in `PAID` status. Add a deployment note.
4. Status flips to `DEPLOYMENT_REQUESTED`.
5. Cross-check on the admin side: the request now appears in the admin's deployment queue.

### Step 3: Onboarding wizard

1. Sidebar → **Onboarding** (only visible if no nodes attached, or visible from a "How to install" link).
2. Three-step wizard: Requirements → Install → Verify.
3. Step 2 shows the install curl command.
4. Step 3 polls for the agent to come online. Without a real machine, this'll time out at 90 seconds with the friendly failure copy.
5. To exercise the success path: have the admin run the test-mode provisioning above, which creates a node attached to this runner. Refresh the verify step on the runner side; it'll show success.

## Real (non-test-mode) deployment

When you have an actual SSH-reachable GPU server:

1. Same UI, but uncheck Test Mode.
2. Provisioner runs the full 7-step install over SSH.
3. Total time: ~2 to 5 minutes depending on network speed.
4. The agent installs to `/opt/a2e-agent`, runs as a systemd service, heartbeats every 30 seconds.
5. After installation, the agent registers itself with the API using its API key. It appears in the dashboard within 30 seconds.

Requirements for the target server:
- Ubuntu 22.04+ or Debian 12+ (RHEL also supported)
- NVIDIA driver installed (>= 535)
- SSH access as root or a user with passwordless sudo
- Outbound HTTPS to `tokenosdeai-api.onrender.com`
- At least 20GB free disk space
- 8GB+ RAM
- Docker will be auto-installed if missing

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Provisioning stuck on CONNECTING | SSH not reachable | Verify host/port from your machine: `ssh -p 22 root@host`. Check firewall. |
| Stuck on VERIFYING with "GPU not detected" | NVIDIA driver missing on target | `nvidia-smi` on the target should work first. |
| Stuck on DOWNLOADING | Target server can't reach API | Test from target: `curl https://tokenosdeai-api.onrender.com/health` |
| Stuck on STARTING | systemd failed | SSH in: `journalctl -u a2e-agent -n 50` |
| Stuck on WAITING_REGISTRATION | Agent started but can't authenticate | Check `/var/log/a2e-agent/agent.log` on target for API_KEY mismatch |
| Test mode not skipping SSH | Checkbox wasn't checked or request didn't include `testMode: true` | Confirm in browser DevTools Network tab; the POST body should include `testMode: true` |

## What test mode does NOT cover

Test mode skips real installation, but the provisioner still:

- Records a real ProvisionJob row in Postgres.
- Creates a real Node row with a real API key.
- Generates real heartbeat history (via the seed keep-alive loop, if running).
- Lets you exercise every admin and runner UI surface.

What it can't simulate:

- Actual job execution (no real GPU runs containers).
- Real container logs in the buyer's compute request page (the agent never receives jobs).
- Real network latency from the agent's heartbeats (timestamps are server-generated).

If you need full end-to-end including real workloads, you'll want a real GPU server. Cheapest test option: a Vast.ai rental ($0.50/hr for an RTX 3090) running Ubuntu, you SSH in and run the install command yourself.
