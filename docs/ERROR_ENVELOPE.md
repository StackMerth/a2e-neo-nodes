# Error envelope standard

## Status

Adopted 2026-06-13 as the canonical shape for new internal A2E routes. Existing routes are NOT mass-migrated; the pen-test note that flagged six distinct shapes (Q25, marked cosmetic) confirmed clients work universally across the deviations. Apply the standard going forward to drift toward consistency naturally.

## The shape

```ts
type ErrorBody = {
  error: string         // machine-readable code, snake_case or kebab-case
  message: string       // human-readable explanation
  details?: unknown     // optional structured payload (validation errors, field names, retry hints)
}
```

Status code carries the failure category. Body explains the specifics.

```ts
return reply.code(400).send({
  error: 'validation_error',
  message: 'gpuCount must be between 1 and 8',
  details: parseResult.error.errors,
})

return reply.code(409).send({
  error: 'rental_status_invalid',
  message: `Cannot cancel: status is ${cr.status}`,
})

return reply.code(402).send({
  error: 'insufficient_balance',
  message: 'Balance $1.20 is less than rental cost $5.00',
})

return reply.code(429).send({
  error: 'heartbeat_throttled_pre_verification',
  message: 'Unverified node. Wait 240s and retry.',
  details: { retryAfterSeconds: 240 },
})
```

## Rules

1. **`error`** is the machine-readable code. snake_case (`insufficient_balance`) or kebab-case (`tx-hash-already-consumed`) are both fine. Pick one per route family and stay consistent within the file. **No spaces, no human prose.**
2. **`message`** is the one-line human explanation. Safe to log, safe to surface in UI. **No PII, no raw stack traces, no secrets.**
3. **`details`** is optional. Use for: validation error arrays, retry hints, field names. Do not put unstructured data here.
4. **Status code** does the heavy lifting on category — `400` for client error, `401` for auth missing, `403` for auth present but not permitted, `404` for not found, `409` for state conflict, `422` for semantic validation, `429` for rate-limit, `500` for server error, `502` for upstream failure, `503` for unavailable.

## Exceptions (protocol-mandated, MUST NOT use A2E shape)

| Surface | Required shape | Why |
|---|---|---|
| `routes/inference.ts` (OpenAI-compat) | `{ error: { message, type, code } }` | OpenAI SDK depends on this nested shape |
| `routes/registry-token.ts` (Docker registry V2) | `{ errors: [{ code, message }] }` | Docker registry spec |
| Webhook receivers (Stripe, etc.) | upstream-defined | upstream parser depends on shape |

These are not deviations from the A2E standard — they are a different API contract, owned by an external client.

## Anti-patterns

```ts
// Bad: error doubles as both code and message
reply.code(404).send({ error: 'Withdrawal request not found' })

// Better: code is machine-readable, message is human
reply.code(404).send({ error: 'not_found', message: 'Withdrawal request not found' })
```

```ts
// Bad: missing message
reply.code(400).send({ error: 'Validation Error' })

// Better:
reply.code(400).send({
  error: 'validation_error',
  message: parsed.error.errors[0]?.message ?? 'Invalid input',
})
```

```ts
// Bad: success envelope on the error path
reply.code(500).send({ success: false, message: 'Send failed' })

// Better:
reply.code(500).send({ error: 'send_failed', message: 'Send failed' })
```

## Backfill policy

Do not mass-edit existing routes to match this shape. Reasons:

1. Clients (portal, marketplace, agent, operator dashboards) all read `response.error` today and would not benefit from the rewrite.
2. Every mass-edit risks one of those clients silently breaking on a string-comparison check.
3. The pen-test classifying this as cosmetic confirms no exploitability.

Apply the standard when:
- Writing a new route
- Editing an existing error path for unrelated reasons (refactor passes through)
- A security review finds a route returning unsafe content via the error body (PII, stack traces) — in which case the rewrite has independent justification.
