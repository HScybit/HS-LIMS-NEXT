import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { emptyUncertaintyGrid, updateUncertaintyGrid } from '../../src/masters/parameter-grid.js';
import { listTestParameters, parameterLaboratories, loadTestParameter, saveTestParameter, retireTestParameter } from '../../src/masters/test-parameters.js';

const owner = ownerPool(); let account; let outsider; let viewer;
const work = (callback, user = account, readOnly = false) => withSession(user.token, callback, { csrfToken: user.csrfToken, readOnly });
const input = () => {
  const key = `PARA_${randomUUID().slice(0, 8)}`;
  return { id: randomUUID(), revision: 0, requestId: randomUUID(), name: 'Synthetic uncertainty parameter', description: 'Synthetic authored notes',
    key, schemeAbbreviation: key, order: 0, laboratoryId: null, measurementUncertainty: null };
};
before(async () => {
  account = await createAccount(owner, { permissions: ['masters.read', 'masters.manage'] });
  outsider = await createAccount(owner, { permissions: ['masters.read', 'masters.manage'] });
  viewer = await createAccount(owner, { organizationId: account.organizationId, permissions: ['masters.read'] });
  for (const user of [account, outsider, viewer]) Object.assign(user, await signIn({ identifier: user.username, password: user.password }));
});
after(async () => { await closePool(); await owner.end(); });

test('master edits keep hidden scientific links and immutable grid history without inventing the earlier master version', async () => {
  const fixture = await createLaboratoryFixture(owner, account, { repeated: false });
  const original = await work((client, identity) => loadTestParameter(client, identity, fixture.parameter.id), account, true);
  assert.equal(original.measurementUncertainty, null);
  const grid = updateUncertaintyGrid(emptyUncertaintyGrid(), { headers: ['Sr. no.', 'Text', 'Notes'], data: [['1', '000.00', '=SUM(A1:A5)'], ['2', '  exact text  ', '']] });
  const command = { ...input(), id: original.id, revision: original.revision, key: original.key, schemeAbbreviation: original.schemeAbbreviation,
    laboratoryId: original.laboratoryId, measurementUncertainty: grid };
  const saved = await work((client, identity) => saveTestParameter(client, identity, command));
  assert.equal(saved.revision, original.revision + 1); assert.deepEqual(saved.measurementUncertainty, grid);
  assert.equal(saved.measurementUnitId, original.measurementUnitId); assert.equal(saved.defaultScale, original.defaultScale);
  assert.deepEqual(saved.methods, original.methods); assert.equal(saved.code, original.code);
  await assert.rejects(work((client, identity) => loadTestParameter(client, identity, original.id, { atRevision: original.revision })), { code: 'parameter_not_found' });
  const historical = await work((client, identity) => loadTestParameter(client, identity, original.id, { atRevision: saved.revision }), account, true);
  assert.equal(historical.savedBy, account.userId); assert.equal(historical.previousRevision, original.revision);
  await work((client, identity) => saveTestParameter(client, identity, { ...command, requestId: randomUUID(), revision: saved.revision, name: 'Later synthetic parameter', measurementUncertainty: null }));
  const unchanged = await work((client, identity) => loadTestParameter(client, identity, original.id, { atRevision: saved.revision }), account, true);
  assert.deepEqual(unchanged, historical);
});

test('concurrent retries create once, stale edits retain history and a reused request cannot substitute other values', async () => {
  const command = { ...input(), measurementUncertainty: emptyUncertaintyGrid() };
  const saved = await Promise.all([0, 1].map(() => work((client, identity) => saveTestParameter(client, identity, command))));
  assert.deepEqual(saved.map((row) => [row.id, row.revision]), [[command.id, 1], [command.id, 1]]);
  const count = await owner.query('SELECT count(*)::integer AS count FROM test_parameter_versions WHERE organization_id=$1 AND parameter_id=$2', [account.organizationId, command.id]);
  assert.equal(count.rows[0].count, 1);
  await assert.rejects(work((client, identity) => saveTestParameter(client, identity, { ...command, name: 'Different retry' })), { code: 'save_request_reused' });
  const changed = await work((client, identity) => saveTestParameter(client, identity, { ...command, requestId: randomUUID(), revision: 1, order: 2 }));
  await assert.rejects(work((client, identity) => saveTestParameter(client, identity, { ...command, requestId: randomUUID(), revision: 1 })), { code: 'stale_parameter' });
  assert.equal(changed.revision, 2);
  const retire = { id: command.id, revision: 2, requestId: randomUUID() };
  assert.deepEqual(await work((client, identity) => retireTestParameter(client, identity, retire)), { id: command.id, revision: 3 });
  assert.deepEqual(await work((client, identity) => retireTestParameter(client, identity, retire)), { id: command.id, revision: 3 });
  await assert.rejects(work((client, identity) => loadTestParameter(client, identity, command.id)), { code: 'parameter_not_found' });
  const retired = await work((client, identity) => loadTestParameter(client, identity, command.id, { atRevision: 3 }), account, true);
  assert.equal(retired.operation, 'retire'); assert.equal(retired.active, false); assert.deepEqual(retired.measurementUncertainty, command.measurementUncertainty);
});

test('master and history permissions reject cross-tenant IDs, readonly writes and foreign labs', async () => {
  const command = input(); const saved = await work((client, identity) => saveTestParameter(client, identity, command));
  await assert.rejects(work((client, identity) => loadTestParameter(client, identity, saved.id), outsider, true), { code: 'parameter_not_found' });
  await assert.rejects(work((client, identity) => loadTestParameter(client, identity, saved.id, { atRevision: 1 }), outsider, true), { code: 'parameter_not_found' });
  await assert.rejects(work((client, identity) => saveTestParameter(client, identity, input()), viewer), { code: 'forbidden' });
  const foreign = await createLaboratoryFixture(owner, outsider, { repeated: false });
  await assert.rejects(work((client, identity) => saveTestParameter(client, identity, { ...input(), laboratoryId: foreign.laboratory.id })), { code: 'invalid_laboratory' });
  await assert.rejects(work((client) => client.query('DELETE FROM test_parameters WHERE organization_id=$1 AND id=$2', [account.organizationId, saved.id])), { code: '42501' });
});

test('direct master edits cannot forge earlier grid data or commit an incomplete configured grid', async () => {
  const command = { ...input(), measurementUncertainty: emptyUncertaintyGrid() };
  await work((client, identity) => saveTestParameter(client, identity, command));
  await assert.rejects(work((client) => client.query(`INSERT INTO parameter_uncertainty_rows(organization_id,parameter_id,revision,id,position) VALUES($1,$2,1,$3,1)`,
    [account.organizationId, command.id, randomUUID()])), { code: '23514', message: 'Parameter child history requires its new version transaction' });
  await assert.rejects(work((client) => client.query('UPDATE test_parameter_versions SET name=$3 WHERE organization_id=$1 AND parameter_id=$2',
    [account.organizationId, command.id, 'Forged history'])), { code: '42501' });
  await assert.rejects(work((client) => client.query(`UPDATE test_parameters SET revision=revision+1,updated_at=transaction_timestamp(),save_request_id=$3
    WHERE organization_id=$1 AND id=$2`, [account.organizationId, command.id, randomUUID()])), { code: '23514', message: 'Uncertainty columns require a complete ordered header' });
  assert.equal((await work((client, identity) => loadTestParameter(client, identity, command.id), account, true)).revision, 1);
});

test('parameter listing joins only its tenant labs and supports literal search, combined filters, numeric sort and empty pages', async () => {
  const fixture = await createLaboratoryFixture(owner, account, { repeated: false });
  const prefix = `List-${randomUUID().slice(0, 8)}`;
  const first = { ...input(), name: `${prefix} 100%_\\ exact`, order: 12, laboratoryId: fixture.laboratory.id };
  const second = { ...input(), name: `${prefix} second`, order: 2 };
  await work((client, identity) => saveTestParameter(client, identity, first));
  await work((client, identity) => saveTestParameter(client, identity, second));
  await work((client, identity) => saveTestParameter(client, identity, { ...input(), name: prefix }), outsider);
  const list = await work((client, identity) => listTestParameters(client, identity, { search: prefix, sort: { key: 'order', dir: 'asc' }, pageSize: 1 }), account, true);
  assert.equal(list.totalCount, 2); assert.deepEqual(list.rows.map((row) => row._id), [second.id]);
  const filtered = await work((client, identity) => listTestParameters(client, identity, { search: prefix,
    filters: { lab_id: { type: 'text', value: fixture.laboratory.name }, name: { type: 'text', value: '100%_\\' } } }), viewer, true);
  assert.equal(filtered.totalCount, 1); assert.equal(filtered.rows[0]._id, first.id); assert.equal(filtered.rows[0].lab_id, fixture.laboratory.name);
  assert.equal((await work((client, identity) => listTestParameters(client, identity, { search: prefix, page: 100 }), account, true)).rows.length, 0);
  for (const query of [{ pageSize: 101 }, { search: '\0' }, { sort: { key: 'name; DELETE', dir: 'asc' } }, { filters: { name: { type: 'relation', value: [] } } }, { filters: { hidden: { type: 'text', value: 'x' } } }]) {
    await assert.rejects(work((client, identity) => listTestParameters(client, identity, query), account, true), (error) => error.status === 400);
  }
  await work((client, identity) => retireTestParameter(client, identity, { id: first.id, revision: 1, requestId: randomUUID() }));
  assert.equal((await work((client, identity) => listTestParameters(client, identity, { search: prefix }), account, true)).totalCount, 1);
});

test('lab lookup reports saturation and can find matching records beyond the first page without foreign or retired options', async () => {
  const prefix = `Lookup-${randomUUID().slice(0, 8)}`;
  await owner.query(`INSERT INTO laboratories(organization_id,code,name) SELECT $1,$2||number,$2||lpad(number::text,3,'0') FROM generate_series(1,103) number`, [account.organizationId, prefix]);
  await owner.query('UPDATE laboratories SET active=false,revision=revision+1,updated_at=transaction_timestamp() WHERE organization_id=$1 AND name=$2', [account.organizationId, `${prefix}102`]);
  await owner.query('INSERT INTO laboratories(organization_id,code,name) VALUES($1,$2,$2)', [outsider.organizationId, `${prefix}foreign`]);
  const matches = await work((client, identity) => parameterLaboratories(client, identity, { search: prefix }), viewer, true);
  assert.equal(matches.rows.length, 100); assert.equal(matches.hasMore, true);
  const last = await work((client, identity) => parameterLaboratories(client, identity, { search: `${prefix}103` }), viewer, true);
  assert.equal(last.rows.length, 1); assert.equal(last.hasMore, false); assert.equal(last.rows[0].name, `${prefix}103`);
  for (const suffix of ['102', 'foreign', 'missing']) assert.deepEqual(await work((client, identity) => parameterLaboratories(client, identity, { search: `${prefix}${suffix}` }), viewer, true), { rows: [], hasMore: false });
});

test('competing case-insensitive keys and concurrent edits commit once and preserve the winning version', async () => {
  const first = input(); const second = { ...input(), key: first.key.toLowerCase() };
  const creates = await Promise.allSettled([first, second].map((command) => work((client, identity) => saveTestParameter(client, identity, command))));
  assert.equal(creates.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(creates.find((result) => result.status === 'rejected').reason.code, 'duplicate_parameter');
  const command = creates[0].status === 'fulfilled' ? first : second;
  const edits = await Promise.allSettled(['First edit', 'Second edit'].map((name) => work((client, identity) => saveTestParameter(client, identity,
    { ...command, revision: 1, requestId: randomUUID(), name }))));
  assert.equal(edits.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(edits.find((result) => result.status === 'rejected').reason.code, 'stale_parameter');
  const current = await work((client, identity) => loadTestParameter(client, identity, command.id), account, true);
  assert.equal(current.name, edits.find((result) => result.status === 'fulfilled').value.name); assert.equal(current.revision, 2);
});
