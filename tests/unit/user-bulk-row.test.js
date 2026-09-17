import test from 'node:test';
import assert from 'node:assert/strict';
import { bindUserBulkHeaders, userBulkHeaders } from '../../src/users/bulk-input.js';
import { userBulkAliases, userBulkRowCommand } from '../../src/users/bulk-row.js';

const id = 'abcdef00-0000-4000-8000-000000000001';
const role = 'abcdef00-0000-4000-8000-000000000002';
const lab = 'abcdef00-0000-4000-8000-000000000003';
const columns = bindUserBulkHeaders(userBulkHeaders);
const row = () => ({ id, values: [' Name ', ' Person@Example.invalid ', '00123', ' Employee007 ', ' Analyst ', '', 'Role name', '', 'Lab name'] });
const credential = { state: 'valid', fingerprint: 'a'.repeat(64), passwordHash: 'Never copy this private hash' };
const prepare = input => userBulkRowCommand({ columns, row: row(), credential, id, requestId: id,
  resolve: async field => [field === 'defaultRoleId' ? role : lab], ...input });

test('User bulk builds the actual create-only native profile with explicit references and no credential fields', async () => {
  const calls = []; const source = row(); const before = structuredClone(source);
  const prepared = await prepare({ row: source, resolve: async (field, values) => { calls.push([field, values]); return [field === 'defaultRoleId' ? role : lab]; } });
  assert.deepEqual(source, before);
  assert.deepEqual(calls, [['defaultRoleId', ['Role name']], ['laboratoryId', ['Lab name']]]);
  assert.deepEqual(prepared.command, { id, username: 'Employee007', email: 'Person@Example.invalid', displayName: 'Name', requestId: id, revision: 0,
    phone: '00123', designation: 'Analyst', canManagePeople: false, businessUnitId: null, defaultRoleId: role, laboratoryId: lab });
  assert.equal(prepared.credentialFingerprint, credential.fingerprint);
  assert.equal(JSON.stringify(prepared).includes(credential.passwordHash), false);
  for (const field of ['password', 'passwordHash', 'customFields', 'customFieldTimeZone', 'roleIds', 'employeeCode']) assert.equal(Object.hasOwn(prepared.command, field), false);
});

test('missing optional User columns keep native defaults; numeric and boolean phone cells retain their source scalar text', async () => {
  const headers = ['name', 'email', 'username', 'role_name', 'password', 'lab_name'];
  const prepared = await prepare({ columns: bindUserBulkHeaders(headers), row: { values: ['Name', 'p@example.invalid', 'login', role, '', lab] } });
  assert.equal(prepared.command.canManagePeople, false); assert.equal(Object.hasOwn(prepared.command, 'phone'), false);
  for (const phone of [0, false]) { const source = row(); source.values[2] = phone; assert.equal((await prepare({ row: source })).command.phone, String(phone)); }
});

test('User bulk never infers a required Role or Lab and rejects invalid credentials, native identity fields and Excel errors', async () => {
  for (const state of ['missing', 'invalid', undefined]) {
    await assert.rejects(prepare({ credential: { state, fingerprint: 'a'.repeat(64) } }), { code: 'invalid_user_bulk_password' });
  }
  await assert.rejects(prepare({ credential: { state: 'valid', fingerprint: 'invalid' } }), { code: 'invalid_user_bulk_password' });
  for (const index of [6, 8]) { const source = row(); source.values[index] = ''; await assert.rejects(prepare({ row: source }), { code: 'invalid_user_bulk_row' }); }
  for (const [index, value] of [[0, ''], [1, 'invalid'], [3, ''], [2, 'x'.repeat(51)]]) {
    const source = row(); source.values[index] = value; await assert.rejects(prepare({ row: source }), { status: 400 });
  }
  for (const metadata of [{ columnNumber: 1, type: 'error', errorCode: '#VALUE!' }, { columnNumber: 1, type: 'formula', hasResult: false }]) {
    await assert.rejects(prepare({ row: { ...row(), cellMetadata: [metadata] } }), { code: 'invalid_user_bulk_row' });
  }
  await assert.rejects(prepare({ resolve: async () => [] }), { status: 400 });
});

test('bulk identity collisions include case variants and crossed username/email aliases while allowing one person to use their email as username', () => {
  const aliasColumns = bindUserBulkHeaders(['name', 'email', 'username', 'role_name', 'password', 'lab_name']);
  const source = [{ id: 'one', values: ['One', 'same@example.invalid', ' SAME@example.invalid '] },
    { id: 'two', values: ['Two', 'other@example.invalid', 'OTHER'] },
    { id: 'three', values: ['Three', 'same@EXAMPLE.invalid', 'other@example.invalid'] }];
  const onlyOne = userBulkAliases(source.slice(0, 1), aliasColumns); assert.equal(onlyOne.get('same@example.invalid').size, 1);
  const aliases = userBulkAliases(source, aliasColumns);
  assert.deepEqual([...aliases.get('same@example.invalid')], ['one', 'three']);
  assert.deepEqual([...aliases.get('other@example.invalid')], ['two', 'three']); assert.equal(aliases.get('other').size, 1);
  const invalid = userBulkAliases([{ id, values: ['Name', 'x'.repeat(321), ''] }], aliasColumns); assert.equal(invalid.size, 0);
});
