import type { FastifyInstance } from 'fastify'

export async function buyerBillingRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', fastify.requireRole('COMPUTE_BUYER', 'ADMIN'))

  /**
   * GET /v1/buyer/billing — Billing overview
   */
  fastify.get('/v1/buyer/billing', async (request, reply) => {
    const userId = request.user!.userId

    const requests = await fastify.prisma.computeRequest.findMany({
      where: { userId },
      orderBy: { requestedAt: 'desc' },
      select: {
        id: true, gpuTier: true, gpuCount: true, durationDays: true,
        ratePerDay: true, totalCost: true, status: true, txHash: true,
        currency: true, requestedAt: true, activatedAt: true, expiresAt: true, completedAt: true,
        co2Grams: true,
      },
    })

    // Group by month
    const byMonth: Record<string, { month: string; requests: typeof requests; total: number; co2Grams: number }> = {}
    for (const req of requests) {
      const date = new Date(req.requestedAt)
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      const label = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long' })
      if (!byMonth[key]) byMonth[key] = { month: label, requests: [], total: 0, co2Grams: 0 }
      byMonth[key].requests.push(req)
      if (['ACTIVE', 'COMPLETED'].includes(req.status)) {
        byMonth[key].total += req.totalCost
        byMonth[key].co2Grams += req.co2Grams ?? 0
      }
    }

    const totalSpent = requests
      .filter(r => ['ACTIVE', 'COMPLETED'].includes(r.status))
      .reduce((sum, r) => sum + r.totalCost, 0)

    // M5.8 / D3: lifetime CO2 emitted across this buyer's rentals.
    const totalCo2Grams = requests
      .filter(r => ['ACTIVE', 'COMPLETED'].includes(r.status))
      .reduce((sum, r) => sum + (r.co2Grams ?? 0), 0)

    const activeCount = requests.filter(r => r.status === 'ACTIVE').length
    const totalRequests = requests.length

    reply.send({
      totalSpent,
      totalCo2Grams: Number(totalCo2Grams.toFixed(2)),
      activeSubscriptions: activeCount,
      totalRequests,
      currency: 'USD',
      months: Object.values(byMonth).sort((a, b) => b.month.localeCompare(a.month)),
    })
  })

  /**
   * GET /v1/buyer/billing/invoice/:requestId — Generate invoice HTML
   */
  fastify.get('/v1/buyer/billing/invoice/:requestId', async (request, reply) => {
    const { requestId } = request.params as { requestId: string }
    const userId = request.user!.userId

    const cr = await fastify.prisma.computeRequest.findFirst({
      where: { id: requestId, userId },
      include: { user: { select: { email: true, walletAddress: true } } },
    })

    if (!cr) return reply.code(404).send({ error: 'Request not found' })

    const invoiceDate = cr.activatedAt ?? cr.approvedAt ?? cr.requestedAt
    const invoiceNumber = `INV-${cr.id.slice(0, 8).toUpperCase()}`

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Invoice ${invoiceNumber}</title>
  <style>
    body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1a1a1a; margin: 0; padding: 40px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 40px; }
    .logo { font-size: 28px; font-weight: 700; }
    .logo span { color: #22c55e; }
    .invoice-info { text-align: right; }
    .invoice-info h2 { margin: 0; font-size: 24px; color: #22c55e; }
    .invoice-info p { margin: 4px 0; color: #666; font-size: 14px; }
    .divider { border: none; border-top: 2px solid #22c55e; margin: 20px 0; }
    .section { margin-bottom: 24px; }
    .section h3 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; color: #999; margin-bottom: 8px; }
    .section p { margin: 4px 0; font-size: 14px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th { text-align: left; padding: 10px 12px; background: #f5f5f5; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #666; }
    td { padding: 12px; border-bottom: 1px solid #eee; font-size: 14px; }
    .total-row td { font-weight: 700; font-size: 16px; border-top: 2px solid #1a1a1a; border-bottom: none; }
    .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #999; font-size: 12px; }
    .status { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
    .status-active { background: #dcfce7; color: #16a34a; }
    .status-completed { background: #f3f4f6; color: #6b7280; }
    .status-pending { background: #fef3c7; color: #d97706; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="logo">A<sup>2</sup><span>E</span> Engine</div>
      <p style="color: #666; margin-top: 4px;">TokenOS Compute Platform</p>
    </div>
    <div class="invoice-info">
      <h2>INVOICE</h2>
      <p>${invoiceNumber}</p>
      <p>Date: ${new Date(invoiceDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
      <p>Status: <span class="status status-${cr.status.toLowerCase()}">${cr.status}</span></p>
    </div>
  </div>

  <hr class="divider">

  <div style="display: flex; justify-content: space-between;">
    <div class="section">
      <h3>Bill To</h3>
      <p>${cr.user.email ?? 'N/A'}</p>
      <p style="font-family: monospace; font-size: 12px;">${cr.user.walletAddress ? cr.user.walletAddress.slice(0, 12) + '...' : 'N/A'}</p>
    </div>
    <div class="section" style="text-align: right;">
      <h3>Payment</h3>
      <p>Currency: ${cr.currency}</p>
      ${cr.txHash ? `<p style="font-family: monospace; font-size: 12px;">TX: ${cr.txHash.slice(0, 16)}...</p>` : ''}
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Description</th>
        <th>GPU Tier</th>
        <th>Qty</th>
        <th>Duration</th>
        <th>Rate/Day</th>
        <th style="text-align: right;">Amount</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>Bare Metal GPU Compute</td>
        <td>${cr.gpuTier}</td>
        <td>${cr.gpuCount}</td>
        <td>${cr.durationDays} days</td>
        <td>$${cr.ratePerDay.toFixed(2)}</td>
        <td style="text-align: right;">$${cr.totalCost.toFixed(2)}</td>
      </tr>
      <tr class="total-row">
        <td colspan="5" style="text-align: right;">Total</td>
        <td style="text-align: right;">$${cr.totalCost.toFixed(2)}</td>
      </tr>
    </tbody>
  </table>

  <div class="section">
    <h3>Compute Details</h3>
    <p>GPU: ${cr.gpuCount}x ${cr.gpuTier}</p>
    <p>Duration: ${cr.durationDays} days</p>
    ${cr.activatedAt ? `<p>Activated: ${new Date(cr.activatedAt).toLocaleDateString()}</p>` : ''}
    ${cr.expiresAt ? `<p>Expires: ${new Date(cr.expiresAt).toLocaleDateString()}</p>` : ''}
    ${cr.purpose ? `<p>Purpose: ${cr.purpose}</p>` : ''}
  </div>

  <div class="footer">
    <p><strong style="color: #ffffff;">TokenOS</strong><strong style="color: #22c55e;">_DeAI</strong> — Decentralized Compute Platform</p>
    <p>user.tokenos.ai</p>
  </div>
</body>
</html>`

    reply.header('Content-Type', 'text/html').send(html)
  })
}
