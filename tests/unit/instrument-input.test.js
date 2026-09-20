import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { instrumentCoreInput, instrumentServiceInput, instrumentRequestFingerprint } from '../../src/instruments/input.js';
import { instrumentGenerationInput } from '../../src/instruments/custom-field-generation.js';

const command = changes => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, code: 'Inst-01', name: 'Instrument', laboratoryId: randomUUID(),
  dateOfInstallation: '2026-09-17', allowedUserIds: [randomUUID()], ...changes });
const service = changes => ({ id: randomUUID(), serviceCode: 'inspection', ...changes });
const invalid = action => assert.throws(action, error => error.status === 400);

test('Instrument core retains exact key case, optional metadata, explicit false and decimal zero', () => {
  const raw = command({ name: '  Instrument  ', calibrated: false, active: false, costOfEquipment: '0', make: '  Maker  ', manufacturerSupplier: 'Supplier' });
  const before = structuredClone(raw); const input = instrumentCoreInput(raw);
  assert.equal(input.name, 'Instrument'); assert.equal(input.code, 'Inst-01'); assert.equal(input.make, 'Maker');
  assert.equal(input.calibrated, false); assert.equal(input.active, false); assert.equal(input.costOfEquipment, '0');
  assert.equal(input.description, null); assert.equal(input.serviceConfigurations, null); assert.deepEqual(raw, before);
  assert.equal(instrumentCoreInput(command({ costOfEquipment: '9999999999999999.99' })).costOfEquipment, '9999999999999999.99');
  assert.equal(instrumentCoreInput(command({ costOfEquipment: '-0.00' })).costOfEquipment, '-0.00');
});

test('Instrument partial edits preserve hidden fields while retaining relationship omission', () => {
  const original = instrumentCoreInput(command({ costOfEquipment: '12.34', currentLocation: 'Shelf', calibrated: false }));
  const raw = { id: original.id, requestId: randomUUID(), revision: 1, name: 'Changed' };
  const input = instrumentCoreInput(raw, original);
  assert.equal(input.costOfEquipment, '12.34'); assert.equal(input.currentLocation, 'Shelf'); assert.equal(input.calibrated, false);
  assert.equal(input.allowedUserIds, null); assert.equal(input.serviceConfigurations, null);
  assert.equal(instrumentRequestFingerprint(raw, input), instrumentRequestFingerprint(raw, instrumentCoreInput(raw, { ...original, costOfEquipment: '99' })));
  const clear = { ...raw, currentLocation: '', serviceConfigurations: [] }; const cleared = instrumentCoreInput(clear, original);
  assert.equal(cleared.currentLocation, null); assert.deepEqual(cleared.serviceConfigurations, []);
  assert.notEqual(instrumentRequestFingerprint(raw, input), instrumentRequestFingerprint(clear, cleared));
});

test('Instrument authoring requires real name/key/lab/date and one to500 distinct access users', () => {
  for (const changes of [{ name: '' }, { code: 'bad key' }, { laboratoryId: null }, { dateOfInstallation: '2026-02-30' }, { dateOfInstallation: '0000-01-01' },
    { allowedUserIds: [] }, { allowedUserIds: null }, { allowedUserIds: undefined }, { revision: -1 }, { unknown: true }]) invalid(() => instrumentCoreInput(command(changes)));
  const ids = Array.from({ length: 501 }, () => randomUUID());
  assert.equal(instrumentCoreInput(command({ allowedUserIds: ids.slice(0, 500) })).allowedUserIds.length, 500);
  invalid(() => instrumentCoreInput(command({ allowedUserIds: ids })));
  invalid(() => instrumentCoreInput(command({ allowedUserIds: [ids[0], ids[0].toUpperCase()] })));
  const sparse = new Array(2); sparse[0] = ids[0]; invalid(() => instrumentCoreInput(command({ allowedUserIds: sparse })));
});

test('Instrument text, booleans and nonnegative costs reject malformed values without numeric coercion', () => {
  for (const costOfEquipment of [-1, '-1e-999', NaN, Infinity, {}, '0x10', '1e400']) invalid(() => instrumentCoreInput(command({ costOfEquipment })));
  for (const changes of [{ name: '\0' }, { name: '\ud800' }, { make: 'x'.repeat(201) }, { active: 'false' }, { calibrated: null }, { purchaseFileId: 'bad' }]) {
    invalid(() => instrumentCoreInput(command(changes)));
  }
});

test('service configuration applies source defaults and preserves explicit zero and false', () => {
  const result = instrumentServiceInput(service());
  assert.equal(result.reminderBeforeDays, 1); assert.equal(result.frequencyDays, null); assert.equal(result.active, true);
  assert.equal(result.templateId, null); assert.deepEqual(result.reminderRoleIds, []);
  const configured = instrumentServiceInput(service({ templateId: randomUUID(), workflowId: randomUUID(), reminderRoleIds: [randomUUID()],
    frequencyDays: 36500, reminderBeforeDays: 0, reminderFrequencyDays: 3650, active: false, lastPerformedOn: '2024-02-29' }));
  assert.equal(configured.reminderBeforeDays, 0); assert.equal(configured.active, false); assert.equal(configured.lastPerformedOn, '2024-02-29');
});

test('service configuration enforces pairing, role requirements and date/frequency boundaries', () => {
  for (const changes of [{ templateId: randomUUID() }, { workflowId: randomUUID() }, { templateId: randomUUID(), workflowId: randomUUID() },
    { reminderBeforeDays: -1 }, { reminderBeforeDays: 3651 }, { reminderBeforeDays: null }, { frequencyDays: 0 }, { frequencyDays: 36501 },
    { frequencyDays: '1' }, { reminderFrequencyDays: 0 }, { reminderFrequencyDays: 3651 }, { nextReminderOn: '2026-02-29' },
    { active: 'false' }, { reminderRoleIds: null }, { serviceCode: 'bad key' }]) invalid(() => instrumentServiceInput(service(changes)));
  const id = randomUUID(); invalid(() => instrumentServiceInput(service({ reminderRoleIds: [id, id.toUpperCase()] })));
});

test('configurations are bounded, ordered and unique by identity and case-insensitive service code', () => {
  const rows = Array.from({ length: 101 }, (_, index) => service({ serviceCode: 'custom-' + index }));
  assert.deepEqual(instrumentCoreInput(command({ serviceConfigurations: rows.slice(0, 100) })).serviceConfigurations.map(row => row.serviceCode), rows.slice(0, 100).map(row => row.serviceCode));
  for (const serviceConfigurations of [rows, null, [{ ...rows[0] }, { ...rows[0], id: randomUUID(), serviceCode: rows[0].serviceCode.toUpperCase() }],
    [rows[0], { ...rows[1], id: rows[0].id }], new Array(1)]) invalid(() => instrumentCoreInput(command({ serviceConfigurations })));
});

test('Instrument field input keeps omission distinct from explicit values and fingerprints the captured intent', () => {
  const value = { fieldId: randomUUID(), fieldRevision: 1, value: [0, false, '', 'value'] };
  const raw = command(); const absent = instrumentCoreInput(raw);
  assert.equal(absent.customFields, undefined); assert.equal(absent.customFieldTimeZone, null);
  const submitted = { ...raw, customFields: [value], customFieldTimeZone: 'Asia/Kolkata' };
  const parsed = instrumentCoreInput(submitted);
  assert.deepEqual(parsed.customFields[0].value, [0, false, 'value']); assert.equal(parsed.customFieldTimeZone, 'Asia/Kolkata');
  assert.notEqual(instrumentRequestFingerprint(raw, absent), instrumentRequestFingerprint(submitted, parsed));
  for (const changes of [{ customFields: null }, { customFields: [value, value] }, { customFields: [{ ...value, value: {} }] }, { customFieldTimeZone: 'Invalid/Zone' }]) {
    invalid(() => instrumentCoreInput(command(changes)));
  }
});

test('Instrument generation accepts an unfinished form and retains source names, service zero, users and false', () => {
  const person = randomUUID(); const lab = randomUUID();
  const request = { instrument: { code: 'KEY', laboratoryId: lab, modelName: 'Model', costOfEquipment: 0, calibrated: false, allowedUserIds: [person],
    serviceConfigurations: [service({ reminderBeforeDays: 0 })] }, customFields: [] };
  const before = structuredClone(request); const generated = instrumentGenerationInput(request);
  assert.equal(generated.doc.name, ''); assert.equal(generated.doc.uniqueKey, 'KEY'); assert.equal(generated.doc.labId, lab);
  assert.equal(generated.doc.model, 'Model'); assert.equal(generated.doc.costOfEquipment, 0); assert.equal(generated.doc.calibrated, false);
  assert.deepEqual(generated.doc.allowAccessTo, [person]); assert.equal(generated.doc.serviceSchedules.inspection.remindBeforeDays, 0);
  assert.equal(generated.doc.serviceSchedules.inspection.frequency, ''); assert.deepEqual(request, before);
});

test('Instrument generation rejects malformed or oversized form values and duplicate schedules', () => {
  const row = service();
  for (const instrument of [{ name: '\ud800' }, { description: '\0' }, { costOfEquipment: Infinity }, { laboratoryId: 'invalid' },
    { serviceConfigurations: new Array(1) }, { serviceConfigurations: [row, { ...row, id: randomUUID(), serviceCode: row.serviceCode.toUpperCase() }] },
    { allowedUserIds: new Array(1) }, { allowedUserIds: Array.from({ length: 501 }, () => randomUUID()) }, { unexpected: true }]) {
    invalid(() => instrumentGenerationInput({ instrument, customFields: [] }));
  }
});
