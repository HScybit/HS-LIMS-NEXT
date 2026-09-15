const signature = (rows, value) => rows.map(value).sort().join('|');

export function sampleReportingRowsChanged(previous, next) {
  // Source server policy deliberately requires both identities and contents to
  // change. Stable typed line IDs distinguish duplicate Product selections.
  return signature(previous, row => row.id) !== signature(next, row => row.id)
    && signature(previous, row => `${row.sampleProductId}:${row.testParameterId}:${row.methodId}`)
      !== signature(next, row => `${row.sampleProductId}:${row.testParameterId}:${row.methodId}`);
}

export function calculateSampleReportingDate(receivedAt, estimatedDays) {
  const days = Number(estimatedDays); const received = new Date(receivedAt);
  if (!Number.isFinite(days) || days <= 0 || !Number.isFinite(received.getTime()) || receivedAt == null) return '';
  // The native form and stored instants use UTC calendar dates. setUTCDate
  // preserves the source's calendar arithmetic, including fractional days.
  const date = new Date(`${received.toISOString().slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return '';
  return date.toISOString().slice(0, 10);
}
