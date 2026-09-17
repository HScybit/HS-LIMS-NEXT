import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { createWorkflowCloneFixture } from '../helpers/workflow-clones.js';
import { loadWorkflowDefinition } from '../../src/workflows/definition.js';
import { executeWorkflowEditorCommand } from '../../src/workflows/commands.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function login(page, actor) {
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(actor.username); await page.getByLabel('Password', { exact: true }).fill(actor.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}

test('Save Flow recovers a lost incomplete-draft response and preserves the active version', async ({ page }, testInfo) => {
  const actor = await createAccount(owner, { permissions: ['workflows.manage'] });
  const session = await signIn({ identifier: actor.username, password: actor.password });
  const work = action => withSession(session.token, action, { csrfToken: session.csrfToken });
  const graph = await work((client, identity) => createWorkflowCloneFixture(client, identity, { edges: 1, details: false }));
  const definition = await work((client, identity) => loadWorkflowDefinition(client, identity, graph.versionId));
  const draft = await work((client, identity) => executeWorkflowEditorCommand(client, identity, graph.workflowId, {
    requestId: randomUUID(), versionId: graph.versionId, revision: definition.version.revision, operation: 'delete_transition', elementId: definition.transitions[0].id,
  }));
  await login(page, actor); await page.goto(`/workflow_management/${graph.workflowId}`);
  const path = `/api/workflows/${graph.workflowId}/commands`; let request;
  await page.route(`**${path}`, async route => {
    request = route.request().postDataJSON(); expect(request.operation).toBe('save_flow'); expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost draft response' } }) });
  });
  await page.getByRole('button', { name: 'Save Flow', exact: true }).click();
  await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic lost draft response');
  await expect(page.getByRole('button', { name: 'Save Flow', exact: true })).toBeDisabled();
  await page.unroute(`**${path}`);
  const retry = page.waitForResponse(response => response.url().endsWith(path) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Retry Save', exact: true }).click(); expect((await retry).request().postDataJSON()).toEqual(request);
  await expect(page.getByRole('status').filter({ hasText: 'Draft saved.' })).toBeVisible();
  await expect(page.locator('.workflow-pill').filter({ hasText: /^Draft$/ })).toBeVisible();
  expect((await page.request.get(`/api/workflows/${graph.workflowId}`)).ok()).toBe(true);
  const current = await (await page.request.get(`/api/workflows/${graph.workflowId}`)).json();
  expect(current.publishedVersionId).toBe(graph.versionId); expect(current.draftVersionId).toBe(draft.versionId);
  expect((await owner.query('SELECT count(*)::integer count FROM workflow_editor_commands WHERE organization_id=$1 AND request_id=$2', [actor.organizationId, request.requestId])).rows[0].count).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('workflow-incomplete-draft-desktop.png'), fullPage: true, animations: 'disabled' });
});

test('Instrument Service workflow type survives creation retry, Details editing and stale reload on mobile', async ({ page }, testInfo) => {
  const actor = await createAccount(owner, { permissions: ['workflows.manage'] }); await login(page, actor); await page.goto('/workflow_management');
  await page.getByRole('button', { name: 'Add Workflow', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Add Workflow' });
  await dialog.getByRole('textbox', { name: /^Name/ }).fill('Instrument approval flow');
  await dialog.getByRole('combobox', { name: /^Applies To/ }).selectOption('instrument_service');
  let request;
  await page.route('**/api/workflows', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    request = route.request().postDataJSON(); expect((await route.fetch()).status()).toBe(201);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost type response' } }) });
  });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click(); await expect(dialog).toContainText('Synthetic lost type response');
  await expect(dialog.getByRole('combobox', { name: /^Applies To/ })).toBeDisabled();
  await page.unroute('**/api/workflows'); await dialog.getByRole('button', { name: 'Retry Save', exact: true }).click();
  await expect(page).toHaveURL(`/workflow_management/${request.id}`); expect(request.appliesTo).toBe('instrument_service');
  await page.getByRole('link', { name: 'Back to workflows', exact: true }).click();
  await page.getByRole('button', { name: 'Details', exact: true }).click(); dialog = page.getByRole('dialog', { name: 'Edit Workflow' });
  await expect(dialog.getByRole('combobox', { name: /^Applies To/ })).toHaveValue('instrument_service');
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value;
  expect((await page.request.patch(`/api/workflows/${request.id}`, { headers: { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': csrf },
    data: { requestId: randomUUID(), metadataRevision: 1, name: request.name, appliesTo: 'test_request' } })).status()).toBe(200);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click(); await expect(dialog).toContainText('Workflow details changed');
  await expect(dialog.getByRole('combobox', { name: /^Applies To/ })).toHaveValue('instrument_service');
  await dialog.getByRole('button', { name: 'Reload details' }).click(); await expect(dialog.getByRole('combobox', { name: /^Applies To/ })).toHaveValue('test_request');
  await dialog.getByRole('combobox', { name: /^Applies To/ }).selectOption('instrument_service');
  await page.setViewportSize({ width: 390, height: 844 }); await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('workflow-instrument-type-mobile.png'), fullPage: true, animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click(); await expect(dialog).toBeHidden();
  const saved = await (await page.request.get(`/api/workflows/${request.id}`)).json(); expect(saved.appliesTo).toBe('instrument_service'); expect(saved.metadataRevision).toBe(3);
});
