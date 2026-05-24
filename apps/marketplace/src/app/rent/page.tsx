/*
 * /rent has been consolidated into /marketplace. The tier-tile quick-
 * rent grid now lives above the operator-catalog filter on the
 * marketplace page so visitors get the high-level overview AND the
 * per-operator detail on a single canonical page (previously the two
 * routes did near-duplicate jobs and forced a "which one do I click?"
 * moment on every visit).
 *
 * Server-side redirect (307 via next/navigation). Old deep links and
 * external referrers continue to resolve.
 */

import { redirect } from 'next/navigation'

export const metadata = {
  // Hint to crawlers + clients that this is no longer a real page.
  // The redirect itself does the heavy lifting for users + bots.
  robots: { index: false, follow: true },
}

export default function RentPage() {
  redirect('/marketplace')
}
