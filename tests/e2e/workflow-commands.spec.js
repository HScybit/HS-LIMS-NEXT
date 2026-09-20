import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { createWorkflowMaster } from '../../src/workflows/metadata.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function fixture() {
  const manager = await createAccount(owner, { permissions: ['workflows.manage'] });
  const session = await signIn({ identifier: manager.username, password: manager.password });
  const workflow = await withSession(session.token, (client, identity) => createWorkflowMaster(client, identity,
    { id: randomUUID(), requestId: randomUUID(), metadataRevision: 0, name: `Browser workflow commands ${randomUUID()}` }), { csrfToken: session.csrfToken });
  return { manager, workflow };
}
async function login(page, account) {
  await page.context().clearCookies(); await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(account.username); await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
  return { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': (await page.context().cookies()).find((cookie) => cookie.name === 'sampleify_csrf').value };
}
const createCommand = (workflow) => ({ requestId: randomUUID(), versionId: workflow.versionId, revision: workflow.revision,
  operation: 'create_state', input: { code: 'initial', name: 'Browser Initial', stateType: 'initial', inputCount: 0 } });

test('a lost HTTP response can be retried without creating another state or receipt', async ({ page }) => {
  const { manager, workflow } = await fixture(); const headers = await login(page, manager);
  const path = `/api/workflows/${workflow.workflowId}/commands`; const command = createCommand(workflow); let lost = false;
  await page.route(`**${path}`, async (route) => {
    if (!lost) { lost = true; await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  const request = () => page.evaluate(async ({ path, headers, command }) => {
    try { const response = await fetch(path, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
      return { status: response.status, body: await response.json() }; }
    catch { return { networkFailure: true }; }
  }, { path, headers, command });
  expect(await request()).toEqual({ networkFailure: true }); expect(lost).toBe(true);
  const retry = await request(); expect(retry.status).toBe(200); expect(retry.body.revision).toBe(2);
  expect(await request()).toEqual(retry);
  expect((await owner.query('SELECT count(*)::integer count FROM workflow_states WHERE organization_id=$1 AND workflow_version_id=$2', [manager.organizationId, workflow.versionId])).rows[0].count).toBe(1);
  expect((await owner.query('SELECT count(*)::integer count FROM workflow_editor_commands WHERE organization_id=$1 AND workflow_id=$2', [manager.organizationId, workflow.workflowId])).rows[0].count).toBe(1);
  await page.goto(`/workflow_management/${workflow.workflowId}`); await expect(page.locator('.workflow-node')).toHaveCount(1);
  await expect(page.locator('.workflow-node')).toContainText('Browser Initial');
});

test('command HTTP creates and publishes a graph, then clones the first later edit and reloads it', async ({ page }) => {
  const { manager, workflow } = await fixture(); const headers = await login(page, manager); const path = `/api/workflows/${workflow.workflowId}/commands`;
  let current = { ...workflow };
  const send = async (operation, input, elementId) => {
    const response = await page.request.post(path, { headers, data: { requestId: randomUUID(), versionId: current.versionId, revision: current.revision,
      operation, ...(input === undefined ? {} : { input }), ...(elementId ? { elementId } : {}) } });
    expect(response.status()).toBe(200); const value = await response.json(); current = value; return value;
  };
  const initial = await send('create_state', { code: 'initial', name: 'Initial', stateType: 'initial', inputCount: 0 });
  const final = await send('create_state', { code: 'final', name: 'Final', stateType: 'final', outputCount: 0 });
  await send('create_transition', { code: 'finish', name: 'Finish', sourceStateId: initial.id, targetStateId: final.id });
  const published = await send('publish', { changeSummary: 'Browser command publication' }); expect(published.status).toBe('published');
  await page.goto(`/workflow_management/${workflow.workflowId}`); await expect(page.locator('.workflow-node')).toHaveCount(2);
  await expect(page.locator('.workflow-line')).toHaveCount(1); await expect(page.locator('.workflow-pill').filter({ hasText: /^Published$/ })).toBeVisible();
  const edited = await send('patch_state', { name: 'Changed draft final' }, final.id);
  expect(edited.versionId).not.toBe(published.versionId); expect(edited.id).not.toBe(final.id); expect(edited.revision).toBe(2);
  await page.reload(); await expect(page.locator('.workflow-node')).toContainText(['Initial', 'Changed draft final']);
  expect((await owner.query('SELECT name FROM workflow_states WHERE organization_id=$1 AND id=$2', [manager.organizationId, final.id])).rows[0].name).toBe('Final');
  const conflicting = await page.request.post(path, { headers, data: { requestId: randomUUID(), versionId: published.versionId, revision: published.revision,
    operation: 'patch_state', elementId: final.id, input: { name: 'Must not replace the pending draft' } } });
  expect(conflicting.status()).toBe(409); expect((await conflicting.json()).error.code).toBe('workflow_draft_exists');
});

test('command HTTP enforces tenant, role, session, Origin and CSRF boundaries', async ({ page, browser }) => {
  const { manager, workflow } = await fixture(); const headers = await login(page, manager);
  const path = `/api/workflows/${workflow.workflowId}/commands`; const command = createCommand(workflow);
  expect((await page.request.post(path, { headers: { Origin: headers.Origin }, data: command })).status()).toBe(403);
  expect((await page.request.post(path, { headers: { ...headers, Origin: 'https://example.invalid' }, data: command })).status()).toBe(403);
  const reader = await createAccount(owner, { organizationId: manager.organizationId, permissions: ['workflows.read'] });
  expect((await page.request.post(path, { headers: await login(page, reader), data: command })).status()).toBe(403);
  const foreign = await createAccount(owner, { permissions: ['workflows.manage'] });
  expect((await page.request.post(path, { headers: await login(page, foreign), data: command })).status()).toBe(404);
  const currentHeaders = await login(page, manager); await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [manager.userId]);
  expect((await page.request.post(path, { headers: currentHeaders, data: command })).status()).toBe(401);
  const anonymous = await browser.newContext();
  try { expect((await anonymous.request.post(`http://127.0.0.1:3100${path}`, { headers, data: command })).status()).toBe(401); }
  finally { await anonymous.close(); }
  expect((await owner.query('SELECT revision FROM workflow_versions WHERE organization_id=$1 AND id=$2', [manager.organizationId, workflow.versionId])).rows[0].revision).toBe(1);
  expect((await owner.query('SELECT count(*)::integer count FROM workflow_editor_commands WHERE organization_id=$1 AND workflow_id=$2', [manager.organizationId, workflow.workflowId])).rows[0].count).toBe(0);
});

test('command HTTP accepts bounded large role selections and rejects malformed or oversized inputs', async ({ page }) => {
  const { manager, workflow } = await fixture(); const headers = await login(page, manager); const path = `/api/workflows/${workflow.workflowId}/commands`;
  // Synthetic labels only; these rows grant no account permissions.
  const roles = (await owner.query(`INSERT INTO roles(organization_id,id,name) SELECT $1,gen_random_uuid(),'Browser command role '||n
    FROM generate_series(1,500) n RETURNING id`, [manager.organizationId])).rows.map((row) => row.id);
  const command = createCommand(workflow); command.input.accessRoleIds = roles;
  expect(Buffer.byteLength(JSON.stringify(command))).toBeGreaterThan(16_000);
  const response = await page.request.post(path, { headers, data: command }); expect(response.status()).toBe(200);
  const created = await response.json();
  expect((await owner.query('SELECT count(*)::integer count FROM workflow_state_capability_roles WHERE organization_id=$1 AND workflow_state_id=$2', [manager.organizationId, created.id])).rows[0].count).toBe(500);
  for (const data of [{ ...command, organizationId: manager.organizationId }, { ...command, requestId: randomUUID(), operation: 'replace_graph' },
    { ...command, requestId: randomUUID(), revision: 2, input: { ...command.input, name: '\uD800' } },
    { ...command, requestId: randomUUID(), revision: 2, input: null }]) expect((await page.request.post(path, { headers, data })).status()).toBe(400);
  expect((await page.request.post(path, { headers, data: { ...command, requestId: randomUUID(), input: { name: 'x'.repeat(4 * 1024 * 1024) } } })).status()).toBe(413);
  expect((await page.request.post(path, { headers: { ...headers, 'Content-Type': 'application/json' }, data: '{' })).status()).toBe(400);
  const changed = await page.request.post(path, { headers, data: { ...command, input: { ...command.input, name: 'Reused request' } } });
  expect(changed.status()).toBe(409); expect((await changed.json()).error.code).toBe('save_request_reused');
  expect((await owner.query('SELECT revision FROM workflow_versions WHERE organization_id=$1 AND id=$2', [manager.organizationId, workflow.versionId])).rows[0].revision).toBe(2);
});
