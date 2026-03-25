# NeoNodes Development Plan

> Complete task breakdown for M3-M7 implementation.
> Reference document for development tracking.

---

## Overview

| Milestone | Module | Scope | Investment | Status |
|-----------|--------|-------|------------|--------|
| M1 | — | Architecture & Economic Design | $800 | COMPLETE |
| M2 | — | Node Registry, Orchestration & A²E Engine | $1,100 | COMPLETE |
| M3 | A | Admin Dashboard & Configuration UI | $1,200 | PENDING |
| M4 | B | Financial System & Settlement Engine | $1,600 | PENDING |
| M5 | C | Node Agent & Execution Runtime | $2,000 | PENDING |
| M6 | D + E | Node Deployer Portal & Compute Buyer API | $2,100 | PENDING |
| M7 | F | External Market Overflow | $1,200 | PENDING |

**Total:** $10,000 (Discounted from $11,200)
**Paid:** $1,900 | **Remaining:** $8,100

---

## M3: Admin Dashboard & Configuration UI

**Module A** | Investment: $1,200

### Overview
Next.js 14 admin dashboard providing full visibility and control over the A²E engine. Real-time monitoring, node management, job tracking, and configuration controls.

### Tech Stack
- Next.js 14 (App Router)
- React + TypeScript
- Tailwind CSS
- Socket.io Client
- Recharts (charts)
- TanStack Table (data tables)

### File Structure
```
apps/dashboard/
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx                    # Overview dashboard
│   │   ├── nodes/
│   │   │   ├── page.tsx                # Node list
│   │   │   └── [id]/page.tsx           # Node detail
│   │   ├── jobs/
│   │   │   ├── page.tsx                # Job list
│   │   │   └── [id]/page.tsx           # Job detail
│   │   ├── rates/
│   │   │   └── page.tsx                # Rate monitoring
│   │   ├── config/
│   │   │   ├── page.tsx                # Configuration
│   │   │   ├── yield-floors/page.tsx   # Yield floor editor
│   │   │   └── markets/page.tsx        # Market toggles
│   │   ├── simulator/
│   │   │   └── page.tsx                # Routing simulator
│   │   └── login/
│   │       └── page.tsx                # Admin login
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Sidebar.tsx
│   │   │   ├── Header.tsx
│   │   │   └── ActivityFeed.tsx
│   │   ├── dashboard/
│   │   │   ├── MetricCard.tsx
│   │   │   ├── EarningsChart.tsx
│   │   │   ├── MarketComparison.tsx
│   │   │   └── SystemHealth.tsx
│   │   ├── nodes/
│   │   │   ├── NodeTable.tsx
│   │   │   ├── NodeStatusBadge.tsx
│   │   │   ├── NodeMetricsChart.tsx
│   │   │   └── NodeActions.tsx
│   │   ├── jobs/
│   │   │   ├── JobTable.tsx
│   │   │   ├── JobStatusBadge.tsx
│   │   │   ├── JobTimeline.tsx
│   │   │   └── RoutingDecisionCard.tsx
│   │   ├── config/
│   │   │   ├── YieldFloorEditor.tsx
│   │   │   ├── MarketToggle.tsx
│   │   │   └── RateOverrideForm.tsx
│   │   └── ui/
│   │       ├── Button.tsx
│   │       ├── Card.tsx
│   │       ├── Table.tsx
│   │       ├── Modal.tsx
│   │       └── Toast.tsx
│   ├── hooks/
│   │   ├── useWebSocket.ts
│   │   ├── useNodes.ts
│   │   ├── useJobs.ts
│   │   ├── useRates.ts
│   │   └── useStats.ts
│   ├── lib/
│   │   ├── api.ts                      # API client
│   │   ├── socket.ts                   # Socket.io setup
│   │   └── utils.ts
│   └── types/
│       └── index.ts
├── tailwind.config.ts
├── next.config.js
└── package.json
```

### Task Breakdown

#### A1. Project Setup
- [ ] Initialize Next.js 14 with App Router
- [ ] Configure Tailwind CSS with TokenOS dark theme
- [ ] Set up TypeScript strict mode
- [ ] Configure ESLint and Prettier
- [ ] Add environment variables (.env.local)
- [ ] Create shared UI components (Button, Card, Table, Modal, Toast)
- [ ] Set up API client with fetch wrapper
- [ ] Configure Socket.io client connection

#### A2. Layout & Navigation
- [ ] Create root layout with dark theme
- [ ] Build sidebar navigation component
- [ ] Build header with user menu
- [ ] Create activity feed sidebar (real-time events)
- [ ] Add mobile responsive navigation
- [ ] Implement breadcrumb navigation

#### A3. Admin Authentication
- [ ] Create login page UI
- [ ] Implement admin authentication API endpoint
- [ ] Add session management with JWT
- [ ] Create auth middleware for protected routes
- [ ] Add logout functionality
- [ ] Implement session timeout handling

#### A4. Overview Dashboard
- [ ] Create metric cards component (nodes, jobs, earnings)
- [ ] Build earnings time-series chart (daily/weekly/monthly)
- [ ] Create system health indicators (API, DB, Redis, external markets)
- [ ] Build market status comparison widget
- [ ] Add live activity feed with WebSocket
- [ ] Create quick actions panel
- [ ] Implement auto-refresh with Socket.io

#### A5. Node Management UI
- [ ] Create node list page with data table
- [ ] Add sorting by status, tier, earnings, last heartbeat
- [ ] Add filtering by status, GPU tier
- [ ] Implement search by wallet address
- [ ] Create node detail page
- [ ] Build node specs display (GPU, tier, registered date)
- [ ] Create GPU metrics chart (temperature, utilization history)
- [ ] Build job history table for node
- [ ] Add node actions (pause, resume, maintenance mode)
- [ ] Implement bulk node operations
- [ ] Add node status badge with color coding

#### A6. Job Management UI
- [ ] Create job list page with data table
- [ ] Add sorting by status, created, earnings
- [ ] Add filtering by status, market, node, date range
- [ ] Implement job search
- [ ] Create job detail page
- [ ] Build job timeline visualization (PENDING → COMPLETED)
- [ ] Display routing decision card with rates comparison
- [ ] Show assigned node information
- [ ] Add job actions (cancel, retry, reassign)
- [ ] Create job logs viewer (if available)

#### A7. Rate Monitoring
- [ ] Create rates overview page
- [ ] Display current rates for all GPU tiers
- [ ] Show rate comparison table (Internal vs Akash vs IO.net)
- [ ] Build rate history chart
- [ ] Add rate freshness indicators
- [ ] Show market availability status

#### A8. Configuration UI
- [ ] Create yield floor editor page
- [ ] Build per-tier yield floor input form
- [ ] Add instant preview of routing impact
- [ ] Create market toggle controls (enable/disable)
- [ ] Build rate override form for manual adjustments
- [ ] Add configuration change confirmation modal
- [ ] Implement audit log display for config changes

#### A9. Routing Simulator
- [ ] Create simulator page UI
- [ ] Build input form (GPU tier, internal demand toggle)
- [ ] Display simulated routing decision
- [ ] Show rate breakdown and comparison
- [ ] Add what-if analysis for yield floor changes
- [ ] Create side-by-side market comparison view

#### A10. Real-time Integration
- [ ] Connect to WebSocket server
- [ ] Handle node:registered events
- [ ] Handle node:offline events
- [ ] Handle node:heartbeat events
- [ ] Handle job:routed events
- [ ] Handle rate:updated events
- [ ] Implement toast notifications for events
- [ ] Add activity feed updates

### Acceptance Criteria
- [ ] Admin can log in and see overview dashboard
- [ ] All nodes visible with real-time status updates
- [ ] All jobs visible with filtering and search
- [ ] Yield floors can be edited and changes take effect immediately
- [ ] Markets can be enabled/disabled
- [ ] Routing simulator produces accurate decisions
- [ ] WebSocket events update UI in real-time

---

## M4: Financial System & Settlement Engine

**Module B** | Investment: $1,600

### Overview
Complete financial tracking, settlement engine, and payment processing system. Tracks earnings per job, aggregates by node, calculates payouts, and processes Solana payments.

### Tech Stack
- Node.js + Fastify (backend)
- Prisma (database)
- BullMQ (settlement queue)
- @solana/web3.js (payments)
- PDFKit (invoice generation)

### File Structure
```
apps/api/src/
├── routes/
│   ├── earnings.ts                     # Earnings endpoints
│   ├── settlements.ts                  # Settlement endpoints
│   └── reports.ts                      # Report endpoints
├── services/
│   ├── earnings/
│   │   ├── calculator.ts               # Earnings calculation
│   │   ├── aggregator.ts               # Earnings aggregation
│   │   └── tracker.ts                  # Real-time tracking
│   ├── settlement/
│   │   ├── engine.ts                   # Settlement engine
│   │   ├── scheduler.ts                # Settlement scheduling
│   │   └── processor.ts                # Payout processing
│   ├── payment/
│   │   ├── solana.ts                   # Solana integration
│   │   ├── batch.ts                    # Batch payments
│   │   └── verification.ts             # Payment verification
│   └── reports/
│       ├── csv-generator.ts            # CSV exports
│       ├── pdf-generator.ts            # PDF invoices
│       └── statements.ts               # Earning statements
├── jobs/
│   ├── settlement-processor.ts         # BullMQ settlement job
│   ├── daily-rollup.ts                 # Daily earnings rollup
│   └── payment-retry.ts                # Failed payment retry
└── types/
    └── financial.ts                    # Financial types

packages/database/prisma/
└── schema.prisma                       # Add financial tables
```

### Database Schema Additions
```prisma
model Earning {
  id            String   @id @default(cuid())
  jobId         String   @unique
  nodeId        String
  amount        Decimal  @db.Decimal(18, 8)
  currency      String   @default("USD")
  market        Market
  ratePerHour   Decimal  @db.Decimal(10, 4)
  durationSecs  Int
  createdAt     DateTime @default(now())

  job           Job      @relation(fields: [jobId], references: [id])
  node          Node     @relation(fields: [nodeId], references: [id])
}

model Settlement {
  id            String           @id @default(cuid())
  nodeId        String
  walletAddress String
  amount        Decimal          @db.Decimal(18, 8)
  currency      String           @default("USD")
  status        SettlementStatus @default(PENDING)
  periodStart   DateTime
  periodEnd     DateTime
  jobCount      Int
  txHash        String?
  txConfirmed   Boolean          @default(false)
  errorMessage  String?
  createdAt     DateTime         @default(now())
  processedAt   DateTime?

  node          Node             @relation(fields: [nodeId], references: [id])
  items         SettlementItem[]
}

model SettlementItem {
  id           String     @id @default(cuid())
  settlementId String
  earningId    String
  amount       Decimal    @db.Decimal(18, 8)

  settlement   Settlement @relation(fields: [settlementId], references: [id])
}

model SettlementConfig {
  id              String   @id @default(cuid())
  period          String   @default("WEEKLY") // DAILY, WEEKLY, MONTHLY
  minimumPayout   Decimal  @db.Decimal(18, 8) @default(10)
  dayOfWeek       Int?     // For weekly (0-6)
  dayOfMonth      Int?     // For monthly (1-28)
  updatedAt       DateTime @updatedAt
}

model InfrastructureCost {
  id          String   @id @default(cuid())
  nodeId      String?
  category    String   // HOSTING, POWER, NETWORK, OTHER
  amount      Decimal  @db.Decimal(18, 8)
  currency    String   @default("USD")
  description String?
  periodStart DateTime
  periodEnd   DateTime
  createdAt   DateTime @default(now())

  node        Node?    @relation(fields: [nodeId], references: [id])
}

enum SettlementStatus {
  PENDING
  PROCESSING
  COMPLETED
  FAILED
}
```

### Task Breakdown

#### B1. Earnings Tracking
- [ ] Create Earning model in Prisma schema
- [ ] Implement automatic earnings calculation on job completion
- [ ] Create earnings service with calculation logic
- [ ] Add per-job earnings recording
- [ ] Implement per-node earnings aggregation
- [ ] Create per-market revenue tracking
- [ ] Add per-GPU-tier earnings analysis
- [ ] Build daily earnings rollup job (BullMQ)
- [ ] Create earnings trend calculation

#### B2. Earnings API Endpoints
- [ ] GET /v1/earnings - List earnings with filters
- [ ] GET /v1/earnings/summary - Aggregated earnings summary
- [ ] GET /v1/earnings/by-node/:nodeId - Node-specific earnings
- [ ] GET /v1/earnings/by-market - Earnings breakdown by market
- [ ] GET /v1/earnings/by-tier - Earnings breakdown by GPU tier
- [ ] GET /v1/earnings/trends - Earnings trend data

#### B3. Cost Tracking
- [ ] Create InfrastructureCost model
- [ ] Implement cost recording API
- [ ] Track external market deployment costs (Akash AKT, IO.net credits)
- [ ] Calculate true cost-per-job
- [ ] Build margin analysis (revenue - costs)
- [ ] Create profitability reporting by tier and market

#### B4. Cost API Endpoints
- [ ] POST /v1/costs - Record infrastructure cost
- [ ] GET /v1/costs - List costs with filters
- [ ] GET /v1/costs/summary - Cost summary by category
- [ ] GET /v1/margins - Margin analysis

#### B5. Settlement Engine
- [ ] Create Settlement and SettlementItem models
- [ ] Build settlement calculation service
- [ ] Implement payout grouping by node/wallet
- [ ] Create settlement scheduling (daily/weekly/monthly)
- [ ] Build settlement queue with BullMQ
- [ ] Implement minimum threshold check
- [ ] Add settlement status tracking
- [ ] Create settlement retry logic for failures

#### B6. Settlement API Endpoints
- [ ] GET /v1/settlements - List settlements
- [ ] GET /v1/settlements/:id - Settlement details
- [ ] POST /v1/settlements/trigger - Manually trigger settlement
- [ ] GET /v1/settlements/pending - Pending settlements
- [ ] GET /v1/settlements/config - Settlement configuration
- [ ] PATCH /v1/settlements/config - Update settlement config

#### B7. Solana Payment Integration
- [ ] Set up @solana/web3.js
- [ ] Create Solana wallet management
- [ ] Implement SOL transfer function
- [ ] Implement USDC (SPL token) transfer function
- [ ] Build multi-recipient batch payment
- [ ] Add transaction recording with tx hash
- [ ] Implement payment verification (on-chain confirmation)
- [ ] Create failed payment retry mechanism

#### B8. Payment API Endpoints
- [ ] POST /v1/payments/process/:settlementId - Process settlement payment
- [ ] GET /v1/payments/:id - Payment details
- [ ] GET /v1/payments/verify/:txHash - Verify payment on-chain

#### B9. Reporting - CSV Exports
- [ ] Implement CSV generator utility
- [ ] GET /v1/reports/earnings/csv - Earnings CSV export
- [ ] GET /v1/reports/settlements/csv - Settlements CSV export
- [ ] GET /v1/reports/jobs/csv - Jobs CSV export
- [ ] GET /v1/reports/nodes/csv - Nodes CSV export
- [ ] Add date range filtering to all exports

#### B10. Reporting - PDF Generation
- [ ] Set up PDFKit
- [ ] Create PDF invoice template
- [ ] Generate customer billing invoices
- [ ] Create monthly earning statements for node runners
- [ ] Build tax-ready annual summaries
- [ ] GET /v1/reports/invoice/:customerId - Generate invoice PDF
- [ ] GET /v1/reports/statement/:nodeId - Generate statement PDF

#### B11. Financial Dashboard (Admin UI Addition)
- [ ] Add financial section to admin dashboard
- [ ] Create revenue overview widget
- [ ] Build cost overview widget
- [ ] Display net profit margins
- [ ] Show pending settlements list
- [ ] Add settlement history table
- [ ] Create earnings vs costs chart

### Acceptance Criteria
- [ ] Earnings calculated automatically on job completion
- [ ] Settlements process on configured schedule
- [ ] Solana payments execute and verify on-chain
- [ ] CSV exports generate correct data
- [ ] PDF statements generate properly
- [ ] Failed payments retry automatically
- [ ] Admin dashboard shows financial overview

---

## M5: Node Agent & Execution Runtime

**Module C** | Investment: $2,000

### Overview
Standalone Node.js agent that runs on GPU nodes. Handles registration, heartbeat, job polling, Docker execution, and status reporting. Distributed as single binary.

### Tech Stack
- Node.js + TypeScript
- Docker SDK (dockerode)
- pkg (binary packaging)
- nvidia-smi (GPU metrics)
- systemd (service management)

### File Structure
```
apps/node-agent/
├── src/
│   ├── index.ts                        # Entry point
│   ├── agent.ts                        # Main agent class
│   ├── config.ts                       # Configuration loader
│   ├── api/
│   │   ├── client.ts                   # A²E API client
│   │   └── types.ts                    # API types
│   ├── gpu/
│   │   ├── detector.ts                 # GPU detection
│   │   ├── metrics.ts                  # GPU metrics collector
│   │   └── allocator.ts                # GPU allocation
│   ├── docker/
│   │   ├── client.ts                   # Docker SDK wrapper
│   │   ├── executor.ts                 # Container execution
│   │   ├── image.ts                    # Image management
│   │   └── cleanup.ts                  # Container cleanup
│   ├── jobs/
│   │   ├── poller.ts                   # Job polling
│   │   ├── executor.ts                 # Job execution orchestrator
│   │   ├── reporter.ts                 # Status reporter
│   │   └── queue.ts                    # Local job queue
│   ├── heartbeat/
│   │   └── sender.ts                   # Heartbeat service
│   ├── recovery/
│   │   ├── state.ts                    # State persistence
│   │   ├── checkpoint.ts               # Job checkpointing
│   │   └── reconnect.ts                # Reconnection logic
│   ├── security/
│   │   ├── sandbox.ts                  # Container sandboxing
│   │   ├── credentials.ts              # Credential storage
│   │   └── verification.ts             # Image verification
│   └── utils/
│       ├── logger.ts                   # Logging
│       └── shell.ts                    # Shell commands
├── scripts/
│   ├── install.sh                      # One-line installer
│   ├── uninstall.sh                    # Uninstaller
│   └── update.sh                       # Self-update script
├── config/
│   └── agent.example.yaml              # Example config
├── systemd/
│   └── neonodes-agent.service          # Systemd service file
├── package.json
├── tsconfig.json
└── pkg.config.json                     # Binary packaging config
```

### Task Breakdown

#### C1. Project Setup
- [ ] Initialize Node.js project with TypeScript
- [ ] Configure strict TypeScript
- [ ] Set up pkg for binary packaging
- [ ] Create configuration file loader (YAML)
- [ ] Set up structured logging (pino)
- [ ] Create environment variable support

#### C2. A²E API Client
- [ ] Create HTTP client for A²E API
- [ ] Implement authentication (API key)
- [ ] Add retry logic with exponential backoff
- [ ] Implement request timeout handling
- [ ] Create type definitions for all API responses
- [ ] Add TLS certificate validation

#### C3. Agent Core
- [ ] Create main Agent class
- [ ] Implement agent lifecycle (start, stop, restart)
- [ ] Add graceful shutdown (complete current job)
- [ ] Implement signal handling (SIGTERM, SIGINT)
- [ ] Create state machine for agent status
- [ ] Add health check endpoint (local)

#### C4. GPU Detection & Metrics
- [ ] Implement nvidia-smi integration
- [ ] Create GPU detection on startup
- [ ] Detect GPU model and tier classification
- [ ] Support multi-GPU detection
- [ ] Collect GPU metrics (temperature, utilization, memory)
- [ ] Implement metrics collection interval
- [ ] Add VRAM tracking
- [ ] Detect GPU health issues (thermal throttling)

#### C5. Registration
- [ ] Implement initial registration with A²E
- [ ] Send GPU specs during registration
- [ ] Handle registration response (node ID, config)
- [ ] Store registration credentials securely
- [ ] Implement re-registration on config change

#### C6. Heartbeat System
- [ ] Create heartbeat sender service
- [ ] Send heartbeats every 30 seconds
- [ ] Include GPU metrics in heartbeat
- [ ] Include current job status
- [ ] Handle heartbeat failures gracefully
- [ ] Implement heartbeat backoff on repeated failures

#### C7. Job Polling
- [ ] Create job polling service
- [ ] Poll for assigned jobs on interval
- [ ] Handle job assignment response
- [ ] Send job acceptance confirmation
- [ ] Implement job rejection (if busy)
- [ ] Add job priority handling

#### C8. Docker Integration
- [ ] Set up dockerode client
- [ ] Implement Docker daemon connection check
- [ ] Create image pull functionality
- [ ] Add image caching to reduce pull time
- [ ] Implement container creation with GPU access
- [ ] Configure resource limits (CPU, memory, GPU)
- [ ] Add volume mounting support
- [ ] Implement environment variable injection
- [ ] Create container start/stop/remove functions

#### C9. Job Execution
- [ ] Create job executor orchestrator
- [ ] Implement execution flow (pull → create → start → wait → cleanup)
- [ ] Add execution timeout enforcement
- [ ] Capture stdout/stderr logs
- [ ] Monitor container resource usage
- [ ] Handle container exit codes
- [ ] Implement graceful job cancellation

#### C10. Status Reporting
- [ ] Report job started (RUNNING status)
- [ ] Send periodic progress updates
- [ ] Report job completed with duration
- [ ] Report job failed with error details
- [ ] Include execution logs in failure report
- [ ] Report resource usage metrics

#### C11. Failure Recovery
- [ ] Implement state persistence to disk
- [ ] Save job state before execution
- [ ] Recover state on agent restart
- [ ] Implement job checkpointing for long jobs
- [ ] Create reconnection logic with backoff
- [ ] Handle orphaned containers on restart

#### C12. Security
- [ ] Implement container sandboxing
- [ ] Set resource limits to prevent exhaustion
- [ ] Configure network policies (restrict access)
- [ ] Add image verification (trusted images only)
- [ ] Secure credential storage (encrypted)
- [ ] Add container user namespacing

#### C13. Installation & Distribution
- [ ] Create one-line installer script (curl | bash)
- [ ] Add Docker prerequisite check
- [ ] Add NVIDIA driver verification
- [ ] Create guided configuration wizard
- [ ] Generate systemd service file
- [ ] Implement auto-start on boot
- [ ] Create uninstall script
- [ ] Build self-update mechanism

#### C14. Binary Packaging
- [ ] Configure pkg for Linux x64
- [ ] Configure pkg for Linux arm64
- [ ] Test binary on fresh Ubuntu 22.04
- [ ] Create release artifacts
- [ ] Set up version tagging

#### C15. API Endpoint Additions
- [ ] POST /v1/nodes/:id/jobs/poll - Agent polls for jobs
- [ ] POST /v1/jobs/:id/accept - Agent accepts job
- [ ] POST /v1/jobs/:id/progress - Progress update
- [ ] POST /v1/jobs/:id/complete - Job completed
- [ ] POST /v1/jobs/:id/fail - Job failed

### Acceptance Criteria
- [ ] Agent installs via one-line script
- [ ] Agent registers with A²E automatically
- [ ] Heartbeats maintain ONLINE status
- [ ] Jobs execute in Docker containers with GPU
- [ ] Job completion reports back to A²E
- [ ] Agent recovers from crashes
- [ ] Agent updates itself

---

## M6: Node Deployer Portal & Compute Buyer API

**Module D + E** | Investment: $2,100

### Overview
Two user-facing portals: Node Runner Portal for GPU providers to onboard and track earnings, and Customer Portal for compute buyers to submit jobs and manage billing.

### Tech Stack
- Next.js 14 (App Router)
- Tailwind CSS
- Wallet Connect (Solana)
- Socket.io Client
- Stripe (optional fiat payments)

### File Structure
```
apps/portal/
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx                    # Landing page
│   │   ├── (auth)/
│   │   │   ├── login/page.tsx
│   │   │   ├── register/page.tsx
│   │   │   └── connect-wallet/page.tsx
│   │   ├── (node-runner)/
│   │   │   ├── layout.tsx
│   │   │   ├── dashboard/page.tsx      # Node runner dashboard
│   │   │   ├── onboarding/
│   │   │   │   ├── page.tsx            # Onboarding wizard
│   │   │   │   ├── requirements/page.tsx
│   │   │   │   ├── download/page.tsx
│   │   │   │   └── verify/page.tsx
│   │   │   ├── nodes/
│   │   │   │   ├── page.tsx            # Node list
│   │   │   │   └── [id]/page.tsx       # Node detail
│   │   │   ├── earnings/
│   │   │   │   ├── page.tsx            # Earnings overview
│   │   │   │   └── history/page.tsx    # Earnings history
│   │   │   ├── payouts/
│   │   │   │   ├── page.tsx            # Payout history
│   │   │   │   └── settings/page.tsx   # Payout settings
│   │   │   ├── jobs/
│   │   │   │   └── page.tsx            # Job history
│   │   │   └── settings/
│   │   │       └── page.tsx            # Account settings
│   │   └── (customer)/
│   │       ├── layout.tsx
│   │       ├── dashboard/page.tsx      # Customer dashboard
│   │       ├── jobs/
│   │       │   ├── page.tsx            # Job list
│   │       │   ├── new/page.tsx        # Submit job
│   │       │   ├── templates/page.tsx  # Job templates
│   │       │   └── [id]/page.tsx       # Job detail
│   │       ├── billing/
│   │       │   ├── page.tsx            # Billing overview
│   │       │   ├── add-funds/page.tsx  # Deposit funds
│   │       │   └── invoices/page.tsx   # Invoice history
│   │       ├── api-keys/
│   │       │   └── page.tsx            # API key management
│   │       └── settings/
│   │           └── page.tsx            # Account settings
│   ├── components/
│   │   ├── auth/
│   │   │   ├── WalletConnect.tsx
│   │   │   ├── LoginForm.tsx
│   │   │   └── RegisterForm.tsx
│   │   ├── node-runner/
│   │   │   ├── OnboardingWizard.tsx
│   │   │   ├── EarningsChart.tsx
│   │   │   ├── NodeCard.tsx
│   │   │   ├── PayoutHistory.tsx
│   │   │   └── AgentDownload.tsx
│   │   ├── customer/
│   │   │   ├── JobSubmitForm.tsx
│   │   │   ├── JobMonitor.tsx
│   │   │   ├── CostEstimator.tsx
│   │   │   ├── BalanceCard.tsx
│   │   │   └── ApiKeyManager.tsx
│   │   └── shared/
│   │       ├── Navbar.tsx
│   │       ├── Footer.tsx
│   │       └── NotificationBell.tsx
│   ├── hooks/
│   │   ├── useWallet.ts
│   │   ├── useAuth.ts
│   │   ├── useNodeRunner.ts
│   │   └── useCustomer.ts
│   └── lib/
│       ├── api.ts
│       ├── wallet.ts
│       └── socket.ts
├── public/
│   └── downloads/                      # Agent downloads
└── package.json

apps/api/src/routes/
├── auth.ts                             # Authentication endpoints
├── node-runner.ts                      # Node runner specific endpoints
├── customer.ts                         # Customer specific endpoints
└── billing.ts                          # Billing endpoints
```

### Database Schema Additions
```prisma
model User {
  id            String    @id @default(cuid())
  email         String?   @unique
  walletAddress String?   @unique
  passwordHash  String?
  role          UserRole  @default(NODE_RUNNER)
  emailVerified Boolean   @default(false)
  twoFactorEnabled Boolean @default(false)
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  nodes         Node[]
  apiKeys       ApiKey[]
  organization  Organization? @relation(fields: [orgId], references: [id])
  orgId         String?
}

model Organization {
  id            String   @id @default(cuid())
  name          String
  balance       Decimal  @db.Decimal(18, 8) @default(0)
  spendingLimit Decimal? @db.Decimal(18, 8)
  createdAt     DateTime @default(now())

  users         User[]
  jobs          Job[]
  apiKeys       ApiKey[]
  deposits      Deposit[]
}

model ApiKey {
  id            String    @id @default(cuid())
  key           String    @unique
  name          String
  userId        String?
  orgId         String?
  permissions   String[]  @default(["jobs:read", "jobs:write"])
  lastUsedAt    DateTime?
  expiresAt     DateTime?
  createdAt     DateTime  @default(now())

  user          User?     @relation(fields: [userId], references: [id])
  organization  Organization? @relation(fields: [orgId], references: [id])
}

model Deposit {
  id            String        @id @default(cuid())
  orgId         String
  amount        Decimal       @db.Decimal(18, 8)
  currency      String        // SOL, USDC
  txHash        String?
  status        DepositStatus @default(PENDING)
  createdAt     DateTime      @default(now())
  confirmedAt   DateTime?

  organization  Organization  @relation(fields: [orgId], references: [id])
}

model JobTemplate {
  id            String   @id @default(cuid())
  orgId         String
  name          String
  gpuTier       GpuTier
  dockerImage   String
  command       String?
  environment   Json?
  createdAt     DateTime @default(now())
}

model Notification {
  id        String           @id @default(cuid())
  userId    String
  type      NotificationType
  title     String
  message   String
  read      Boolean          @default(false)
  createdAt DateTime         @default(now())
}

enum UserRole {
  NODE_RUNNER
  CUSTOMER
  ADMIN
}

enum DepositStatus {
  PENDING
  CONFIRMED
  FAILED
}

enum NotificationType {
  NODE_OFFLINE
  PAYOUT_SENT
  JOB_COMPLETED
  JOB_FAILED
  LOW_BALANCE
}
```

### Task Breakdown

#### D1. Authentication System
- [ ] Create User model in Prisma
- [ ] Implement Wallet Connect integration (Phantom, Solflare)
- [ ] Add email/password authentication option
- [ ] Create JWT session management
- [ ] Implement refresh token rotation
- [ ] Add email verification flow
- [ ] Create password reset flow
- [ ] Implement optional 2FA (TOTP)

#### D2. Auth API Endpoints
- [ ] POST /v1/auth/register - Email registration
- [ ] POST /v1/auth/login - Email login
- [ ] POST /v1/auth/wallet - Wallet authentication
- [ ] POST /v1/auth/refresh - Refresh token
- [ ] POST /v1/auth/logout - Logout
- [ ] POST /v1/auth/verify-email - Email verification
- [ ] POST /v1/auth/reset-password - Password reset

#### D3. Node Runner - Onboarding Flow
- [ ] Create welcome wizard UI
- [ ] Display system requirements
- [ ] Create platform-specific download links
- [ ] Build installation guide with screenshots
- [ ] Implement automatic node detection (when online)
- [ ] Add GPU benchmark (optional)
- [ ] Create terms of service acceptance

#### D4. Node Runner - Dashboard
- [ ] Create earnings overview (today, week, month, all-time)
- [ ] Build node status display (online/offline, current job)
- [ ] Add performance metrics (uptime, jobs completed)
- [ ] Create earnings chart (time-series)
- [ ] Build recent activity feed
- [ ] Add quick actions (pause all, resume all)

#### D5. Node Runner - Node Management
- [ ] Create node list view
- [ ] Build node detail page (specs, status, history)
- [ ] Add pause/resume controls
- [ ] Implement maintenance mode scheduling
- [ ] Create node removal (deregister)
- [ ] Support multiple nodes per account

#### D6. Node Runner - Earnings & Payouts
- [ ] Create earnings history page
- [ ] Build payout history with blockchain links
- [ ] Add payout settings (threshold, frequency)
- [ ] Implement wallet management
- [ ] Create earnings projection based on history
- [ ] Add export to CSV

#### D7. Node Runner - Job History
- [ ] Create job history list
- [ ] Build job detail view (duration, earnings, market)
- [ ] Add execution logs access (if enabled)
- [ ] Implement filtering and search

#### D8. Node Runner - Notifications
- [ ] Create notification system
- [ ] Add email alerts (node offline, payout sent)
- [ ] Build in-app notification feed
- [ ] Create notification preferences page
- [ ] Implement browser push notifications (optional)

#### D9. Node Runner API Endpoints
- [ ] GET /v1/node-runner/dashboard - Dashboard data
- [ ] GET /v1/node-runner/nodes - List user's nodes
- [ ] PATCH /v1/node-runner/nodes/:id - Update node
- [ ] GET /v1/node-runner/earnings - Earnings data
- [ ] GET /v1/node-runner/payouts - Payout history
- [ ] PATCH /v1/node-runner/settings - Update settings

#### E1. Customer - Organization & Billing
- [ ] Create Organization model
- [ ] Implement team management (invite, remove)
- [ ] Add role-based access (admin, developer, viewer)
- [ ] Create balance tracking
- [ ] Implement deposit detection (Solana)
- [ ] Add spending limits

#### E2. Customer - Job Submission
- [ ] Create job submission form
- [ ] Build GPU tier selection
- [ ] Add container config (image, command, env)
- [ ] Implement resource selection (GPU count, memory)
- [ ] Create cost estimator (before submit)
- [ ] Build job templates (save & reuse)
- [ ] Add batch job submission
- [ ] Implement priority levels

#### E3. Customer - Job Monitoring
- [ ] Create active jobs list with real-time status
- [ ] Build job status progression UI
- [ ] Add live log streaming (WebSocket)
- [ ] Show resource metrics during execution
- [ ] Implement cancel job functionality
- [ ] Display queue position

#### E4. Customer - Job History
- [ ] Create historical job list
- [ ] Build job detail view
- [ ] Add output download
- [ ] Implement job clone/rerun
- [ ] Create execution logs archive

#### E5. Customer - Billing
- [ ] Create billing overview page
- [ ] Build add funds flow (SOL/USDC)
- [ ] Generate QR code for deposits
- [ ] Display usage history
- [ ] Create invoice download (PDF)
- [ ] Implement spending limits
- [ ] Add auto-recharge (optional)

#### E6. Customer - API Access
- [ ] Create API key management UI
- [ ] Build key generation with permissions
- [ ] Add key revocation
- [ ] Implement key rotation
- [ ] Display API usage stats
- [ ] Create rate limit visibility
- [ ] Add webhook configuration

#### E7. Customer - SDK & Documentation
- [ ] Create interactive API documentation
- [ ] Build Python SDK
- [ ] Build JavaScript SDK
- [ ] Add code examples
- [ ] Create quick start guide

#### E8. Customer API Endpoints
- [ ] POST /v1/customer/jobs - Submit job
- [ ] GET /v1/customer/jobs - List jobs
- [ ] GET /v1/customer/jobs/:id - Job detail
- [ ] DELETE /v1/customer/jobs/:id - Cancel job
- [ ] GET /v1/customer/jobs/:id/logs - Job logs
- [ ] GET /v1/customer/billing - Billing info
- [ ] GET /v1/customer/billing/invoices - Invoices
- [ ] POST /v1/customer/api-keys - Create API key
- [ ] DELETE /v1/customer/api-keys/:id - Revoke key
- [ ] POST /v1/customer/webhooks - Configure webhook

### Acceptance Criteria
- [ ] Node runners can sign up and onboard via portal
- [ ] Node runners see earnings and payout history
- [ ] Customers can submit jobs via portal
- [ ] Customers can add funds and see billing
- [ ] API keys work for programmatic access
- [ ] Real-time status updates work
- [ ] Both portals work on mobile

---

## M7: External Market Overflow

**Module F** | Investment: $1,200

### Overview
Bidirectional integration with Akash Network and IO.net. When internal demand is high, serve internal jobs. When internal demand is low, list idle nodes on external markets. Node runners always earn.

### Tech Stack
- Akash SDK (@akashnetwork/akashjs)
- IO.net API (REST)
- Vast.ai API (REST)
- BullMQ (job queues)

### File Structure
```
packages/market-adapters/
├── src/
│   ├── index.ts                        # Export all adapters
│   ├── types.ts                        # Shared types
│   ├── base-adapter.ts                 # Base adapter class
│   ├── akash/
│   │   ├── index.ts                    # Akash adapter
│   │   ├── client.ts                   # Akash API client
│   │   ├── sdl.ts                      # SDL generator
│   │   ├── deployment.ts               # Deployment management
│   │   └── types.ts                    # Akash types
│   ├── ionet/
│   │   ├── index.ts                    # IO.net adapter
│   │   ├── client.ts                   # IO.net API client
│   │   ├── cluster.ts                  # Cluster management
│   │   └── types.ts                    # IO.net types
│   └── vastai/
│       ├── index.ts                    # Vast.ai adapter
│       ├── client.ts                   # Vast.ai API client
│       └── types.ts                    # Vast.ai types
└── package.json

apps/api/src/
├── services/
│   ├── external-market/
│   │   ├── router.ts                   # Market routing logic
│   │   ├── listing.ts                  # List nodes on external markets
│   │   ├── execution.ts                # Execute jobs on external markets
│   │   └── monitor.ts                  # Monitor external deployments
│   └── overflow/
│       ├── engine.ts                   # Overflow decision engine
│       └── scheduler.ts                # Overflow scheduling
├── jobs/
│   ├── external-job-executor.ts        # Execute jobs on external markets
│   ├── external-listing-manager.ts     # Manage external listings
│   └── external-status-checker.ts      # Check external job status
```

### Task Breakdown

#### F1. Market Adapter Base
- [ ] Create base adapter interface
- [ ] Define common types (rate, availability, job)
- [ ] Implement adapter registry
- [ ] Add adapter health checking
- [ ] Create rate normalization (all to $/hr)

#### F2. Akash Network Integration
- [ ] Set up Akash SDK
- [ ] Implement wallet/account management
- [ ] Create AKT balance checking
- [ ] Build SDL (Stack Definition Language) generator
- [ ] Implement deployment creation
- [ ] Add bid selection logic (best provider)
- [ ] Create deployment status monitoring
- [ ] Implement log retrieval
- [ ] Add deployment termination
- [ ] Track AKT costs per deployment
- [ ] Implement provider reputation scoring

#### F3. IO.net Integration
- [ ] Set up IO.net API client
- [ ] Implement authentication
- [ ] Create cluster creation
- [ ] Build job submission
- [ ] Add status monitoring
- [ ] Implement result retrieval
- [ ] Track IO credits usage
- [ ] Add failover handling

#### F4. Vast.ai Integration
- [ ] Set up Vast.ai API client
- [ ] Implement authentication
- [ ] Query available instances
- [ ] Create instance rental
- [ ] Build job execution
- [ ] Monitor instance status
- [ ] Track costs
- [ ] Handle instance termination

#### F5. Overflow Engine
- [ ] Create overflow decision logic
- [ ] Implement internal capacity checking
- [ ] Route overflow to best external market
- [ ] Add cost-benefit analysis
- [ ] Enforce margin protection
- [ ] Build fallback chain (Internal → Akash → IO.net → Vast.ai)

#### F6. External Listing (Idle Nodes)
- [ ] Detect idle internal nodes
- [ ] Create listing on Akash
- [ ] Create listing on IO.net
- [ ] Monitor for external job assignments
- [ ] Route external jobs to internal nodes
- [ ] Handle listing removal when internal demand rises
- [ ] Track external earnings

#### F7. Bidirectional Routing
- [ ] Implement demand level detection
- [ ] High demand: serve internal, delist from external
- [ ] Low demand: list on external markets
- [ ] Automatic switching based on thresholds
- [ ] Ensure node runners always earning
- [ ] Hourly rate calculation regardless of source

#### F8. External Job Execution Queue
- [ ] Create BullMQ queue for external jobs
- [ ] Implement job submission to external markets
- [ ] Add status polling
- [ ] Handle job completion
- [ ] Handle job failure with retry
- [ ] Track external job costs

#### F9. Monitoring & Reporting
- [ ] Create external market dashboard section
- [ ] Show active external deployments
- [ ] Display costs by market
- [ ] Track success/failure rates
- [ ] Add alerts for external market issues

#### F10. API Endpoints
- [ ] GET /v1/external/status - External market status
- [ ] GET /v1/external/deployments - Active deployments
- [ ] POST /v1/external/list/:nodeId - List node externally
- [ ] DELETE /v1/external/list/:nodeId - Remove listing
- [ ] GET /v1/external/earnings - External earnings

### Acceptance Criteria
- [ ] Jobs overflow to Akash when internal busy
- [ ] Jobs overflow to IO.net as secondary
- [ ] Idle nodes list on external markets
- [ ] Node runners earn from both internal and external
- [ ] External costs tracked accurately
- [ ] Automatic switching based on demand

---

## Verification Checklist

### M3 Complete When:
- [ ] Admin dashboard accessible at /admin
- [ ] All nodes visible with real-time status
- [ ] Jobs filterable by status/market/node
- [ ] Configuration changes take effect
- [ ] WebSocket events update UI

### M4 Complete When:
- [ ] Earnings calculate on job completion
- [ ] Settlements process on schedule
- [ ] Solana payments execute
- [ ] CSV/PDF exports work
- [ ] Financial dashboard shows data

### M5 Complete When:
- [ ] Agent installs via curl | bash
- [ ] Agent registers and heartbeats
- [ ] Jobs execute in Docker
- [ ] Completion reports back
- [ ] Agent recovers from crash

### M6 Complete When:
- [ ] Node runners onboard via portal
- [ ] Earnings and payouts visible
- [ ] Customers submit jobs via portal
- [ ] Billing and invoices work
- [ ] API keys authenticate

### M7 Complete When:
- [ ] Overflow jobs go to Akash/IO.net
- [ ] Idle nodes list externally
- [ ] Bidirectional routing works
- [ ] External earnings tracked
- [ ] Node runners always earning

---

## Notes

- Each milestone builds on previous ones
- M6 is when investors see user-facing portals
- External markets (M7) maximize node utilization
- All milestones include testing and documentation
- Deployment to production included in each milestone
