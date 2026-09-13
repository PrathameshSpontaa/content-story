import { loadEnv } from './lib/env.js';

// During development, secrets come from the project-root .env.local.
loadEnv();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Server-only packages that shouldn't be bundled.
  serverExternalPackages: ['pg', 'pg-boss', 'razorpay'],
  // Old paths from the first beta build.
  async redirects() {
    return [
      { source: '/feed', destination: '/stories', permanent: false },
      { source: '/watchlist', destination: '/following', permanent: false },
    ];
  },
};

export default nextConfig;
