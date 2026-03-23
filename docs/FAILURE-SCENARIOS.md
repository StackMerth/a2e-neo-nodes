# Failure Scenarios & Recovery Logic

> **Project:** A²E Engine for TokenOS
> **Version:** 1.0.0
> **Date:** 2026-03-23

---

## 1. Overview

This document maps all failure scenarios in the A²E system and defines the recovery logic for each. The goal is to ensure operator earnings are protected and jobs are never lost.

---

## 2. Failure Categories

| Category | Examples | Impact |
|----------|----------|--------|
| Node Failures | Node offline, GPU crash, network loss | Job execution interrupted |
| Market Failures | Akash API down, IO.net unavailable | Cannot route to external market |
| System Failures | Database down, Redis crash, API error | Service degradation |
| Job Failures | Timeout, OOM, application error | Job doesn't complete |
| Rate Failures | Cannot fetch rates, stale data | Routing decisions may be suboptimal |

---

## 3. Node Failure Scenarios

### 3.1 Node Goes Offline (Missed Heartbeat)

**Detection:**
- Node sends heartbeat every 30 seconds
- After 60 seconds without heartbeat → status = `DEGRADED`
- After 90 seconds without heartbeat → status = `OFFLINE`

**Recovery:**
```
Node misses heartbeat
        ↓
Wait 60 seconds
        ↓
Mark node DEGRADED (still receives jobs but flagged)
        ↓
Wait 30 more seconds (90s total)
        ↓
Mark node OFFLINE
        ↓
Exclude from routing decisions
        ↓
Requeue any RUNNING jobs to other nodes
        ↓
Emit WebSocket: node:offline
```

**Operator Impact:** None — jobs automatically rerouted

**Code Reference:** `apps/api/src/jobs/node-health.ts`

---

### 3.2 Node Crashes Mid-Job

**Detection:**
- Heartbeat stops during job execution
- Job status remains RUNNING but node is OFFLINE

**Recovery:**
```
Detect node offline with active jobs
        ↓
For each RUNNING job on this node:
        ↓
    Set job status = FAILED
    Set failureReason = NODE_OFFLINE
    Calculate partial GPU-seconds
    Credit partial earnings to operator
        ↓
    If retryCount < maxRetries (default: 3)
        ↓
        Set job status = REQUEUED
        Return to job queue with same priority
        ↓
    Else
        ↓
        Set job status = CANCELLED
        Notify admin
```

**Operator Impact:** Partial earnings credited for work done

---

### 3.3 Node Reconnects After Failure

**Detection:**
- Heartbeat received from previously OFFLINE node

**Recovery:**
```
Receive heartbeat from OFFLINE node
        ↓
Verify node identity (wallet address)
        ↓
Run health check (GPU available, resources OK)
        ↓
If healthy:
    Set status = ONLINE
    Add back to routing pool
    Emit WebSocket: node:online
        ↓
If unhealthy:
    Keep status = DEGRADED
    Log reason
    Alert admin
```

---

## 4. Market Failure Scenarios

### 4.1 External Market API Unavailable

**Detection:**
- Rate fetch fails (HTTP error, timeout, invalid response)
- Consecutive failures > 3

**Recovery:**
```
Rate fetch fails for AKASH
        ↓
Retry with exponential backoff (1s, 2s, 4s)
        ↓
If all retries fail:
        ↓
    Mark AKASH as unavailable (temporary)
    Use last known rate (if < 5 minutes old)
    OR exclude from routing decisions
        ↓
    Continue fetching every 60s
        ↓
    When API recovers:
        Mark AKASH as available
        Resume normal routing
```

**Operator Impact:** Jobs route to next best available market

---

### 4.2 All External Markets Unavailable

**Detection:**
- Both AKASH and IONET marked unavailable
- No external rates available

**Recovery:**
```
All external markets down
        ↓
Route all jobs to INTERNAL market
        ↓
If no internal demand:
    Hold jobs in queue (PENDING)
    Set maxQueueTime = 30 minutes
        ↓
    If market recovers within 30 min:
        Process queued jobs normally
        ↓
    If timeout reached:
        Route to INTERNAL at yield floor rate
        Log: "External markets unavailable — floor rate applied"
```

**Operator Impact:** Guaranteed yield floor rate — never $0

---

### 4.3 External Market Rejects Job

**Detection:**
- Job submitted to Akash/IO.net returns error
- Deployment fails

**Recovery:**
```
External market rejects job
        ↓
Log rejection reason
        ↓
If reason is temporary (capacity, rate limit):
    Wait 30 seconds
    Retry same market (max 2 retries)
        ↓
If reason is permanent (invalid job, unsupported GPU):
    Route to next best market
        ↓
If all markets reject:
    Hold in INTERNAL queue
    Alert admin
```

---

## 5. System Failure Scenarios

### 5.1 Database Unavailable

**Detection:**
- Prisma connection fails
- Queries timeout

**Recovery:**
```
Database connection lost
        ↓
API continues running (degraded mode)
        ↓
Routing decisions use Redis cache
    (rates cached, recent decisions cached)
        ↓
New jobs held in Redis queue
    (not persisted to DB yet)
        ↓
Health endpoint returns: { database: "ERROR" }
        ↓
When DB recovers:
    Flush Redis queue to database
    Verify data integrity
    Resume normal operation
```

**Operator Impact:** Service continues — no data loss

---

### 5.2 Redis Unavailable

**Detection:**
- Redis connection fails
- BullMQ queues inaccessible

**Recovery:**
```
Redis connection lost
        ↓
Job queue stops processing
        ↓
API continues accepting requests
    (writes directly to PostgreSQL)
        ↓
Routing uses database queries (slower)
        ↓
Health endpoint returns: { redis: "ERROR" }
        ↓
When Redis recovers:
    BullMQ resumes from last checkpoint
    Rate caching resumes
```

**Operator Impact:** Slower response times, but no data loss

---

### 5.3 API Server Crashes

**Detection:**
- PM2 detects process exit
- Health check fails

**Recovery:**
```
API process crashes
        ↓
PM2 detects within 1 second
        ↓
PM2 auto-restarts process
        ↓
Process loads state from database
        ↓
BullMQ reconnects and resumes queue
        ↓
WebSocket clients auto-reconnect
        ↓
Service restored (typically < 5 seconds)
```

**Operator Impact:** Brief interruption — requests during crash return 503

---

## 6. Job Failure Scenarios

### 6.1 Job Timeout

**Detection:**
- Job exceeds maxDuration
- No completion signal received

**Recovery:**
```
Job exceeds maxDuration
        ↓
Send termination signal to node
        ↓
Wait 30 seconds for graceful shutdown
        ↓
If no response:
    Force mark job as FAILED
    Reason: TIMEOUT
        ↓
Calculate billable GPU-seconds (capped at maxDuration)
Credit earnings to operator
        ↓
If job is retriable:
    Requeue with fresh timeout
```

---

### 6.2 Job Out of Memory (OOM)

**Detection:**
- Node reports OOM error
- GPU memory exhausted

**Recovery:**
```
OOM detected
        ↓
Job marked FAILED
Reason: OUT_OF_MEMORY
        ↓
Do NOT requeue to same tier
        ↓
If higher tier available:
    Suggest upgrade: "Job requires H200 (141GB) instead of H100 (80GB)"
        ↓
Notify job submitter
```

---

### 6.3 Application Error

**Detection:**
- Job returns non-zero exit code
- Application-level error

**Recovery:**
```
Application error detected
        ↓
Log error details
Job marked FAILED
Reason: APPLICATION_ERROR
        ↓
Do NOT auto-requeue (likely to fail again)
        ↓
Notify job submitter with error details
        ↓
Partial earnings credited if work was done
```

---

## 7. Rate Failure Scenarios

### 7.1 Stale Rate Data

**Detection:**
- Rate data older than 5 minutes
- Rate fetch jobs failing

**Recovery:**
```
Rate data is stale (> 5 minutes old)
        ↓
Log warning
        ↓
For routing decisions:
    Use stale rate with warning flag
    Response includes: "rateDataAge": 360
        ↓
Continue attempting fresh fetches
        ↓
If stale > 30 minutes:
    Exclude market from routing
    Log: "Market excluded due to stale data"
```

---

### 7.2 Rate Anomaly Detected

**Detection:**
- Rate changes > 50% in 5 minutes
- Rate outside expected bounds

**Recovery:**
```
Anomaly: AKASH rate jumped from $5 to $15
        ↓
Flag rate as suspicious
        ↓
Fetch rate again (verification)
        ↓
If verified:
    Accept new rate
    Log unusual movement
        ↓
If not verified:
    Use previous rate
    Alert admin: "Rate anomaly detected"
```

---

## 8. Recovery Summary Table

| Scenario | Detection Time | Recovery Time | Data Loss | Operator Impact |
|----------|---------------|---------------|-----------|-----------------|
| Node offline | 90 seconds | Immediate reroute | None | None |
| Node crash mid-job | 90 seconds | < 5 minutes | None | Partial earnings |
| Market API down | 3 retries (~10s) | Auto when restored | None | Routes elsewhere |
| Database down | Immediate | Auto when restored | None | Degraded mode |
| Redis down | Immediate | Auto when restored | None | Slower responses |
| API crash | < 1 second | < 5 seconds | None | Brief 503 errors |
| Job timeout | At maxDuration | Immediate | None | Partial earnings |
| Job OOM | Immediate | Manual intervention | None | Job fails |
| Stale rates | 5 minutes | Auto fetch | None | Warning flag |

---

## 9. Alerting

### 9.1 Alert Levels

| Level | Scenarios | Action |
|-------|-----------|--------|
| INFO | Node reconnected, rate updated | Log only |
| WARNING | Node degraded, stale rates, single market down | Log + dashboard |
| ERROR | Node offline with jobs, all markets down | Log + dashboard + notification |
| CRITICAL | Database down, API crash, data integrity issue | Immediate notification |

### 9.2 Notification Channels

- Dashboard alerts panel (real-time)
- WebSocket events to connected clients
- Webhook to configured endpoints (optional)

---

## 10. Testing Failure Scenarios

### 10.1 Simulate Node Failure

```bash
# Stop sending heartbeats for a node
curl -X DELETE https://a2e.byredstone.com/v1/nodes/{nodeId}/heartbeat-test

# Verify node goes DEGRADED after 60s, OFFLINE after 90s
```

### 10.2 Simulate Market Failure

```bash
# Disable Akash market temporarily
curl -X PATCH https://a2e.byredstone.com/v1/config/markets \
  -H "X-API-Key: your-key" \
  -d '{"market": "AKASH", "enabled": false}'

# Verify jobs route to next best market
```

### 10.3 Simulate Rate Anomaly

```bash
# Inject test rate (admin only)
curl -X POST https://a2e.byredstone.com/v1/rates/test \
  -H "X-API-Key: admin-key" \
  -d '{"market": "AKASH", "gpuTier": "H100", "ratePerHour": 50.00}'

# Verify anomaly detection triggers
```
