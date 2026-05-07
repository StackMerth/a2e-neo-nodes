/**
 * Idempotency / dedup tests for POST /v1/buyer/compute/request.
 *
 * Two layers of defence covered here:
 *   - Layer 1 (Idempotency-Key header): exercised by checkIdempotencyKey
 *     under services/idempotency/. The existing keys.ts tests already cover
 *     hash-mismatch + expiry; we re-verify that the route correctly wires
 *     into that machinery via a thin route boot.
 *   - Layer 2 (txHash dedup): direct prisma stub. This is the more critical
 *     defence — even buyers who don't send Idempotency-Key cannot
 *     double-submit because the same Solana tx hash maps to a single
 *     compute request.
 *
 * We boot a minimal Fastify instance with the buyer-compute routes mounted
 * and exercise via fastify.inject() so the route logic runs end-to-end.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

import { buyerComputeRoutes } from '../buyer-compute'

interface ComputeRequestRow {
  id: string
  userId: string
  txHash: string
  gpuTier: string
  gpuCount: number
  durationDays: number
  ratePerDay: number
  totalCost: number
  status: string
}

function buildPrismaStub(seed: ComputeRequestRow[] = []) {
  const rows: ComputeRequestRow[] = [...seed]
  return {
    rows,
    findFirstSpy: vi.fn(async ({ where }: { where: { userId: string; txHash: string } }) => {
      return rows.find((r) => r.userId === where.userId && r.txHash === where.txHash) ?? null
    }),
    createSpy: vi.fn(async ({ data }: { data: Omit<ComputeRequestRow, 'id'> }) => {
      const row: ComputeRequestRow = { id: `cr-${rows.length + 1}`, ...data }
      rows.push(row)
      return row
    }),
    user: {
      findMany: vi.fn(async () => []),
    },
    idempotencyKey: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
      upsert: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  }
}

async function buildApp(prismaStub: ReturnType<typeof buildPrismaStub>) {
  const app = Fastify({ logger: false })

  // Decorators expected by buyer-compute (auth + role gate). For the tests we
  // bypass them by stuffing a known userId onto the request and approving
  // every role check. The 'as never' casts skip Fastify's strict
  // GetterSetter signature — the runtime behaviour is what we're testing.
  app.decorate('authenticate', (async (request: { user: { userId: string } }) => {
    request.user = { userId: 'user-buyer-1' }
  }) as never)
  app.decorate('requireRole', (() => async () => undefined) as never)

  app.decorate('prisma', {
    computeRequest: {
      count: vi.fn(async () => 0),
      aggregate: vi.fn(async () => ({ _sum: { totalCost: 0 } })),
      findFirst: prismaStub.findFirstSpy,
      findMany: vi.fn(async () => prismaStub.rows),
      create: prismaStub.createSpy,
      update: vi.fn(async () => ({})),
    },
    user: prismaStub.user,
    idempotencyKey: prismaStub.idempotencyKey,
  } as never)

  await app.register(buyerComputeRoutes)
  await app.ready()
  return app
}

const validBody = {
  gpuTier: 'H100',
  gpuCount: 1,
  durationDays: 30,
  txHash: '5sFqZbR3nT8aVwPUJxLkM2nQwY9ZcXk1bN4mRsT3dF6gH7iJ8kL9nM0pQ1rS2tU3vW4xY5zA6bC7',
}

describe('POST /v1/buyer/compute/request — idempotency / dedup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates a new compute request when no prior request exists for this user+txHash', async () => {
    const stub = buildPrismaStub()
    const app = await buildApp(stub)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/buyer/compute/request',
      payload: validBody,
    })

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.id).toBe('cr-1')
    expect(body.gpuTier).toBe('H100')
    expect(stub.createSpy).toHaveBeenCalledOnce()

    await app.close()
  })

  it('returns the existing record when the same user re-submits with the same txHash (double-click defence)', async () => {
    const seed: ComputeRequestRow = {
      id: 'cr-existing-99',
      userId: 'user-buyer-1',
      txHash: validBody.txHash,
      gpuTier: 'H100',
      gpuCount: 1,
      durationDays: 30,
      ratePerDay: 140.15,
      totalCost: 140.15 * 1 * 30,
      status: 'PENDING',
    }
    const stub = buildPrismaStub([seed])
    const app = await buildApp(stub)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/buyer/compute/request',
      payload: validBody,
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['x-idempotency-replay']).toBe('tx-hash')
    const body = response.json()
    expect(body.id).toBe('cr-existing-99')

    // The critical assertion: the dedup short-circuit prevented a second
    // computeRequest.create call. No double-charge, no duplicate row.
    expect(stub.createSpy).not.toHaveBeenCalled()

    await app.close()
  })

  it('treats a different txHash from the same user as a separate request', async () => {
    const seed: ComputeRequestRow = {
      id: 'cr-existing-99',
      userId: 'user-buyer-1',
      txHash: 'totally-different-tx',
      gpuTier: 'H100',
      gpuCount: 1,
      durationDays: 30,
      ratePerDay: 140.15,
      totalCost: 4204.5,
      status: 'PENDING',
    }
    const stub = buildPrismaStub([seed])
    const app = await buildApp(stub)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/buyer/compute/request',
      payload: validBody,
    })

    expect(response.statusCode).toBe(201)
    expect(stub.createSpy).toHaveBeenCalledOnce()

    await app.close()
  })

  it('replays the cached response when the same Idempotency-Key is re-sent', async () => {
    const stub = buildPrismaStub()
    const app = await buildApp(stub)

    // First call seeds the idempotency cache via upsert.
    let stored: { statusCode: number; body: unknown } | null = null
    stub.idempotencyKey.findUnique = vi.fn(async () => null)
    stub.idempotencyKey.upsert = vi.fn(async ({ create }: { create: { statusCode: number; responseBody: string } }) => {
      stored = { statusCode: create.statusCode, body: JSON.parse(create.responseBody) }
      return create
    }) as never

    const first = await app.inject({
      method: 'POST',
      url: '/v1/buyer/compute/request',
      headers: { 'idempotency-key': 'idem-test-1' },
      payload: validBody,
    })
    expect(first.statusCode).toBe(201)
    expect(stub.createSpy).toHaveBeenCalledOnce()
    expect(stored).not.toBeNull()

    // Wire up the cache so the second call sees a hit. We also need to
    // remove the prior compute-request row so the txHash dedup (layer 2)
    // doesn't short-circuit before layer 1 is reached.
    stub.rows.length = 0
    const crypto = await import('crypto')
    const requestHash = crypto.createHash('sha256').update(JSON.stringify(validBody)).digest('hex')
    stub.idempotencyKey.findUnique = vi.fn(async () => ({
      id: 'idem-test-1',
      endpoint: '/v1/buyer/compute/request',
      requestHash,
      statusCode: stored!.statusCode,
      responseBody: JSON.stringify(stored!.body),
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
    })) as never

    // Second call: replay
    const second = await app.inject({
      method: 'POST',
      url: '/v1/buyer/compute/request',
      headers: { 'idempotency-key': 'idem-test-1' },
      payload: validBody,
    })
    expect(second.statusCode).toBe(201)
    expect(second.headers['x-idempotency-replay']).toBe('true')
    // No second create call — cached response replayed.
    expect(stub.createSpy).toHaveBeenCalledOnce()

    await app.close()
  })
})
