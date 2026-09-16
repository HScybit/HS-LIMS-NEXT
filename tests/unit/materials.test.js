import test from 'node:test';
import assert from 'node:assert/strict';
import { materialAmount, materialFingerprint, materialInput, materialTransactionInput } from '../../src/materials/input.js';

const id = 'abcdef12-1234-4567-89ab-abcdef123456';
const input = () => ({ id, requestId: id, revision: 0, name: '  Material  ', code: '  KEY  ', description: '  Description  ',
  categoryId: id, measurementUnitId: id, initialQuantity: ' 1.2500000001 ', minimumQuantity: '0' });
const transaction = () => ({ id, requestId: id, materialId: id, type: 'in', quantity: '1', cost: '0', supplier: '  Supplier  ', batchSerialNumber: ' A ' });

test('material inputs retain exact decimals, trim text and normalize UUIDs without inventing a maximum', () => {
  const result = materialInput({ ...input(), id: id.toUpperCase() });
  assert.equal(result.id, id); assert.equal(result.name, 'Material'); assert.equal(result.code, 'KEY'); assert.equal(result.description, 'Description');
  assert.equal(result.initialQuantity, '1.2500000001'); assert.equal(result.minimumQuantity, '0'); assert.equal(Object.hasOwn(result, 'maximumQuantity'), false);
  assert.equal(materialInput({ ...input(), maximumQuantity: null }).maximumQuantity, null);
  assert.equal(materialInput({ ...input(), description: null }).description, '');
});

test('material amounts preserve finite decimal precision and meaningful zero without accepting prefixes or underflow', () => {
  for (const value of ['0', '-0', '+0.0', '1e2', '0.0000000001', '5e-324', '1.7976931348623157e308']) assert.equal(materialAmount(value, 'Amount'), value);
  assert.equal(materialAmount(0, 'Amount'), '0'); assert.equal(materialAmount('', 'Amount', { optional: true }), null);
  for (const value of ['', null, true, [], {}, '0x10', '1tail', 'Infinity', '-Infinity', 'NaN', '-1', '1e309', '1e-99999', '0e999999', '1,000']) {
    assert.throws(() => materialAmount(value, 'Amount'), { status: 400 });
  }
  for (const value of [0, '0', '-0', '1e-400']) assert.throws(() => materialAmount(value, 'Amount', { positive: true }), { status: 400 });
});

test('material retry fingerprints compare decimals exactly across equivalent exponents and trailing zeros', () => {
  const first = materialInput(input());
  assert.equal(materialFingerprint(first), materialFingerprint({ ...first, initialQuantity: '12500000001e-10', minimumQuantity: '-0.0' }));
  assert.notEqual(materialFingerprint(first), materialFingerprint({ ...first, initialQuantity: '1.2500000002' }));
  assert.notEqual(materialFingerprint(first), materialFingerprint({ ...first, maximumQuantity: '0' }));
});

for (const [field, values] of [
  ['name', ['', null, true, 'x'.repeat(201), 'A\0B']], ['code', ['', 'x'.repeat(65), {}, 'A\0B']],
  ['description', [false, 'x'.repeat(16001), 'A\0B']], ['categoryId', ['bad', null]], ['measurementUnitId', ['bad', null]],
  ['revision', [-1, 0.1, '1', null, 2_147_483_647]],
]) test(`material authoring rejects invalid ${field}`, () => {
  for (const value of values) assert.throws(() => materialInput({ ...input(), [field]: value }), { status: 400 });
});

test('material and transaction payloads reject forged ownership and unsupported fields', () => {
  for (const value of [null, [], 'record', { ...input(), organizationId: id }, { ...input(), createdBy: id }, { ...input(), active: false }]) {
    assert.throws(() => materialInput(value), { code: 'invalid_input' });
  }
  for (const value of [null, [], { ...transaction(), createdAt: '2026-01-01' }, { ...transaction(), unitName: 'Forged' }]) {
    assert.throws(() => materialTransactionInput(value), { code: 'invalid_input' });
  }
});

test('transaction inputs keep zero cost, require positive quantity and ignore OUT-only irrelevant cost and expiry', () => {
  const result = materialTransactionInput(transaction()); assert.equal(result.supplier, 'Supplier'); assert.equal(result.batchSerialNumber, 'A'); assert.equal(result.cost, '0');
  const out = materialTransactionInput({ ...transaction(), type: 'out_damaged', cost: 'invalid', expiryDate: 'invalid' });
  assert.equal(out.cost, null); assert.equal(out.expiryDate, '');
  for (const changes of [{ type: 'adjust' }, { cost: null }, { quantity: '0' }, { quantity: '-1' }, { supplier: 'x'.repeat(251) }, { batchSerialNumber: '' }, { batchSerialNumber: 'x'.repeat(151) }]) {
    assert.throws(() => materialTransactionInput({ ...transaction(), ...changes }), { status: 400 });
  }
});
