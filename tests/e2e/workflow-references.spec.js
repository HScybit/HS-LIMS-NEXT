import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { createTemplate } from '../../src/templates/authoring.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function login(page, account) {
  await page.context().clearCookies(); await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(account.username); await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
async function headers(page) {
  return { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': (await page.context().cookies()).find((cookie) => cookie.name === 'sampleify_csrf').value };
}
async function fixture() {
  const manager = await createAccount(owner, { permissions: ['workflows.manage'] });
  const author = await createAccount(owner, { organizationId: manager.organizationId, permissions: ['templates.manage'] });
  const session = await signIn({ identifier: author.username, password: author.password });
  const template = await withSession(session.token, (client, identity) => createTemplate(client, identity,
    { name: 'Browser workflow template 0 %_', kind: 'datasheet' }), { csrfToken: session.csrfToken });
  return { manager, template };
}

test('workflow reference HTTP lookups support 500 selected IDs with bounded POST bodies and enforce CSRF', async ({ page }) => {
  const { manager, template } = await fixture();
  // Synthetic label-only roles; they grant no authority to any account.
  const roles = (await owner.query(`INSERT INTO roles(organization_id,id,name)
    SELECT $1,gen_random_uuid(),'Browser reference '||lpad(n::text,4,'0') FROM generate_series(1,500) n RETURNING id`, [manager.organizationId])).rows;
  await login(page, manager); const requestHeaders = await headers(page);
  const result = await page.request.get(`/api/workflows/lookups/templates?query=${encodeURIComponent(JSON.stringify({ search: '0 %_', selectedIds: [template.templateId] }))}`);
  expect(result.status()).toBe(200);
  const templateLabels = await result.json();
  expect(templateLabels.rows).toEqual([{ id: template.templateId, name: 'Browser workflow template 0 %_', active: true }]);
  expect(templateLabels.selected).toEqual(templateLabels.rows);
  const command = { search: 'Browser reference', selectedIds: roles.map((role) => role.id) };
  expect(Buffer.byteLength(JSON.stringify(command))).toBeGreaterThan(16_000);
  const choices = await page.request.post('/api/workflows/lookups/roles', { headers: requestHeaders, data: command });
  expect(choices.status()).toBe(200); const body = await choices.json();
  expect(body.rows).toHaveLength(100); expect(body.hasMore).toBe(true); expect(body.selected).toHaveLength(500);
  expect(body.selected.every((row) => Object.keys(row).sort().join(',') === 'active,id,name')).toBe(true);
  expect((await page.request.post('/api/workflows/lookups/roles', { headers: { Origin: requestHeaders.Origin }, data: command })).status()).toBe(403);
  expect((await page.request.post('/api/workflows/lookups/roles', { headers: { ...requestHeaders, Origin: 'https://example.invalid' }, data: command })).status()).toBe(403);
  for (const data of [{ selectedIds: [...command.selectedIds, randomUUID()] }, { selectedIds: [roles[0].id, roles[0].id.toUpperCase()] },
    { organizationId: manager.organizationId }, { search: '\0' }, { search: '\uD800' }]) {
    expect((await page.request.post('/api/workflows/lookups/roles', { headers: requestHeaders, data })).status()).toBe(400);
  }
  expect((await page.request.post('/api/workflows/lookups/roles', { headers: requestHeaders, data: { search: 'x'.repeat(66_000) } })).status()).toBe(413);
  expect((await page.request.get('/api/workflows/lookups/users')).status()).toBe(400);
  expect((await page.request.get('/api/workflows/lookups/roles?query=%7B')).status()).toBe(400);
  expect((await owner.query('SELECT revision FROM template_versions WHERE organization_id=$1 AND id=$2', [manager.organizationId, template.versionId])).rows[0].revision).toBe(1);
});

test('workflow reference readers, foreign users and revoked sessions retain their own boundaries', async ({ page, browser }) => {
  const { manager, template } = await fixture();
  const reader = await createAccount(owner, { organizationId: manager.organizationId, permissions: ['workflows.read'] });
  const query = encodeURIComponent(JSON.stringify({ selectedIds: [template.templateId] }));
  await login(page, reader);
  const visible = await page.request.get(`/api/workflows/lookups/templates?query=${query}`);
  expect(visible.status()).toBe(200); expect((await visible.json()).selected[0].id).toBe(template.templateId);
  const foreign = await createAccount(owner, { permissions: ['workflows.manage'] }); await login(page, foreign);
  const hidden = await page.request.get(`/api/workflows/lookups/templates?query=${query}`);
  expect(hidden.status()).toBe(200); expect(await hidden.json()).toEqual({ rows: [], hasMore: false, selected: [] });
  const unrelated = await createAccount(owner, { organizationId: manager.organizationId, permissions: ['samples.read'] }); await login(page, unrelated);
  expect((await page.request.get('/api/workflows/lookups/roles')).status()).toBe(403);
  await login(page, manager); await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [manager.userId]);
  expect((await page.request.get('/api/workflows/lookups/templates')).status()).toBe(401);
  const anonymous = await browser.newContext();
  try { expect((await anonymous.request.get('http://127.0.0.1:3100/api/workflows/lookups/templates')).status()).toBe(401); }
  finally { await anonymous.close(); }
});
