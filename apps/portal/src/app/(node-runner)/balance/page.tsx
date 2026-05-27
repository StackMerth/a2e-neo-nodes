'use client'

/**
 * Operator-side Balance page. Renders the same component as
 * /buyer/balance so dual-role users (and operators who want to
 * pre-load credit for upcoming deployments) get one shared wallet.
 *
 * BuyerBalance is keyed by userId, not role, so the underlying API +
 * Stripe topup flow works identically. Only difference is the
 * surrounding layout: this route inherits the node-runner Sidebar so
 * operators don't get flipped into the buyer-portal chrome when they
 * click Balance.
 */

import BalancePage from '@/app/buyer/balance/page'

export default BalancePage
