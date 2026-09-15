import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { registerSample } from '../../src/samples/register.js';

const owner = ownerPool(); let registrar; let fixture;
before(async () => {
  registrar = await createAccount(owner, { permissions: ['samples.create'] });
  Object.assign(registrar, await signIn({ identifier: registrar.username, password: registrar.password }));
  fixture = await createLaboratoryFixture(owner, registrar, { repeated: false });
});
after(async () => { await closePool(); await owner.end(); });
const register = headers => withSession(registrar.token, (client, identity) => registerSample(client, identity, { ...fixture.registration, ...headers }), { csrfToken: registrar.csrfToken });
const stored = async sample => (await owner.query('SELECT sample_number,received_at::text AS received,due_at::text AS due,retention_due_on::text AS retention FROM samples WHERE organization_id=$1 AND id=$2', [registrar.organizationId, sample.id])).rows[0];
async function snapshot() {
  const result = {};
  for (const table of ['samples', 'sample_products', 'sample_tests', 'sample_events', 'number_sequences', 'workflow_runs', 'workflow_run_history', 'template_instances']) {
    result[table] = (await owner.query(`SELECT * FROM ${table} WHERE organization_id=$1`, [registrar.organizationId])).rows.map(row => JSON.stringify(row)).sort();
  }
  return result;
}

test('registration preserves the supplied receiving and due microseconds', async () => {
  const sample = await register({ receivedAt: '2026-09-12T10:30:00.123456+05:30', dueAt: '2026-09-14T00:00:00.654321Z' });
  const saved = await stored(sample);
  assert.equal(saved.received, '2026-09-12 05:00:00.123456+00');
  assert.equal(saved.due, '2026-09-14 00:00:00.654321+00');
  assert.equal(saved.retention, '2026-10-12');
});

test('a due instant one microsecond before receipt is rejected', async () => {
  const before = await snapshot();
  await assert.rejects(register({ receivedAt: '2026-09-12T05:00:00.123456Z', dueAt: '2026-09-12T05:00:00.123455Z' }), { code: 'invalid_sample' });
  assert.deepEqual(await snapshot(), before);
});

test('equivalent offsets, null due dates and PostgreSQL precision rounding retain their actual instants', async () => {
  const equal = await register({ receivedAt: '2026-09-12T10:30:00.123456+05:30', dueAt: '2026-09-12T05:00:00.123456Z' });
  assert.equal((await stored(equal)).received, (await stored(equal)).due);
  const rounded = await register({ receivedAt: '2026-09-12T05:00:00.1234567Z', dueAt: null });
  assert.equal((await stored(rounded)).received, '2026-09-12 05:00:00.123457+00'); assert.equal((await stored(rounded)).due, null);
  const preciseOrder = await register({ receivedAt: '2026-09-12T05:00:00.12345649Z', dueAt: '2026-09-12T05:00:00.1234564Z' });
  assert.equal((await stored(preciseOrder)).received, (await stored(preciseOrder)).due);
});

test('sample-number year, receiving date and retention agree across rounded and offset year boundaries', async () => {
  const nextYear = await register({ receivedAt: '2026-12-31T23:59:59.9999999Z', dueAt: null });
  const next = await stored(nextYear);
  assert.match(next.sample_number, /^SMP-2027-\d{6}$/); assert.equal(next.received, '2027-01-01 00:00:00+00'); assert.equal(next.retention, '2027-01-31');
  const previousYear = await register({ receivedAt: '2026-01-01T00:00:00.000001+05:30', dueAt: null });
  const previous = await stored(previousYear);
  assert.match(previous.sample_number, /^SMP-2025-\d{6}$/); assert.equal(previous.received, '2025-12-31 18:30:00.000001+00'); assert.equal(previous.retention, '2026-01-30');
});

test('invalid offsets and canonical year overflow or underflow leave no numbers, captures, workflow or sample records', async () => {
  const before = await snapshot();
  for (const dates of [
    { receivedAt: '2026-09-12T05:00:00+23:00', dueAt: null },
    { receivedAt: '9999-12-31T23:59:59.9999999Z', dueAt: null },
    { receivedAt: '0001-01-01T00:00:00+00:01', dueAt: null },
    { dueAt: '9999-12-31T23:59:59.9999999Z' },
  ]) {
    await assert.rejects(register(dates), { code: 'invalid_sample' }); assert.deepEqual(await snapshot(), before);
  }
});

test('concurrent registrations allocate unique numbers in the normalized receiving year', async () => {
  const created = await Promise.all(Array.from({ length: 6 }, () => register({ receivedAt: '2031-12-31T23:59:59.9999999Z', dueAt: null })));
  assert.deepEqual(created.map(sample => sample.sampleNumber).sort(), Array.from({ length: 6 }, (_, i) => `SMP-2032-${String(i + 1).padStart(6, '0')}`));
  for (const sample of created) assert.equal((await stored(sample)).received, '2032-01-01 00:00:00+00');
  const sequence = await owner.query("SELECT next_value FROM number_sequences WHERE organization_id=$1 AND sequence_key='sample' AND period_key='2032'", [registrar.organizationId]);
  assert.equal(sequence.rows[0].next_value, '7');
});
