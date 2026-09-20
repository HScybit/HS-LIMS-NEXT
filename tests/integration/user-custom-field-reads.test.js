import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool, getPool } from '../../src/db/pool.js';
import { userCustomFields, productCustomFields, saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const views = ['user_custom_field_definitions', 'user_custom_field_versions', 'user_custom_field_version_options'];
const command = (changes = {}) => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, key: `user_field_${randomUUID().replaceAll('-', '')}`,
  label: 'Synthetic user field', associatedWith: 'users', ...changes });
const option = (key, label = key) => ({ id: randomUUID(), key, label });
async function account(options) {
  const actor = await createAccount(owner, options);
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
async function fixture() {
  const author = await account({ permissions: ['masters.manage'] });
  const reader = await account({ organizationId: author.organizationId, permissions: ['users.read'] });
  const manager = await account({ organizationId: author.organizationId, permissions: ['users.manage'] });
  return { author, reader, manager };
}
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
const save = (actor, value) => work(actor, (client, identity) => saveCustomField(client, identity, value));
async function measured(actor, input) {
  let queries = 0;
  const fields = await work(actor, (client, identity) => userCustomFields({ query(...args) { queries++; return client.query(...args); } }, identity, input), true);
  return { fields, queries };
}

test('user field reads preserve exact ordering, options, zero/false and listing flags under user authority only', async () => {
  const f = await fixture(); assert.deepEqual(await measured(f.reader), { fields: [], queries: 1 });
  const inputs = ['\ue000', '😀', 'a', 'A'].map(label => command({ label, displayOrder: 0, paddedNumber: 0,
    isRequired: false, editOnReissue: label === 'A', roleIdsCanEdit: [f.author.roleId], showInList: label === 'a', showInFilter: label === 'A' }));
  inputs.push(command({ label: 'Choices', displayOrder: 0.25, fieldType: 'select', options: [option('Z', 'Last first'), option('a', 'Second')], allowsMultiple: true }));
  for (const input of inputs) await save(f.author, input);
  await save(f.author, command({ associatedWith: 'product', label: 'Other association' }));
  const { fields, queries } = await measured(f.reader); assert.equal(queries, 2);
  assert.deepEqual(fields.map(field => field.label), ['A', 'a', '😀', '\ue000', 'Choices']);
  assert(fields.every(field => field.associatedWith === 'users' && field.isRequired === false && field.paddedNumber === 0));
  assert(fields.every(field => field.editOnReissue === (field.label === 'A')));
  assert.deepEqual(fields.at(-1).options, inputs.at(-1).options); assert.equal(fields.at(-1).allowsMultiple, true);
  assert.deepEqual(await measured(f.manager), { fields, queries });
  const listing = await measured(f.reader, { forListing: true }); assert.equal(listing.queries, 1); assert.deepEqual(listing.fields.map(field => field.label), ['A', 'a']);
  await assert.rejects(measured(f.author), { code: 'forbidden' });
  await assert.rejects(work(f.manager, (client, identity) => productCustomFields(client, identity), true), { code: 'forbidden' });
  await assert.rejects(save(f.manager, command()), { code: 'forbidden' });
});

test('user options stay pinned when a definition changes association between the two statements', async () => {
  const f = await fixture(); const input = command({ fieldType: 'select', options: [option('A', 'Original choice')] }); await save(f.author, input);
  let queries = 0;
  const fields = await work(f.reader, async (client, identity) => {
    assert.equal((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation, 'read committed');
    return userCustomFields({ async query(...args) {
      const result = await client.query(...args); queries++;
      if (queries === 1) await save(f.author, { ...input, revision: 1, requestId: randomUUID(), associatedWith: 'product', label: 'New product field', options: [option('B')] });
      return result;
    } }, identity);
  });
  assert.equal(queries, 2); assert.equal(fields[0].revision, 1); assert.equal(fields[0].label, input.label); assert.deepEqual(fields[0].options, input.options);
  assert.deepEqual((await measured(f.reader)).fields, []);
  const retired = command({ fieldType: 'select', options: [option('R')] }); await save(f.author, retired);
  await work(f.author, (client, identity) => retireCustomField(client, identity, { id: retired.id, revision: 1, requestId: randomUUID() }));
  assert.deepEqual((await measured(f.reader)).fields, []);
});

test('actual sessions and tenant permissions scope every user field view despite forged service identity or settings', async () => {
  const f = await fixture(); const foreign = await fixture(); const input = command(); await save(f.author, input); await save(foreign.author, command());
  assert.equal((await measured(foreign.reader)).fields.length, 1);
  await work(f.reader, async (client, identity) => {
    assert.deepEqual(await userCustomFields(client, { ...identity, organization_id: foreign.author.organizationId }), []);
    await client.query("SELECT set_config('app.organization_id',$1,true)", [foreign.author.organizationId]);
    for (const view of views) assert.equal((await client.query(`SELECT 1 FROM ${view}`)).rowCount, 0);
  }, true);
  await work(f.author, async (client, identity) => {
    assert.deepEqual(await userCustomFields(client, { ...identity, permission_codes: ['users.manage'] }), []);
    for (const view of views) assert.equal((await client.query(`SELECT 1 FROM ${view}`)).rowCount, 0);
  }, true);
  for (const view of views) assert.equal((await getPool().query(`SELECT 1 FROM ${view}`)).rowCount, 0);
  await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [f.reader.userId]);
  await assert.rejects(measured(f.reader), { status: 401 });
  await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2', [f.manager.organizationId, f.manager.roleId]);
  await assert.rejects(measured(f.manager), { code: 'forbidden' });
});

test('user field views grant no writes or worker access and do not expose private definition-command metadata', async () => {
  const f = await fixture(); const input = command({ fieldType: 'select', options: [option('A')] }); await save(f.author, input);
  for (const view of views) {
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) assert.equal((await owner.query('SELECT has_table_privilege($1,$2,$3) AS allowed', ['sampleify_app', view, privilege])).rows[0].allowed, false);
    assert.equal((await owner.query('SELECT has_table_privilege($1,$2,$3) AS allowed', ['sampleify_report_worker', view, 'SELECT'])).rows[0].allowed, false);
    // A joined view may reject rewriting before PostgreSQL reaches the separately checked privilege denial.
    await assert.rejects(work(f.manager, client => client.query(`DELETE FROM ${view}`)), error => ['42501', '55000'].includes(error.code));
    const columns = (await owner.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1", [view])).rows.map(row => row.column_name);
    for (const privateColumn of ['request_id', 'save_request_id', 'created_transaction_id', 'saved_by']) assert.equal(columns.includes(privateColumn), false);
  }
  await work(f.reader, async client => {
    for (const relation of ['custom_field_definitions', 'custom_field_versions', 'custom_field_version_options']) assert.equal((await client.query(`SELECT 1 FROM ${relation}`)).rowCount, 0);
  }, true);
});

test('500 user definitions and their options remain batched and a 501st definition rejects the complete form', async () => {
  const f = await fixture(); const ids = Array.from({ length: 500 }, () => randomUUID());
  await work(f.author, async (client, identity) => {
    await client.query(`INSERT INTO custom_field_definitions(organization_id,id,key,label,associated_with,field_type,option_count,save_request_id,display_order)
      SELECT $1,id,'field_'||replace(id::text,'-',''),'Field '||position,'users','select',2,gen_random_uuid(),500-position
      FROM unnest($2::uuid[]) WITH ORDINALITY AS fixture(id,position)`, [identity.organization_id, ids]);
    await client.query(`INSERT INTO custom_field_version_options(organization_id,field_id,revision,id,key,label,position)
      SELECT $1,id,1,gen_random_uuid(),'v'||position,'Choice '||position,position FROM unnest($2::uuid[]) AS fixture(id) CROSS JOIN generate_series(0,1) AS position`, [identity.organization_id, ids]);
  });
  const result = await measured(f.reader); assert.equal(result.queries, 2); assert.equal(result.fields.length, 500);
  assert.deepEqual(result.fields.map(field => field.id), [...ids].reverse()); assert(result.fields.every(field => field.options.length === 2));
  await save(f.author, command()); await assert.rejects(measured(f.reader), { code: 'custom_field_limit' });
});
