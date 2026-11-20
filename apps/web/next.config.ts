import type { NextConfig } from 'next';
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // All product images are static assets; the runtime optimizer is not used.
  images: { unoptimized: true },
  // Clerk's same-origin rewrite must retain the explicit loopback development host.
  skipProxyUrlNormalize: true,
  transpilePackages: ['@pactwoven/contracts'],
  experimental: { cpus: 2 },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' },
    ] }];
  },
};
export default config;
