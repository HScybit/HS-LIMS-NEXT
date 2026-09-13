import test from 'node:test';
import assert from 'node:assert/strict';
import { laboratorySchemeSettingsInput } from '../../src/organization-settings/service.js';
import { productGenerationInput } from '../../src/masters/product-custom-field-generation.js';

const settings = { schemeCurrentYearDigits: '0', schemeNextYearDigits: '-1', schemeSeparator: ' / ', schemeMonthFormat: 'short', schemeNonNablStartNumber: '9tail' };
test('scheme settings preserve source scalar lexemes, distinguish omission and reject incomplete or malformed settings', () => {
  assert.equal(laboratorySchemeSettingsInput({}), null);
  assert.deepEqual(laboratorySchemeSettingsInput(settings), settings);
  for (const input of [{ schemeCurrentYearDigits: '2' }, { ...settings, schemeMonthFormat: 'invalid' }, { ...settings, schemeSeparator: '\0' },
    { ...settings, schemeNextYearDigits: undefined }, { ...settings, schemeNonNablStartNumber: 9 }, { ...settings, schemeCurrentYearDigits: 'x'.repeat(129) }]) {
    assert.throws(() => laboratorySchemeSettingsInput(input), { code: 'invalid_scheme_settings' });
  }
});

test('Product generation accepts unfinished form fields but rejects hidden context, invalid values and forged identifiers', () => {
  const input = { product: { name: '', description: '  exact  ', abbreviation: null, key: '', tagIds: [] }, customFields: [] };
  const parsed = productGenerationInput(input);
  assert.equal(parsed.product.description, '  exact  '); assert.equal(parsed.product.abbr, null); assert.equal(parsed.productId, null);
  assert.throws(() => productGenerationInput({ ...input, product: { ...input.product, is_nabl: true } }), { code: 'invalid_input' });
  assert.throws(() => productGenerationInput({ ...input, productId: 'foreign-invalid' }), { code: 'invalid_id' });
  assert.throws(() => productGenerationInput({ ...input, product: { name: '\ud800' } }), { code: 'invalid_input' });
  assert.throws(() => productGenerationInput({ ...input, customFieldTimeZone: 'constructor' }), { code: 'invalid_custom_field_timezone' });
});
