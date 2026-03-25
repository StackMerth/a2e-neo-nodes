export function generateCSV<T>(
  data: T[],
  columns: { key: keyof T; header: string }[]
): string {
  const headers = columns.map((c) => c.header).join(',')

  const rows = data.map((row) =>
    columns
      .map((col) => {
        const value = row[col.key]
        if (value === null || value === undefined) return ''
        if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
          return `"${value.replace(/"/g, '""')}"`
        }
        return String(value)
      })
      .join(',')
  )

  return [headers, ...rows].join('\n')
}

export interface EarningsCSVRow {
  date: string
  nodeId: string
  walletAddress: string
  gpuTier: string
  market: string
  earnings: number
  gpuHours: number
  jobCount: number
}

export interface SettlementsCSVRow {
  id: string
  nodeId: string
  walletAddress: string
  amount: number
  currency: string
  status: string
  jobCount: number
  periodStart: string
  periodEnd: string
  txHash: string
  createdAt: string
  processedAt: string
}

export interface JobsCSVRow {
  id: string
  deploymentId: string
  nodeId: string
  gpuTier: string
  market: string
  status: string
  ratePerHour: number
  durationSeconds: number
  earnings: number
  requestedAt: string
  completedAt: string
}

export interface NodesCSVRow {
  id: string
  walletAddress: string
  gpuTier: string
  nodeType: string
  status: string
  region: string
  totalEarnings: number
  totalJobs: number
  createdAt: string
  lastHeartbeat: string
}

export const earningsColumns: { key: keyof EarningsCSVRow; header: string }[] = [
  { key: 'date', header: 'Date' },
  { key: 'nodeId', header: 'Node ID' },
  { key: 'walletAddress', header: 'Wallet Address' },
  { key: 'gpuTier', header: 'GPU Tier' },
  { key: 'market', header: 'Market' },
  { key: 'earnings', header: 'Earnings (USD)' },
  { key: 'gpuHours', header: 'GPU Hours' },
  { key: 'jobCount', header: 'Job Count' },
]

export const settlementsColumns: { key: keyof SettlementsCSVRow; header: string }[] = [
  { key: 'id', header: 'Settlement ID' },
  { key: 'nodeId', header: 'Node ID' },
  { key: 'walletAddress', header: 'Wallet Address' },
  { key: 'amount', header: 'Amount' },
  { key: 'currency', header: 'Currency' },
  { key: 'status', header: 'Status' },
  { key: 'jobCount', header: 'Job Count' },
  { key: 'periodStart', header: 'Period Start' },
  { key: 'periodEnd', header: 'Period End' },
  { key: 'txHash', header: 'TX Hash' },
  { key: 'createdAt', header: 'Created At' },
  { key: 'processedAt', header: 'Processed At' },
]

export const jobsColumns: { key: keyof JobsCSVRow; header: string }[] = [
  { key: 'id', header: 'Job ID' },
  { key: 'deploymentId', header: 'Deployment ID' },
  { key: 'nodeId', header: 'Node ID' },
  { key: 'gpuTier', header: 'GPU Tier' },
  { key: 'market', header: 'Market' },
  { key: 'status', header: 'Status' },
  { key: 'ratePerHour', header: 'Rate/Hour (USD)' },
  { key: 'durationSeconds', header: 'Duration (sec)' },
  { key: 'earnings', header: 'Earnings (USD)' },
  { key: 'requestedAt', header: 'Requested At' },
  { key: 'completedAt', header: 'Completed At' },
]

export const nodesColumns: { key: keyof NodesCSVRow; header: string }[] = [
  { key: 'id', header: 'Node ID' },
  { key: 'walletAddress', header: 'Wallet Address' },
  { key: 'gpuTier', header: 'GPU Tier' },
  { key: 'nodeType', header: 'Node Type' },
  { key: 'status', header: 'Status' },
  { key: 'region', header: 'Region' },
  { key: 'totalEarnings', header: 'Total Earnings (USD)' },
  { key: 'totalJobs', header: 'Total Jobs' },
  { key: 'createdAt', header: 'Created At' },
  { key: 'lastHeartbeat', header: 'Last Heartbeat' },
]
