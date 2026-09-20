import { HttpError } from '../auth/errors.js';
import { sampleProductInput } from './input.js';

const invalid = message => { throw new HttpError(400, 'invalid_sample', message); };

export function sampleProductsUpdateInput(products, categoryId) {
  if (!Array.isArray(products) || !products.length || products.length > 100) invalid('Add between 1 and 100 products.');
  const lines = products.map(product => sampleProductInput(product, categoryId, true));
  const tests = lines.flatMap(line => line.tests);
  if (tests.length > 5000) invalid('A sample cannot exceed 5,000 selected tests.');
  for (const [rows, label] of [[lines, 'sample line'], [tests, 'selected test']]) {
    const ids = rows.map(row => row.id).filter(Boolean);
    if (new Set(ids).size !== ids.length) invalid(`The same ${label} ID cannot be supplied twice.`);
    for (const row of rows) for (const value of Object.values(row)) {
      if (typeof value === 'string' && (!value.isWellFormed() || value.includes('\0'))) invalid('Sample lines contain invalid text.');
    }
  }
  for (const line of lines) for (const key of ['productId', 'sampleCategoryId', 'measurementUnitId', 'tagId']) line[key] = line[key]?.toLowerCase() ?? null;
  for (const test of tests) if (test.rate?.startsWith('-') && /[1-9]/.test(test.rate.split(/[eE]/)[0])) invalid('Rate must be at least zero.');
  return lines;
}

// Find free positions above the final order range. This also handles imported
// positions near the integer limit without adding to their maximum value.
export function temporarySampleOrders(rows, finalCount) {
  const occupied = new Set(rows.map(row => row.displayOrder));
  let next = finalCount;
  return rows.map(row => {
    while (occupied.has(next)) next += 1;
    const position = next++; occupied.add(position);
    return { id: row.id, displayOrder: position };
  });
}
