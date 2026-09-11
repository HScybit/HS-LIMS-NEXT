const nextConfig = {
  poweredByHeader: false,
  reactProductionProfiling: process.env.PROFILE_REACT === '1',
  experimental: { optimizePackageImports: ['@tabler/icons-react'] },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'same-origin' },
        { key: 'X-Frame-Options', value: 'DENY' },
      ],
    }];
  },
};

export default nextConfig;
