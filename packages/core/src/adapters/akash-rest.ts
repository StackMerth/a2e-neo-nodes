/**
 * Akash REST query helpers.
 *
 * The chain-sdk's gRPC-Web transport is alpha and finicky against the public
 * `grpc.akashnet.net` endpoint (returns "protocol error: missing status").
 * Akash's REST API is stable, well-documented, and works reliably — so we
 * route ALL read-only queries through REST while keeping transaction
 * broadcast on cosmjs Stargate (which uses the RPC endpoint that does work).
 *
 * Source of truth for endpoint shapes:
 *   https://api.akashnet.net/swagger/
 */

const DEFAULT_REST_URL = 'https://api.akashnet.net'
const REQUEST_TIMEOUT_MS = 10_000

interface CertificateRest {
  serial: string
  state: 'valid' | 'revoked' | string
}

interface CertificatesListResponse {
  certificates?: Array<{
    certificate?: { state?: string; cert?: string; pubkey?: string }
    serial?: string
  }>
}

export async function queryWalletCertificatesREST(
  owner: string,
  restUrl: string = DEFAULT_REST_URL
): Promise<CertificateRest[]> {
  const url = `${restUrl}/akash/cert/v1/certificates/list?filter.owner=${encodeURIComponent(owner)}&filter.state=valid`
  const data = await fetchJson<CertificatesListResponse>(url)
  return (data.certificates ?? [])
    .filter((c) => c.certificate?.state === 'valid')
    .map((c) => ({
      serial: c.serial ?? '',
      state: 'valid' as const,
    }))
}

export interface BidRest {
  /** BidID fields */
  owner: string
  dseq: string
  gseq: number
  oseq: number
  bseq: number
  provider: string
  /** "open" | "matched" | "lost" | "closed" */
  state: string
  /** DecCoin amount as string, denom always uakt for Akash */
  priceUakt: string
}

interface BidsListResponse {
  bids?: Array<{
    bid?: {
      id?: { owner?: string; dseq?: string; gseq?: number; oseq?: number; bseq?: number; provider?: string }
      state?: string
      price?: { denom?: string; amount?: string }
    }
  }>
}

export async function queryBidsREST(
  options: {
    owner: string
    dseq?: string
    state?: 'open' | 'matched' | 'lost' | 'closed'
    restUrl?: string
  }
): Promise<BidRest[]> {
  const restUrl = options.restUrl ?? DEFAULT_REST_URL
  const params = new URLSearchParams()
  params.set('filters.owner', options.owner)
  if (options.dseq) params.set('filters.dseq', options.dseq)
  if (options.state) params.set('filters.state', options.state)
  const url = `${restUrl}/akash/market/v1beta5/bids/list?${params.toString()}`
  const data = await fetchJson<BidsListResponse>(url)
  const out: BidRest[] = []
  for (const item of data.bids ?? []) {
    const id = item.bid?.id
    const price = item.bid?.price
    if (!id || !price?.amount) continue
    out.push({
      owner: id.owner ?? '',
      dseq: id.dseq ?? '0',
      gseq: id.gseq ?? 0,
      oseq: id.oseq ?? 0,
      bseq: id.bseq ?? 0,
      provider: id.provider ?? '',
      state: item.bid?.state ?? '',
      priceUakt: price.amount,
    })
  }
  return out
}

export interface LeaseRest {
  owner: string
  dseq: string
  gseq: number
  oseq: number
  provider: string
  /** "active" | "insufficient_funds" | "closed" — server returns string state */
  state: string
  priceUakt: string
}

interface LeaseResponse {
  lease?: {
    leaseId?: { owner?: string; dseq?: string; gseq?: number; oseq?: number; provider?: string }
    state?: string
    price?: { denom?: string; amount?: string }
  }
}

export async function queryLeaseREST(
  id: { owner: string; dseq: string | bigint; gseq: number; oseq: number; provider: string },
  restUrl: string = DEFAULT_REST_URL
): Promise<LeaseRest | null> {
  const params = new URLSearchParams()
  params.set('id.owner', id.owner)
  params.set('id.dseq', String(id.dseq))
  params.set('id.gseq', String(id.gseq))
  params.set('id.oseq', String(id.oseq))
  params.set('id.provider', id.provider)
  const url = `${restUrl}/akash/market/v1beta5/leases/info?${params.toString()}`
  try {
    const data = await fetchJson<LeaseResponse>(url)
    const lease = data.lease
    if (!lease?.leaseId) return null
    return {
      owner: lease.leaseId.owner ?? '',
      dseq: lease.leaseId.dseq ?? '0',
      gseq: lease.leaseId.gseq ?? 0,
      oseq: lease.leaseId.oseq ?? 0,
      provider: lease.leaseId.provider ?? '',
      state: lease.state ?? '',
      priceUakt: lease.price?.amount ?? '0',
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/404|not.*found/i.test(msg)) return null
    throw err
  }
}

interface BalancesResponse {
  balances?: Array<{ denom?: string; amount?: string }>
}

/**
 * Returns the wallet's uakt balance, in AKT (already divided by 1e6). Returns
 * 0 if the wallet has no AKT denomination on file.
 */
export async function queryWalletAktBalanceREST(
  address: string,
  restUrl: string = DEFAULT_REST_URL
): Promise<number> {
  const url = `${restUrl}/cosmos/bank/v1beta1/balances/${encodeURIComponent(address)}`
  const data = await fetchJson<BalancesResponse>(url)
  const aktBalance = (data.balances ?? []).find((b) => b.denom === 'uakt')
  if (!aktBalance?.amount) return 0
  return Number(aktBalance.amount) / 1_000_000
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Akash REST ${response.status}: ${text.slice(0, 200)}`)
  }
  return (await response.json()) as T
}
