import { HttpError } from '../auth/errors.js';

export const masterBulkCsvLimits = Object.freeze({
  bytes: 16 * 1024 * 1024,
  rows: 2500,
  columns: 250,
  cellCharacters: 16000,
  headerCharacters: 250,
});

function invalid(message) {
  return new HttpError(400, 'invalid_bulk_csv', message);
}

// CSV carries text, including values that look like numbers, dates or formulas.
// Master binding applies field-specific conversions after these source values are captured.
export function parseMasterBulkCsv(input) {
  if (typeof input !== 'string') throw invalid('Provide CSV text.');
  if (input.length > masterBulkCsvLimits.bytes) throw invalid('The CSV must be 16 MiB or smaller.');
  if (!input.isWellFormed() || input.includes('\0')) throw invalid('The CSV contains invalid text.');
  if (new TextEncoder().encode(input).byteLength > masterBulkCsvLimits.bytes) throw invalid('The CSV must be 16 MiB or smaller.');

  const rows = [];
  let headers;
  let sourceHeaders;
  let headerRowNumber;
  let values = [];
  let cell = '';
  let state = 'start';
  let lineNumber = 1;
  let rowNumber = 1;

  function append(value) {
    if (cell.length + value.length > masterBulkCsvLimits.cellCharacters) {
      throw invalid(`Row ${rowNumber}, column ${values.length + 1} exceeds 16,000 characters.`);
    }
    cell += value;
  }

  function finishCell() {
    if (values.length >= masterBulkCsvLimits.columns) throw invalid(`Row ${rowNumber} exceeds 250 columns.`);
    values.push(cell);
    cell = '';
    state = 'start';
  }

  function finishRow() {
    finishCell();
    if (values.some(value => value.trim() !== '')) {
      if (!headers) {
        sourceHeaders = values;
        headers = values.map(value => value.trim());
        // Spreadsheet exports commonly append empty columns after the named headers.
        while (headers.at(-1) === '') headers.pop();
        if (headers.some(value => !value)) throw invalid(`Header cells cannot be blank (row ${rowNumber}).`);
        if (headers.some(value => value.length > masterBulkCsvLimits.headerCharacters)) {
          throw invalid('Column headers must be 250 characters or shorter.');
        }
        if (new Set(headers).size !== headers.length) throw invalid('Each column header must be unique.');
        headerRowNumber = rowNumber;
      } else {
        if (rows.length >= masterBulkCsvLimits.rows) throw invalid('Upload 2,500 data rows or fewer at a time.');
        if (values.slice(headers.length).some(value => value.trim() !== '')) {
          throw invalid(`Row ${rowNumber} has a value in a column without a header.`);
        }
        rows.push({ rowNumber, values });
      }
    }
    values = [];
  }

  for (let index = input.startsWith('\uFEFF') ? 1 : 0; index < input.length; index++) {
    const character = input[index];
    if (character === '\r' || character === '\n') {
      const crlf = character === '\r' && input[index + 1] === '\n';
      if (state === 'quoted') append(crlf ? '\r\n' : character);
      else finishRow();
      if (crlf) index++;
      lineNumber++;
      if (state !== 'quoted') rowNumber = lineNumber;
    } else if (state === 'quoted') {
      if (character === '"') {
        if (input[index + 1] === '"') {
          append('"'); index++;
        } else state = 'closed';
      } else append(character);
    } else if (character === ',') {
      finishCell();
    } else if (character === '"') {
      if (state !== 'start') throw invalid(`Row ${rowNumber}, column ${values.length + 1} has an unexpected quote.`);
      state = 'quoted';
    } else {
      if (state === 'closed' && character !== ' ' && character !== '\t') {
        throw invalid(`Row ${rowNumber}, column ${values.length + 1} has text after its closing quote.`);
      }
      append(character);
      if (state === 'start') state = 'plain';
    }
  }

  if (state === 'quoted') throw invalid(`Row ${rowNumber}, column ${values.length + 1} has an unterminated quoted value.`);
  if (cell.length || values.length || state !== 'start') finishRow();
  if (!headers || rows.length === 0) throw invalid('The CSV must contain a header and at least one data row.');
  return { headerRowNumber, headers, sourceHeaders, rows };
}
