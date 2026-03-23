# Arbitrage Rule Set Design

> **Project:** A²E Engine for TokenOS
> **Version:** 1.0.0
> **Date:** 2026-03-23

---

## 1. Overview

The A²E (Arbitrage & Orchestration Engine) makes routing decisions to maximize operator earnings. This document defines the complete rule set governing these decisions.

---

## 2. Core Principle

> **Route every idle GPU-second to its highest-paying buyer.**

The engine prioritizes:
1. **Internal demand** — Premium retail rate (TokenOS agent tasks)
2. **External markets** — Wholesale rates (Akash, IO.net) when no internal demand
3. **Yield floor** — Guaranteed minimum regardless of market conditions

---

## 3. Decision Variables

### 3.1 Input Variables

| Variable | Type | Description |
|----------|------|-------------|
| `gpuTier` | Enum | GPU tier (H100, H200, B200, B300, GB300) |
| `hasInternalDemand` | Boolean | Whether internal (retail) work is available |
| `deploymentId` | String | Reference to TokenOS deployment |
| `nodeId` | String | Specific node (optional, for override) |

### 3.2 Rate Variables

| Variable | Source | Update Frequency |
|----------|--------|------------------|
| `internalRate` | TokenOS config | Static (configured) |
| `akashRate` | Akash Network API | Every 60 seconds |
| `ionetRate` | IO.net API | Every 60 seconds |
| `yieldFloor` | System config | Admin-configurable |

### 3.3 Output Variables

| Variable | Type | Description |
|----------|------|-------------|
| `market` | Enum | Selected market (INTERNAL, AKASH, IONET) |
| `ratePerHour` | Float | Effective hourly rate |
| `ratePerDay` | Float | Effective daily rate |
| `reason` | String | Human-readable decision explanation |
| `yieldFloorApplied` | Boolean | Whether floor rate was enforced |

---

## 4. Rule Set

### Rule 1: Internal Demand Priority

```
IF hasInternalDemand = TRUE
AND internalMarket.available = TRUE
THEN
    SELECT market = INTERNAL
    SET rate = internalRate[gpuTier]
    SET reason = "Internal demand available — premium retail rate"
```

**Rationale:** Internal jobs pay premium retail rates and support TokenOS's core product.

---

### Rule 2: External Market Selection

```
IF hasInternalDemand = FALSE
THEN
    FETCH rates FROM [AKASH, IONET] WHERE market.enabled = TRUE

    FOR EACH market IN availableMarkets:
        IF market.available = TRUE:
            ADD TO candidates

    IF candidates.length > 0:
        SELECT market = MAX(candidates, BY rate)
        SET rate = selectedMarket.rate
        SET reason = "No internal demand — routing to {market} (${rate}/day)"
```

**Rationale:** Maximize operator earnings by selecting highest-paying external market.

---

### Rule 3: Yield Floor Enforcement

```
IF selectedRate < yieldFloor[gpuTier]
THEN
    SET effectiveRate = yieldFloor[gpuTier]
    SET yieldFloorApplied = TRUE
    SET reason = "{market} rate below floor — yield floor applied (${floor}/day)"
```

**Rationale:** Guarantee minimum earnings regardless of market conditions.

---

### Rule 4: No Markets Available

```
IF availableMarkets.length = 0
AND hasInternalDemand = FALSE
THEN
    SELECT market = INTERNAL
    SET rate = yieldFloor[gpuTier]
    SET yieldFloorApplied = TRUE
    SET reason = "No external markets available — reserved at floor rate"
```

**Rationale:** Never leave nodes idle — always assign at minimum floor rate.

---

### Rule 5: Market Disabled Override

```
IF market.enabled = FALSE (via admin config)
THEN
    EXCLUDE market FROM routing decisions
    LOG "Market {market} disabled by admin"
```

**Rationale:** Allow admin to disable problematic markets without code changes.

---

## 5. Rate Configuration

### 5.1 Internal Rates (Retail)

| GPU Tier | Daily Rate | Hourly Rate |
|----------|------------|-------------|
| H100 | $140.15 | $5.84 |
| H200 | $179.85 | $7.49 |
| B200 | $321.10 | $13.38 |
| B300 | $431.75 | $17.99 |
| GB300 | $499.35 | $20.81 |

### 5.2 Yield Floor (Minimum Guarantee)

| GPU Tier | Daily Floor | Hourly Floor |
|----------|-------------|--------------|
| H100 | $83.00 | $3.46 |
| H200 | $105.00 | $4.38 |
| B200 | $170.00 | $7.08 |
| B300 | $250.00 | $10.42 |
| GB300 | $300.00 | $12.50 |

### 5.3 External Rate Bounds

Sanity checks to detect anomalies:

| GPU Tier | Min Expected | Max Expected |
|----------|--------------|--------------|
| H100 | $2.00/hr | $15.00/hr |
| H200 | $3.00/hr | $20.00/hr |
| B200 | $5.00/hr | $30.00/hr |
| B300 | $8.00/hr | $40.00/hr |
| GB300 | $10.00/hr | $50.00/hr |

---

## 6. Decision Flow Diagram

```
                    ┌──────────────────────────────┐
                    │     Routing Request          │
                    │  { gpuTier, hasInternalDemand }
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │   Has Internal Demand?       │
                    └──────────────┬───────────────┘
                                   │
              ┌────────────────────┴────────────────────┐
              │ YES                                     │ NO
              ▼                                         ▼
   ┌─────────────────────┐               ┌─────────────────────────┐
   │ Route to INTERNAL   │               │ Fetch External Rates    │
   │ Rate = Retail Rate  │               │ (AKASH, IONET)          │
   └──────────┬──────────┘               └────────────┬────────────┘
              │                                       │
              │                                       ▼
              │                          ┌─────────────────────────┐
              │                          │ Any Markets Available?  │
              │                          └────────────┬────────────┘
              │                                       │
              │                    ┌──────────────────┴──────────────────┐
              │                    │ YES                                 │ NO
              │                    ▼                                     ▼
              │       ┌─────────────────────────┐         ┌─────────────────────┐
              │       │ Select Highest Rate     │         │ Reserve for Internal │
              │       │ Among Available Markets │         │ at Floor Rate        │
              │       └────────────┬────────────┘         └──────────┬──────────┘
              │                    │                                  │
              │                    ▼                                  │
              │       ┌─────────────────────────┐                     │
              │       │ Rate >= Yield Floor?    │                     │
              │       └────────────┬────────────┘                     │
              │                    │                                  │
              │         ┌──────────┴──────────┐                       │
              │         │ YES                 │ NO                    │
              │         ▼                     ▼                       │
              │  ┌─────────────┐    ┌─────────────────┐               │
              │  │ Use Market  │    │ Apply Floor     │               │
              │  │ Rate        │    │ Rate            │               │
              │  └──────┬──────┘    └────────┬────────┘               │
              │         │                    │                        │
              └─────────┴────────────────────┴────────────────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │      Return Decision         │
                    │  { market, rate, reason }    │
                    └──────────────────────────────┘
```

---

## 7. Edge Cases

### 7.1 Tie Between External Markets

```
IF akashRate = ionetRate
THEN
    SELECT market WITH higher historicalReliability
    IF equal: SELECT AKASH (default preference)
```

### 7.2 Internal Rate Lower Than External

```
IF hasInternalDemand = TRUE
AND externalRate > internalRate
THEN
    STILL SELECT INTERNAL (Rule 1 takes priority)

    NOTE: Internal demand ensures TokenOS agents get compute.
          This is a business decision, not a bug.

    FUTURE: Make this configurable (Phase 2)
```

### 7.3 Rate Fetch Failure

```
IF rateFetch(market) FAILS
THEN
    IF cachedRate.age < 5 minutes:
        USE cachedRate WITH warning flag
    ELSE:
        EXCLUDE market FROM this decision
        LOG "Stale rate data for {market}"
```

### 7.4 All Rates Below Floor

```
IF ALL externalRates < yieldFloor
THEN
    SELECT market = HIGHEST(externalRates)
    SET effectiveRate = yieldFloor
    SET yieldFloorApplied = TRUE
    SET reason = "All markets below floor — floor rate applied"
```

---

## 8. Configurable Parameters

Admins can adjust these without code changes:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `yieldFloor[tier]` | See Section 5.2 | Minimum rate per GPU tier |
| `market[name].enabled` | true | Enable/disable specific market |
| `rateFetchInterval` | 60 seconds | How often to fetch external rates |
| `rateStaleThreshold` | 5 minutes | When to consider rate data stale |
| `rateAnomalyThreshold` | 50% | Rate change that triggers anomaly alert |

---

## 9. Logging & Audit

Every routing decision is logged:

```json
{
  "id": "log_abc123",
  "timestamp": "2026-03-23T10:30:00Z",
  "request": {
    "deploymentId": "#104",
    "gpuTier": "H100",
    "hasInternalDemand": false
  },
  "decision": {
    "market": "AKASH",
    "ratePerHour": 5.25,
    "ratePerDay": 126.00,
    "yieldFloorApplied": false
  },
  "context": {
    "internalRate": 5.84,
    "akashRate": 5.25,
    "ionetRate": 4.80,
    "yieldFloor": 3.46,
    "akashAvailable": true,
    "ionetAvailable": true
  },
  "reason": "No internal demand — routing to AKASH ($126.00/day)",
  "decisionTimeMs": 12
}
```

---

## 10. Future Enhancements (Phase 2+)

| Enhancement | Description |
|-------------|-------------|
| SLA scoring | Factor in market reliability, not just rate |
| Predictive routing | ML model to predict rate movements |
| Operator preferences | Let operators set market preferences |
| Time-of-day pricing | Different rates for peak/off-peak |
| Spot vs reserved | Support different pricing tiers |
| Multi-GPU jobs | Route jobs requiring multiple GPUs |
