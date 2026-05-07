/**
 * Email sender — health snapshot tests.
 *
 * The integration code is exercised by the existing notification flow tests;
 * here we cover only the new health-state machinery so the /health/detailed
 * endpoint reports something useful when SMTP misbehaves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@a2e/database', () => ({
  prisma: {
    config: {
      findMany: vi.fn(async () => []),
    },
  },
}))

import { _resetEmailHealthForTests, getEmailHealth, sendEmail } from '../sender'

describe('email health snapshot', () => {
  beforeEach(() => {
    _resetEmailHealthForTests()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports unconfigured before any send is attempted', () => {
    const h = getEmailHealth()
    expect(h.status).toBe('unconfigured')
    expect(h.totalSent).toBe(0)
    expect(h.totalFailed).toBe(0)
    expect(h.lastSendSucceededAt).toBeNull()
  })

  it('flips to unconfigured + increments failure counters when send is called without SMTP config', async () => {
    const result = await sendEmail('alice@example.com', 'Test', '<p>hi</p>')
    expect(result).toBe(false)

    const h = getEmailHealth()
    expect(h.status).toBe('unconfigured')
    expect(h.totalFailed).toBe(1)
    expect(h.consecutiveFailures).toBe(1)
    expect(h.lastSendFailedAt).toBeTruthy()
    expect(h.lastFailureReason).toMatch(/SMTP not configured/)
  })

  it('logs the unconfigured warning at error level only once per process', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await sendEmail('a@example.com', 's', 'h')
    await sendEmail('b@example.com', 's', 'h')
    await sendEmail('c@example.com', 's', 'h')

    // First call logs once; subsequent calls suppress the log to avoid flooding pm2 output.
    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(errSpy.mock.calls[0]![0]).toMatch(/SMTP unconfigured/)

    const h = getEmailHealth()
    expect(h.totalFailed).toBe(3)
    expect(h.consecutiveFailures).toBe(3)
    expect(h.status).toBe('unconfigured')
  })
})
