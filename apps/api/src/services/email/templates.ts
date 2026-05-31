/**
 * T8b — typed HTML email body templates per notification type.
 *
 * The base wrapTemplate() in sender.ts handles the outer chrome
 * (brand wordmark, dark theme, footer). These functions render the
 * INNER content block — a receipt for BALANCE_TOPUP, a payout
 * confirmation for PAYOUT_SENT, etc.
 *
 * Callers pass typed templateData per notification type; the
 * notification service picks the right renderer. Falls back to the
 * generic title + message block when no specialised template is
 * registered for a type.
 *
 * Adding a new template = add a renderer function below and wire it
 * into renderBodyForType().
 */

const PORTAL_URL = process.env.PORTAL_URL ?? 'https://user.tokenos.ai'

interface BaseEmailTemplateArgs {
  title: string
  message: string
  link?: string
}

export interface BalanceTopupReceiptArgs extends BaseEmailTemplateArgs {
  /** Amount credited, in USD. */
  amountUsd: number
  /** Source label for the receipt — "Solana mainnet", "Card via Stripe", "Admin credit". */
  source: string
  /** Buyer's balance AFTER the credit landed. */
  newBalanceUsd: number
  /** ISO timestamp; defaults to now if unset. */
  occurredAt?: string
  /** Optional reference id printed in the footer for support traceability. */
  referenceId?: string
}

/**
 * Render a receipt-style HTML block for a BALANCE_TOPUP email.
 * Looks like a clean financial receipt — big amount, transaction
 * detail rows, new balance, CTA back to the dashboard.
 */
export function renderBalanceTopupReceipt(args: BalanceTopupReceiptArgs): string {
  const occurred = args.occurredAt
    ? new Date(args.occurredAt).toLocaleString('en-US', {
        dateStyle: 'long',
        timeStyle: 'short',
      })
    : new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' })

  const link = args.link ?? '/buyer/balance'
  const cta = `${PORTAL_URL}${link.startsWith('/') ? link : '/' + link}`

  return `
    <p style="color: #a1a1aa; font-size: 14px; margin: 0 0 8px;">Receipt</p>
    <h2 style="color: #ffffff; font-size: 20px; margin: 0 0 24px; font-weight: 600;">
      ${escapeHtml(args.title)}
    </h2>

    <div style="background: #0a0a0f; border: 1px solid rgba(34, 197, 94, 0.25); border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 24px;">
      <p style="color: #71717a; font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em; margin: 0 0 8px;">Amount credited</p>
      <p style="color: #22c55e; font-size: 36px; font-weight: 700; margin: 0; letter-spacing: -0.02em;">
        +$${args.amountUsd.toFixed(2)}
      </p>
    </div>

    <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
      <tr>
        <td style="color: #71717a; font-size: 13px; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.06);">Source</td>
        <td style="color: #e4e4e7; font-size: 13px; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.06); text-align: right;">
          ${escapeHtml(args.source)}
        </td>
      </tr>
      <tr>
        <td style="color: #71717a; font-size: 13px; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.06);">Date</td>
        <td style="color: #e4e4e7; font-size: 13px; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.06); text-align: right;">
          ${escapeHtml(occurred)}
        </td>
      </tr>
      <tr>
        <td style="color: #71717a; font-size: 13px; padding: 10px 0;">New balance</td>
        <td style="color: #ffffff; font-size: 14px; padding: 10px 0; text-align: right; font-weight: 600;">
          $${args.newBalanceUsd.toFixed(2)}
        </td>
      </tr>
    </table>

    <p style="color: #a1a1aa; font-size: 14px; line-height: 1.6; margin: 0 0 24px;">
      ${escapeHtml(args.message)}
    </p>

    <div style="text-align: center; margin-top: 24px;">
      <a href="${cta}" style="display: inline-block; padding: 12px 24px; background: #22c55e; color: #0a0a0f; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px;">
        View balance
      </a>
    </div>

    ${args.referenceId ? `
    <p style="color: #52525b; font-size: 11px; text-align: center; margin: 32px 0 0; font-family: monospace;">
      ref: ${escapeHtml(args.referenceId)}
    </p>` : ''}
  `
}

/**
 * Generic fallback — the title + message wrap that the notification
 * service has shipped with since before T8b. Kept identical to its
 * previous inline form so existing notification types render the
 * same as they did before.
 */
export function renderGenericBody(args: BaseEmailTemplateArgs): string {
  return `<h2 style="color: #ffffff; margin: 0 0 16px;">${escapeHtml(args.title)}</h2>
           <p style="color: #a1a1aa; line-height: 1.6;">${escapeHtml(args.message)}</p>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
