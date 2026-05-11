/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // basePath was '/portal' in Phase 1 because the original deployment served
  // both dashboard and portal under different paths on a single domain.
  // On its own Vercel subdomain, the portal needs to serve at the root, so
  // the basePath is removed. Re-add it (and set NEXT_PUBLIC_BASE_PATH=/portal
  // in env) only if you go back to a path-multiplexed deployment.
  //
  // output: 'standalone' was removed because Vercel does its own bundling
  // and ignores the setting, and standalone mode triggers EPERM symlink
  // errors on Windows local builds. The portal has never been Dockerized,
  // so dropping it is risk-free.
}

module.exports = nextConfig
