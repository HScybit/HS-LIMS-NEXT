import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { registerSample } from '../../src/samples/register.js';
import { updateSample } from '../../src/samples/update.js';
import { loadSample } from '../../src/samples/load.js';

const owner = ownerPool(); let manager;
const work = (action) => withSession(manager.token, action, { csrfToken: manager.csrfToken });
before(async () => {
  const user = await createAccount(owner, { permissions: ['samples.create', 'samples.manage', 'samples.read'] });
  manager = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
});
after(async () => { await closePool(); await owner.end(); });

async function registerSampleOfType(sampleType, headers = {}) {
  const fixture = await createLaboratoryFixture(owner, manager, { repeated: false });
  const products = sampleType === 'complaint'
    ? [{ ...structuredClone(fixture.registration.products[0]), tests: fixture.registration.products[0].tests.map((row) => ({ ...row, isRetest: true })) }]
    : fixture.registration.products;
  const created = await work((client, identity) => registerSample(client, identity, { ...fixture.registration, sampleType, products, ...headers }));
  return work((client, identity) => loadSample(client, identity, created.id));
}

test('root cause and corrective/preventive action can be recorded and updated on a complaint sample', async () => {
  const sample = await registerSampleOfType('complaint');
  assert.equal(sample.complaintRca, null); assert.equal(sample.complaintCapa, null);
  await work((client, identity) => updateSample(client, identity, sample.id, { revision: sample.revision,
    complaintRca: 'Calibration drift on the balance', complaintCapa: 'Recalibrated and added to the weekly schedule' }));
  const saved = await work((client, identity) => loadSample(client, identity, sample.id));
  assert.equal(saved.revision, sample.revision + 1);
  assert.equal(saved.complaintRca, 'Calibration drift on the balance');
  assert.equal(saved.complaintCapa, 'Recalibrated and added to the weekly schedule');
  assert.equal(saved.activity.filter((event) => event.eventType === 'sample_updated').length, 1);
  await work((client, identity) => updateSample(client, identity, sample.id, { revision: saved.revision, complaintRca: 'Revised finding' }));
  const revised = await work((client, identity) => loadSample(client, identity, sample.id));
  assert.equal(revised.complaintRca, 'Revised finding');
  assert.equal(revised.complaintCapa, 'Recalibrated and added to the weekly schedule');
});

test('RCA/CAPA are ignored on non-complaint samples, matching how complaint-only fields already behave', async () => {
  for (const sampleType of ['internal', 'amendment']) {
    const sample = await registerSampleOfType(sampleType);
    await work((client, identity) => updateSample(client, identity, sample.id, { revision: sample.revision, complaintRca: 'Should not apply', complaintCapa: 'Should not apply' }));
    const saved = await work((client, identity) => loadSample(client, identity, sample.id));
    assert.equal(saved.complaintRca, null); assert.equal(saved.complaintCapa, null);
    assert.equal(saved.revision, sample.revision, 'no-op change to a non-editable field must not advance the revision');
  }
});
