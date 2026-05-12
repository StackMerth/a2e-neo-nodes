# TokenOS DeAI Operator Guide

How to run a GPU node on the TokenOS DeAI network: install the agent, get paid,
build reputation, and invite other operators.

---

## 1. What you need before you start

- A machine with at least one NVIDIA GPU (H100, H200, B200, B300, or
  GB300; "OTHER" tier is allowed for custom hardware but pricing is
  manual)
- Ubuntu 22.04 or later
- Docker installed and the `nvidia-container-toolkit`
- A public IP or a stable inbound tunnel (Cloudflare Tunnel works)
- A Solana wallet for payouts (any address; you'll paste it during
  setup)
- An email address for your portal account

## 2. Sign up

1. Go to <https://a2e-user.stackforgelab.tech/signup>
2. Pick **Node Runner**
3. Enter email + password (8+ chars)
4. If someone invited you with a referral link, the page shows
   "Invited by CODE" before you submit; the attribution applies
   automatically when you click Create
5. You land on the portal dashboard with role NODE_RUNNER

## 3. Link your payout wallet

1. Open **Settings** in the sidebar
2. The "Link a Solana wallet" card is visible if your wallet is unset
3. Paste your Solana address (base58, 32-44 chars), click Save
4. Toast confirms: "Wallet linked. Refresh to see it on your profile."
5. Settlements, refunds, and referral commission flow to this address

You never share your private key. Only the public address.

## 4. Install the node-agent

(Coming with the BYOG installer — Project 1. Until then operators
provision through the dashboard's manual flow.)

The intent is one-line:

```bash
curl -sSL https://a2e-user.stackforgelab.tech/install.sh | bash
```

This will:

1. Detect your GPU(s) and CPU
2. Pull the latest agent Docker image
3. Register the node against your operator account via API key
4. Start the heartbeat loop

Status of your nodes appears in **Dashboard → Nodes** within seconds.

## 5. How you get paid

### Pricing tiers

- **On-Demand:** full retail rate (see /stats for the live rate sheet)
- **Spot:** 40% off retail, your node may be preempted with 90 seconds
  notice when ON_DEMAND demand spikes
- **Reserved:** buyer commits 7/30/90 days, you get steady utilization

Whether your node is offered as Spot is your choice
(`NodeRunner.availableAsSpot` toggle on your profile).

### Cadence

- **Per-minute meter** tracks every active rental
- **Daily settlement** rolls up your earnings and writes a payout row
- **Threshold-based payout** triggers automatically once your balance
  exceeds `payoutThreshold` (default $10)
- **Solana transfer** lands within 11 seconds median once initiated

### Where to see it

- **Dashboard → Earnings** — daily totals, by market, by node
- **Dashboard → Payouts** — payout history with tx hashes
- **Dashboard → Withdrawals** — early withdrawal requests if you want
  cash before the next threshold trigger

## 6. Reputation

Public score, public formula:

- 60% — uptime over the last 30 days
- 25% — average buyer rating (last 30d, APPROVED only)
- 15% — completed-job count (log-scaled)

Tiers: **Platinum** ≥ 90, **Gold** ≥ 80, **Silver** ≥ 60, **Bronze** below.

Buyers see your score on the marketplace leaderboard
(<https://marketplace.stackforgelab.tech/leaderboard>) and your vanity
profile at `/operator/<your-slug>`. Recompute happens daily via the
worker. No paid promotion, no manual override.

To improve your score:

1. **Uptime** — keep heartbeats fresh, fix DEGRADED transitions fast
2. **Ratings** — be responsive when a buyer's rental has issues; the
   moderation queue rejects spam ratings, real feedback counts
3. **Volume** — complete jobs end-to-end; chargebacks reset the
   counter for that rental

## 7. Referrals

Every operator gets an 8-character invite code, auto-generated on first
visit to **Sidebar → Referrals**.

- Your share URL is `https://marketplace.stackforgelab.tech/?ref=<CODE>`
- When someone signs up as a Node Runner through your link, they're
  attributed for 365 days
- You earn **10% of their network earnings** during that window
- Commission accrues daily, paid out via the same settlement engine

Buyer signups are NOT in the program (referral commission is for
growing the supply side).

### Anti-abuse

- **IP sock-puppet detection:** signups from the same IP as the
  referrer are flagged automatically; the Referral row lands as
  REVOKED and no commission accrues. Admin can manually un-revoke if
  the match is legitimate (same household).
- **Lifetime cap:** $5,000 per referrer total during the post-launch
  guard period. Real network-builders aren't affected; this just
  bounds damage from sock-puppet rings that slip through the IP
  check.

### Where to see it

- **Sidebar → Referrals** — your code, share URL, list of referees,
  lifetime commission accrued
- **Public:** <https://marketplace.stackforgelab.tech/leaderboard?tab=referrers>
  — top referrers across the whole network

## 8. Notifications

In **Settings → Notification Preferences** you can toggle:

- Node offline
- Payout sent
- Job completed
- Job failed
- Investment confirmed

The bell icon top-right surfaces unread events in real time.

## 9. Listing strategies

- **Run 24/7:** uptime dominates the score; intermittent operators
  rank low even with great ratings
- **Geographic placement matters:** buyers can filter on region; if
  you're in an under-served region your nodes get picked more often
- **Spot opt-in if you're price-competitive:** 40% off retail means
  more frequent allocations, especially during ON_DEMAND spikes
- **Match buyer expectations:** if your `gpuTier=H100` but you're
  actually running an A100, declare it as `OTHER` with a custom rate.
  Misrepresentation tanks ratings fast.

## 10. Getting help

- **Portal chat widget** (bottom-right) — once enabled, real-time
  support
- **Email:** see the marketplace footer for the support address
- **Issues with code:** GitHub issues on
  <https://github.com/StackMerth/a2e-neo-nodes>
