# Early Tester Onboarding — TokenOS_DeAI

You're one of the first people using TokenOS_DeAI in production. Thanks for trying it. This doc walks you through everything from sign-up to your first rental, terminate, and what to do when something breaks.

If you get stuck, the fastest path is to email **support@deaimarket.org** (or DM the admin who set you up). Please copy any error message verbatim.

---

## What TokenOS_DeAI is, in one breath

A GPU compute marketplace. You rent H100 / H200 / B200 (and others) by the hour, get SSH access in about a minute, run your workload, and terminate when you're done. You only pay for the time you actually used.

During this early window you'll be served by **Lambda Labs** behind the scenes (the platform provisions an instance for you and surfaces the SSH credentials). Once the BYOG operator network scales up, your rentals will also start matching internal nodes — the experience for you is identical either way.

---

## What you need before you start

- A modern browser (Chrome, Firefox, Brave, Safari).
- An SSH client. macOS / Linux: the built-in `ssh` works. Windows: PowerShell's `ssh` or PuTTY.
- An email address.
- A wallet address (optional — only needed if you want to top up your own balance with USDC instead of being pre-credited by the admin).

That's it. No card needed for the early-tester window — the admin will pre-credit your account directly.

---

## Step 1 — Create your account

1. Go to **https://user.tokenos.ai**.
2. Click **Sign up** (top-right) → enter your email + a password → submit.
3. Check your inbox for a verification email from `noreply@deaimarket.org`. Click the link.
4. You're now logged in to the buyer portal.

> If the verification email doesn't arrive within 2 minutes, check spam. Still nothing → email support@deaimarket.org with your account email.

---

## Step 2 — The admin credits your balance

This part happens on the admin side, not yours. The admin (whoever set you up) will:

- Open the admin dashboard
- Find your user
- Credit your balance with an agreed amount (e.g. $300 to cover ~10-15 hours of single H100 time at retail)

You'll see a notification land — both as a top-center toast in the portal AND as an email receipt — saying:

> **+$300.00 admin credit** — balance now $300.00.

Your **Balance** page (top-right wallet icon) reflects the credit immediately. You're ready to rent.

---

## Step 3 — Submit a rental request

1. Click **Rent compute** (or navigate to `/buyer/request`).
2. **GPU tier**: pick what you need (e.g. `H100` for single, `B200` for top-tier inference)
3. **GPU count**: how many GPUs in the rental. Single is fine for most jobs; multi-GPU clusters work too.
4. **Duration**: how many days the rental should run. Pricing is hourly under the hood; you can terminate early for a prorated refund. For bursty workloads, set a generous duration (you only pay for actual hours used).
5. **Workload type**: pick `INFERENCE`, `TRAINING`, or `MIXED`. Consumer-tier GPUs (RTX 4090/3090) only serve `INFERENCE`; data-center tier accepts all three.
6. **Payment method**: pick **Balance**. (Wallet and Card are also available, but Balance is fastest since the admin pre-credited you.)
7. Click **Submit request**.

Your request moves to **PENDING** state. The auto-allocator runs every 10 seconds and finds you a node.

---

## Step 4 — Watch the provisioning

Depending on whether the allocator finds an internal node or falls through to Lambda Labs, you'll see one of these states on your request detail page:

### Lambda Labs provisioning (current default while internal supply is small)
- Status flips to **PROVISIONING_EXTERNAL**
- A cyan card appears: **"Provisioning on Lambda Labs"** with a spinner
- The page auto-refreshes every 5 seconds while it polls
- Within ~60 seconds, Lambda finishes booting and the page swaps to the SSH credentials card

### Internal node (when operator inventory matches your request)
- Status flips straight to **ACTIVE**
- SSH credentials appear immediately (host, port, username, password)

Both flows surface the same per-minute meter on the request detail page so you can watch the running cost tick up live.

---

## Step 5 — Connect via SSH

### Lambda Labs rentals (key-based auth)

The portal shows you a card titled **"SSH Access (Lambda Labs)"**. It contains:
- The instance type and region
- Host (IPv4 address)
- Port (22)
- Username (`ubuntu`)
- A blurred-by-default **Private key (PKCS#8 PEM)** block

Two ways to use the key:

1. **Easiest — download the .pem file.** Click **Download .pem**. Saves to your Downloads folder as something like `tokenos-rental-cmh4xyz123.pem`. Then in your terminal:
   ```
   chmod 600 ~/Downloads/tokenos-rental-cmh4xyz123.pem
   ssh -i ~/Downloads/tokenos-rental-cmh4xyz123.pem ubuntu@<host-from-portal> -p 22
   ```

2. **Copy and paste.** Click **Show** to reveal the key, click the copy button, paste it into a new file named `tokenos-key.pem`, then `chmod 600 tokenos-key.pem` and SSH the same way.

The portal also shows a pre-baked ssh command at the bottom of the card — copy that and paste, just replace the `.pem` path with where you saved it.

**The private key is only shown while the rental is live.** Save it somewhere safe; if you lose it, you'll need to terminate and start a new rental.

### Internal-node rentals (password auth)

The portal shows host / port / username / password. Use:
```
ssh ubuntu@<host-from-portal> -p <port>
```
Paste the password when prompted.

---

## Step 6 — Run your workload

Once SSH'd in, you have full root-equivalent access (passwordless `sudo`). CUDA + nvidia-smi are pre-installed; Python 3 is there; you can `pip install` anything.

For your specific use case (experiments with `~2-4h/day, on-demand`), the typical pattern is:

1. SSH in
2. `nvidia-smi` to confirm the GPUs are visible
3. Run your experiment (training run, inference batch, whatever)
4. Save outputs to S3 / GitHub / your laptop (whatever's easiest — anything that leaves the box)
5. Terminate (next step)

> Anything you save inside the instance is destroyed when the rental ends. Push results to persistent storage before terminating.

---

## Step 7 — Terminate when you're done

This is the most important step for your wallet. **Always terminate.** Otherwise the meter keeps running until the full requested duration completes.

On the request detail page, click the **Terminate Rental** button at the bottom (it's the full-width red button when the rental is `ACTIVE`).

What happens:
- Meter stops within ~5 seconds
- Refund of unused-minute equivalent goes back to your **Balance** (visible on the Balance page immediately)
- The Lambda instance (or internal node) is released within ~60 seconds
- SSH access stops working
- You get a notification + email confirmation

---

## How billing actually works

- **Per-minute meter.** Your `accruedCost` ticks up every 60 seconds while the rental is `ACTIVE`. Watch it live on the request detail page.
- **You only pay for ACTIVE time.** PROVISIONING (Lambda boot) doesn't count. Terminating immediately = nearly $0.
- **Pre-paid model.** When you submit the request, the FULL `totalCost` (rate × duration × GPU count) is reserved from your balance. On terminate, the unused portion refunds.
- **Solana refunds go to your wallet if you've linked one; otherwise they credit back to your platform balance.**

Example: you request 8x H100 for 1 day at $24/hr → $576 reserved. You run for 3 hours then terminate → $72 charged, $504 refunded. Reflects in the balance within seconds.

---

## When things go wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| "Topup destination not configured" warning | Platform-side config (rare) | Email support — they'll know |
| Rental stuck in PROVISIONING_EXTERNAL > 5 min | Lambda capacity tight or instance unhealthy | Refresh the page. If still stuck, terminate (the system will auto-refund), submit a new request |
| SSH "Permission denied (publickey)" | Wrong key file or wrong permissions on the .pem | Run `chmod 600 <your-pem>` first. Make sure you're using `-i <pem>` not `-i <some-other-file>` |
| SSH connection refused | Instance is still booting (rare race) | Wait 30s and retry |
| Meter charged more than expected | You forgot to terminate | Painful but always recoverable for partial periods — terminate now to stop the bleeding; email support if numbers look very wrong |
| "Insufficient balance" | Balance ran out mid-experiment | Email admin for a top-up, or top up yourself via Solana USDC on the Balance page |

If the portal is completely unreachable, that's a platform-wide issue — email support immediately and we'll status-page it.

---

## Limits during early access

- **One concurrent rental** by default (raise on request)
- **$10,000/day spend cap** (raise on request)
- **Available regions** depend on Lambda's current capacity — usually `us-east-3`, `us-south-1`, `us-west-1`
- **Available GPU types right now**: H100 (SXM5), H200, B200. L40S and consumer tiers when internal operators come online (none yet)

---

## Privacy + security notes

- The SSH private key for each Lambda rental is generated fresh per-rental. Old keys are deleted from Lambda when the rental ends.
- We log: who rented what, when, for how long, total cost. We do NOT log: anything inside your SSH session, your code, your data, your model weights.
- Your platform balance, payment methods, and rental history are private to your account.
- Don't share your SSH key file — anyone with it can access your instance until terminated.

---

## What to send back to the admin

After your first session, please reply with:
1. What worked
2. What confused you (UX, copy, error messages)
3. Anything that broke

Even minor friction is useful — you're literally the first real human running this end-to-end. Brutal feedback is appreciated.

Thank you for testing.
