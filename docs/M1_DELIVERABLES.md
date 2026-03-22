# Milestone 1 Deliverables

> **Project:** A²E Engine for TokenOS
> **Milestone:** M1 — Architecture & Design
> **Status:** Complete
> **Date:** 2026-03-22

---

## What Was Delivered

### 1. System Architecture Document
**File:** [ARCHITECTURE.md](./ARCHITECTURE.md)

Complete technical design including:
- System overview and data flow diagrams
- Service architecture (API, Core Engine, Database, Dashboard)
- A²E routing logic flowchart
- GPU tier configuration with rates
- API endpoint summary
- WebSocket events specification
- Deployment architecture
- Security considerations

### 2. API Contract (OpenAPI Specification)
**File:** [openapi.yaml](./openapi.yaml)

Full API specification with 30+ endpoints:
- `POST /v1/route` — Main integration point for TokenOS
- Node management (register, heartbeat, list)
- Job management (submit, track, status)
- Rate queries (current rates, history)
- Routing decision log
- Earnings and reporting
- Configuration management
- Health checks

**View Interactive API Docs:** https://editor.swagger.io (paste openapi.yaml contents)

### 3. Database Schema
**File:** [../packages/database/prisma/schema.prisma](../packages/database/prisma/schema.prisma)
**Visual Diagram:** [database-erd.md](./database-erd.md)

10 tables designed:
| Table | Purpose |
|-------|---------|
| Node | GPU nodes registered in network |
| Heartbeat | Node health metrics over time |
| Job | Job submissions and lifecycle |
| RoutingLog | Every A²E routing decision with reasoning |
| MarketRate | Current rates from each market |
| MarketRateHistory | Historical rate data |
| Earning | Per-node, per-day earnings ledger |
| Config | System configuration |
| YieldFloor | Minimum rate per GPU tier |
| MarketConfig | Market enable/disable flags |

### 4. Core Engine Implementation
**Files:** `packages/core/src/`

- `routing-engine.ts` — A²E arbitrage logic
- `rate-provider.ts` — Rate fetching and caching
- `yield-floor.ts` — Yield floor management

### 5. Project Scaffolding
Monorepo structure with:
- TypeScript configuration
- pnpm workspaces
- Turborepo build system
- Development environment setup

---

## How to Verify

### Option 1: View on GitHub
Repository: https://github.com/redstoneai/a2e-engine (private)

Key files to review:
- `docs/ARCHITECTURE.md`
- `docs/openapi.yaml`
- `docs/database-erd.md`
- `packages/database/prisma/schema.prisma`

### Option 2: View API Spec Visually
1. Go to https://editor.swagger.io
2. File → Import URL or paste contents of `docs/openapi.yaml`
3. Browse all endpoints interactively

### Option 3: Review Architecture Document
Open `docs/ARCHITECTURE.md` — includes:
- ASCII diagrams of system architecture
- Flowchart of routing decision logic
- Table of GPU tiers with rates

---

## Integration Preview

The main integration point for TokenOS is a single API call:

**Request:**
```http
POST /v1/route
Content-Type: application/json
X-API-Key: your-api-key

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

---

## A²E Routing Logic Summary

```
┌─────────────────────────────────────┐
│         Job Routing Request         │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│     Has Internal Demand?            │
└─────────────────┬───────────────────┘
                  │
     ┌────────────┴────────────┐
     │ YES                     │ NO
     ▼                         ▼
┌──────────────┐    ┌─────────────────────┐
│ Route to     │    │ Compare External    │
│ INTERNAL     │    │ Markets (Akash,     │
│ (Premium     │    │ IO.net)             │
│  Rate)       │    └──────────┬──────────┘
└──────────────┘               │
                               ▼
                    ┌─────────────────────┐
                    │ Route to Highest    │
                    │ Paying Market       │
                    │ (Above Yield Floor) │
                    └─────────────────────┘
```

---

## GPU Tier Rates (from TokenOS docs)

| Tier | GPU | Retail Rate (Internal) | Cost Floor (Min) |
|------|-----|------------------------|------------------|
| T1 | H100 SXM5 | $140.15/day | $83/day |
| T2 | H200 SXM5 | $179.85/day | $105/day |
| T3 | B200 SXM | $321.10/day | $170/day |
| T4 | B300 SXM | $431.75/day | $250/day |
| T5 | GB300 NVL | $499.35/day | $300/day |

---

## Next Steps (M2)

Once M1 is approved, M2 will implement:
- Working API server with all endpoints
- Node registration and heartbeat system
- Real Akash Network rate fetching
- Job routing with live decisions
- WebSocket real-time updates
- Unit tests for routing logic

The client will be able to:
- Register test nodes via API
- Submit jobs and see routing decisions
- View live rate comparisons

---

## Questions?

Contact us to schedule a walkthrough of the architecture.
