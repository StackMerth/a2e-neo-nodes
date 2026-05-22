export interface StatementData {
  nodeId: string
  walletAddress: string
  gpuTier: string
  periodStart: string
  periodEnd: string
  totalEarnings: number
  totalJobs: number
  totalGpuHours: number
  settlements: {
    id: string
    amount: number
    status: string
    txHash?: string
    processedAt?: string
  }[]
  dailyEarnings: {
    date: string
    market: string
    earnings: number
    jobCount: number
  }[]
}

export interface InvoiceData {
  invoiceNumber: string
  customerId: string
  customerName: string
  periodStart: string
  periodEnd: string
  lineItems: {
    description: string
    gpuTier: string
    hours: number
    ratePerHour: number
    amount: number
  }[]
  subtotal: number
  tax: number
  total: number
}

export function generateStatementHTML(data: StatementData): string {
  const settlementsHtml = data.settlements
    .map(
      (s) => `
      <tr>
        <td>${s.id.substring(0, 8)}...</td>
        <td>$${s.amount.toFixed(2)}</td>
        <td>${s.status}</td>
        <td>${s.txHash ? s.txHash.substring(0, 16) + '...' : '-'}</td>
        <td>${s.processedAt ?? '-'}</td>
      </tr>
    `
    )
    .join('')

  const earningsHtml = data.dailyEarnings
    .map(
      (e) => `
      <tr>
        <td>${e.date}</td>
        <td>${e.market}</td>
        <td>$${e.earnings.toFixed(2)}</td>
        <td>${e.jobCount}</td>
      </tr>
    `
    )
    .join('')

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Earnings Statement - ${data.nodeId}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      margin: 0;
      padding: 40px;
      color: #e4e4e7;
      background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 100%);
      min-height: 100vh;
    }
    h1 {
      color: #ffffff;
      font-size: 28px;
      font-weight: 700;
      margin: 0 0 8px 0;
    }
    h2 {
      color: #22c55e;
      font-size: 18px;
      font-weight: 600;
      margin: 32px 0 16px 0;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    h2::before {
      content: '';
      width: 4px;
      height: 20px;
      background: linear-gradient(180deg, #22c55e 0%, #16a34a 100%);
      border-radius: 2px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      margin-bottom: 32px;
      padding-bottom: 24px;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .header p { margin: 4px 0; font-size: 14px; color: #a1a1aa; }
    .header strong { color: #e4e4e7; }
    .logo {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
    }
    .logo-icon {
      width: 40px;
      height: 40px;
      background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      color: #0a0a0f;
      font-size: 18px;
    }
    .summary {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      padding: 24px;
      border-radius: 16px;
      margin: 24px 0;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 24px;
    }
    .summary-item {
      text-align: center;
      padding: 16px;
      background: rgba(255,255,255,0.02);
      border-radius: 12px;
    }
    .summary-value {
      font-size: 32px;
      font-weight: 700;
      color: #22c55e;
      margin-bottom: 4px;
    }
    .summary-label { color: #71717a; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 16px 0;
      background: rgba(255,255,255,0.02);
      border-radius: 12px;
      overflow: hidden;
    }
    th, td {
      padding: 14px 16px;
      text-align: left;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      font-size: 14px;
    }
    th {
      background: rgba(255,255,255,0.04);
      font-weight: 600;
      color: #a1a1aa;
      text-transform: uppercase;
      font-size: 12px;
      letter-spacing: 0.5px;
    }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr:hover { background: rgba(255,255,255,0.02); }
    .status-completed { color: #22c55e; }
    .status-pending { color: #f59e0b; }
    .status-failed { color: #ef4444; }
    .footer {
      margin-top: 48px;
      padding-top: 24px;
      border-top: 1px solid rgba(255,255,255,0.08);
      color: #52525b;
      font-size: 12px;
    }
    .footer p { margin: 4px 0; }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
    }
    .badge-gpu {
      background: rgba(34,197,94,0.15);
      color: #22c55e;
      border: 1px solid rgba(34,197,94,0.3);
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="logo">
        <div class="logo-icon">A²</div>
        <h1>Earnings Statement</h1>
      </div>
      <p><strong>Node:</strong> ${data.nodeId}</p>
      <p><strong>Wallet:</strong> ${data.walletAddress}</p>
      <p><strong>GPU Tier:</strong> <span class="badge badge-gpu">${data.gpuTier}</span></p>
    </div>
    <div style="text-align: right;">
      <p><strong>Period</strong></p>
      <p style="color: #e4e4e7; font-size: 16px;">${data.periodStart} - ${data.periodEnd}</p>
      <p style="margin-top: 12px;"><strong>Generated</strong></p>
      <p style="color: #e4e4e7;">${new Date().toISOString().split('T')[0]}</p>
    </div>
  </div>

  <div class="summary">
    <div class="summary-grid">
      <div class="summary-item">
        <div class="summary-value">$${data.totalEarnings.toFixed(2)}</div>
        <div class="summary-label">Total Earnings</div>
      </div>
      <div class="summary-item">
        <div class="summary-value">${data.totalJobs}</div>
        <div class="summary-label">Jobs Completed</div>
      </div>
      <div class="summary-item">
        <div class="summary-value">${data.totalGpuHours.toFixed(1)}</div>
        <div class="summary-label">GPU Hours</div>
      </div>
    </div>
  </div>

  <h2>Settlement History</h2>
  <table>
    <thead>
      <tr>
        <th>ID</th>
        <th>Amount</th>
        <th>Status</th>
        <th>TX Hash</th>
        <th>Processed</th>
      </tr>
    </thead>
    <tbody>
      ${settlementsHtml || '<tr><td colspan="5" style="color: #52525b; text-align: center; padding: 32px;">No settlements in this period</td></tr>'}
    </tbody>
  </table>

  <h2>Daily Earnings</h2>
  <table>
    <thead>
      <tr>
        <th>Date</th>
        <th>Market</th>
        <th>Earnings</th>
        <th>Jobs</th>
      </tr>
    </thead>
    <tbody>
      ${earningsHtml || '<tr><td colspan="4" style="color: #52525b; text-align: center; padding: 32px;">No earnings in this period</td></tr>'}
    </tbody>
  </table>

  <div class="footer">
    <p>This statement is auto-generated by TokenOS_DeAI.</p>
    <p>For questions, contact support@tokenos.ai</p>
  </div>
</body>
</html>
`
}

export function generateInvoiceHTML(data: InvoiceData): string {
  const lineItemsHtml = data.lineItems
    .map(
      (item) => `
      <tr>
        <td>${item.description}</td>
        <td>${item.gpuTier}</td>
        <td>${item.hours.toFixed(2)}</td>
        <td>$${item.ratePerHour.toFixed(2)}</td>
        <td>$${item.amount.toFixed(2)}</td>
      </tr>
    `
    )
    .join('')

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Invoice ${data.invoiceNumber}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 40px; color: #333; }
    h1 { color: #1a1a2e; }
    .invoice-header { display: flex; justify-content: space-between; margin-bottom: 40px; }
    .invoice-number { font-size: 24px; color: #6366f1; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #e2e8f0; }
    th { background: #f1f5f9; font-weight: 600; }
    .totals { margin-top: 20px; text-align: right; }
    .total-row { display: flex; justify-content: flex-end; gap: 40px; padding: 8px 0; }
    .total-label { color: #64748b; }
    .grand-total { font-size: 20px; font-weight: bold; color: #6366f1; border-top: 2px solid #6366f1; padding-top: 10px; }
    .footer { margin-top: 60px; color: #64748b; font-size: 12px; }
  </style>
</head>
<body>
  <div class="invoice-header">
    <div>
      <h1>INVOICE</h1>
      <p class="invoice-number">${data.invoiceNumber}</p>
    </div>
    <div style="text-align: right;">
      <p><strong>TokenOS_DeAI</strong></p>
      <p>Decentralized Compute Platform</p>
      <p>user.tokenos.ai</p>
    </div>
  </div>

  <div style="margin-bottom: 30px;">
    <p><strong>Bill To:</strong></p>
    <p>${data.customerName}</p>
    <p>Customer ID: ${data.customerId}</p>
  </div>

  <div style="margin-bottom: 30px;">
    <p><strong>Period:</strong> ${data.periodStart} - ${data.periodEnd}</p>
    <p><strong>Invoice Date:</strong> ${new Date().toISOString().split('T')[0]}</p>
  </div>

  <table>
    <thead>
      <tr>
        <th>Description</th>
        <th>GPU Tier</th>
        <th>Hours</th>
        <th>Rate/Hour</th>
        <th>Amount</th>
      </tr>
    </thead>
    <tbody>
      ${lineItemsHtml}
    </tbody>
  </table>

  <div class="totals">
    <div class="total-row">
      <span class="total-label">Subtotal:</span>
      <span>$${data.subtotal.toFixed(2)}</span>
    </div>
    <div class="total-row">
      <span class="total-label">Tax:</span>
      <span>$${data.tax.toFixed(2)}</span>
    </div>
    <div class="total-row grand-total">
      <span>Total:</span>
      <span>$${data.total.toFixed(2)}</span>
    </div>
  </div>

  <div class="footer">
    <p>Payment Terms: Due upon receipt</p>
    <p>Payment Methods: SOL, USDC (Solana)</p>
    <p>Questions? Contact billing@tokenos.ai</p>
  </div>
</body>
</html>
`
}
