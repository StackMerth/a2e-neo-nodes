# A2E Database Schema - Entity Relationship Diagram

## Overview

The A2E (Arbitrage-to-Earn) Engine database manages GPU node orchestration, job routing, market rate tracking, and earnings calculation for the TokenOS platform.

---

## Entity Relationship Diagram

```mermaid
erDiagram
    %% ============================================================================
    %% NODES & MONITORING
    %% ============================================================================

    Node {
        String id PK "cuid()"
        String walletAddress UK "unique"
        GpuTier gpuTier "H100, H200, B200, B300, GB300"
        NodeType nodeType "PROVISIONED, BYOG"
        NodeStatus status "ONLINE, DEGRADED, OFFLINE"
        String region "nullable"
        DateTime lastHeartbeat
        Int missedBeats
        DateTime createdAt
        DateTime updatedAt
    }

    Heartbeat {
        String id PK "cuid()"
        String nodeId FK
        Float gpuUtilization "0-100%"
        Float gpuTemperature "Celsius"
        Float gpuMemoryUsed "GB"
        Float gpuMemoryTotal "GB"
        DateTime timestamp
    }

    %% ============================================================================
    %% JOBS & ROUTING
    %% ============================================================================

    Job {
        String id PK "cuid()"
        String deploymentId "external reference"
        String nodeId FK "nullable"
        Market market "INTERNAL, AKASH, IONET"
        Float ratePerHour
        GpuTier gpuTier
        JobStatus status "PENDING, ROUTING, ASSIGNED, RUNNING, COMPLETED, FAILED, CANCELLED"
        DateTime requestedAt
        DateTime routedAt
        DateTime startedAt
        DateTime completedAt
        Int durationSeconds
        Float earnings
        String errorMessage
        Int retryCount
        DateTime createdAt
        DateTime updatedAt
    }

    RoutingLog {
        String id PK "cuid()"
        String jobId FK UK "unique"
        Market selectedMarket
        Float selectedRate
        Float internalRate
        Float akashRate
        Float ionetRate
        Float yieldFloor
        Boolean yieldFloorApplied
        String reason "decision explanation"
        Int decisionTimeMs
        DateTime timestamp
    }

    %% ============================================================================
    %% MARKET RATES
    %% ============================================================================

    MarketRate {
        String id PK "cuid()"
        Market market
        GpuTier gpuTier
        Float ratePerHour
        Float ratePerDay
        Boolean available
        DateTime fetchedAt
    }

    MarketRateHistory {
        String id PK "cuid()"
        Market market
        GpuTier gpuTier
        Float ratePerHour
        Float ratePerDay
        DateTime fetchedAt
    }

    %% ============================================================================
    %% EARNINGS
    %% ============================================================================

    Earning {
        String id PK "cuid()"
        String nodeId FK
        Date date
        Market market
        Int gpuSeconds
        Float earnings
        Int jobCount
        DateTime createdAt
        DateTime updatedAt
    }

    %% ============================================================================
    %% CONFIGURATION
    %% ============================================================================

    Config {
        String key PK
        String value
        DateTime updatedAt
    }

    YieldFloor {
        GpuTier gpuTier PK
        Float ratePerHour
        Float ratePerDay
        DateTime updatedAt
    }

    MarketConfig {
        Market market PK
        Boolean enabled
        Int priority "higher = preferred"
        String apiEndpoint
        DateTime updatedAt
    }

    %% ============================================================================
    %% RELATIONSHIPS
    %% ============================================================================

    Node ||--o{ Heartbeat : "monitors"
    Node ||--o{ Job : "executes"
    Node ||--o{ Earning : "accumulates"
    Job ||--o| RoutingLog : "has routing decision"
```

---

## Table Descriptions

### Core Entities

| Table | Description | Primary Key |
|-------|-------------|-------------|
| **Node** | GPU compute nodes (provisioned or BYOG) | `id` (cuid) |
| **Job** | Compute jobs routed through the A2E engine | `id` (cuid) |
| **Earning** | Daily earnings aggregation per node per market | `id` (cuid) |

### Monitoring & Routing

| Table | Description | Primary Key |
|-------|-------------|-------------|
| **Heartbeat** | Node health metrics (GPU utilization, temp, memory) | `id` (cuid) |
| **RoutingLog** | Routing decision audit trail with rate comparisons | `id` (cuid) |

### Market Data

| Table | Description | Primary Key |
|-------|-------------|-------------|
| **MarketRate** | Current rates per market/GPU tier | `id` (cuid) |
| **MarketRateHistory** | Historical rate snapshots for analysis | `id` (cuid) |

### Configuration

| Table | Description | Primary Key |
|-------|-------------|-------------|
| **Config** | Key-value configuration store | `key` |
| **YieldFloor** | Minimum acceptable rates per GPU tier | `gpuTier` |
| **MarketConfig** | Market-specific settings (enabled, priority, API) | `market` |

---

## Relationships Summary

| Relationship | Type | Description |
|--------------|------|-------------|
| Node -> Heartbeat | One-to-Many | Each node has multiple heartbeat records for monitoring |
| Node -> Job | One-to-Many | Nodes execute multiple jobs over time |
| Node -> Earning | One-to-Many | Daily earnings are tracked per node/market combination |
| Job -> RoutingLog | One-to-One | Each job has one routing decision record |

---

## Enums Reference

### GpuTier
GPU hardware tiers supported by the platform:
- `H100` - NVIDIA H100
- `H200` - NVIDIA H200
- `B200` - NVIDIA B200
- `B300` - NVIDIA B300
- `GB300` - NVIDIA GB300

### NodeType
- `PROVISIONED` - TokenOS provisions from data center
- `BYOG` - Bring Your Own GPU (customer-owned hardware)

### NodeStatus
- `ONLINE` - Node is healthy and accepting jobs
- `DEGRADED` - Node has issues but is partially functional
- `OFFLINE` - Node is not available

### JobStatus
- `PENDING` - Job submitted, waiting for routing
- `ROUTING` - A2E engine is deciding where to route
- `ASSIGNED` - Assigned to a node/market
- `RUNNING` - Job is executing
- `COMPLETED` - Job finished successfully
- `FAILED` - Job failed
- `CANCELLED` - Job was cancelled

### Market
- `INTERNAL` - TokenOS internal (premium retail rate)
- `AKASH` - Akash Network (external marketplace)
- `IONET` - IO.net (external marketplace)

---

## Indexes

The schema includes optimized indexes for common query patterns:

| Table | Index Fields | Purpose |
|-------|--------------|---------|
| Node | `status` | Filter nodes by availability |
| Node | `gpuTier` | Filter nodes by GPU type |
| Node | `lastHeartbeat` | Identify stale nodes |
| Heartbeat | `nodeId, timestamp` | Time-series queries per node |
| Job | `status` | Filter jobs by state |
| Job | `deploymentId` | External system lookups |
| Job | `nodeId` | Jobs per node queries |
| Job | `market` | Market-specific analytics |
| Job | `requestedAt` | Time-based job queries |
| RoutingLog | `selectedMarket` | Market routing analytics |
| RoutingLog | `timestamp` | Time-series routing decisions |
| MarketRate | `market, gpuTier, fetchedAt` | Rate lookups and history |
| MarketRateHistory | `market, gpuTier, fetchedAt` | Historical rate analysis |
| Earning | `nodeId, date` | Earnings per node lookups |
| Earning | `date` | Daily earnings reports |

---

## Unique Constraints

| Table | Unique Fields | Purpose |
|-------|---------------|---------|
| Node | `walletAddress` | One node per wallet |
| RoutingLog | `jobId` | One routing decision per job |
| MarketRate | `market, gpuTier` | One current rate per market/tier |
| Earning | `nodeId, date, market` | One earnings record per node/date/market |

---

*Generated from Prisma schema: `packages/database/prisma/schema.prisma`*
