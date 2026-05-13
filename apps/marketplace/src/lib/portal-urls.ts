/*
 * Single source of truth for portal URLs used by marketplace CTAs.
 * Centralized so the RefCapture component can match on these paths
 * when rewriting anchors with the referral code.
 *
 * NEXT_PUBLIC_PORTAL_URL must be set in marketplace's Vercel env to
 * the actual portal origin. Falls back to user.tokenos.ai (production).
 */
const PORTAL_URL = process.env.NEXT_PUBLIC_PORTAL_URL || 'https://user.tokenos.ai'
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://a2e-api.onrender.com'

export const portalUrls = {
  signup: `${PORTAL_URL}/signup`,
  login: `${PORTAL_URL}/login`,
  signupBuyer: `${PORTAL_URL}/register?role=buyer`,
  signupOperator: `${PORTAL_URL}/register`,
  spec: `${API_URL}/docs`,
}
