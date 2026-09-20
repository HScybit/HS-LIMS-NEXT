import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';
import { saveUserCustomFields } from '../../src/users/custom-fields.js';

let owner; test.beforeAll(() => { owner = ownerPool(); }); test.afterAll(async () => { await closePool(); await owner.end(); });
async function fixture() {
  const author = await createAccount(owner, { permissions: ['masters.manage'] }); const manager = await createAccount(owner, { organizationId: author.organizationId, permissions: ['users.manage'] });
  const person = await createAccount(owner, { organizationId: author.organizationId, permissions: ['users.read'] });
  const authorSession = await signIn({ identifier: author.username, password: author.password }); const managerSession = await signIn({ identifier: manager.username, password: manager.password });
  const lab = randomUUID(); await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'HTTP field consistency')", [author.organizationId, lab]);
  const definition = { id: randomUUID(), requestId: randomUUID(), revision: 0, key: 'original_key', label: 'Original field', associatedWith: 'users', fieldType: 'text', validateUniqueness: true };
  const define = input => withSession(authorSession.token, (client, identity) => saveCustomField(client, identity, input)); const field = await define(definition);
  return { author, manager, person, authorSession, managerSession, lab, definition, field, define,
    input(customFields) { const id = randomUUID(); return { id, requestId: randomUUID(), revision: 0, username: `field-consistency-${id}`, email: `${id}@example.invalid`, displayName: 'HTTP consistency user',
      password: 'Synthetic HTTP consistency password', defaultRoleId: person.roleId, laboratoryId: lab, customFields }; } };
}
const entry = (field, value) => ({ fieldId: field.id, fieldRevision: field.revision, value });
async function login(page, actor) {
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(actor.username); await page.getByLabel('Password', { exact: true }).fill(actor.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
const create = (page, input) => page.evaluate(async input => {
  const csrf = document.cookie.split('; ').find(cookie => cookie.startsWith('sampleify_csrf='))?.split('=')[1] ?? '';
  const response = await fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(input) });
  return { status: response.status, body: await response.json() };
}, input);

test('creation HTTP applies source saved-key uniqueness across field renames and replacement definitions', async ({ page }) => {
  const f = await fixture(); await withSession(f.managerSession.token, (client, identity) => saveUserCustomFields(client, identity, f.person.userId,
    { requestId: randomUUID(), revision: 0, customFields: [entry(f.field, 'SAME')] }));
  const renamed = await f.define({ ...f.definition, requestId: randomUUID(), revision: 1, key: 'renamed_key' });
  await login(page, f.manager); const allowed = f.input([entry(renamed, 'SAME')]); expect((await create(page, allowed)).status).toBe(201);
  const replacement = await f.define({ ...f.definition, id: randomUUID(), requestId: randomUUID() });
  const blocked = f.input([entry(renamed, 'NEW'), entry(replacement, 'SAME')]); const duplicate = await create(page, blocked);
  expect(duplicate.status).toBe(409); expect(duplicate.body.error.code).toBe('duplicate_user_custom_field');
  expect((await owner.query('SELECT 1 FROM users WHERE id=$1', [blocked.id])).rowCount).toBe(0);
  const original = await (await page.request.get(`/api/users/${f.person.userId}/custom-fields`)).json();
  expect(original.customFields[0].key).toBe('original_key'); expect(original.customFields[0].fieldId).toBe(f.field.id);
  expect((await create(page, allowed)).status).toBe(201);
});

test('creation HTTP waits for a real definition writer and returns a reload conflict without a deadlock or partial account', async ({ page }) => {
  const f = await fixture(); await login(page, f.manager); const input = f.input([entry(f.field, 'value')]);
  let ready, release; const started = new Promise(resolve => { ready = resolve; }); const mayInsert = new Promise(resolve => { release = resolve; });
  let writer, pending, written, response;
  try {
    writer = withSession(f.authorSession.token, async (client, identity) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('custom-field-definitions:'||$1::text,0))", [identity.organization_id]);
      ready((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid); await mayInsert;
      return saveCustomField(client, identity, { ...f.definition, id: randomUUID(), requestId: randomUUID(), key: 'added_key' });
    }).then(value => ({ value }), error => ({ error }));
    const pid = await Promise.race([started, writer.then(result => { throw result.error ?? new Error('Writer ended before holding its advisory lock.'); })]);
    pending = create(page, input).then(value => ({ value }), error => ({ error })); let blocked = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      blocked = (await owner.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND wait_event='advisory' AND $1=ANY(pg_blocking_pids(pid)) AND query ILIKE '%users_create_account%'", [pid])).rowCount > 0;
      if (blocked) break; await delay(10);
    }
    expect(blocked).toBe(true); release();
  } finally { release(); if (writer) written = await writer; if (pending) response = await pending; }
  expect(written.error).toBeUndefined(); expect(response.error).toBeUndefined(); expect(response.value.status).toBe(409);
  expect(response.value.body.error.code).toBe('user_custom_fields_changed');
  for (const [table, column] of [['users', 'id'], ['credentials', 'user_id'], ['user_creation_commands', 'user_id'], ['user_field_value_versions', 'subject_user_id']]) {
    expect((await owner.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`, [input.id])).rowCount).toBe(0);
  }
});
