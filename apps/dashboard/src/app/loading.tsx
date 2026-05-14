/*
 * Next.js Suspense loading state for admin route transitions. Returns
 * null so route changes don't briefly flash a brand-y orb. The auth-
 * resolving guard in AuthenticatedLayout still shows the typewriter
 * boot screen; per-page data loaders inside each route show their
 * own local skeletons.
 */
export default function Loading() {
  return null
}
