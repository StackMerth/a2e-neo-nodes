# M4 Implementation Report: Financial System & Settlement Engine

**Milestone:** M4 (Module B)
**Investment:** $1,600
**Status:** COMPLETE
**Date:** March 26, 2026

---

## Executive Summary

M4 delivers a complete financial system for the A²E Engine, providing comprehensive earnings tracking, cost management, settlement processing, and payment infrastructure. The system includes a dev mode for testing payments without transferring real funds, CSV/PDF report generation, and a full financial dashboard.

### Key Deliverables

| Feature | Status | Description |
|---------|--------|-------------|
| Earnings Tracking | ✅ | Per-job earnings with market breakdown |
| Earnings API | ✅ | 6 endpoints for earnings queries and analytics |
| Cost Tracking | ✅ | Infrastructure cost recording and categorization |
| Cost API | ✅ | Cost summary and breakdown endpoints |
| Settlement Engine | ✅ | Automatic calculation and creation of settlements |
| Settlement API | ✅ | Full CRUD + trigger + manual completion |
| Payment System | ✅ | Dev mode simulation + live mode infrastructure |
| Payment API | ✅ | 7 endpoints including batch processing |
| CSV Export | ✅ | Earnings, settlements, jobs, nodes exports |
| PDF/HTML Reports | ✅ | Statement and invoice generation |
| Financial Dashboard | ✅ | Revenue, costs, settlements, exports UI |

---

## Architecture Overview

### Tech Stack

- **Backend:** Fastify + TypeScript
- **Database:** PostgreSQL + Prisma
- **Queue:** BullMQ + Redis (for background jobs)
- **Payment:** Solana Web3 (infrastructure ready)
- **Reports:** CSV generator + HTML templates

### File Structure

```
apps/api/src/
├── routes/
│   ├── earnings.ts         # Earnings endpoints
│   ├── costs.ts            # Cost tracking endpoints
│   ├── settlements.ts      # Settlement management
│   ├── payments.ts         # Payment processing (NEW)
│   └── reports.ts          # CSV/PDF export endpoints
├── services/
│   ├── earnings/
│   │   └── calculator.ts   # Earnings aggregation logic
│   ├── settlement/
│   │   └── engine.ts       # Settlement calculation
│   ├── payment/
│   │   └── solana.ts       # Solana payment service (NEW)
│   └── reports/
│       ├── csv-generator.ts    # CSV generation
│       └── pdf-generator.ts    # HTML/PDF templates
└── jobs/
    └── (settlement-processor.ts planned)

packages/database/prisma/
└── schema.prisma           # +Payment model, +PaymentStatus enum

apps/dashboard/src/app/
└── financial/page.tsx      # Financial overview dashboard
```

### Database Schema (New/Updated)

```prisma
// NEW: Payment tracking
model Payment {
  id               String        @id @default(cuid())
  settlementId     String
  amount           Float
  currency         String        @default("USDC")
  recipientAddress String
  status           PaymentStatus @default(PENDING)
  txHash           String?
  txConfirmed      Boolean       @default(false)
  confirmations    Int           @default(0)
  isDevMode        Boolean       @default(false)
  errorMessage     String?
  retryCount       Int           @default(0)
  maxRetries       Int           @default(3)
  createdAt        DateTime      @default(now())
  processedAt      DateTime?
  confirmedAt      DateTime?
}

enum PaymentStatus {
  PENDING
  PROCESSING
  SENT
  CONFIRMED
  FAILED
}

// Existing (from M3)
model Settlement { ... }
model Earning { ... }
model InfrastructureCost { ... }
```

---

## API Endpoints Reference

### Earnings Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/earnings` | GET | List earnings with filters |
| `/v1/earnings/summary` | GET | Aggregated earnings summary |
| `/v1/earnings/by-node/:nodeId` | GET | Node-specific earnings |
| `/v1/earnings/by-market` | GET | Earnings breakdown by market |
| `/v1/earnings/by-tier` | GET | Earnings breakdown by GPU tier |
| `/v1/earnings/trends` | GET | Time-series earnings data |

### Cost Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/costs` | GET | List infrastructure costs |
| `/v1/costs` | POST | Record new cost |
| `/v1/costs/summary` | GET | Cost summary by category |

### Settlement Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/settlements` | GET | List settlements |
| `/v1/settlements/:id` | GET | Settlement details |
| `/v1/settlements/trigger` | POST | Calculate and create settlements |
| `/v1/settlements/pending` | GET | Pending settlement calculations |
| `/v1/settlements/config` | GET | Settlement configuration |
| `/v1/settlements/config` | PATCH | Update settlement config |
| `/v1/settlements/:id/process` | POST | Mark for processing |
| `/v1/settlements/:id/complete` | POST | Manual completion with txHash |
| `/v1/settlements/:id/fail` | POST | Mark as failed |

### Payment Endpoints (NEW)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/payments/mode` | GET | Get current payment mode (dev/live) |
| `/v1/payments` | GET | List all payments |
| `/v1/payments/:id` | GET | Payment details |
| `/v1/payments/stats` | GET | Payment statistics |
| `/v1/payments/process/:settlementId` | POST | Process settlement payment |
| `/v1/payments/verify/:txHash` | POST | Verify on-chain transaction |
| `/v1/payments/batch` | POST | Process multiple settlements |

### Report Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/reports/earnings/csv` | GET | Export earnings as CSV |
| `/v1/reports/settlements/csv` | GET | Export settlements as CSV |
| `/v1/reports/jobs/csv` | GET | Export jobs as CSV |
| `/v1/reports/nodes/csv` | GET | Export nodes as CSV |
| `/v1/reports/statement/:nodeId` | GET | Generate earnings statement HTML |
| `/v1/reports/summary` | GET | Financial summary report |

---

## Feature Details

### 1. Earnings Tracking

**Service:** `services/earnings/calculator.ts`

The earnings system tracks revenue from completed jobs:

- **Per-Job Earnings:** Calculated from job duration × rate
- **Daily Aggregation:** Grouped by node, date, and market
- **Market Breakdown:** Separate tracking for INTERNAL, AKASH, IONET

**Earnings Data Model:**
```typescript
interface Earning {
  nodeId: string
  date: Date           // Day of earnings
  market: Market       // INTERNAL | AKASH | IONET
  gpuSeconds: number   // Total compute time
  earnings: number     // USD amount
  jobCount: number     // Jobs completed
}
```

### 2. Cost Tracking

**Route:** `routes/costs.ts`

Infrastructure costs are tracked by category:

| Category | Description |
|----------|-------------|
| HOSTING | Data center / cloud hosting fees |
| POWER | Electricity costs |
| NETWORK | Bandwidth and connectivity |
| OTHER | Miscellaneous expenses |

**Cost Data Model:**
```typescript
interface InfrastructureCost {
  nodeId?: string      // Optional node association
  category: string     // Cost category
  amount: number       // USD amount
  periodStart: Date    // Billing period start
  periodEnd: Date      // Billing period end
  description?: string // Optional notes
}
```

### 3. Settlement Engine

**Service:** `services/settlement/engine.ts`

Automatic settlement calculation:

1. **Calculate Pending:** Scans earnings not yet settled
2. **Apply Minimum:** Enforces minimum payout threshold
3. **Create Settlement:** Records settlement with job details
4. **Track Status:** PENDING → PROCESSING → COMPLETED/FAILED

**Settlement Configuration:**
```typescript
interface SettlementConfig {
  period: 'DAILY' | 'WEEKLY' | 'MONTHLY'
  minimumPayout: number    // Default: $10
  dayOfWeek?: number       // For weekly (0-6)
  dayOfMonth?: number      // For monthly (1-28)
  solanaRpcUrl?: string    // Solana RPC endpoint
  usdcMint?: string        // USDC token address
}
```

### 4. Payment System

**Service:** `services/payment/solana.ts`

The payment system supports two modes:

#### Dev Mode (Default)

- **Enabled when:** `PAYMENT_MODE` is not `live` OR Solana config missing
- **Behavior:** Simulates successful payments
- **Transaction Hash:** Generated with `DEV_` prefix
- **Auto-Confirm:** Payments instantly marked as CONFIRMED

```json
{
  "success": true,
  "txHash": "DEV_5ODbMTiQPF1WHBHeJ90zJkrtYgvcryY0KJFgS4Di2QA3ZfTfqbDdzIBN6UVFh9YUfwjq6IN2W9WxtQ4w",
  "isDevMode": true,
  "status": "CONFIRMED",
  "message": "DEV MODE: Payment simulated successfully - no real funds transferred"
}
```

#### Live Mode (Future)

- **Enabled when:** `PAYMENT_MODE=live` AND Solana config present
- **Requires:** `solanaRpcUrl`, `payerPrivateKey`, `usdcMint`
- **Integration:** Uses `@solana/web3.js` (infrastructure ready)

### 5. CSV Export

**Service:** `services/reports/csv-generator.ts`

Exports available:

| Report | Columns |
|--------|---------|
| Earnings | Date, Node ID, Wallet, GPU Tier, Market, Earnings, GPU Hours, Jobs |
| Settlements | ID, Node, Wallet, Amount, Status, TX Hash, Period, Created |
| Jobs | ID, Deployment, Node, GPU, Market, Status, Rate, Duration, Earnings |
| Nodes | ID, Wallet, GPU, Type, Status, Region, Total Earnings, Total Jobs |

### 6. HTML/PDF Reports

**Service:** `services/reports/pdf-generator.ts`

**Earnings Statement:**
- Node and wallet information
- Period summary (earnings, jobs, GPU hours)
- Settlement history table
- Daily earnings breakdown
- Professional formatting with TokenOS branding

**Invoice Template:**
- Invoice number and customer details
- Line items with GPU tier, hours, rates
- Subtotal, tax, total
- Payment terms and methods

### 7. Financial Dashboard

**Page:** `apps/dashboard/src/app/financial/page.tsx`

**Key Metrics:**
- Total Revenue
- Total Costs
- Gross Profit
- Profit Margin

**Revenue Breakdown:**
- By market (Internal, Akash, IO.net)
- Progress bars showing distribution
- GPU hours and job counts

**Cost Breakdown:**
- By category (Hosting, Power, Network, Other)
- Progress bars showing distribution

**Settlements:**
- Pending settlements with amounts
- "Trigger All" button for batch settlement
- Recent settlement history table
- Status badges (Pending, Processing, Completed, Failed)

**Export Section:**
- Export Earnings CSV
- Export Settlements CSV
- Export Jobs CSV

---

## Testing Guide

### Prerequisites

1. **API Server Running:**
   ```bash
   # On server (LXC 119)
   pm2 status a2e-api
   # Should show "online"
   ```

2. **Dashboard Running:**
   ```bash
   # Production
   https://a2e.byredstone.com

   # Local development
   cd /Users/redstone/Projects/A2E/apps/dashboard
   pnpm dev
   ```

### Test Scenarios

#### Test 1: Payment Mode Verification

```bash
# Check current payment mode
curl -s "https://a2e.byredstone.com/v1/payments/mode" \
  -H "X-API-Key: a2e-dev-key-2026" | jq .
```

**Expected Response:**
```json
{
  "mode": "dev",
  "description": "Development mode - payments are simulated, no real funds transferred",
  "devMode": true,
  "rpcConfigured": false,
  "payerConfigured": false
}
```

#### Test 2: Register Node and Create Settlement

```bash
# Step 1: Register a node with valid Solana address
curl -s -X POST "https://a2e.byredstone.com/v1/nodes" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: a2e-dev-key-2026" \
  -d '{
    "walletAddress": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    "gpuTier": "H100",
    "nodeType": "BYOG"
  }' | jq .

# Note the node ID from response
```

#### Test 3: Process Payment (Dev Mode)

```bash
# Process a pending settlement
curl -s -X POST "https://a2e.byredstone.com/v1/payments/process/{settlementId}" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: a2e-dev-key-2026" \
  -d '{"currency": "USDC"}' | jq .
```

**Expected Response:**
```json
{
  "success": true,
  "paymentId": "cmn6fv2mq000l10tyuqthmh9d",
  "settlementId": "test-settlement-1",
  "txHash": "DEV_5ODbMTiQPF...",
  "amount": 125.5,
  "currency": "USDC",
  "recipientAddress": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  "isDevMode": true,
  "status": "CONFIRMED",
  "message": "DEV MODE: Payment simulated successfully - no real funds transferred"
}
```

#### Test 4: Payment Statistics

```bash
curl -s "https://a2e.byredstone.com/v1/payments/stats" \
  -H "X-API-Key: a2e-dev-key-2026" | jq .
```

**Expected Response:**
```json
{
  "currentMode": "dev",
  "modeDescription": "Development mode - payments are simulated, no real funds transferred",
  "stats": {
    "total": 1,
    "confirmed": 1,
    "failed": 0,
    "devModePayments": 1,
    "totalAmountPaid": 125.5
  }
}
```

#### Test 5: Batch Payment Processing

```bash
curl -s -X POST "https://a2e.byredstone.com/v1/payments/batch" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: a2e-dev-key-2026" \
  -d '{
    "settlementIds": ["settlement-1", "settlement-2"],
    "currency": "USDC"
  }' | jq .
```

**Expected Response:**
```json
{
  "processed": 2,
  "successful": 2,
  "failed": 0,
  "isDevMode": true,
  "message": "DEV MODE: Payments simulated - no real funds transferred",
  "results": [
    { "settlementId": "settlement-1", "success": true, "txHash": "DEV_..." },
    { "settlementId": "settlement-2", "success": true, "txHash": "DEV_..." }
  ]
}
```

#### Test 6: Earnings API

```bash
# Get earnings summary
curl -s "https://a2e.byredstone.com/v1/earnings/summary?days=30" \
  -H "X-API-Key: a2e-dev-key-2026" | jq .

# Get earnings by market
curl -s "https://a2e.byredstone.com/v1/earnings/by-market?days=30" \
  -H "X-API-Key: a2e-dev-key-2026" | jq .

# Get earnings trends
curl -s "https://a2e.byredstone.com/v1/earnings/trends?days=30&groupBy=day" \
  -H "X-API-Key: a2e-dev-key-2026" | jq .
```

#### Test 7: Settlements API

```bash
# List settlements
curl -s "https://a2e.byredstone.com/v1/settlements?limit=10" \
  -H "X-API-Key: a2e-dev-key-2026" | jq .

# Get pending settlements (calculated but not created)
curl -s "https://a2e.byredstone.com/v1/settlements/pending" \
  -H "X-API-Key: a2e-dev-key-2026" | jq .

# Trigger settlement creation
curl -s -X POST "https://a2e.byredstone.com/v1/settlements/trigger" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: a2e-dev-key-2026" \
  -d '{}' | jq .

# Get settlement config
curl -s "https://a2e.byredstone.com/v1/settlements/config" \
  -H "X-API-Key: a2e-dev-key-2026" | jq .
```

#### Test 8: Cost Tracking

```bash
# Record a cost
curl -s -X POST "https://a2e.byredstone.com/v1/costs" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: a2e-dev-key-2026" \
  -d '{
    "category": "HOSTING",
    "amount": 500,
    "description": "Monthly server costs",
    "periodStart": "2026-03-01",
    "periodEnd": "2026-03-31"
  }' | jq .

# Get cost summary
curl -s "https://a2e.byredstone.com/v1/costs/summary?days=30" \
  -H "X-API-Key: a2e-dev-key-2026" | jq .
```

#### Test 9: Report Generation

```bash
# Download earnings CSV
curl -s "https://a2e.byredstone.com/v1/reports/earnings/csv" \
  -H "X-API-Key: a2e-dev-key-2026" \
  -o earnings.csv

# Download settlements CSV
curl -s "https://a2e.byredstone.com/v1/reports/settlements/csv" \
  -H "X-API-Key: a2e-dev-key-2026" \
  -o settlements.csv

# Get financial summary
curl -s "https://a2e.byredstone.com/v1/reports/summary?days=30" \
  -H "X-API-Key: a2e-dev-key-2026" | jq .

# Generate node statement (HTML)
curl -s "https://a2e.byredstone.com/v1/reports/statement/{nodeId}?days=30" \
  -H "X-API-Key: a2e-dev-key-2026" \
  -o statement.html
```

#### Test 10: Financial Dashboard

1. **Navigate to Financial Page**
   - Go to `https://a2e.byredstone.com/financial`
   - Should see key metrics grid

2. **Change Time Period**
   - Select "7 days", "30 days", or "90 days"
   - All data should refresh

3. **Revenue by Market**
   - Should show breakdown with progress bars
   - Colors: Green (Internal), Blue (Akash), Purple (IO.net)

4. **Costs by Category**
   - Should show breakdown with progress bars
   - Colors by category type

5. **Pending Settlements**
   - Should show pending amount
   - Click "Trigger All" to create settlements

6. **Settlement History**
   - Should show recent settlements table
   - Status badges with colors

7. **Export Reports**
   - Click each export button
   - Should download CSV files

#### Test 11: Transaction Verification

```bash
# Verify a dev mode transaction (always succeeds)
curl -s -X POST "https://a2e.byredstone.com/v1/payments/verify/DEV_abc123" \
  -H "X-API-Key: a2e-dev-key-2026" | jq .
```

**Expected Response:**
```json
{
  "txHash": "DEV_abc123",
  "verified": true,
  "confirmations": 32,
  "isDevMode": true,
  "error": null,
  "paymentId": null
}
```

---

## Payment System Architecture

### Payment Flow Diagram

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Settlement │────▶│   Payment    │────▶│   Solana    │
│   PENDING   │     │  PROCESSING  │     │  (Dev/Live) │
└─────────────┘     └──────────────┘     └─────────────┘
                           │                    │
                           ▼                    ▼
                    ┌──────────────┐     ┌─────────────┐
                    │   Payment    │◀────│   TX Hash   │
                    │ SENT/FAILED  │     │  Generated  │
                    └──────────────┘     └─────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │   Payment    │
                    │  CONFIRMED   │
                    └──────────────┘
```

### Dev Mode vs Live Mode

| Aspect | Dev Mode | Live Mode |
|--------|----------|-----------|
| Activation | Default (no config) | `PAYMENT_MODE=live` |
| Funds Transfer | None (simulated) | Real SOL/USDC |
| TX Hash | `DEV_` prefix | Real Solana hash |
| Confirmation | Instant | Blockchain confirmation |
| Use Case | Development/Testing | Production |

### Enabling Live Payments

When ready for production:

1. **Set Environment Variable:**
   ```bash
   PAYMENT_MODE=live
   ```

2. **Configure Solana Settings:**
   ```bash
   curl -X PATCH "https://a2e.byredstone.com/v1/settlements/config" \
     -H "Content-Type: application/json" \
     -H "X-API-Key: a2e-dev-key-2026" \
     -d '{
       "solanaRpcUrl": "https://api.mainnet-beta.solana.com",
       "usdcMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
     }'
   ```

3. **Securely Store Payer Key:**
   - Add `payerPrivateKey` to settlement config
   - Ensure proper encryption at rest

4. **Implement `@solana/web3.js`:**
   - TODO markers in `services/payment/solana.ts`
   - Connection, transaction, confirmation logic

---

## Environment Variables

```env
# apps/api/.env

# Database
DATABASE_URL=postgresql://a2e:password@localhost:5432/a2e

# Redis
REDIS_URL=redis://localhost:6379

# Authentication
API_KEY=a2e-dev-key-2026
ADMIN_USERNAME=admin
ADMIN_PASSWORD=a2e-admin-2026
JWT_SECRET=your-secret-key

# Payment Mode (dev = default, live = production)
PAYMENT_MODE=dev

# Solana (optional, for live mode)
# Configured via /v1/settlements/config API
```

---

## Known Limitations

1. **Live Payments:** Solana integration is infrastructure-ready but requires `@solana/web3.js` implementation
2. **Scheduled Settlements:** No automated scheduler yet (manual trigger via API)
3. **PDF Generation:** Returns HTML; browser print-to-PDF for actual PDFs
4. **Multi-Currency:** USD only; SOL/USDC conversion pending price feed
5. **Invoice Generation:** Template exists but no dedicated endpoint

---

## Security Considerations

1. **Dev Mode Protection:** Clearly marked with `DEV_` prefix and `isDevMode: true`
2. **Wallet Validation:** Solana address format validated before processing
3. **Retry Limits:** Max 3 retries before settlement marked failed
4. **API Key Required:** All endpoints require authentication
5. **Private Key Storage:** Should be encrypted; not logged or exposed

---

## Deployment

### Deploy to Server

```bash
# Build locally
cd /Users/redstone/Projects/A2E
pnpm build

# Sync database schema
rsync -avz packages/database/prisma/schema.prisma root@135.181.162.188:/tmp/

# SSH to server and deploy
ssh root@135.181.162.188
pct exec 119 -- bash -c '
  cd /opt/a2e
  export $(grep -v ^# .env | xargs)

  # Update schema
  cp /tmp/schema.prisma packages/database/prisma/
  cd packages/database
  npx prisma db push
  npx prisma generate

  # Rebuild
  cd /opt/a2e
  pnpm build

  # Restart with correct environment
  pm2 delete a2e-api
  export $(grep -v ^# .env | xargs)
  pm2 start apps/api/dist/index.js --name a2e-api --update-env
  pm2 save
'
```

---

## Appendix: File Changes Summary

### New Files (6)

```
packages/database/prisma/schema.prisma    (+Payment model, +PaymentStatus enum)
apps/api/src/routes/payments.ts           (NEW - Payment API endpoints)
apps/api/src/routes/reports.ts            (NEW - Report generation)
apps/api/src/services/payment/solana.ts   (REWRITTEN - Dev/Live mode)
apps/api/src/services/reports/csv-generator.ts    (NEW)
apps/api/src/services/reports/pdf-generator.ts    (NEW)
```

### Modified Files (5)

```
apps/api/src/index.ts                     (+payments routes registration)
apps/api/src/routes/earnings.ts           (Enhanced with more endpoints)
apps/api/src/routes/settlements.ts        (Added process/complete/fail)
apps/api/src/routes/costs.ts              (Added summary endpoint)
apps/dashboard/src/app/financial/page.tsx (Full implementation)
```

### Database Changes

```sql
-- New table
CREATE TABLE "Payment" (
  id TEXT PRIMARY KEY,
  "settlementId" TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  currency TEXT DEFAULT 'USDC',
  "recipientAddress" TEXT NOT NULL,
  status "PaymentStatus" DEFAULT 'PENDING',
  "txHash" TEXT,
  "txConfirmed" BOOLEAN DEFAULT false,
  confirmations INTEGER DEFAULT 0,
  "isDevMode" BOOLEAN DEFAULT false,
  "errorMessage" TEXT,
  "retryCount" INTEGER DEFAULT 0,
  "maxRetries" INTEGER DEFAULT 3,
  "createdAt" TIMESTAMP DEFAULT now(),
  "processedAt" TIMESTAMP,
  "confirmedAt" TIMESTAMP
);

-- New enum
CREATE TYPE "PaymentStatus" AS ENUM (
  'PENDING', 'PROCESSING', 'SENT', 'CONFIRMED', 'FAILED'
);

-- Indexes
CREATE INDEX "Payment_settlementId_idx" ON "Payment"("settlementId");
CREATE INDEX "Payment_status_idx" ON "Payment"(status);
CREATE INDEX "Payment_txHash_idx" ON "Payment"("txHash");
```

---

## Next Steps (M5 - If Applicable)

Potential future enhancements:

- **Automated Settlement Scheduler:** BullMQ job for periodic settlements
- **Live Solana Integration:** Full `@solana/web3.js` implementation
- **Price Feed Integration:** Real-time SOL/USD conversion
- **Webhook Notifications:** Payment completion callbacks
- **Multi-signature Wallet:** Enhanced security for large payments

---

*Report generated: March 26, 2026*
