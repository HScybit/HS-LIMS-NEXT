import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { sampleRegistrationOptions } from '../../src/samples/options.js';
import { registerSample } from '../../src/samples/register.js';
import { updateSample } from '../../src/samples/update.js';
import { loadSample } from '../../src/samples/load.js';

const owner = ownerPool(); let manager;
const work = action => withSession(manager.token, action, { csrfToken: manager.csrfToken });
before(async () => {
  manager = await createAccount(owner, { permissions: ['samples.create', 'samples.manage', 'samples.read'] });
  Object.assign(manager, await signIn({ identifier: manager.username, password: manager.password }));
});
after(async () => { await closePool(); await owner.end(); });
const setDays = (account, fixture, days) => owner.query(`UPDATE sample_categories
  SET estimated_time_in_days=$3::double precision,revision=revision+1 WHERE organization_id=$1 AND id=$2`,
[account.organizationId, fixture.category.id, days]);
const storedDays = async (account, fixture) => (await owner.query(`SELECT estimated_time_in_days AS days
  FROM sample_categories WHERE organization_id=$1 AND id=$2`, [account.organizationId, fixture.category.id])).rows[0].days;

test('category storage and registration choices preserve fractional and finite boundary estimates', async () => {
  const fixture = await createLaboratoryFixture(owner, manager, { repeated: false });
  for (const days of [0.5, 1.5, 2.9, 0, Number.MIN_VALUE, Number.MAX_VALUE]) {
    await setDays(manager, fixture, days);
    assert.equal(await storedDays(manager, fixture), days);
    const options = await work(sampleRegistrationOptions);
    assert.equal(options.sampleCategories.find(category => category.id === fixture.category.id).estimatedTimeInDays, days);
    assert.equal(JSON.parse(JSON.stringify(options)).sampleCategories.find(category => category.id === fixture.category.id).estimatedTimeInDays, days);
  }
});

test('negative, null and nonfinite estimates fail without changing the saved category', async () => {
  const fixture = await createLaboratoryFixture(owner, manager, { repeated: false });
  await setDays(manager, fixture, 0.5);
  const before = (await owner.query('SELECT * FROM sample_categories WHERE organization_id=$1 AND id=$2', [manager.organizationId, fixture.category.id])).rows[0];
  for (const days of [-0.5, '-Infinity', 'Infinity', 'NaN', null]) {
    await assert.rejects(setDays(manager, fixture, days), error => error.code === (days === null ? '23502' : '23514'));
    assert.deepEqual((await owner.query('SELECT * FROM sample_categories WHERE organization_id=$1 AND id=$2', [manager.organizationId, fixture.category.id])).rows[0], before);
  }
});

test('fractional category fallback keeps source calendar truncation when changed sample lines are saved', async () => {
  for (const [days, expected] of [[0.5, '2024-02-28'], [1.5, '2024-02-29'], [2.9, '2024-03-01']]) {
    const fixture = await createLaboratoryFixture(owner, manager, { repeated: false });
    await setDays(manager, fixture, days);
    await owner.query('UPDATE decision_rules SET estimated_time_in_days=0,revision=revision+1 WHERE organization_id=$1 AND id=$2', [manager.organizationId, fixture.rule.id]);
    const created = await work((client, identity) => registerSample(client, identity, { ...fixture.registration,
      receivedAt: '2024-02-28T10:30:00.123456Z', dueAt: '2024-03-20T18:00:00.654321Z' }));
    const sample = await work((client, identity) => loadSample(client, identity, created.id));
    const products = [{ ...fixture.registration.products[0], id: sample.products[0].id,
      tests: [{ ...fixture.registration.products[0].tests[0], id: sample.products[0].tests[0].id }] }, structuredClone(fixture.registration.products[0])];
    await work((client, identity) => updateSample(client, identity, sample.id, { revision: sample.revision, products }));
    const saved = await work((client, identity) => loadSample(client, identity, sample.id));
    assert.equal(saved.dueAt.toISOString(), days < 1 ? sample.receivedAt.toISOString() : `${expected}T00:00:00.000Z`);
    assert.equal(saved.products[0].tests[0].id, sample.products[0].tests[0].id);
    const dates = (await owner.query('SELECT received_at::text AS received,due_at::text AS due FROM samples WHERE organization_id=$1 AND id=$2', [manager.organizationId, sample.id])).rows[0];
    assert.equal(dates.received, '2024-02-28 10:30:00.123456+00');
    if (days < 1) assert.equal(dates.due, dates.received);
  }
});

test('zero and finite estimates beyond the calendar range retain the exact saved due date or null', async () => {
  for (const days of [0, Number.MAX_VALUE]) for (const dueAt of [null, '2024-03-20T18:00:00.654321Z']) {
    const fixture = await createLaboratoryFixture(owner, manager, { repeated: false }); await setDays(manager, fixture, days);
    await owner.query('UPDATE decision_rules SET estimated_time_in_days=0,revision=revision+1 WHERE organization_id=$1 AND id=$2', [manager.organizationId, fixture.rule.id]);
    const created = await work((client, identity) => registerSample(client, identity, { ...fixture.registration, receivedAt: '2024-02-28T10:30:00.123456Z', dueAt }));
    const sample = await work((client, identity) => loadSample(client, identity, created.id));
    const exactDue = async () => (await owner.query('SELECT due_at::text AS due FROM samples WHERE organization_id=$1 AND id=$2', [manager.organizationId, sample.id])).rows[0].due;
    const before = await exactDue();
    const products = [{ ...fixture.registration.products[0], id: sample.products[0].id,
      tests: [{ ...fixture.registration.products[0].tests[0], id: sample.products[0].tests[0].id }] }, structuredClone(fixture.registration.products[0])];
    await work((client, identity) => updateSample(client, identity, sample.id, { revision: sample.revision, products }));
    assert.equal(await exactDue(), before);
  }
});

test('category choices remain tenant isolated and registrar permissions cannot edit estimates', async () => {
  const fixture = await createLaboratoryFixture(owner, manager, { repeated: false }); await setDays(manager, fixture, 0.5);
  const other = await createAccount(owner, { permissions: ['samples.create', 'samples.read'] });
  Object.assign(other, await signIn({ identifier: other.username, password: other.password }));
  const foreignFixture = await createLaboratoryFixture(owner, other, { repeated: false }); await setDays(other, foreignFixture, 1.5);
  const options = await work(sampleRegistrationOptions);
  assert(!options.sampleCategories.some(category => category.id === foreignFixture.category.id));
  assert.equal((await withSession(other.token, sampleRegistrationOptions)).sampleCategories.find(category => category.id === foreignFixture.category.id).estimatedTimeInDays, 1.5);
  assert.equal((await work((client, identity) => client.query('UPDATE sample_categories SET estimated_time_in_days=2.5,revision=revision+1 WHERE organization_id=$1 AND id=$2', [identity.organization_id, fixture.category.id]))).rowCount, 0);
  assert.equal(await storedDays(manager, fixture), 0.5);
});
