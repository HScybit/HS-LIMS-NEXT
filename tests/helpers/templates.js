import { randomUUID } from 'node:crypto';
import { createTemplate, copyDefinition } from '../../src/templates/authoring.js';
import { database } from '../../src/db/pool.js';
import { parseExpression } from '../../src/templates/expressions.js';

// Explicit synthetic fixture; no source database records or serialized canonical definitions.
export function analyticalRecords({ rowCount = 2, repeated = true, chain = false } = {}) {
  const sections = [{ id: randomUUID(), parentColumnId: null, position: 0, name: 'Analytical results' }];
  const records = { sections, rows: [], columns: [], fields: [], options: [], expressions: [], groups: [] };
  let previousCalculated;
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row = { id: randomUUID(), sectionId: sections[0].id, position: rowIndex };
    records.rows.push(row);
    let repeatGroupId = null;
    if (repeated && rowIndex === 0) {
      repeatGroupId = randomUUID();
      records.groups.push({ id: repeatGroupId, parentGroupId: null, rowId: row.id, sectionId: null, source: 'manual', minimum: 2, maximum: 1000 });
    }
    const rawId = randomUUID();
    const calculatedId = randomUUID();
    for (const [position, id, widget, alias] of [[0, rawId, 'number_widget', `raw_${rowIndex}`], [1, calculatedId, 'formula_widget', `result_${rowIndex}`]]) {
      const columnId = randomUUID();
      records.columns.push({ id: columnId, rowId: row.id, position, span: 6 });
      records.fields.push({ id, columnId, repeatGroupId, widget, valueType: 'numeric', alias, label: alias, required: widget === 'number_widget',
        numeric: { fieldId: id, displayScale: 2, padDecimals: true, minimum: null, maximum: null } });
    }
    let formula = `raw_${rowIndex} * 2`;
    let references = { [`raw_${rowIndex}`]: { fieldId: rawId, scope: 'current' } };
    if (chain && previousCalculated && !repeated) {
      formula = `result_${rowIndex - 1} + raw_${rowIndex}`;
      references[`result_${rowIndex - 1}`] = { fieldId: previousCalculated, scope: 'current' };
    }
    records.expressions.push({ id: randomUUID(), fieldId: calculatedId, purpose: 'calculate', nodes: parseExpression(formula, (alias) => references[alias]) });
    previousCalculated = calculatedId;
  }
  if (repeated && rowCount > 1) {
    const firstRaw = records.fields[0];
    const lastResult = records.fields.at(-1);
    const expression = records.expressions.at(-1);
    expression.nodes = parseExpression(`SUM(${firstRaw.alias})`, () => ({ fieldId: firstRaw.id, scope: 'descendants' }));
    expression.fieldId = lastResult.id;
  }
  return records;
}

export async function createAnalyticalTemplate(client, identity, options) {
  const created = await createTemplate(client, identity, { name: 'Synthetic analytical template', description: 'Synthetic test fixture', kind: 'datasheet' });
  const records = analyticalRecords(options);
  await copyDefinition(database(client), records, identity.organization_id, created.versionId);
  return { ...created, records };
}
