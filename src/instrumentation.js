export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NEXT_PHASE === 'phase-production-build') return;
  const { startInlineReportWorker } = await import('./reports/inline-worker.js');
  await startInlineReportWorker();
}
