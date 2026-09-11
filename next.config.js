const nextConfig = {
  poweredByHeader: false,
  reactProductionProfiling: process.env.PROFILE_REACT === '1',
  experimental: { optimizePackageImports: ['@tabler/icons-react'] },
  async headers() {
    // Next 16.3.4 appends Route Handler Content-Type as an array, which its
    // compression filter rejects. Setting these JSON-only routes here keeps a
    // scalar header and the framework's normal encoding negotiation/threshold.
    // Upstream: https://github.com/vercel/next.js/issues/98007
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'same-origin' },
        { key: 'X-Frame-Options', value: 'DENY' },
      ],
    }, ...[
      '/api/templates', '/api/templates/:templateId',
      '/api/template-versions/:versionId', '/api/template-versions/:versionId/:action(freeze|draft)',
      '/api/datasheets/:datasheetId', '/api/datasheets/:datasheetId/:action(values|calculate|repeats)',
      '/api/samples', '/api/samples/:sampleId', '/api/samples/:sampleId/test-requests',
      '/api/test-requests/:requestId', '/api/test-requests/:requestId/:action(assignments|allocation-options)',
    ].map((source) => ({ source, headers: [{ key: 'Content-Type', value: 'application/json; charset=utf-8' }] }))];
  },
};

export default nextConfig;
