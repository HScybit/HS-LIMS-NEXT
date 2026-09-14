import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { ownerPool, createAccount } from '../helpers/database.js';
import { analyticalRecords } from '../helpers/templates.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool, database } from '../../src/db/pool.js';
import { createTemplate, copyDefinition, freezeTemplate } from '../../src/templates/authoring.js';
import { createCapture } from '../../src/templates/capture.js';
import { loadCapture } from '../../src/templates/loader.js';
import { setCaptureContext } from '../../src/templates/access.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });

test('batched capture guards reject mixed invalid rows atomically and retain exact default and append-only history', async () => {
  const user = await createAccount(owner, { permissions: ['templates.manage', 'datasheets.execute'] });
  const session = await signIn({ identifier: user.username, password: user.password });
  const work = (action, readOnly = false) => withSession(session.token, action, { csrfToken: session.csrfToken, readOnly });
  const template = await work(async (client, identity) => {
    const created = await createTemplate(client, identity, { name: 'Synthetic batched capture guards', kind: 'datasheet' });
    const records = analyticalRecords();
    for (const field of records.fields.filter((field) => field.widget === 'number_widget')) Object.assign(field, { defaultState: 'present', defaultNumber: '0' });
    await copyDefinition(database(client), records, identity.organization_id, created.versionId);
    await freezeTemplate(client, identity, created.versionId, 1);
    return { ...created, records };
  });
  const created = await work((client, identity) => createCapture(client, identity, template.versionId));
  const read = () => work((client, identity) => loadCapture(client, identity.organization_id, created.instanceId), true);
  const initial = await read();
  assert(initial.values.every((value) => value.state === 'present' && Number(value.numberValue) === 0));
  const repeated = initial.occurrences.find((row) => row.groupId === template.records.groups[0].id);
  const root = initial.occurrences.find((row) => !row.groupId);
  const [raw, calculated, rootRaw] = template.records.fields;
  const valid = { fieldId: raw.id, occurrenceId: repeated.id, origin: 'entered', number: '0' };
  const insert = (client, identity, revision, rows) => client.query(`INSERT INTO template_values
    (organization_id,instance_id,version_id,field_id,occurrence_id,revision,value_type,state,origin,number_value,saved_by)
    SELECT $1,$2,$3,input.field_id,input.occurrence_id,$4,'numeric','present',input.origin,input.number,$5
    FROM unnest($6::uuid[],$7::uuid[],$8::text[],$9::numeric[]) input(field_id,occurrence_id,origin,number)`,
  [identity.organization_id, created.instanceId, template.versionId, revision, identity.user_id,
    rows.map((row) => row.fieldId), rows.map((row) => row.occurrenceId), rows.map((row) => row.origin), rows.map((row) => row.number)]);
  async function newRevision(client) {
    await setCaptureContext(client, created.instanceId);
    return (await client.query('UPDATE template_instances SET revision=revision+1 WHERE organization_id=$1 AND id=$2 RETURNING revision',
      [user.organizationId, created.instanceId])).rows[0].revision;
  }
  for (const [invalid, message] of [
    [{ fieldId: rootRaw.id, occurrenceId: repeated.id, origin: 'entered', number: '0' }, 'Value field and repeat occurrence do not match'],
    [{ fieldId: calculated.id, occurrenceId: repeated.id, origin: 'entered', number: '0' }, 'Calculated fields cannot accept entered values'],
    [{ fieldId: rootRaw.id, occurrenceId: root.id, origin: 'calculated', number: '0' }, 'Calculated fields cannot accept entered values'],
    [{ fieldId: rootRaw.id, occurrenceId: root.id, origin: 'default', number: '1' }, 'Default history must match its frozen field and new occurrence'],
    [{ fieldId: rootRaw.id, occurrenceId: root.id, origin: 'default', number: '0' }, 'Default history must match its frozen field and new occurrence'],
  ]) {
    await assert.rejects(work(async (client, identity) => insert(client, identity, await newRevision(client), [valid, invalid])), { code: '23514', message });
    const current = await read(); assert.equal(current.revision, initial.revision); assert.deepEqual(current.values, initial.values);
  }
  await work(async (client, identity) => {
    const revision = await newRevision(client);
    await insert(client, identity, revision, []);
    await insert(client, identity, revision, [valid, { fieldId: rootRaw.id, occurrenceId: root.id, origin: 'entered', number: '1' }]);
  });
  const saved = await read(); assert.equal(saved.revision, initial.revision + 1);
  assert.equal(saved.values.find((value) => value.fieldId === rootRaw.id).numberValue, '1');
  assert.deepEqual((await work((client, identity) => loadCapture(client, identity.organization_id, created.instanceId, initial.revision), true)).values, initial.values);
  for (const sql of ['UPDATE template_values SET number_value=2', 'DELETE FROM template_values']) {
    await assert.rejects(work(async (client) => {
      await setCaptureContext(client, created.instanceId);
      await client.query(`${sql} WHERE organization_id=$1 AND instance_id=$2`, [user.organizationId, created.instanceId]);
    }), { code: '42501' });
    await assert.rejects(owner.query(`${sql} WHERE organization_id=$1 AND instance_id=$2`, [user.organizationId, created.instanceId]),
      { code: '55000', message: 'Saved values are append-only' });
  }
  assert.deepEqual((await read()).values, saved.values);
});
