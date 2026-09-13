import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { productCustomFields, saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';

const owner = ownerPool(); let manager; let viewer; let outsider; let noAccess;
const work = (callback, user = manager, readOnly = false) => withSession(user.token, callback, { csrfToken: user.csrfToken, readOnly });
const input = (changes = {}) => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, key: `field_${randomUUID().replaceAll('-', '')}`,
  label: 'Synthetic Product field', associatedWith: 'product', ...changes });
const option = (key, label = key) => ({ id: randomUUID(), key, label });
async function measured(user = manager) {
  let statements = 0;
  const fields = await work((client, identity) => productCustomFields({ query: (...args) => { statements++; return client.query(...args); } }, identity), user, true);
  return { fields, statements };
}
before(async () => {
  manager = await createAccount(owner, { permissions: ['masters.manage'] });
  viewer = await createAccount(owner, { organizationId: manager.organizationId, permissions: ['masters.read'] });
  noAccess = await createAccount(owner, { organizationId: manager.organizationId, permissions: [] });
  outsider = await createAccount(owner, { permissions: ['masters.manage'] });
  for (const user of [manager, viewer, outsider, noAccess]) Object.assign(user, await signIn({ identifier: user.username, password: user.password }));
});
after(async () => { await closePool(); await owner.end(); });

test('Product fields preserve source order, zero/false settings and tenant permissions without applying definition role gates', async () => {
  assert.deepEqual(await measured(), { fields: [], statements: 1 });
  const labels = ['\ue000', '😀', 'a', 'A', 'Z'];
  const commands = labels.map((label) => input({ label, displayOrder: 0, isRequired: false, showInList: false,
    roleIdsCanEdit: [manager.roleId], associateRoleSpecificUsers: true, associatedWithRoleId: manager.roleId }));
  commands.push(input({ label: 'Fractional order', displayOrder: 0.25, fieldType: 'text', options: [option('hidden')] }));
  for (const command of commands) await work((client, identity) => saveCustomField(client, identity, command));
  await work((client, identity) => saveCustomField(client, identity, input({ label: 'Other association', associatedWith: 'parameter' })));
  const { fields, statements } = await measured(viewer);
  assert.equal(statements, 1); assert.deepEqual(fields.map((field) => field.label), ['A', 'Z', 'a', '😀', '\ue000', 'Fractional order']);
  assert.ok(fields.every((field) => field.options.length === 0 && field.isRequired === false && field.showInList === false));
  assert.equal(fields[0].displayOrder, 0); assert.equal(fields[5].displayOrder, 0.25);
  assert.deepEqual(fields.map((field) => field.id).sort(), commands.map((command) => command.id).sort());
  assert.deepEqual(await measured(outsider), { fields: [], statements: 1 });
  await assert.rejects(measured(noAccess), { code: 'forbidden' });
});

test('batched Product options remain bound to the selected revision when a definition changes between reads', async () => {
  const firstOptions = [option('Z', 'Old last'), option('A', 'Old first')];
  const command = input({ label: 'Changing choices', fieldType: 'select', options: firstOptions });
  await work((client, identity) => saveCustomField(client, identity, command));
  let statements = 0;
  const fields = await work((client, identity) => productCustomFields({ query: async (...args) => {
    const result = await client.query(...args); statements++;
    if (statements === 1) await work((other, actor) => saveCustomField(other, actor, { ...command, requestId: randomUUID(), revision: 1,
      label: 'New choices', options: [option('N', 'Replacement')] }));
    return result;
  } }, identity), viewer, true);
  const previous = fields.find((field) => field.id === command.id);
  assert.equal(statements, 2); assert.equal(previous.revision, 1); assert.equal(previous.label, 'Changing choices'); assert.deepEqual(previous.options, firstOptions);
  const current = (await measured()).fields.find((field) => field.id === command.id);
  assert.equal(current.revision, 2); assert.equal(current.label, 'New choices'); assert.equal(current.options[0].key, 'N');
  await work((client, identity) => saveCustomField(client, identity, { ...command, revision: 2, requestId: randomUUID(), associatedWith: 'customer' }));
  assert.ok((await measured()).fields.every((field) => field.id !== command.id));
  const retired = input({ fieldType: 'select', options: [option('R')] });
  await work((client, identity) => saveCustomField(client, identity, retired));
  await work((client, identity) => retireCustomField(client, identity, { id: retired.id, revision: 1, requestId: randomUUID() }));
  assert.ok((await measured()).fields.every((field) => field.id !== retired.id));
});

test('Product field loading rejects incomplete option children inside an unfinished transaction', async () => {
  for (const positions of [[], [0], [1]]) {
    await assert.rejects(work(async (client, identity) => {
      const field = input();
      await client.query(`INSERT INTO custom_field_definitions(organization_id,id,key,label,associated_with,field_type,option_count,save_request_id)
        VALUES($1,$2,$3,$4,'product','select',2,$5)`, [identity.organization_id, field.id, field.key, field.label, field.requestId]);
      for (const position of positions) await client.query(`INSERT INTO custom_field_version_options(organization_id,field_id,revision,id,key,label,position)
        VALUES($1,$2,1,$3,$4,$4,$5)`, [identity.organization_id, field.id, randomUUID(), `v${position}`, position]);
      await productCustomFields(client, identity);
    }), { code: 'incomplete_custom_field' });
  }
});

test('500 Product fields with ordered options use two statements and a 501st field fails without a partial form', async () => {
  const user = await createAccount(owner, { permissions: ['masters.manage'] });
  Object.assign(user, await signIn({ identifier: user.username, password: user.password }));
  const ids = Array.from({ length: 500 }, () => randomUUID());
  await work(async (client, identity) => {
    await client.query(`INSERT INTO custom_field_definitions(organization_id,id,key,label,associated_with,field_type,option_count,save_request_id,display_order)
      SELECT $1,id,'field_'||replace(id::text,'-',''),'Field '||position,'product','select',2,gen_random_uuid(),500-position
      FROM unnest($2::uuid[]) WITH ORDINALITY AS fixture(id,position)`, [identity.organization_id, ids]);
    await client.query(`INSERT INTO custom_field_version_options(organization_id,field_id,revision,id,key,label,position)
      SELECT $1,id,1,gen_random_uuid(),'v'||position,'Choice '||position,position
      FROM unnest($2::uuid[]) AS fixture(id) CROSS JOIN generate_series(0,1) AS position`, [identity.organization_id, ids]);
  }, user);
  const loaded = await measured(user);
  assert.equal(loaded.statements, 2); assert.equal(loaded.fields.length, 500);
  assert.deepEqual(loaded.fields.map((field) => field.id), [...ids].reverse());
  assert.ok(loaded.fields.every((field) => field.revision === 1 && field.options.length === 2 && field.options[0].key === 'v0' && field.options[1].key === 'v1'));
  await work((client, identity) => saveCustomField(client, identity, input()), user);
  await assert.rejects(measured(user), { code: 'custom_field_limit' });
});
