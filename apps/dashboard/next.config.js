/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // output: 'standalone' was removed because Vercel does its own bundling
  // and ignores the setting, and standalone mode triggers EPERM symlink
  // errors on Windows local builds. The dashboard has never been Dockerized,
  // so dropping it is risk-free.
}

module.exports = nextConfig
