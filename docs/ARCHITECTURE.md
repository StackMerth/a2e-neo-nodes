# A²E Engine Architecture

> **Version:** 1.0.0
> **Last Updated:** 2026-03-22
> **Status:** Phase 1 Design

---

## 1. Overview

The A²E (Arbitrage & Orchestration Engine) is a standalone microservice that optimizes GPU node earnings by routing jobs to the highest-paying market.

### Key Principles

1. **Standalone Service** — Does not modify TokenOS codebase
2. **Single Integration Point** — `POST /route` API endpoint
3. **Internal First** — Premium retail rate for internal demand
4. **Guaranteed Yield** — External markets fill idle capacity
5. **No Third-Party Dependencies** — Custom monitoring, no Grafana/Prometheus

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              TokenOS Platform                                │
│                           (compute.tokenos.ai)                               │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ POST /route
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              A²E Engine                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │   API       │  │   Routing   │  │    Rate     │  │    Node     │        │
│  │   Layer     │──│   Engine    │──│   Provider  │  │   Registry  │        │
│  │  (Fastify)  │  │   (Core)    │  │             │  │             │        │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘        │
│         │                │                │                │                │
│         │                │                │                │                │
│  ┌──────┴────────────────┴────────────────┴────────────────┴──────┐        │
│  │                         Data Layer                              │        │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │        │
│  │  │  PostgreSQL │  │    Redis    │  │   BullMQ    │             │        │
│  │  │  (Prisma)   │  │   (Cache)   │  │   (Queue)   │             │        │
│  │  └─────────────┘  └─────────────┘  └─────────────┘             │        │
│  └────────────────────────────────────────────────────────────────┘        │
│         │                                                                   │
│  ┌──────┴──────────────────────────────────────────────────────────┐       │
│  │                    External Market Adapters                      │       │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │       │
│  │  │    Akash    │  │   IO.net    │  │   (Future)  │              │       │
│  │  │   Adapter   │  │   Adapter   │  │   Markets   │              │       │
│  │  └─────────────┘  └─────────────┘  └─────────────┘              │       │
│  └─────────────────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ WebSocket
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Admin Dashboard                                    │
│                          (Next.js + React)                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Service Architecture

### 3.1 Package Structure

```
a2e-engine/
├── apps/
│   ├── api/                 # Fastify REST API + WebSocket
│   └── dashboard/           # Next.js Admin Dashboard
├── packages/
│   ├── core/                # A²E routing logic
│   ├── database/            # Prisma schema & client
│   └── shared/              # Shared types & utilities
├── docs/                    # Documentation
└── docker/                  # Docker configurations
```

### 3.2 Service Responsibilities

| Service | Technology | Responsibility |
|---------|------------|----------------|
| API | Fastify | REST endpoints, WebSocket, request validation |
| Core | TypeScript | Routing engine, rate comparison, yield floor |
| Database | Prisma + PostgreSQL | Persistence, queries, migrations |
| Queue | BullMQ + Redis | Async job processing, rate fetching |
| Dashboard | Next.js | Admin UI, real-time monitoring |

---

## 4. Core Routing Logic

### 4.1 Decision Flow

```
                    ┌──────────────────┐
                    │   Route Request  │
                    │   (gpuTier, etc) │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │  Has Internal    │
                    │    Demand?       │
                    └────────┬─────────┘
                             │
              ┌──────────────┴──────────────┐
              │ YES                         │ NO
              ▼                             ▼
    ┌──────────────────┐          ┌──────────────────┐
    │  Route INTERNAL  │          │  Compare External │
    │  (Retail Rate)   │          │     Markets       │
    └──────────────────┘          └────────┬─────────┘
                                           │
                                           ▼
                                  ┌──────────────────┐
                                  │  Select Highest  │
                                  │   Paying Market  │
                                  └────────┬─────────┘
                                           │
                                           ▼
                                  ┌──────────────────┐
                                  │  Apply Yield     │
                                  │  Floor if Needed │
                                  └────────┬─────────┘
                                           │
                                           ▼
                                  ┌──────────────────┐
                                  │ Return Decision  │
                                  │ + Log Reasoning  │
                                  └──────────────────┘
```

### 4.2 Rate Priority

1. **Internal (Retail)** — Premium rate, used when internal demand exists
2. **External (Wholesale)** — Fallback for idle capacity, highest bidder wins
3. **Yield Floor** — Minimum guaranteed rate per GPU tier

### 4.3 GPU Tier Configuration

| Tier | GPU | Retail Rate | Cost Floor | VRAM |
|------|-----|-------------|------------|------|
| T1 | H100 SXM5 | $140.15/day | $83/day | 80 GB |
| T2 | H200 SXM5 | $179.85/day | $105/day | 141 GB |
| T3 | B200 SXM | $321.10/day | $170/day | 192 GB |
| T4 | B300 SXM | $431.75/day | $250/day | 288 GB |
| T5 | GB300 NVL | $499.35/day | $300/day | 288 GB |

---

## 5. Data Model

### 5.1 Entity Relationship

```
┌─────────────┐       ┌─────────────┐       ┌─────────────┐
│    Node     │───────│     Job     │───────│ RoutingLog  │
│             │ 1   n │             │ 1   1 │             │
└─────────────┘       └─────────────┘       └─────────────┘
      │                     │
      │ 1                   │
      │ n                   │
┌─────────────┐             │
│  Heartbeat  │             │
│             │             │
└─────────────┘             │
      │                     │
      │                     │
┌─────────────┐       ┌─────────────┐
│   Earning   │       │ MarketRate  │
│             │       │             │
└─────────────┘       └─────────────┘
```

### 5.2 Key Tables

| Table | Purpose |
|-------|---------|
| Node | GPU nodes registered in the network |
| Heartbeat | Health metrics from nodes |
| Job | Job submissions and their status |
| RoutingLog | Every routing decision with reasoning |
| MarketRate | Current rates from each market |
| MarketRateHistory | Historical rates for analytics |
| Earning | Per-node, per-day earnings ledger |
| Config | System configuration key-value pairs |
| YieldFloor | Yield floor per GPU tier |
| MarketConfig | Market enable/disable flags |

---

## 6. API Design

### 6.1 Main Integration Endpoint

```
POST /v1/route
```

**Request:**
```json
{
  "deploymentId": "#104",
  "gpuTier": "H100",
  "hasInternalDemand": false
}
```

**Response:**
```json
{
  "market": "AKASH",
  "ratePerHour": 5.25,
  "ratePerDay": 126.00,
  "reason": "No internal demand — routing to AKASH ($126.00/day)",
  "timestamp": "2026-03-22T10:30:00Z",
  "yieldFloorApplied": false
}
```

### 6.2 API Endpoints Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /v1/route | Get routing decision (main integration) |
| GET | /v1/nodes | List all nodes |
| POST | /v1/nodes | Register a node |
| POST | /v1/nodes/:id/heartbeat | Send node heartbeat |
| GET | /v1/jobs | List jobs |
| POST | /v1/jobs | Submit a job |
| GET | /v1/rates | Get current market rates |
| GET | /v1/routing-log | Get routing decision history |
| GET | /v1/earnings | Get earnings summary |
| GET | /v1/health | Health check |

---

## 7. Real-time Updates

### 7.1 WebSocket Events

| Event | Payload | Description |
|-------|---------|-------------|
| node:registered | Node | New node came online |
| node:offline | { nodeId } | Node went offline |
| node:heartbeat | { nodeId, metrics } | Heartbeat received |
| job:submitted | Job | New job submitted |
| job:routed | { jobId, decision } | Routing decision made |
| job:completed | Job | Job finished |
| rate:updated | MarketRates | Market rates changed |
| earnings:updated | { nodeId, earnings } | Earnings calculated |

### 7.2 Connection

```javascript
const socket = io('wss://a2e.tokenos.ai', {
  auth: { apiKey: 'your-api-key' }
})

socket.on('job:routed', (data) => {
  console.log(`Job ${data.jobId} routed to ${data.decision.market}`)
})
```

---

## 8. External Market Integration

### 8.1 Adapter Interface

```typescript
interface ExternalMarketAdapter {
  market: 'AKASH' | 'IONET'
  getRate(gpuTier: GpuTier): Promise<MarketRateInfo>
  isEnabled(): boolean
}
```

### 8.2 Rate Fetching

- Rates are fetched every 60 seconds (configurable)
- Cached in Redis with 60-second TTL
- History stored in PostgreSQL for analytics
- Graceful fallback if external API fails

### 8.3 Supported Markets (Phase 1)

| Market | Status | API |
|--------|--------|-----|
| Internal | Always available | Config-based |
| Akash Network | Phase 1 | Public pricing API |
| IO.net | Phase 1 (if available) | TBD |

---

## 9. Deployment Architecture

### 9.1 Infrastructure

```
┌─────────────────────────────────────────────┐
│           Hetzner (135.181.162.188)          │
│                  Proxmox VE                  │
│  ┌─────────────────────────────────────────┐ │
│  │     LXC Container (10.10.10.198)        │ │
│  │  ┌─────────────┐  ┌─────────────┐       │ │
│  │  │   Nginx     │  │    PM2      │       │ │
│  │  │  (Reverse   │  │ (Process    │       │ │
│  │  │   Proxy)    │  │  Manager)   │       │ │
│  │  └─────────────┘  └─────────────┘       │ │
│  │  ┌─────────────┐  ┌─────────────┐       │ │
│  │  │ PostgreSQL  │  │    Redis    │       │ │
│  │  └─────────────┘  └─────────────┘       │ │
│  └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

### 9.2 Deployment Workflow

1. Develop locally
2. Push to GitHub (redstoneai/a2e-engine)
3. SSH to server
4. `cd /opt/a2e && git pull origin main`
5. `pnpm install && pnpm build`
6. `pm2 restart a2e-api`

---

## 10. Security

### 10.1 Authentication

- API Key authentication for all endpoints
- Keys stored securely (environment variables)
- Rate limiting per API key

### 10.2 Data Protection

- No secrets in code
- Environment variables for configuration
- Input validation on all endpoints
- Parameterized queries (Prisma)

---

## 11. Monitoring

### 11.1 Health Checks

- `/health` — Basic liveness check
- `/health/detailed` — Database, Redis, external APIs status

### 11.2 Logging

- Structured JSON logging (pino)
- Request/response logging
- Error tracking with stack traces
- Routing decision audit trail

### 11.3 Metrics (Custom Dashboard)

- Nodes online/offline
- Jobs routed per market
- Average routing decision time
- Earnings per period
- Rate trends

---

## 12. Future Considerations (Phase 2+)

- Custom Operator Dashboard
- Detailed GPU metrics service
- Additional markets (Bittensor, AIOZ, Fluence)
- ML-assisted routing predictions
- TDX attestation integration
- On-chain settlement hooks
