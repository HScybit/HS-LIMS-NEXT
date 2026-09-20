import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveLaboratory } from '../../src/masters/laboratories.js';
import { listEnvironmentData, getEnvironmentData, createEnvironmentData, updateEnvironmentData, deleteEnvironmentData, laboratoriesMissingReadings } from '../../src/environment/service.js';

const owner = ownerPool(); let manager;
const work = (action, user = manager) => withSession(user.token, action, { csrfToken: user.csrfToken });
before(async () => {
  const user = await createAccount(owner, { permissions: ['environment_data.manage', 'environment_data.read', 'users.manage', 'masters.read'] });
  manager = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
});
after(async () => { await closePool(); await owner.end(); });

async function laboratoryWithLimits(limits = {}) {
  const fixture = await createLaboratoryFixture(owner, manager, { workflow: false });
  const saved = await work((client, identity) => saveLaboratory(client, identity, { id: fixture.laboratory.id, revision: fixture.laboratory.revision,
    requestId: randomUUID(), code: fixture.laboratory.code, name: fixture.laboratory.name,
    minimumTemperature: limits.minTemperature ?? null, maximumTemperature: limits.maxTemperature ?? null,
    minimumHumidity: limits.minHumidity ?? null, maximumHumidity: limits.maxHumidity ?? null }));
  return { ...fixture.laboratory, ...saved };
}

test('a reading can be recorded, listed, updated and deleted with revision locking', async () => {
  const laboratory = await laboratoryWithLimits({ minTemperature: '15', maxTemperature: '25' });
  const created = await work((client, identity) => createEnvironmentData(client, identity,
    { laboratoryId: laboratory.id, recordedAt: '2026-04-01T10:00:00Z', temperatureCelsius: 20, relativeHumidityPercent: 45 }));
  assert.equal(created.temperatureCelsius, '20'); assert.equal(created.revision, 1);
  const listed = await work((client, identity) => listEnvironmentData(client, identity));
  assert(listed.items.some((item) => item.id === created.id));
  const updated = await work((client, identity) => updateEnvironmentData(client, identity, created.id,
    { revision: created.revision, laboratoryId: laboratory.id, recordedAt: '2026-04-01T10:00:00Z', temperatureCelsius: 22, relativeHumidityPercent: 46 }));
  assert.equal(updated.temperatureCelsius, '22'); assert.equal(updated.revision, 2);
  await assert.rejects(work((client, identity) => updateEnvironmentData(client, identity, created.id,
    { revision: created.revision, laboratoryId: laboratory.id, recordedAt: '2026-04-01T10:00:00Z', temperatureCelsius: 23 })), { code: 'environment_reading_changed' });
  await work((client, identity) => deleteEnvironmentData(client, identity, created.id, updated.revision));
  await assert.rejects(work((client, identity) => getEnvironmentData(client, identity, created.id)), { code: 'environment_reading_not_found' });
});

test('temperature or humidity is required, and at least one field must be given', async () => {
  const laboratory = await laboratoryWithLimits();
  await assert.rejects(work((client, identity) => createEnvironmentData(client, identity, { laboratoryId: laboratory.id, recordedAt: '2026-04-01T10:00:00Z' })),
    { code: 'invalid_environment_reading' });
});

test('an out-of-range reading is hard-rejected, matching PERN rather than Meteor\'s silent acceptance', async () => {
  const laboratory = await laboratoryWithLimits({ minTemperature: '15', maxTemperature: '25', minHumidity: '30', maxHumidity: '60' });
  await assert.rejects(work((client, identity) => createEnvironmentData(client, identity,
    { laboratoryId: laboratory.id, recordedAt: '2026-04-01T10:00:00Z', temperatureCelsius: 30 })), { code: 'temperature_out_of_range' });
  await assert.rejects(work((client, identity) => createEnvironmentData(client, identity,
    { laboratoryId: laboratory.id, recordedAt: '2026-04-01T10:00:00Z', temperatureCelsius: 10 })), { code: 'temperature_out_of_range' });
  await assert.rejects(work((client, identity) => createEnvironmentData(client, identity,
    { laboratoryId: laboratory.id, recordedAt: '2026-04-01T10:00:00Z', relativeHumidityPercent: 90 })), { code: 'humidity_out_of_range' });
  const within = await work((client, identity) => createEnvironmentData(client, identity,
    { laboratoryId: laboratory.id, recordedAt: '2026-04-01T10:00:00Z', temperatureCelsius: 20, relativeHumidityPercent: 45 }));
  assert.equal(within.temperatureCelsius, '20');
});

test('a laboratory limit that is not a parseable number rejects the validation attempt rather than being silently skipped', async () => {
  const laboratory = await laboratoryWithLimits({ minTemperature: 'room temperature' });
  await assert.rejects(work((client, identity) => createEnvironmentData(client, identity,
    { laboratoryId: laboratory.id, recordedAt: '2026-04-01T10:00:00Z', temperatureCelsius: 20 })), { code: 'invalid_laboratory_limit' });
});

test('readings with no configured limits are accepted without range checks', async () => {
  const laboratory = await laboratoryWithLimits();
  const created = await work((client, identity) => createEnvironmentData(client, identity,
    { laboratoryId: laboratory.id, recordedAt: '2026-04-01T10:00:00Z', temperatureCelsius: -80 }));
  assert.equal(created.temperatureCelsius, '-80');
});

test('the missed-reading scan reports nothing when no interval is configured for the organization', async () => {
  const result = await work((client, identity) => laboratoriesMissingReadings(client, identity));
  assert.deepEqual(result, { items: [], intervalConfigured: false });
});
