import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool, getPool } from '../../src/db/pool.js';
import { saveCustomField, loadCustomField, retireCustomField, listCustomFields, customFieldRoles } from '../../src/masters/custom-fields.js';

const owner = ownerPool(); let manager; let viewer; let colleague; let outsider; let noAccess;
const work = (callback, user = manager, readOnly = false) => withSession(user.token, callback, { csrfToken: user.csrfToken, readOnly });
const input = (changes = {}) => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, key: `field_${randomUUID().replaceAll('-', '')}`,
  label: 'Synthetic field', associatedWith: 'product', fieldType: 'select', ...changes });
const option = (key = 'A', label = 'First') => ({ id: randomUUID(), key, label });
async function rawField(client, identity, changes = {}) {
  const value = input(changes);
  await client.query(`INSERT INTO custom_field_definitions(organization_id,id,key,label,associated_with,option_count,edit_role_count,save_request_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [identity.organization_id, value.id, value.key, value.label, value.associatedWith,
    changes.optionCount ?? 0, changes.editRoleCount ?? 0, value.requestId]);
  return value;
}
before(async () => {
  manager = await createAccount(owner, { permissions: ['masters.manage'] });
  viewer = await createAccount(owner, { organizationId: manager.organizationId, permissions: ['masters.read'] });
  colleague = await createAccount(owner, { organizationId: manager.organizationId, permissions: ['masters.manage'] });
  noAccess = await createAccount(owner, { organizationId: manager.organizationId, permissions: [] });
  outsider = await createAccount(owner, { permissions: ['masters.manage', 'masters.read'] });
  for (const user of [manager, viewer, colleague, noAccess, outsider]) Object.assign(user, await signIn({ identifier: user.username, password: user.password }));
});
after(async () => { await closePool(); await owner.end(); });

test('report reissue editability preserves omitted updates, exact retries, hidden settings and immutable revisions', async () => {
  const absent = await work((client, identity) => saveCustomField(client, identity, input()));
  assert.equal(absent.editOnReissue, false);
  const command = input({ associatedWith: 'sample', editOnReissue: true });
  const first = await work((client, identity) => saveCustomField(client, identity, command));
  assert.equal(first.editOnReissue, true);
  const { editOnReissue: _editOnReissue, ...legacy } = command;
  assert.deepEqual(await work((client, identity) => saveCustomField(client, identity, legacy)), first);
  const update = { ...legacy, revision: 1, requestId: randomUUID(), associatedWith: 'product', label: 'Hidden setting retained' };
  const second = await work((client, identity) => saveCustomField(client, identity, update));
  assert.equal(second.editOnReissue, true); assert.equal(second.associatedWith, 'product');
  assert.deepEqual(await work((client, identity) => saveCustomField(client, identity, update)), second);
  await assert.rejects(work((client, identity) => saveCustomField(client, identity, { ...update, editOnReissue: false })), { code: 'save_request_reused' });
  const third = await work((client, identity) => saveCustomField(client, identity, { ...update, revision: 2, requestId: randomUUID(), editOnReissue: false }));
  assert.equal(third.editOnReissue, false);
  const fourth = await work((client, identity) => saveCustomField(client, identity, { ...command, revision: 3, requestId: randomUUID(), associatedWith: 'sample_product' }));
  assert.equal(fourth.editOnReissue, true);
  await assert.rejects(work(client => client.query(`UPDATE custom_field_definitions SET active=false,edit_on_reissue=false,revision=5,
    save_request_id=$3,updated_at=transaction_timestamp() WHERE organization_id=$1 AND id=$2`, [manager.organizationId, first.id, randomUUID()])), { code: '23514' });
  assert.deepEqual(await work((client, identity) => loadCustomField(client, identity, first.id)), fourth);
  await work((client, identity) => retireCustomField(client, identity, { id: first.id, revision: 4, requestId: randomUUID() }));
  for (const [revision, expected] of [[1, first], [2, second], [3, third], [4, fourth]]) {
    assert.deepEqual(await work((client, identity) => loadCustomField(client, identity, first.id, { atRevision: revision }), viewer, true), expected);
  }
  const retired = await work((client, identity) => loadCustomField(client, identity, first.id, { atRevision: 5 }), viewer, true);
  assert.equal(retired.editOnReissue, true); assert.equal(retired.active, false); assert.equal(retired.operation, 'retire');
  await assert.rejects(work((client, identity) => loadCustomField(client, identity, first.id, { atRevision: 1 }), outsider, true), { code: 'custom_field_not_found' });
  await assert.rejects(work((client, identity) => loadCustomField(client, identity, first.id, { atRevision: 1 }), noAccess, true), { code: 'forbidden' });
  await assert.rejects(work((client, identity) => saveCustomField(client, identity, input({ editOnReissue: true })), viewer), { code: 'forbidden' });
});

test('custom field revisions retain actual actors, zero/false settings and ordered option/role identities after edits', async () => {
  const options = [option('A', 'Upper'), option('a', 'Lower')];
  const command = input({ key: `MIXED_${randomUUID().replaceAll('-', '')}`, options, roleIdsCanEdit: [viewer.roleId, manager.roleId],
    associatedWithRoleId: viewer.roleId, allowsMultiple: true, displayOrder: 0, paddedNumber: 0, description: ' 0\n ', isRequired: false });
  const first = await work((client, identity) => saveCustomField(client, identity, command));
  assert.equal(first.key, command.key.toLowerCase()); assert.equal(first.description, '0'); assert.equal(first.displayOrder, 0);
  assert.equal(first.isRequired, false); assert.deepEqual(first.options, options); assert.deepEqual(first.roleIdsCanEdit, command.roleIdsCanEdit);
  assert.equal(first.savedBy, manager.userId); assert.equal(first.revision, 1); assert.equal(first.previousRevision, null);
  const saved = await work((client, identity) => saveCustomField(client, identity, { ...command, requestId: randomUUID(), revision: 1,
    label: 'Changed', fieldType: 'date_time', datetimeFormat: 'MMMM Do YYYY | hh:mm A', options: [...options].reverse(), roleIdsCanEdit: [], associatedWithRoleId: null }), colleague);
  assert.equal(saved.revision, 2); assert.equal(saved.savedBy, colleague.userId); assert.equal(saved.datetimeFormat, 'MMMM Do YYYY | hh:mm A');
  assert.deepEqual(saved.options, [...options].reverse()); assert.deepEqual(saved.roleIdsCanEdit, []);
  assert.deepEqual(await work((client, identity) => loadCustomField(client, identity, first.id, { atRevision: 1 }), viewer, true), first);
  assert.deepEqual(await work((client, identity) => saveCustomField(client, identity, command)), first);
});

test('exact concurrent retries produce one version and altered requests or stale edits cannot replace it', async () => {
  const command = input({ options: [option()] });
  const repeated = await Promise.all([0, 1].map(() => work((client, identity) => saveCustomField(client, identity, command))));
  assert.deepEqual(repeated[0], repeated[1]);
  for (const patch of [{ label: 'Changed' }, { options: [] }, { id: randomUUID() }]) await assert.rejects(work((client, identity) => saveCustomField(client, identity, { ...command, ...patch })), { code: 'save_request_reused' });
  await assert.rejects(work((client, identity) => saveCustomField(client, identity, command), colleague), { code: 'save_request_reused' });
  const edits = await Promise.allSettled(['First edit', 'Second edit'].map((label) => work((client, identity) => saveCustomField(client, identity,
    { ...command, revision: 1, requestId: randomUUID(), label }))));
  assert.equal(edits.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(edits.filter((result) => result.reason?.code === 'stale_custom_field').length, 1);
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM custom_field_versions WHERE organization_id=$1 AND field_id=$2', [manager.organizationId, command.id])).rows[0].count, 2);
});

test('active keys are unique across included entities while retirement preserves history and permits a new identity', async () => {
  const key = `unique_${randomUUID().replaceAll('-', '')}`;
  const collisions = await Promise.allSettled(['product', 'parameter'].map((associatedWith) => work((client, identity) => saveCustomField(client, identity,
    input({ key: associatedWith === 'product' ? key.toUpperCase() : key, associatedWith, options: [option()], roleIdsCanEdit: [manager.roleId] })))));
  assert.equal(collisions.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(collisions.filter((result) => result.reason?.code === 'duplicate_custom_field_key').length, 1);
  const first = collisions.find((result) => result.status === 'fulfilled').value;
  const command = { id: first.id, revision: 1, requestId: randomUUID() };
  const retired = await work((client, identity) => retireCustomField(client, identity, command));
  assert.deepEqual(await work((client, identity) => retireCustomField(client, identity, command)), retired);
  const historical = await work((client, identity) => loadCustomField(client, identity, first.id, { atRevision: 2 }), viewer, true);
  assert.equal(historical.active, false); assert.equal(historical.operation, 'retire'); assert.deepEqual(historical.options, first.options);
  assert.deepEqual(historical.roleIdsCanEdit, first.roleIdsCanEdit);
  await assert.rejects(work((client, identity) => loadCustomField(client, identity, first.id), viewer, true), { code: 'custom_field_not_found' });
  const next = await work((client, identity) => saveCustomField(client, identity, input({ key })));
  assert.notEqual(next.id, first.id);
  assert.deepEqual(await work((client, identity) => loadCustomField(client, identity, first.id, { atRevision: 1 }), viewer, true), first);
  await assert.rejects(work((client, identity) => saveCustomField(client, identity, input({ id: first.id, revision: 2, key }))), { code: 'custom_field_not_found' });
});

test('custom field reads, roles and writes enforce organization and permission boundaries', async () => {
  const field = await work((client, identity) => saveCustomField(client, identity, input()));
  for (const user of [noAccess, viewer]) await assert.rejects(work((client, identity) => saveCustomField(client, identity, input()), user), { code: 'forbidden' });
  await assert.rejects(work((client, identity) => loadCustomField(client, identity, field.id), noAccess, true), { code: 'forbidden' });
  for (const opts of [{}, { atRevision: 1 }]) await assert.rejects(work((client, identity) => loadCustomField(client, identity, field.id, opts), outsider, true), { code: 'custom_field_not_found' });
  for (const changes of [{ associatedWithRoleId: outsider.roleId }, { roleIdsCanEdit: [outsider.roleId] }, { roleIdsCanEdit: [randomUUID()] }]) {
    await assert.rejects(work((client, identity) => saveCustomField(client, identity, input(changes))), { code: 'invalid_custom_field_roles' });
  }
  const roles = await work((client, identity) => customFieldRoles(client, identity), viewer, true);
  assert.ok(roles.rows.some((role) => role.id === manager.roleId)); assert.ok(roles.rows.every((role) => role.id !== outsider.roleId));
  for (const table of ['custom_field_definitions', 'custom_field_versions', 'custom_field_version_options', 'custom_field_version_edit_roles']) {
    assert.equal((await work((client) => client.query(`SELECT 1 FROM ${table}`), noAccess, true)).rowCount, 0);
    assert.equal((await getPool().query(`SELECT 1 FROM ${table}`)).rowCount, 0);
    assert.equal((await owner.query('SELECT has_table_privilege($1,$2,$3) AS allowed', ['sampleify_report_worker', table, 'SELECT'])).rows[0].allowed, false);
  }
});

test('SQL rejects incomplete or late option/role history, forged writes and changes to immutable revisions', async () => {
  for (const changes of [{ optionCount: 1 }, { editRoleCount: 1 }]) await assert.rejects(work((client, identity) => rawField(client, identity, changes)), { code: '23514' });
  const field = await work((client, identity) => saveCustomField(client, identity, input({ options: [option()], roleIdsCanEdit: [manager.roleId] })));
  await assert.rejects(work((client) => client.query(`INSERT INTO custom_field_version_options(organization_id,field_id,revision,id,key,label,position)
    VALUES($1,$2,1,$3,'late','Late',0)`, [manager.organizationId, field.id, randomUUID()])), { code: '23514' });
  await assert.rejects(work((client) => client.query(`INSERT INTO custom_field_version_edit_roles(organization_id,field_id,revision,role_id,position)
    VALUES($1,$2,1,$3,0)`, [manager.organizationId, field.id, viewer.roleId])), { code: '23514' });
  for (const table of ['custom_field_versions', 'custom_field_version_options', 'custom_field_version_edit_roles']) {
    await assert.rejects(owner.query(`UPDATE ${table} SET revision=revision WHERE organization_id=$1 AND field_id=$2`, [manager.organizationId, field.id]), { code: '55000' });
    await assert.rejects(work((client) => client.query(`DELETE FROM ${table} WHERE organization_id=$1 AND field_id=$2`, [manager.organizationId, field.id])), { code: '42501' });
  }
  await assert.rejects(work((client) => client.query('DELETE FROM custom_field_definitions WHERE organization_id=$1 AND id=$2', [manager.organizationId, field.id])), { code: '42501' });
  await assert.rejects(work((client) => client.query(`UPDATE custom_field_definitions SET label='Unsaved',updated_at=transaction_timestamp()
    WHERE organization_id=$1 AND id=$2`, [manager.organizationId, field.id])), { code: '23514' });
  await assert.rejects(work((client, identity) => rawField(client, identity), viewer), { code: '42501' });
  await assert.rejects(work((client) => client.query('INSERT INTO custom_field_versions SELECT * FROM custom_field_versions WHERE organization_id=$1 AND field_id=$2', [manager.organizationId, field.id])), { code: '42501' });
  assert.equal((await work((client, identity) => loadCustomField(client, identity, field.id))).revision, 1);
});

test('SQL rejects sparse option positions, tenant role references and oversized whitespace without partial versions', async () => {
  await assert.rejects(work(async (client, identity) => {
    const value = await rawField(client, identity, { optionCount: 2 });
    await client.query(`INSERT INTO custom_field_version_options(organization_id,field_id,revision,id,key,label,position)
      VALUES($1,$2,1,$3,'only','Only',1)`, [identity.organization_id, value.id, randomUUID()]);
  }), { code: '23514' });
  await assert.rejects(work(async (client, identity) => {
    const value = await rawField(client, identity);
    await client.query(`UPDATE custom_field_definitions SET associated_with_role_id=$3,revision=2,save_request_id=$4,updated_at=transaction_timestamp()
      WHERE organization_id=$1 AND id=$2`, [identity.organization_id, value.id, outsider.roleId, randomUUID()]);
  }), { code: '23503' });
  await assert.rejects(work((client, identity) => rawField(client, identity, { label: `${' '.repeat(201)}x` })), { code: '23514' });
  await assert.rejects(work(async (client, identity) => {
    const value = await rawField(client, identity, { optionCount: 1 });
    await client.query(`INSERT INTO custom_field_version_options(organization_id,field_id,revision,id,key,label,position)
      VALUES($1,$2,1,$3,'valid',$4,0)`, [identity.organization_id, value.id, randomUUID(), `${' '.repeat(201)}x`]);
  }), { code: '23514' });
});

test('retirement SQL must preserve both scalar settings and every ordered option and role', async () => {
  const field = await work((client, identity) => saveCustomField(client, identity, input({ options: [option()], roleIdsCanEdit: [manager.roleId] })));
  await assert.rejects(work((client) => client.query(`UPDATE custom_field_definitions SET active=false,label='Changed',revision=2,
    save_request_id=$3,updated_at=transaction_timestamp() WHERE organization_id=$1 AND id=$2`, [manager.organizationId, field.id, randomUUID()])), { code: '23514' });
  await assert.rejects(work(async (client) => {
    await client.query(`UPDATE custom_field_definitions SET active=false,revision=2,save_request_id=$3,updated_at=transaction_timestamp()
      WHERE organization_id=$1 AND id=$2`, [manager.organizationId, field.id, randomUUID()]);
    await client.query(`INSERT INTO custom_field_version_options(organization_id,field_id,revision,id,key,label,position)
      SELECT organization_id,field_id,2,id,key,'Changed during retirement',position FROM custom_field_version_options
      WHERE organization_id=$1 AND field_id=$2 AND revision=1`, [manager.organizationId, field.id]);
    await client.query(`INSERT INTO custom_field_version_edit_roles(organization_id,field_id,revision,role_id,position)
      SELECT organization_id,field_id,2,role_id,position FROM custom_field_version_edit_roles
      WHERE organization_id=$1 AND field_id=$2 AND revision=1`, [manager.organizationId, field.id]);
  }), { code: '23514' });
  assert.deepEqual(await work((client, identity) => loadCustomField(client, identity, field.id)), field);
});

test('large option/role sets keep definition loading at three SQL statements and role lookups bounded', async () => {
  const roleIds = Array.from({ length: 500 }, () => randomUUID());
  await owner.query(`INSERT INTO roles(organization_id,id,name) SELECT $1,id,'Batch role '||position
    FROM unnest($2::uuid[]) WITH ORDINALITY AS roles(id,position)`, [manager.organizationId, roleIds]);
  const options = Array.from({ length: 500 }, (_, index) => option(`v${index}`, `Option ${index}`));
  const field = await work((client, identity) => saveCustomField(client, identity, input({ options, roleIdsCanEdit: roleIds })));
  const statements = [];
  const loaded = await work((client, identity) => loadCustomField({ query: (...args) => { statements.push(args[0]); return client.query(...args); } }, identity, field.id), viewer, true);
  assert.equal(statements.length, 3); assert.deepEqual(loaded.options, options); assert.deepEqual(loaded.roleIdsCanEdit, roleIds);
  assert.ok(Buffer.byteLength(JSON.stringify(loaded)) < 160_000);
  const roles = await work((client, identity) => customFieldRoles(client, identity, { search: 'Batch role' }), viewer, true);
  assert.equal(roles.rows.length, 100); assert.equal(roles.hasMore, true);
  const exact = await work((client, identity) => customFieldRoles(client, identity, { search: 'Batch role 499' }), viewer, true);
  assert.equal(exact.rows.length, 1); assert.equal(exact.hasMore, false);
});

test('custom field listing supports literal search, source columns, type filters, dates and stable pages', async () => {
  const marker = `Listing ${randomUUID()}`;
  const first = await work((client, identity) => saveCustomField(client, identity, input({ label: `${marker} alpha`, description: '10%_literal', fieldType: 'checkbox' })));
  await work((client, identity) => saveCustomField(client, identity, input({ label: `${marker} beta`, fieldType: 'date' })));
  const statements = [];
  const result = await work((client, identity) => listCustomFields({ query: (...args) => { statements.push(args[0]); return client.query(...args); } }, identity,
    { search: marker, page: 1, pageSize: 1, sort: { key: 'label', dir: 'asc' } }), viewer, true);
  assert.equal(statements.length, 2); assert.equal(result.totalCount, 2); assert.equal(result.rows[0]._id, first.id);
  const filtered = await work((client, identity) => listCustomFields(client, identity, { search: marker, filters: { data_type: { type: 'select', value: 'checkbox' } } }), viewer, true);
  assert.equal(filtered.totalCount, 1);
  assert.equal((await work((client, identity) => listCustomFields(client, identity, { search: '10%_literal' }), viewer, true)).rows[0]._id, first.id);
  const empty = await work((client, identity) => listCustomFields(client, identity, { search: marker, page: 100 }), viewer, true);
  assert.equal(empty.totalCount, 2); assert.deepEqual(empty.rows, []);
  assert.equal((await work((client, identity) => listCustomFields(client, identity, { filters: { created_at: { type: 'date', from: '2099-01-01' } } }), viewer, true)).totalCount, 0);
  for (const query of [{ pageSize: 101 }, { sort: { key: 'bad', dir: 'asc' } }, { sort: { key: 'label', dir: 'asc; SELECT 1' } },
    { filters: { data_type: { type: 'select', value: 'bad' } } }, { filters: { created_at: { type: 'date', from: '2026-02-30' } } },
    { filters: { created_at: { type: 'date', from: '2026-02-02', to: '2026-02-01' } } }, { search: 'a\0b' }]) {
    await assert.rejects(work((client, identity) => listCustomFields(client, identity, query), viewer, true), { status: 400 });
  }
});

test('a role removed after validation fails cleanly and rolls back the complete save', async () => {
  for (const association of ['associatedWithRoleId', 'roleIdsCanEdit']) {
    const roleId = randomUUID();
    await owner.query('INSERT INTO roles(organization_id,id,name) VALUES($1,$2,$3)', [manager.organizationId, roleId, 'Concurrent role']);
    const command = input({ [association]: association === 'roleIdsCanEdit' ? [roleId] : roleId });
    await assert.rejects(work((client, identity) => saveCustomField({ query: async (...args) => {
      const result = await client.query(...args);
      if (args[0].startsWith('SELECT id FROM roles')) await owner.query('DELETE FROM roles WHERE organization_id=$1 AND id=$2', [manager.organizationId, roleId]);
      return result;
    } }, identity, command)), { code: 'invalid_custom_field_roles' });
    assert.equal((await owner.query('SELECT 1 FROM custom_field_definitions WHERE organization_id=$1 AND id=$2', [manager.organizationId, command.id])).rowCount, 0);
    assert.equal((await owner.query('SELECT 1 FROM custom_field_versions WHERE organization_id=$1 AND field_id=$2', [manager.organizationId, command.id])).rowCount, 0);
  }
});
