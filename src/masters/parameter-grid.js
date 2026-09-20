import { HttpError } from '../auth/errors.js';
import { fieldsOnly, text, uuid } from '../templates/input.js';

export const uncertaintyLimits = Object.freeze({ rows: 500, columns: 32, cellLength: 2000, headerLength: 200, bytes: 1_048_576 });
const invalid = (message) => { throw new HttpError(400, 'invalid_uncertainty', message); };
const newId = () => globalThis.crypto.randomUUID();

// This is an HTTP/editor model. Each column, row and cell is stored separately
// in the dedicated parameter uncertainty tables; serial cells are derived.
export function normalizeUncertaintyGrid(value) {
  if (value == null) return null;
  fieldsOnly(value, ['columns', 'rows']);
  if (!Array.isArray(value.columns) || value.columns.length < 2 || value.columns.length > uncertaintyLimits.columns) invalid('Measurement uncertainty needs between 2 and 32 columns.');
  if (!Array.isArray(value.rows) || !value.rows.length || value.rows.length > uncertaintyLimits.rows) invalid('Measurement uncertainty needs between 1 and 500 rows.');
  const columns = value.columns.map((column) => {
    fieldsOnly(column, ['id', 'title']);
    const title = text(column.title, 'Column header', uncertaintyLimits.headerLength);
    if (title.includes('\0')) invalid('Column headers cannot contain null characters.');
    return { id: uuid(column.id, 'Uncertainty column').toLowerCase(), title };
  });
  const rows = value.rows.map((row) => {
    fieldsOnly(row, ['id', 'values']);
    if (!Array.isArray(row.values) || row.values.length !== columns.length - 1) invalid('Every uncertainty row must match its text columns.');
    const values = row.values.map((cell) => {
      if (typeof cell !== 'string' || cell.length > uncertaintyLimits.cellLength || cell.includes('\0')) invalid('Uncertainty cells must contain at most 2,000 text characters.');
      return cell;
    });
    return { id: uuid(row.id, 'Uncertainty row').toLowerCase(), values };
  });
  if (new Set(columns.map((column) => column.id)).size !== columns.length || new Set(rows.map((row) => row.id)).size !== rows.length) invalid('Uncertainty row and column identities must be unique.');
  const encoder = new TextEncoder();
  let bytes = columns.reduce((total, column) => total + encoder.encode(column.title).byteLength, 0);
  for (const row of rows) for (const value of row.values) bytes += encoder.encode(value).byteLength;
  if (bytes > uncertaintyLimits.bytes) throw new HttpError(413, 'uncertainty_too_large', 'Measurement uncertainty text exceeds 1 MiB.');
  return { columns, rows };
}

export function emptyUncertaintyGrid(createId = newId) {
  return { columns: ['Sr. no.', 'Text'].map((title) => ({ id: createId(), title })), rows: [{ id: createId(), values: [''] }] };
}

export function uncertaintySpreadsheet(grid) {
  return { headers: grid.columns.map((column) => column.title), data: grid.rows.map((row, index) => [String(index + 1), ...row.values]) };
}

// The source editor appends/removes only the last row/column. Keep the stable
// identities of surviving records when adapting its positional change event.
export function updateUncertaintyGrid(previous, next, createId = newId) {
  if (!Array.isArray(next?.headers) || !Array.isArray(next?.data)) invalid('The uncertainty editor returned an invalid grid.');
  const columns = next.headers.map((title, index) => ({ id: previous?.columns[index]?.id ?? createId(), title }));
  const rows = next.data.map((row, index) => {
    if (!Array.isArray(row) || row.length !== columns.length) invalid('Every uncertainty row must match its headers.');
    return { id: previous?.rows[index]?.id ?? createId(), values: row.slice(1).map((value) => {
      if (value == null) return '';
      if (!['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) invalid('Uncertainty cells require scalar text.');
      return String(value);
    }) };
  });
  return normalizeUncertaintyGrid({ columns, rows });
}
