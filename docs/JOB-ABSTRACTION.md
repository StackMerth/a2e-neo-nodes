# Job Abstraction Specification

> **Project:** A²E Engine for TokenOS
> **Version:** 1.0.0
> **Date:** 2026-03-23

---

## 1. Overview

This document defines how workloads (jobs) are structured, submitted, and tracked within the A²E system. While A²E focuses on routing decisions (determining WHERE to execute), this specification defines the job model that flows through the system.

---

## 2. Job Definition

### 2.1 Job Structure

```typescript
interface Job {
  // Identity
  id: string                    // Unique job identifier (UUID)
  deploymentId: string          // TokenOS deployment reference (e.g., "#104")

  // Resource Requirements
  gpuTier: GpuTier              // Required GPU tier (H100, H200, B200, B300, GB300)
  gpuCount: number              // Number of GPUs needed (default: 1)
  vramRequired?: number         // Minimum VRAM in GB (optional, inferred from tier)

  // Timing
  estimatedDuration?: number    // Expected runtime in seconds (optional)
  maxDuration?: number          // Hard timeout in seconds (optional)
  priority: 'LOW' | 'NORMAL' | 'HIGH'  // Queue priority

  // Routing Context
  hasInternalDemand: boolean    // Whether internal (retail) work is available
  preferredMarket?: Market      // Optional market preference

  // Metadata
  submittedAt: Date             // When job was submitted
  submittedBy: string           // Wallet address or operator ID
  tags?: string[]               // Optional categorization tags
}
```

### 2.2 GPU Tiers

| Tier | GPU Model | VRAM | Typical Workloads |
|------|-----------|------|-------------------|
| H100 | H100 SXM5 | 80 GB | GPT-4 class inference, code generation |
| H200 | H200 SXM5 | 141 GB | Llama 3 405B, Mixtral 8x22B |
| B200 | B200 SXM | 192 GB | Dense MoE, multi-modal |
| B300 | B300 SXM | 288 GB | Frontier reasoning models |
| GB300 | GB300 NVL | 288 GB | AGI-scale inference |

### 2.3 Job Status Lifecycle

```
PENDING → ROUTING → ASSIGNED → RUNNING → COMPLETED
                                    ↓
                                 FAILED → REQUEUED
                                    ↓
                               CANCELLED
```

| Status | Description |
|--------|-------------|
| PENDING | Job submitted, waiting in queue |
| ROUTING | A²E is determining best market |
| ASSIGNED | Market selected, waiting for execution |
| RUNNING | Job is executing on assigned node |
| COMPLETED | Job finished successfully |
| FAILED | Job failed during execution |
| REQUEUED | Failed job returned to queue for retry |
| CANCELLED | Job cancelled by admin or timeout |

---

## 3. Job Submission

### 3.1 Submit Job Request

```http
POST /v1/jobs
Content-Type: application/json
X-API-Key: your-api-key

{
  "deploymentId": "#104",
  "gpuTier": "H100",
  "gpuCount": 1,
  "hasInternalDemand": true,
  "priority": "NORMAL",
  "estimatedDuration": 3600,
  "maxDuration": 7200
}
```

### 3.2 Submit Job Response

```json
{
  "id": "job_abc123",
  "status": "PENDING",
  "deploymentId": "#104",
  "gpuTier": "H100",
  "createdAt": "2026-03-23T10:00:00Z",
  "queuePosition": 3
}
```

---

## 4. Routing Decision

### 4.1 Route Request (Standalone)

For systems that manage their own job queue, use the route endpoint directly:

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

### 4.2 Route Response

```json
{
  "market": "AKASH",
  "ratePerHour": 5.25,
  "ratePerDay": 126.00,
  "reason": "No internal demand — routing to AKASH ($126.00/day)",
  "timestamp": "2026-03-23T10:00:05Z",
  "yieldFloorApplied": false,
  "suggestedNode": "node_xyz789"
}
```

---

## 5. Job Assignment

Once routed, the job is assigned to a specific node or external market:

### 5.1 Internal Assignment

```json
{
  "jobId": "job_abc123",
  "market": "INTERNAL",
  "assignedNode": "node_xyz789",
  "assignedAt": "2026-03-23T10:00:10Z",
  "ratePerHour": 5.84,
  "expectedCompletion": "2026-03-23T11:00:10Z"
}
```

### 5.2 External Assignment (Akash)

```json
{
  "jobId": "job_abc123",
  "market": "AKASH",
  "externalReference": "akash-deployment-id-456",
  "assignedAt": "2026-03-23T10:00:10Z",
  "ratePerHour": 5.25,
  "provider": "akash1abc..."
}
```

---

## 6. Job Completion

### 6.1 Successful Completion

```json
{
  "jobId": "job_abc123",
  "status": "COMPLETED",
  "startedAt": "2026-03-23T10:00:15Z",
  "completedAt": "2026-03-23T10:45:30Z",
  "actualDuration": 2715,
  "gpuSecondsUsed": 2715,
  "earnings": {
    "gross": 4.41,
    "rate": 5.84,
    "market": "INTERNAL"
  }
}
```

### 6.2 Failed Completion

```json
{
  "jobId": "job_abc123",
  "status": "FAILED",
  "failedAt": "2026-03-23T10:15:00Z",
  "failureReason": "NODE_OFFLINE",
  "partialDuration": 900,
  "willRequeue": true,
  "retryCount": 1,
  "maxRetries": 3
}
```

---

## 7. Integration with TokenOS

### 7.1 Minimal Integration (Current)

TokenOS calls A²E for routing decisions only:

```
TokenOS                              A²E
   │                                  │
   │  POST /v1/route                  │
   │  { gpuTier, hasInternalDemand }  │
   │ ────────────────────────────────►│
   │                                  │
   │  { market, rate, reason }        │
   │ ◄────────────────────────────────│
   │                                  │
   ▼
TokenOS executes job based on decision
```

### 7.2 Full Integration (Phase 2)

A²E manages complete job lifecycle:

```
TokenOS                              A²E
   │                                  │
   │  POST /v1/jobs                   │
   │  { full job payload }            │
   │ ────────────────────────────────►│
   │                                  │
   │  { jobId, status: PENDING }      │
   │ ◄────────────────────────────────│
   │                                  │
   │         WebSocket Events         │
   │ ◄────────────────────────────────│
   │  job:routed, job:started,        │
   │  job:completed, job:failed       │
   │                                  │
```

---

## 8. Job Prioritization

### 8.1 Queue Priority

Jobs are processed in priority order:

1. **HIGH** — Urgent jobs, processed first
2. **NORMAL** — Standard jobs (default)
3. **LOW** — Background jobs, processed when capacity available

### 8.2 Tie-Breaking

When priority is equal:
1. Earlier submission time wins
2. Shorter estimated duration wins (faster turnaround)
3. Higher-tier GPU requests processed first (maximize earnings)

---

## 9. Rate Limiting

| Scope | Limit |
|-------|-------|
| Jobs per minute (per API key) | 60 |
| Concurrent jobs (per operator) | 100 |
| Max job duration | 24 hours |
| Max queue depth (system) | 10,000 |

---

## 10. Webhook Notifications (Optional)

Configure webhooks to receive job status updates:

```http
POST /v1/config/webhooks
{
  "url": "https://tokenos.ai/webhooks/a2e",
  "events": ["job:completed", "job:failed"],
  "secret": "webhook-signing-secret"
}
```

Webhook payload:
```json
{
  "event": "job:completed",
  "timestamp": "2026-03-23T10:45:30Z",
  "data": {
    "jobId": "job_abc123",
    "status": "COMPLETED",
    "earnings": 4.41
  },
  "signature": "sha256=..."
}
```
