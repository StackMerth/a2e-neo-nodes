# Solana Live Mode Setup

Switch settlements from simulated tx hashes (`PAYMENT_MODE=dev`) to real Solana
USDC transfers (`PAYMENT_MODE=live`). This is the free Phase 1 completion item
included with any Phase 2 bundle. Total time: ~30 minutes once you have the
funds ready.

## What live mode does

When `PAYMENT_MODE=live`, the settlement engine:

- Reads `payerPrivateKey` from `SettlementConfig` (Postgres) or env.
- Constructs a real SPL Token transfer of USDC from the payer wallet to each
  node runner's wallet address.
- Submits to Solana mainnet via `SOLANA_RPC_URL`.
- Waits for confirmation (1 block by default), records the real tx hash on the
  Settlement row.
- The reconciler worker double-checks the tx on-chain over the next 5 to 60
  minutes and flips `txConfirmed=true` once finalised.

In `PAYMENT_MODE=dev` (current state) all of this still runs but the tx hash is
a `DEV_*` placeholder and no actual transfer happens.

## What you need before flipping the switch

| Item | Detail |
|---|---|
| **Solana payer wallet** | A keypair with USDC + SOL balance |
| **USDC balance** | Enough to cover expected weekly settlement totals. Recommend starting with $100 to $500 for testing. |
| **SOL balance** | ~0.1 SOL ($10 to $20) for transaction fees. Each settlement tx costs ~0.000005 SOL plus rent for new ATAs. |
| **RPC endpoint** | The default `https://api.mainnet-beta.solana.com` works but is rate-limited. For production traffic, get a Helius / QuickNode / Alchemy endpoint (free tier works for low volume). |

## Step-by-step

### 1. Generate a payer wallet

If you already have a Phantom wallet you want to use, **skip to step 2 and export the private key**.

If you want a fresh keypair generated programmatically, on your local machine with Node installed:

```powershell
node -e "const k = require('@solana/web3.js').Keypair.generate(); console.log('Public:', k.publicKey.toBase58()); console.log('Private (base58):', require('bs58').default.encode(Buffer.from(k.secretKey)));"
```

You'll get output like:

```
Public:  9X8...Bj2  (this is the wallet address you'll fund)
Private: 5KJ...zZx  (THIS IS THE SECRET, treat like a password)
```

**Save the private key in a password manager immediately.** Anyone with this key controls all settlement funds.

### 2. Export from Phantom (if using existing wallet)

Phantom → Settings → Manage Accounts → click your account → Export Private Key.
You'll get a base58 string. Same security warning applies.

### 3. Fund the wallet

Send the wallet:

- **USDC** (mainnet, mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`). Bridge from any exchange or transfer from another wallet.
- **SOL** (~0.1 SOL initially). Same source.

Confirm both balances on https://solscan.io by pasting the public key.

### 4. Set Render env vars

Render dashboard → **a2e-api** → **Environment**. Add or update:

| Key | Value |
|---|---|
| `PAYMENT_MODE` | `live` |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` (or your Helius/QuickNode URL) |

The payer private key is NOT set as an env var. It goes into the `SettlementConfig` row in Postgres so it can be rotated without redeploying. Set it via the admin dashboard:

- Open `https://a2e-admin.stackforgelab.tech/settings`
- Find the **Settlement Config** section
- Paste the **base58** (Phantom format) or **JSON array** private key into the `Payer Private Key` field
- Save

The API supports three formats automatically: JSON array (`[1,2,3,...]`), base58 (Phantom export), and base64.

### 5. Confirm

Click **Save Changes** on Render's environment page. Render redeploys (~30 seconds, build cached).

Visit `https://tokenosdeai-api.onrender.com/health/detailed` (admin auth required) to confirm `payment.mode === 'live'`.

### 6. Test with a small payout

In the admin dashboard:

1. Settlements page → find a PENDING settlement (or trigger a manual run on a small node).
2. Process → server attempts a real transfer.
3. Within 5 seconds: settlement row updates with a real Solana tx hash.
4. Visit https://solscan.io/tx/{hash} to verify on-chain.
5. Within 5 to 60 minutes: reconciler flips `txConfirmed=true`.

## Recommended starter funding

For the smoke-test phase:

- **$100 USDC** on the payer wallet (covers ~10 typical small settlements).
- **0.1 SOL** for fees (covers ~20,000 transactions worth of fees, plenty).

For a real launch with the seeded test data plus a few real node runners:

- **$1,000 to $5,000 USDC** (depending on weekly settlement size; admin dashboard's Settlements page projects upcoming amounts).
- **0.5 SOL** for fees and ATA rent.

## Switching back to dev mode

Just flip `PAYMENT_MODE` to `dev` on Render and redeploy. Subsequent settlements will use simulated tx hashes again. Existing live settlements remain on-chain and reconciled regardless.

## Security checklist

- [ ] Private key is in a password manager (Bitwarden, 1Password, etc.), not in plain text.
- [ ] Render's `SettlementConfig.payerPrivateKey` value is set via the admin dashboard, not via Render env (env vars are visible to anyone with Render access; DB rows have stricter scoping).
- [ ] Use a **dedicated** Solana wallet for settlement, not a personal/treasury wallet. Limits the blast radius if compromised.
- [ ] Set up balance alerts. The payer wallet running out of USDC mid-settlement leaves payouts in retry-loop limbo.
- [ ] M1 will move the private key out of plain DB storage entirely (KMS or env-encrypted). Until then, treat the DB column as a soft secret.

## What can go wrong

| Symptom | Cause | Fix |
|---|---|---|
| Settlement stuck in PROCESSING for >5 min | Insufficient SOL for fees, or RPC timing out | Check payer SOL balance; switch to a paid RPC endpoint |
| `Insufficient USDC` error | Payer USDC balance < settlement amount | Top up the payer |
| `Failed to create ATA` | Recipient wallet has no USDC ATA and payer doesn't have SOL for rent (~0.002 SOL per new recipient) | Top up SOL |
| `Invalid private key format` | Format mismatch | Check private key is one of: JSON array `[1,2,...]`, base58, or base64. Phantom exports as base58. |
| All settlements suddenly fail | RPC endpoint outage or rate limit | Switch `SOLANA_RPC_URL` to a paid provider (Helius/QuickNode free tier) |

## Reconciler behavior

After live mode is on, the reconciler ([apps/api/src/services/reconciliation/reconciler.ts](apps/api/src/services/reconciliation/reconciler.ts)) tracks every submitted tx:

- Polls every 5 minutes (configurable via `reconciliation-scheduler`).
- Per tx: 5 attempts with backoff `[1, 5, 15, 60, 240]` minutes.
- On success: marks Payment CONFIRMED + Settlement COMPLETED.
- On failure or not-found after max attempts: marks the row for manual review.

You can monitor reconciliation queue depth in the admin dashboard's System page.
