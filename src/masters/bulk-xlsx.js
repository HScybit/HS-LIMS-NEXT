import ExcelJS from 'exceljs';
import { fromBufferPromise } from 'yauzl';
import { crc32 } from 'node:zlib';
import { HttpError } from '../auth/errors.js';
import { masterBulkXlsxLimits as limits } from './bulk-xlsx-limits.js';

const invalid = message => new HttpError(400, 'invalid_bulk_workbook', message);
const blank = value => value == null || typeof value === 'string' && value.trim() === '';

// Check actual expanded data before ExcelJS loads whole XML entries into memory.
async function checkArchive(buffer) {
  const zip = await fromBufferPromise(buffer, { validateEntrySizes: true, strictFileNames: true });
  let archiveError;
  zip.on('error', error => { archiveError = error; });
  try {
    if (zip.entryCount > limits.archiveEntries) throw invalid('The workbook contains too many archive entries.');
    const entries = []; const names = new Set(); let declaredBytes = 0;
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName;
      const parts = name.replace(/\/$/, '').split('/');
      if (name.length > 1000 || name.includes('\0') || parts.some(part => !part || part === '.' || part === '..') || names.has(name)) {
        throw invalid('The workbook contains ambiguous archive entries.');
      }
      if (entry.isEncrypted()) throw invalid('Use an unencrypted XLSX workbook.');
      if (![0, 8].includes(entry.compressionMethod)) throw invalid('The workbook uses an unsupported compression format.');
      names.add(name); entries.push(entry); declaredBytes += entry.uncompressedSize;
      if (entries.length > limits.archiveEntries) throw invalid('The workbook contains too many archive entries.');
      if (declaredBytes > limits.expandedBytes) throw invalid('The expanded workbook must be 64 MiB or smaller.');
    }
    if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml') || !names.has('xl/_rels/workbook.xml.rels')) {
      throw invalid('The file is not an XLSX workbook.');
    }
    let expandedBytes = 0;
    for (const entry of entries) {
      const stream = await zip.openReadStreamPromise(entry);
      let bytes = 0; let checksum = 0;
      try {
        for await (const chunk of stream) {
          bytes += chunk.length; expandedBytes += chunk.length;
          if (expandedBytes > limits.expandedBytes || bytes > entry.uncompressedSize) {
            throw invalid('The expanded workbook exceeds its size limit.');
          }
          checksum = crc32(chunk, checksum);
        }
      } finally { stream.destroy(); }
      if (bytes !== entry.uncompressedSize || checksum !== entry.crc32) throw invalid('The workbook contains damaged archive data.');
    }
    if (archiveError) throw archiveError;
    return expandedBytes;
  } finally { zip.close(); }
}

function cellValue(cell, columnNumber, countBytes) {
  let value = cell.value;
  let metadata;
  if (cell.type === ExcelJS.ValueType.Formula) {
    // ExcelJS cell.value omits falsy formula results; the result accessor preserves them.
    value = cell.result;
    metadata = { columnNumber, type: 'formula', formula: cell.formula, hasResult: value !== undefined && value !== null };
    countBytes(metadata.formula);
    if (!metadata.hasResult) return { value: '', metadata };
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    if (typeof value.error === 'string') {
      countBytes(value.error);
      return { value: '', metadata: { ...metadata, columnNumber, type: metadata?.type ?? 'error', errorCode: value.error } };
    }
    if (Array.isArray(value.richText)) {
      let text = '';
      for (const part of value.richText) {
        if (typeof part.text !== 'string' || text.length + part.text.length > limits.cellCharacters) throw invalid('A workbook cell exceeds 16,000 characters.');
        text += part.text;
      }
      value = text;
      metadata = { ...metadata, columnNumber, type: metadata?.type ?? 'rich_text' };
    } else if (typeof value.text === 'string') {
      if (typeof value.hyperlink === 'string') {
        countBytes(value.hyperlink);
        metadata = { ...metadata, columnNumber, type: metadata?.type ?? 'hyperlink', hyperlink: value.hyperlink };
      }
      value = value.text;
    } else throw invalid(`Column ${columnNumber} contains an unsupported workbook value.`);
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw invalid('A workbook cell contains an invalid date.');
    metadata = { ...metadata, columnNumber, type: metadata?.type ?? 'date' };
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid('A workbook cell contains an invalid number.');
  } else if (value != null && !['string', 'boolean'].includes(typeof value)) throw invalid('The workbook contains an unsupported cell value.');
  value ??= '';
  countBytes(value);
  if (cell.numFmt && cell.numFmt !== 'General') {
    countBytes(cell.numFmt);
    metadata = { ...metadata, columnNumber, type: metadata?.type ?? 'formatted', numberFormat: cell.numFmt };
  }
  return { value, metadata };
}

// Called inside the bounded worker. This reads source data only; it never writes masters.
export async function decodeMasterXlsx(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > limits.bytes) throw invalid('Provide an XLSX workbook of at most 16 MiB.');
  try {
    const expandedBytes = await checkArchive(buffer);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer, { maxRows: limits.worksheetRows, maxCols: limits.columns });
    const sheet = workbook.worksheets[0];
    if (!sheet) throw invalid('The workbook does not contain any worksheets.');
    for (const worksheet of workbook.worksheets) {
      if (worksheet.rowCount > limits.worksheetRows || worksheet.columnCount > limits.columns) {
        throw invalid('Each worksheet must stay within 10,000 row positions and 250 columns.');
      }
    }
    let decodedBytes = 0;
    const countBytes = value => {
      if (typeof value === 'string' && (value.length > limits.cellCharacters || !value.isWellFormed() || value.includes('\0'))) {
        throw invalid('Workbook cells must contain valid text of at most 16,000 characters.');
      }
      decodedBytes += typeof value === 'string' ? Buffer.byteLength(value) : value instanceof Date || typeof value === 'number' ? 8 : 1;
      if (decodedBytes > limits.decodedBytes) throw invalid('Decoded workbook values must be 16 MiB or smaller.');
    };
    const rows = []; let headers; let sourceHeaders; let headerRowNumber; let headerCellMetadata;
    const columnCount = sheet.columnCount;
    for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber++) {
      const row = sheet.findRow(rowNumber);
      if (!row) continue;
      const values = []; const cellMetadata = [];
      for (let columnNumber = 1; columnNumber <= columnCount; columnNumber++) {
        const { value, metadata } = cellValue(row.getCell(columnNumber), columnNumber, countBytes);
        values.push(value); if (metadata) cellMetadata.push(metadata);
      }
      // A formula without a result and an Excel error are data requiring correction, not empty rows.
      const hasCellError = cellMetadata.some(cell => cell.errorCode || cell.type === 'formula' && !cell.hasResult);
      if (values.every(blank) && !hasCellError) continue;
      if (!headers) {
        if (hasCellError || values.some(value => !blank(value) && typeof value !== 'string')) throw invalid('Column headers must contain text.');
        sourceHeaders = values;
        headers = values.map(value => String(value ?? '').trim());
        while (headers.at(-1) === '') headers.pop();
        if (headers.some(value => !value || value.length > limits.headerCharacters)) throw invalid('Column headers must be nonblank text of at most 250 characters.');
        if (new Set(headers).size !== headers.length) throw invalid('Each column header must be unique.');
        headerRowNumber = rowNumber; headerCellMetadata = cellMetadata;
      } else {
        if (rows.length >= limits.rows) throw invalid('Upload 2,500 data rows or fewer at a time.');
        if (values.slice(headers.length).some(value => !blank(value)) || cellMetadata.some(cell => cell.columnNumber > headers.length && (cell.errorCode || cell.type === 'formula'))) {
          throw invalid(`Row ${rowNumber} has a value in a column without a header.`);
        }
        rows.push({ rowNumber, values, cellMetadata });
      }
    }
    if (!headers || rows.length === 0) throw invalid('The workbook must contain a header and at least one data row.');
    return { sheetName: sheet.name, date1904: Boolean(workbook.properties.date1904), sheetCount: workbook.worksheets.length,
      headerRowNumber, headers, sourceHeaders, headerCellMetadata, rows, expandedBytes, decodedBytes };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw invalid('The XLSX workbook could not be read. Check the file and try again.');
  }
}
