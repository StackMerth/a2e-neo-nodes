/**
 * C7 wave 1: per-year operator earnings summary for tax prep.
 *
 * Builds a CSV with two sections:
 *
 *   1. Operator-header row pre-filled from NodeRunner tax-info fields
 *      (legalName, taxId, address, jurisdiction). Cells are blank if
 *      the operator never submitted W-9 info; the CSV still works as
 *      a generic earnings export.
 *
 *   2. Per-month breakdown of gross earnings (sourced from completed
 *      Settlement rows whose periodEnd falls in the tax year). One row
 *      per calendar month plus a TOTAL row. Includes the count of
 *      settlements + a semicolon-separated list of payout tx hashes
 *      for audit / on-chain verification.
 *
 * US-focused first iteration. W-8BEN flow for non-US operators is a
 * follow-up (~2 days; same shape with different header columns).
 *
 * Output format is `text/csv` — caller sets the Content-Disposition
 * header. The "TIN" column is masked to last-4 here so a leaked CSV
 * file from a user's downloads folder doesn't reveal the full SSN/
 * EIN; admins can still reconstruct via DB lookup if needed.
 */

import type { PrismaClient, TaxIdType } from '@a2e/database'

interface TaxYearOptions {
  /** 4-digit year (e.g. 2026). Validated by the caller. */
  year: number
}

interface MonthBucket {
  month: string   // 'YYYY-MM'
  grossUsd: number
  settlementCount: number
  txHashes: string[]
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function maskTaxId(raw: string | null, type: TaxIdType | null): string {
  if (!raw) return ''
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 4) return '***'
  const last4 = digits.slice(-4)
  // SSN format XXX-XX-LAST4 ; EIN format XX-XXXLAST4 — close enough
  // that a CPA will recognize the shape without exposing the full id.
  if (type === 'SSN') return `XXX-XX-${last4}`
  if (type === 'EIN') return `XX-XXX${last4}`
  return `***-${last4}`
}

export async function generateTaxYearCsv(
  prisma: PrismaClient,
  nodeRunnerId: string,
  opts: TaxYearOptions,
): Promise<{ csv: string; operatorName: string; total: number }> {
  const { year } = opts

  const nr = await prisma.nodeRunner.findUnique({
    where: { id: nodeRunnerId },
    select: {
      id: true,
      name: true,
      email: true,
      walletAddress: true,
      legalName: true,
      taxId: true,
      taxIdType: true,
      taxAddress: true,
      taxJurisdiction: true,
    },
  })
  if (!nr) throw new Error(`NodeRunner ${nodeRunnerId} not found`)

  // Tax year window. periodEnd is the timestamp we filter on — that's
  // when the platform considers the payout "earned" for the year (vs
  // periodStart which can straddle a year boundary). All times UTC
  // for simplicity; W-9 / 1099 deadlines are dated, not timed.
  const yearStart = new Date(Date.UTC(year, 0, 1, 0, 0, 0))
  const yearEnd = new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0))

  // Pull every completed settlement for this operator's nodes inside
  // the year. Single query, joined via the Node relation — keeps the
  // round-trips constant regardless of how many nodes the operator
  // runs.
  const settlements = await prisma.settlement.findMany({
    where: {
      status: 'COMPLETED',
      periodEnd: { gte: yearStart, lt: yearEnd },
      node: { nodeRunnerId },
    },
    select: {
      amount: true,
      periodEnd: true,
      txHash: true,
    },
    orderBy: { periodEnd: 'asc' },
  })

  // Bucket by calendar month. 12 buckets pre-allocated so months with
  // zero earnings still appear as 0.00 rows — gives operators a
  // complete picture of their year at a glance.
  const buckets: MonthBucket[] = Array.from({ length: 12 }, (_, i) => {
    const m = String(i + 1).padStart(2, '0')
    return { month: `${year}-${m}`, grossUsd: 0, settlementCount: 0, txHashes: [] }
  })

  for (const s of settlements) {
    const monthIdx = s.periodEnd.getUTCMonth()
    const bucket = buckets[monthIdx]!
    bucket.grossUsd += s.amount
    bucket.settlementCount += 1
    if (s.txHash) bucket.txHashes.push(s.txHash)
  }

  const total = buckets.reduce((sum, b) => sum + b.grossUsd, 0)

  // Build the CSV. Two sections separated by a blank line — operators
  // can split on the blank in a spreadsheet to get the breakdown table
  // by itself for further analysis.
  const headerRow = [
    'Operator Name',
    'Legal Name',
    'TIN Type',
    'TIN',
    'Address',
    'Tax Jurisdiction',
    'Tax Year',
    'Operator Wallet',
  ].join(',')
  const operatorRow = [
    csvCell(nr.name),
    csvCell(nr.legalName ?? ''),
    csvCell(nr.taxIdType ?? ''),
    csvCell(maskTaxId(nr.taxId, nr.taxIdType)),
    csvCell(nr.taxAddress ?? ''),
    csvCell(nr.taxJurisdiction ?? 'US'),
    csvCell(year),
    csvCell(nr.walletAddress),
  ].join(',')

  const breakdownHeader = ['Month', 'Gross Earnings (USD)', 'Settlements Count', 'Payout TX Hashes'].join(',')
  const breakdownRows = buckets.map((b) =>
    [
      csvCell(b.month),
      csvCell(b.grossUsd.toFixed(2)),
      csvCell(b.settlementCount),
      // Semicolon-separated list — CSV cell may contain commas in tx
      // hashes? No, base58 + DEV_ format never includes commas, but
      // we still wrap in quotes via csvCell for safety.
      csvCell(b.txHashes.join(';')),
    ].join(','),
  )
  const totalRow = ['TOTAL', total.toFixed(2), settlements.length, ''].join(',')

  const csv = [
    headerRow,
    operatorRow,
    '',
    breakdownHeader,
    ...breakdownRows,
    totalRow,
  ].join('\n')

  return { csv, operatorName: nr.name, total }
}
