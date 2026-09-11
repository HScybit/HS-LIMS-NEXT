import { randomUUID } from 'node:crypto';
import { parseExpression } from '../../src/templates/expressions.js';

export const performanceFixtures = [
  { name: 'small', sectionCount: 5, rowCount: 5, repeatedRows: 1, occurrences: 10, nested: false, conditions: false },
  { name: 'large', sectionCount: 100, rowCount: 200, repeatedRows: 10, occurrences: 21, nested: false, conditions: false },
  { name: 'complex', sectionCount: 40, rowCount: 100, repeatedRows: 20, occurrences: 46, nested: true, conditions: true },
];

export function performanceRecords(fixture) {
  const records = { sections: [], rows: [], columns: [], fields: [], options: [], expressions: [], groups: [] };
  const sectionPositions = new Map();
  for (let index = 0; index < fixture.sectionCount; index += 1) {
    let parentColumnId = null;
    if (fixture.nested && index % 7 !== 0) {
      const parent = records.sections[index - 1];
      const rowId = randomUUID(); parentColumnId = randomUUID();
      records.rows.push({ id: rowId, sectionId: parent.id, position: 0 });
      records.columns.push({ id: parentColumnId, rowId, position: 0 });
      sectionPositions.set(parent.id, 1);
    }
    records.sections.push({ id: randomUUID(), parentColumnId, position: parentColumnId ? 0 : records.sections.filter((section) => !section.parentColumnId).length, name: `Synthetic section ${index + 1}` });
  }
  let previousResult;
  for (let index = 0; index < fixture.rowCount; index += 1) {
    const section = records.sections[index % fixture.sectionCount];
    const rowId = randomUUID();
    const position = sectionPositions.get(section.id) ?? 0;
    sectionPositions.set(section.id, position + 1);
    records.rows.push({ id: rowId, sectionId: section.id, position });
    let groupId = null;
    if (index < fixture.repeatedRows) {
      groupId = randomUUID();
      records.groups.push({ id: groupId, parentGroupId: null, rowId, source: 'manual', minimum: fixture.occurrences, maximum: 1000 });
    }
    const rowFields = [];
    for (let column = 0; column < 5; column += 1) {
      const columnId = randomUUID(); const fieldId = randomUUID();
      records.columns.push({ id: columnId, rowId, position: column });
      const field = { id: fieldId, columnId, repeatGroupId: groupId, widget: column === 4 ? 'formula_widget' : 'number_widget', valueType: 'numeric', alias: `field_${index}_${column}`,
        label: `Synthetic ${index + 1}.${column + 1}`, numeric: { fieldId, displayScale: 3, padDecimals: true } };
      records.fields.push(field); rowFields.push(field);
    }
    const references = Object.fromEntries(rowFields.map((field) => [field.alias, { fieldId: field.id, scope: 'current' }]));
    let formula = `(${rowFields[0].alias} + ${rowFields[1].alias}) / 2`;
    if (fixture.conditions && previousResult && !groupId) {
      const scope = previousResult.repeatGroupId ? 'descendants' : 'current';
      references[previousResult.alias] = { fieldId: previousResult.id, scope };
      formula += ` + ${scope === 'descendants' ? `SUM(${previousResult.alias})` : previousResult.alias}`;
    }
    const result = rowFields[4];
    records.expressions.push({ id: randomUUID(), fieldId: result.id, purpose: 'calculate', nodes: parseExpression(formula, (alias) => references[alias]) });
    previousResult = result;
    if (fixture.conditions) for (const field of rowFields.slice(0, 4)) records.expressions.push({ id: randomUUID(), fieldId: field.id, purpose: 'required', nodes: parseExpression(`${field.alias} >= 0`, (alias) => references[alias]) });
    if (fixture.name === 'large' && index % 20 === 0) {
      const choice = rowFields[3]; choice.widget = 'dropdown_widget'; choice.valueType = 'option'; choice.numeric = null;
      for (let option = 0; option < 10; option += 1) records.options.push({ id: randomUUID(), fieldId: choice.id, position: option, label: `Option ${option + 1}`, value: String(option + 1) });
    }
  }
  return records;
}
