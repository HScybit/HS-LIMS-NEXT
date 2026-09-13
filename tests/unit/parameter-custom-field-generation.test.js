import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generateParameterScheme, generateProductScheme } from '../../src/custom-fields/product-generation.js';
import { parameterGenerationInput } from '../../src/masters/parameter-custom-field-generation.js';
import { emptyUncertaintyGrid } from '../../src/masters/parameter-grid.js';

test('parameter schemes use parameter counters and form keys without substituting its name as a product', async () => {
  const value = await generateParameterScheme({ field: { scheme: '{{entity.name}}/{{entity.scheme_abbr}}/{{entity.order}}/{{product_name}}/{{product_abbr}}/{{total_counter}}/{{samples_counter}}/{{flag}}' },
    doc: { name: 'Nickel', scheme_abbr: 'Ni', order: 0, project_field_data: { flag: { display_value: false } } },
    clock: { year: 2026, month: 9, day: 13, timestamp: 1 }, counts: { parameters: 7, samples: 4 }, settings: { nonNablStartNumber: '9tail' } });
  assert.equal(value, 'Nickel/Ni/0///16/5/false');
  for (const generate of [generateProductScheme, generateParameterScheme]) {
    assert.equal(await generate({ field: { scheme: 'literal' }, doc: {} }), 'literal');
  }
});

test('parameter generation validates draft structure, preserves empty and zero order and adapts the uncertainty spreadsheet', () => {
  const input = { parameter: { name: '', description: '', key: '', schemeAbbreviation: '', order: '', laboratoryId: '', measurementUncertainty: emptyUncertaintyGrid() }, customFields: [] };
  const command = parameterGenerationInput(input);
  assert.equal(command.doc.order, ''); assert.equal(command.doc.lab_id, '');
  assert.deepEqual(command.doc.measurement_uncertainty, { headers: ['Sr. no.', 'Text'], data: [['1', '']] });
  assert.equal(parameterGenerationInput({ ...input, parameter: { ...input.parameter, order: 0 } }).doc.order, 0);
  for (const order of [NaN, Infinity, {}, [], true, '\0', 'a'.repeat(65)]) {
    assert.throws(() => parameterGenerationInput({ ...input, parameter: { ...input.parameter, order } }), { code: 'invalid_input' });
  }
  assert.throws(() => parameterGenerationInput({ ...input, parameter: { ...input.parameter, productId: randomUUID() } }), { code: 'invalid_input' });
});
