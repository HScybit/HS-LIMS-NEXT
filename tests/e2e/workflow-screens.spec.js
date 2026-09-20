import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { createWorkflowMaster } from '../../src/workflows/metadata.js';
import { saveWorkflowState, saveWorkflowTransition, publishWorkflow, cloneWorkflowDraft } from '../../src/workflows/authoring.js';

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
  const account = await createAccount(owner, { permissions: ['workflows.manage'] });
  const session = await signIn({ identifier: account.username, password: account.password });
  const graph = await withSession(session.token, async (client, identity) => {
    const workflow = await createWorkflowMaster(client, identity, { id: randomUUID(), requestId: randomUUID(), metadataRevision: 0,
      name: 'Synthetic browser workflow', description: 'Inspect and approve', appliesTo: 'test_request' });
    const first = await saveWorkflowState(client, identity, workflow.versionId, 1, { code: 'registered', name: 'Registered', stateType: 'initial',
      canvasX: 120, canvasY: 160, inputCount: 0, outputCount: 8, legacyTrState: 'allocated', accessRoleIds: [account.roleId], color: 'blue', badgeStyle: 'dark' });
    const last = await saveWorkflowState(client, identity, workflow.versionId, first.revision, { code: 'approved', name: 'Approved <safe text>', stateType: 'final',
      canvasX: 620, canvasY: 280, inputCount: 2, outputCount: 0, legacyTrState: 'approved', isPositiveTermination: true });
    const edge = await saveWorkflowTransition(client, identity, workflow.versionId, last.revision, { code: 'approve', name: 'Approve',
      sourceStateId: first.id, targetStateId: last.id, sourcePort: 8, targetPort: 2, approvalMode: 'any', autoMoveMode: 'no',
      approverStages: [{ stageNumber: 1, roleIds: [account.roleId] }], conditions: [{ sourceField: 'revision', operator: 'gte', comparisonValue: '0' }] });
    await publishWorkflow(client, identity, workflow.versionId, edge.revision, 'Synthetic browser workflow fixture');
    return { ...workflow, first: first.id, last: last.id };
  }, { csrfToken: session.csrfToken });
  return { account, session, graph };
}

test('workflow list creates, edits and deletes with safe retries and deliberate stale-detail reload', async ({ page }, testInfo) => {
  test.setTimeout(60_000); const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const account = await createAccount(owner, { permissions: ['workflows.manage'] }); await login(page, account);
  await page.goto('/workflow_management');
  await expect(page.getByRole('heading', { name: 'Workflow Master', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add Workflow', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Add Workflow', exact: true });
  await dialog.getByRole('textbox', { name: /^Name/ }).fill('   '); await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toContainText('Workflow name is required.');
  await dialog.getByRole('textbox', { name: /^Name/ }).fill('Browser workflow'); await dialog.getByLabel('Description').fill('0');
  let creation;
  await page.route('**/api/workflows', async (route) => {
    if (route.request().method() !== 'POST') return route.continue(); creation = route.request().postDataJSON();
    expect((await route.fetch()).status()).toBe(201);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost save response' } }) });
  });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click(); await expect(dialog).toContainText('Synthetic lost save response');
  await expect(dialog.getByRole('textbox', { name: /^Name/ })).toHaveAttribute('readonly', '');
  await page.unroute('**/api/workflows');
  const retry = page.waitForResponse((response) => response.url().endsWith('/api/workflows') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Retry Save', exact: true }).click(); expect((await retry).request().postDataJSON()).toEqual(creation);
  await expect(page).toHaveURL(`/workflow_management/${creation.id}`); await expect(page.getByRole('heading', { name: 'No nodes yet' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to workflows', exact: true }).click();
  let row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Browser workflow', exact: true }) });
  await row.getByRole('button', { name: 'Details', exact: true }).click(); dialog = page.getByRole('dialog', { name: 'Edit Workflow' });
  await expect(dialog.getByLabel('Description')).toHaveValue('0'); await dialog.getByRole('textbox', { name: /^Name/ }).fill('Unsaved local name');
  expect((await page.request.patch(`/api/workflows/${creation.id}`, { headers: await headers(page), data: {
    requestId: randomUUID(), metadataRevision: 1, name: 'Concurrent name', description: 'Concurrent description',
  } })).status()).toBe(200);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click(); await expect(dialog).toContainText('Workflow details changed in another session.');
  await expect(dialog.getByRole('textbox', { name: /^Name/ })).toHaveValue('Unsaved local name');
  await dialog.getByRole('button', { name: 'Reload details', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: /^Name/ })).toHaveValue('Concurrent name');
  await dialog.getByRole('textbox', { name: /^Name/ }).fill('Edited workflow');
  await page.screenshot({ path: testInfo.outputPath('workflow-details-desktop.png'), fullPage: true, animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click(); await expect(dialog).toBeHidden();
  row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Edited workflow', exact: true }) });
  await expect(row).toBeVisible(); await page.screenshot({ path: testInfo.outputPath('workflow-list-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.lims-main')).toHaveCSS('margin-left', '0px');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('workflow-list-mobile.png'), fullPage: true, animations: 'disabled' });
  const before = await (await page.request.get(`/api/workflows/${creation.id}`)).json();
  expect(before.metadataRevision).toBe(3); expect(before.appliesTo).toBe('sample'); expect(before.description).toBe('Concurrent description');
  let deletion;
  await page.route(`**/api/workflows/${creation.id}`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue(); deletion = route.request().postDataJSON(); expect((await route.fetch()).status()).toBe(200);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost delete response' } }) });
  });
  page.once('dialog', (dialog) => dialog.accept()); await row.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic lost delete response'); await page.unroute(`**/api/workflows/${creation.id}`);
  const removed = page.waitForResponse((response) => response.request().method() === 'DELETE');
  await page.getByRole('button', { name: 'Retry delete', exact: true }).click(); expect((await removed).request().postDataJSON()).toEqual(deletion);
  await expect(row).toHaveCount(0);
  const history = (await owner.query('SELECT count(*)::int count FROM workflow_metadata_versions WHERE organization_id=$1 AND workflow_id=$2', [account.organizationId, creation.id])).rows[0];
  expect(history.count).toBe(4); expect(errors).toEqual([]);
});

test('Flow loads exact source geometry, retries failed reads and clones once after a lost response', async ({ page }, testInfo) => {
  test.setTimeout(60_000); const { account, graph } = await fixture(); await login(page, account); await page.goto('/workflow_management');
  const path = `/api/workflows/${graph.workflowId}/definition`;
  await page.route(`**${path}`, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic graph load failure' } }) }));
  await page.getByRole('link', { name: 'Flow', exact: true }).click(); await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic graph load failure');
  await page.unroute(`**${path}`); await page.getByRole('button', { name: 'Retry', exact: true }).click();
  const canvas = page.getByRole('region', { name: 'Workflow canvas' });
  await expect(canvas.locator('.workflow-node')).toHaveCount(2); await expect(canvas.locator('.workflow-line')).toHaveCount(1);
  await expect(canvas.locator('.workflow-node').first()).toHaveCSS('left', '120px');
  await expect(canvas.locator('.workflow-node').first()).toHaveCSS('height', '214px');
  await expect(canvas.locator('.workflow-node').last()).toContainText('Approved <safe text>');
  await expect(page.locator('.workflow-header-actions')).toContainText('Published');
  await page.screenshot({ path: testInfo.outputPath('workflow-canvas-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.lims-main')).toHaveCSS('margin-left', '0px');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await canvas.evaluate((element) => { element.scrollLeft = 520; });
  await page.screenshot({ path: testInfo.outputPath('workflow-canvas-mobile.png'), fullPage: true, animations: 'disabled' });
  const original = await (await page.request.get(path)).json();
  await page.getByRole('link', { name: 'Back to workflows', exact: true }).click(); let cloned;
  await page.route(`**/api/workflows/${graph.workflowId}/clone`, async (route) => {
    cloned = route.request().postDataJSON(); expect((await route.fetch()).status()).toBe(201);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost clone response' } }) });
  });
  await page.getByRole('button', { name: 'Clone', exact: true }).click(); await expect(page.locator('.alert[role="alert"]')).toContainText('Synthetic lost clone response');
  await page.unroute(`**/api/workflows/${graph.workflowId}/clone`);
  const retry = page.waitForResponse((response) => response.url().endsWith('/clone') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Retry clone', exact: true }).click(); expect((await retry).request().postDataJSON()).toEqual(cloned);
  await expect(page).toHaveURL(`/workflow_management/${cloned.id}`); await expect(page.locator('.workflow-header-actions')).toContainText('Draft');
  const copy = await (await page.request.get(`/api/workflows/${cloned.id}/definition`)).json();
  expect(copy.workflow.appliesTo).toBe('test_request'); expect(copy.workflow.name).toBe(original.workflow.name + ' - Copy');
  expect(copy.states.map((state) => [state.name, state.canvasX, state.canvasY, state.legacyTrState])).toEqual(original.states.map((state) => [state.name, state.canvasX, state.canvasY, state.legacyTrState]));
  expect(copy.transitions[0].sourcePort).toBe(8); expect(copy.transitions[0].conditions[0].comparisonText).toBe('0');
  expect((await owner.query('SELECT count(*)::int count FROM workflow_clone_origins WHERE organization_id=$1 AND request_id=$2', [account.organizationId, cloned.requestId])).rows[0].count).toBe(1);
});

test('workflow readers prefer published graphs and management routes keep tenant and permission boundaries', async ({ page }) => {
  const { account, session, graph } = await fixture();
  const draft = await withSession(session.token, (client, identity) => cloneWorkflowDraft(client, identity, graph.versionId), { csrfToken: session.csrfToken });
  const reader = await createAccount(owner, { organizationId: account.organizationId, permissions: ['workflows.read'] }); await login(page, reader);
  await page.goto('/workflow_management'); await expect(page.getByRole('button', { name: 'Add Workflow', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Details', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Clone', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Flow', exact: true }).click(); await expect(page.locator('.workflow-header-actions')).toContainText('Published');
  expect((await (await page.request.get(`/api/workflows/${graph.workflowId}/definition`)).json()).version.id).toBe(graph.versionId);
  await page.goto(`/workflow_management/${graph.workflowId}?versionId=${draft.versionId}`); await expect(page.locator('.workflow-header-actions')).toContainText('Draft');
  await page.goto(`/workflow_management/${graph.workflowId}?versionId=${randomUUID()}`); await expect(page.locator('.alert[role="alert"]')).toContainText('This workflow version was not found.');
  await expect(page.getByRole('region', { name: 'Workflow canvas' })).toHaveCount(0);
  expect((await page.request.post(`/api/workflows/${graph.workflowId}/clone`, { headers: await headers(page), data: { id: randomUUID(), requestId: randomUUID() } })).status()).toBe(403);
  const foreign = await createAccount(owner, { permissions: ['workflows.manage'] }); await login(page, foreign);
  await page.goto(`/workflow_management/${graph.workflowId}`); await expect(page.locator('.alert[role="alert"]')).toContainText('Workflow was not found.');
  const runtimeOnly = await createAccount(owner, { organizationId: account.organizationId, permissions: ['samples.read'] }); await login(page, runtimeOnly);
  await page.goto('/workflow_management'); await expect(page.locator('.alert[role="alert"]')).toContainText('You do not have permission to view workflows.');
  expect((await page.request.get(`/api/workflows/${graph.workflowId}/definition`)).status()).toBe(403);
});
