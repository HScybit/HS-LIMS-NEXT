import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { loadMethod, retireMethod } from '../../src/masters/methods.js';
import { loadTestParameter, saveTestParameter, retireTestParameter } from '../../src/masters/test-parameters.js';
import { emptyUncertaintyGrid } from '../../src/masters/parameter-grid.js';

const owner = ownerPool(); let account;
const work = (callback) => withSession(account.token, callback, { csrfToken: account.csrfToken });
before(async () => {
  account = await createAccount(owner, { permissions: ['masters.manage'] });
  Object.assign(account, await signIn({ identifier: account.username, password: account.password }));
});
after(async () => { await closePool(); await owner.end(); });

test('retirement retains existing longer master text and links without creating an invented earlier revision', async () => {
  const fixture = await createLaboratoryFixture(owner, account, { repeated: false });
  const name = 'L'.repeat(250); const description = 'd'.repeat(16001);
  for (const [table, id, retire, load] of [
    ['methods_of_analysis', fixture.method.id, retireMethod, loadMethod],
    ['test_parameters', fixture.parameter.id, retireTestParameter, loadTestParameter],
  ]) {
    await owner.query(`UPDATE ${table} SET name=$3,description=$4,revision=revision+1 WHERE organization_id=$1 AND id=$2`, [account.organizationId, id, name, description]);
    const old = await work((client, identity) => load(client, identity, id));
    const removal = { id, revision: old.revision, requestId: randomUUID() };
    const result = await work((client, identity) => retire(client, identity, removal));
    assert.equal(result.revision, old.revision + 1);
    const history = await work((client, identity) => load(client, identity, id, { atRevision: result.revision }));
    assert.equal(history.name, name); assert.equal(history.description, description); assert.equal(history.savedBy, account.userId);
    assert.deepEqual(await work((client, identity) => retire(client, identity, removal)), result);
    await assert.rejects(work((client, identity) => load(client, identity, id, { atRevision: old.revision })), (error) => error.status === 404);
  }
  assert.equal((await owner.query('SELECT 1 FROM parameter_methods WHERE organization_id=$1 AND test_parameter_id=$2 AND method_id=$3',
    [account.organizationId, fixture.parameter.id, fixture.method.id])).rowCount, 1);
});

test('parameter retirement rejects changed settings and a replacement grid even within a valid version transaction', async () => {
  const key = randomUUID(); const grid = emptyUncertaintyGrid(); grid.rows[0].values[0] = 'Authored uncertainty';
  const command = { id: randomUUID(), revision: 0, requestId: randomUUID(), name: 'Retirement guard parameter', description: '',
    key, schemeAbbreviation: key, order: 0, laboratoryId: null, measurementUncertainty: grid };
  await work((client, identity) => saveTestParameter(client, identity, command));
  await assert.rejects(work((client) => client.query(`UPDATE test_parameters SET active=false,name='Forged retirement',revision=revision+1,save_request_id=$3
    WHERE organization_id=$1 AND id=$2`, [account.organizationId, command.id, randomUUID()])), { code: '23514', message: 'Parameter retirement preserves its last settings' });
  await assert.rejects(work(async (client) => {
    await client.query('UPDATE test_parameters SET active=false,revision=revision+1,save_request_id=$3 WHERE organization_id=$1 AND id=$2', [account.organizationId, command.id, randomUUID()]);
    await client.query(`INSERT INTO parameter_uncertainty_columns(organization_id,parameter_id,revision,id,position,title)
      SELECT organization_id,parameter_id,2,id,position,title FROM parameter_uncertainty_columns WHERE organization_id=$1 AND parameter_id=$2 AND revision=1`, [account.organizationId, command.id]);
    await client.query(`INSERT INTO parameter_uncertainty_rows(organization_id,parameter_id,revision,id,position)
      SELECT organization_id,parameter_id,2,id,position FROM parameter_uncertainty_rows WHERE organization_id=$1 AND parameter_id=$2 AND revision=1`, [account.organizationId, command.id]);
    await client.query(`INSERT INTO parameter_uncertainty_cells(organization_id,parameter_id,revision,row_id,column_id,text_value)
      SELECT organization_id,parameter_id,2,row_id,column_id,'Forged grid' FROM parameter_uncertainty_cells WHERE organization_id=$1 AND parameter_id=$2 AND revision=1`, [account.organizationId, command.id]);
  }), { code: '23514', message: 'Parameter retirement preserves its last uncertainty grid' });
  assert.equal((await work((client, identity) => loadTestParameter(client, identity, command.id))).revision, 1);
  assert.equal((await work((client, identity) => retireTestParameter(client, identity, { id: command.id, revision: 1, requestId: randomUUID() }))).revision, 2);
});

test('new master identities cannot be inserted as retired without an actual prior active revision', async () => {
  await assert.rejects(work((client) => client.query(`INSERT INTO methods_of_analysis(organization_id,id,code,name,method_uuid,active,save_request_id)
    VALUES($1,$2,$3,'Inactive new method',$3,false,$4)`, [account.organizationId, randomUUID(), randomUUID(), randomUUID()])), { code: '23514', message: 'New methods start active at revision one' });
  await assert.rejects(work((client) => client.query(`INSERT INTO test_parameters(organization_id,id,code,name,master_key,scheme_abbreviation,active,save_request_id)
    VALUES($1,$2,$3,'Inactive new parameter',$3,$3,false,$4)`, [account.organizationId, randomUUID(), randomUUID(), randomUUID()])), { code: '23514', message: 'New parameters start active at revision one' });
});
