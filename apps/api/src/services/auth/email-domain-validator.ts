/**
 * SECURITY (2026-06-11 third-round): synthetic domains like
 * cpk-redteam.io and other made-up TLDs slip past the static blocklist
 * because they're not RFC-reserved. Querying for an MX record catches
 * them: a domain with no MX cannot receive mail, so any "user" claiming
 * an inbox there is forged. Real domains (gmail.com, company.com,
 * any-real-domain.io) always have at least one MX record.
 *
 * Falls open on DNS errors so a transient resolver outage doesn't
 * lock out real signups. The error path is logged so we can monitor
 * for resolver issues separately.
 */
import { promises as dns } from 'node:dns'

const DNS_TIMEOUT_MS = 3000

export interface EmailDomainCheck {
  domain: string
  hasMx: boolean
  reason: 'ok' | 'no-mx' | 'invalid-format' | 'resolver-error'
  resolverError?: string
}

function extractDomain(email: string): string | null {
  const at = email.lastIndexOf('@')
  if (at < 1 || at === email.length - 1) return null
  return email.slice(at + 1).toLowerCase().trim()
}

/**
 * Returns true if the domain is deliverable (has at least one MX record).
 * Falls open (returns true) on resolver errors so a transient DNS outage
 * doesn't break real signups. The caller can log {reason} for monitoring.
 */
export async function checkEmailDomain(email: string): Promise<EmailDomainCheck> {
  const domain = extractDomain(email)
  if (!domain) {
    return { domain: '', hasMx: false, reason: 'invalid-format' }
  }

  try {
    const lookup = dns.resolveMx(domain)
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('DNS resolveMx timeout')), DNS_TIMEOUT_MS),
    )
    const records = await Promise.race([lookup, timeout])

    const valid = Array.isArray(records) && records.some(r => r.exchange && r.exchange.length > 0)
    if (!valid) {
      return { domain, hasMx: false, reason: 'no-mx' }
    }
    return { domain, hasMx: true, reason: 'ok' }
  } catch (err) {
    // ENOTFOUND / ENODATA / SERVFAIL = domain genuinely has no MX.
    // Other errors (TIMEOUT / EAI_AGAIN) are transient — fall open.
    const code = (err as NodeJS.ErrnoException)?.code ?? ''
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NODATA') {
      return { domain, hasMx: false, reason: 'no-mx', resolverError: code }
    }
    return {
      domain,
      hasMx: true, // fall open
      reason: 'resolver-error',
      resolverError: err instanceof Error ? err.message : String(err),
    }
  }
}
