/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // basePath was '/portal' in Phase 1 because the original deployment served
  // both dashboard and portal under different paths on a single domain.
  // On its own Vercel subdomain, the portal needs to serve at the root, so
  // the basePath is removed. Re-add it (and set NEXT_PUBLIC_BASE_PATH=/portal
  // in env) only if you go back to a path-multiplexed deployment.
}

module.exports = nextConfig
