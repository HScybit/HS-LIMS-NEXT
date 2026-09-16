import { masterBulkCsvLimits } from './bulk-csv.js';

export const masterBulkXlsxLimits = Object.freeze({
  ...masterBulkCsvLimits,
  expandedBytes: 64 * 1024 * 1024,
  archiveEntries: 512,
  worksheetRows: 10000,
  decodedBytes: 16 * 1024 * 1024,
  timeoutMs: 20000,
  concurrentReaders: 2,
});
