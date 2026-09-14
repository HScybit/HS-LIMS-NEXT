const nextConfig = {
  poweredByHeader: false,
  reactProductionProfiling: process.env.PROFILE_REACT === '1',
  // The server reuses the source selection filter without bundling its React component graph.
  serverExternalPackages: ['react-select'],
  experimental: { optimizePackageImports: ['@tabler/icons-react'] },
  outputFileTracingIncludes: {
    '/api/masters/products/custom-field-generation': ['./src/custom-fields/*.js', './src/masters/custom-field-config.js', './src/auth/errors.js',
      './node_modules/moment/**', './node_modules/moment-timezone/**'],
  },
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
      '/api/datasheets/:datasheetId', '/api/datasheets/:datasheetId/:action(values|calculate|repeats|submit)',
      '/api/samples', '/api/samples/:sampleId', '/api/samples/:sampleId/test-requests',
      '/api/samples/:sampleId/:action(reports|report-options)', '/api/reports/:reportId', '/api/reports/:reportId/pdf',
      '/api/test-requests/:requestId', '/api/test-requests/:requestId/:action(assignments|allocation-options)',
      '/api/workflow-runs/:runId', '/api/workflow-runs/:runId/:action(transitions|datasheet-transitions)',
      '/api/approvals/:caseId', '/api/approval-assignments/:assignmentId/approve',
      '/api/report-assets/documents', '/api/report-assets/documents/:documentId',
      '/api/report-assets/watermarks', '/api/report-assets/watermarks/:watermarkId',
      '/api/report-assets/custom-css', '/api/report-assets/custom-css/current',
    ].map((source) => ({ source, headers: [{ key: 'Content-Type', value: 'application/json; charset=utf-8' }] }))];
  },
};

export default nextConfig;
