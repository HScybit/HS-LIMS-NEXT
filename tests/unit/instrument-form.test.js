import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { instrumentFormDraft, instrumentFormErrors, instrumentFormSubmission, instrumentNextReminder, isBreakdownService } from '../../src/instruments/form.js';
import { instrumentCoreInput } from '../../src/instruments/input.js';

const type = { id: 'calibration', serviceCode: 'calibration', label: 'Calibration' };
const valid = { name: 'Instrument', code: 'INST-1', laboratoryId: randomUUID(), dateOfInstallation: '2026-09-17', allowedUserIds: [randomUUID()] };

test('Instrument wizard submission preserves hidden metadata, zero, false, active types and stable service identities', () => {
  const prior = { ...valid, active: false, calibrated: false, costOfEquipment: '0.00', currentLocation: 'Stored shelf', serviceConfigurations: [
    { id: randomUUID(), serviceCode: type.serviceCode, frequencyDays: 30, reminderBeforeDays: 0, lastPerformedOn: '2026-09-01', reminderRoleIds: [] },
    { id: randomUUID(), serviceCode: 'breakdown' },
  ] };
  const draft = instrumentFormDraft(prior, [type]); assert.equal(draft.serviceConfigurations.length, 1);
  assert.equal(draft.serviceConfigurations[0].id, prior.serviceConfigurations[0].id); assert.deepEqual(instrumentFormErrors(draft), {});
  const submission = instrumentFormSubmission(draft);
  const parsed = instrumentCoreInput({ ...submission, id: randomUUID(), revision: 0, requestId: randomUUID() });
  assert.equal(parsed.currentLocation, 'Stored shelf'); assert.equal(parsed.costOfEquipment, '0.00'); assert.equal(parsed.calibrated, false); assert.equal(parsed.active, false);
  assert.equal(parsed.serviceConfigurations[0].nextReminderOn, '2026-10-01'); assert.equal(parsed.serviceConfigurations[0].reminderBeforeDays, 0);
});

test('Instrument wizard blank numeric controls become native null or source zero without inventing service schedules', () => {
  const draft = instrumentFormDraft({ ...valid, serviceConfigurations: [] }, [type]);
  const service = instrumentFormSubmission(draft).serviceConfigurations[0];
  assert.equal(service.frequencyDays, null); assert.equal(service.reminderBeforeDays, 0); assert.equal(service.reminderFrequencyDays, null); assert.equal(service.nextReminderOn, null);
  assert.equal(instrumentFormDraft(null, []).serviceConfigurations.length, 0);
  for (const key of ['name', 'code', 'laboratoryId', 'dateOfInstallation', 'allowedUserIds']) assert.ok(instrumentFormErrors(instrumentFormDraft(null, []))[key]);
});

test('Instrument dates handle leap years, DST-independent days, year 1 and overflow before saving', () => {
  for (const [lastPerformedOn, frequencyDays, expected] of [['2024-02-28', 1, '2024-02-29'], ['2026-03-08', 1, '2026-03-09'], ['0001-01-01', 1, '0001-01-02']]) {
    assert.equal(instrumentNextReminder({ lastPerformedOn, frequencyDays }), expected);
  }
  assert.throws(() => instrumentNextReminder({ lastPerformedOn: '9999-12-31', frequencyDays: 1 }), /31\/12\/9999/);
  const draft = instrumentFormDraft({ ...valid, serviceConfigurations: [] }, [type]);
  for (const value of ['2026-02-29', '0000-01-01', '2026-13-01']) assert.ok(instrumentFormErrors({ ...draft, dateOfInstallation: value }).dateOfInstallation);
  const service = draft.serviceConfigurations[0]; service.lastPerformedOn = '9999-12-31'; service.frequencyDays = 1;
  assert.ok(instrumentFormErrors(draft)[service.id + ':frequencyDays']);
});

test('Instrument date controls accept their actual display buffer and submit canonical calendar dates', () => {
  const draft = instrumentFormDraft({ ...valid, serviceConfigurations: [] }, [type]);
  draft.dateOfInstallation = '17/09/2026'; draft.serviceConfigurations[0].lastPerformedOn = '28/02/2024'; draft.serviceConfigurations[0].frequencyDays = '1';
  assert.deepEqual(instrumentFormErrors(draft), {});
  const input = instrumentFormSubmission(draft);
  assert.equal(input.dateOfInstallation, '2026-09-17'); assert.equal(input.serviceConfigurations[0].lastPerformedOn, '2024-02-28'); assert.equal(input.serviceConfigurations[0].nextReminderOn, '2024-02-29');
  for (const dateOfInstallation of ['17/0', '29/02/2026', '01/01/0000']) assert.ok(instrumentFormErrors({ ...draft, dateOfInstallation }).dateOfInstallation);
});

test('Instrument wizard validates service pairs, role counts and integer boundaries and recognizes configured breakdown keys', () => {
  const draft = instrumentFormDraft({ ...valid, serviceConfigurations: [] }, [type]); const service = draft.serviceConfigurations[0];
  service.templateId = randomUUID(); assert.ok(instrumentFormErrors(draft)[service.id + ':workflowId']); assert.ok(instrumentFormErrors(draft)[service.id + ':reminderRoleIds']);
  service.workflowId = randomUUID(); service.reminderRoleIds = [randomUUID()];
  for (const [key, values] of [['frequencyDays', [-1, 0, 1.2, 36501, 'bad']], ['reminderBeforeDays', [-1, 3651]], ['reminderFrequencyDays', [0, 3651]]]) {
    for (const value of values) { service[key] = value; assert.ok(instrumentFormErrors(draft)[service.id + ':' + key]); } service[key] = '';
  }
  assert.deepEqual(instrumentFormErrors(draft), {}); assert.equal(isBreakdownService('breakdown'), true); assert.equal(isBreakdownService('calibration'), false);
});
