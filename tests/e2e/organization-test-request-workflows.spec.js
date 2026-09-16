import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { closePool } from '../../src/db/pool.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
const permissions = ['settings.manage', 'samples.create', 'samples.read', 'samples.manage', 'test_requests.allocate'];
async function login(page, account) {
  await page.context().clearCookies(); await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(account.username); await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
async function openSettings(page) {
  await page.goto('/organization_settings'); await page.getByRole('tab', { name: 'Workflow Configs', exact: true }).click();
  await expect(page.getByLabel('Test Request / Job Workflow', { exact: true })).toBeVisible();
}
const headers = async page => ({ Origin: 'http://127.0.0.1:3100',
  'X-CSRF-Token': (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value });
async function save(page) {
  const response = page.waitForResponse(response => response.url().endsWith('/api/organization-settings/laboratory') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save Settings', exact: true }).click(); return response;
}
async function updateThroughApi(page, changes) {
  const { settings } = await (await page.request.get('/api/organization-settings/laboratory')).json();
  return page.request.put('/api/organization-settings/laboratory', { headers: await headers(page), data: { revision: settings.revision,
    autoCreateJobs: settings.autoCreateJobs, resultSummaryTemplateId: settings.resultSummaryTemplateId,
    jobWorkflowId: settings.jobWorkflowId, testRequestWorkflowId: settings.testRequestWorkflowId, ...changes } });
}
const workflow = page => page.getByLabel('Test Request / Job Workflow', { exact: true });

test('the common workflow saves both keys, gates allocation, clears explicitly and remains accessible on mobile', async ({ page }, testInfo) => {
  const account = await createAccount(owner, { permissions }); const fixture = await createLaboratoryFixture(owner, account, { repeated: false });
  const workflowId = fixture.workflowRecords[1].workflow.id; const errors = []; page.on('pageerror', error => errors.push(error.message));
  await login(page, account);
  expect((await updateThroughApi(page, { testRequestWorkflowId: null, jobWorkflowId: null })).status()).toBe(200);
  await openSettings(page); await expect(workflow(page)).toHaveValue('');
  await expect(page.getByText('Test Request / Job Workflow is not configured.', { exact: true })).toBeVisible();
  const created = await page.request.post('/api/samples', { headers: await headers(page), data: fixture.registration }); expect(created.status()).toBe(201);
  const sample = await created.json();
  const generated = await page.request.post(`/api/samples/${sample.id}/test-requests`, { headers: await headers(page), data: {} }); expect(generated.status()).toBe(201);
  const request = (await generated.json()).items[0];
  const allocate = () => headers(page).then(requestHeaders => page.request.post(`/api/test-requests/${request.id}/assignments`,
    { headers: requestHeaders, data: { revision: 1, assignmentType: 'analyst', assignedUserId: account.userId } }));
  const denied = await allocate(); expect(denied.status()).toBe(422); expect((await denied.json()).error.code).toBe('test_request_workflow_not_configured');
  await workflow(page).selectOption(workflowId); expect((await save(page)).status()).toBe(200);
  await openSettings(page); await expect(workflow(page)).toHaveValue(workflowId);
  const stored = (await (await page.request.get('/api/organization-settings/laboratory')).json()).settings;
  expect(stored.testRequestWorkflowId).toBe(workflowId); expect(stored.jobWorkflowId).toBe(workflowId); expect((await allocate()).status()).toBe(200);
  await page.screenshot({ path: testInfo.outputPath('request-workflow-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 }); await workflow(page).scrollIntoViewIfNeeded(); await expect(workflow(page)).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('request-workflow-mobile.png'), fullPage: true, animations: 'disabled' });
  await workflow(page).selectOption(''); expect((await save(page)).status()).toBe(200); await openSettings(page); await expect(workflow(page)).toHaveValue('');
  const viewer = await createAccount(owner, { organizationId: account.organizationId, permissions: ['settings.read'] });
  await login(page, viewer); await openSettings(page); await expect(workflow(page)).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save Settings', exact: true })).toHaveCount(0);
  expect((await updateThroughApi(page, { testRequestWorkflowId: workflowId, jobWorkflowId: workflowId })).status()).toBe(403);
  expect(errors).toEqual([]);
});

test('different retained source keys show a warning and a save from another tab synchronizes an unavailable selection', async ({ page }) => {
  const account = await createAccount(owner, { permissions }); const fixture = await createLaboratoryFixture(owner, account, { repeated: false });
  const alternate = await createLaboratoryFixture(owner, account, { repeated: false, configureSampleWorkflows: false });
  const workflowId = fixture.workflowRecords[1].workflow.id;
  await login(page, account); expect((await updateThroughApi(page, { jobWorkflowId: alternate.workflowRecords[1].workflow.id })).status()).toBe(200);
  await owner.query("UPDATE workflow_versions SET status='retired',retired_at=now(),revision=revision+1 WHERE organization_id=$1 AND id=$2", [account.organizationId, fixture.workflowRecords[1].version.id]);
  await openSettings(page); await expect(workflow(page)).toHaveValue(workflowId);
  await expect(workflow(page).locator('option:checked')).toContainText('(unavailable)');
  await expect(page.getByText('Test Requests and Jobs have different workflows. Saving applies the selected workflow to both.', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'TR Settings', exact: true }).click(); expect((await save(page)).status()).toBe(200);
  await page.getByRole('tab', { name: 'Workflow Configs', exact: true }).click();
  await expect(page.getByText('Test Requests and Jobs have different workflows. Saving applies the selected workflow to both.', { exact: true })).toHaveCount(0);
  const stored = (await (await page.request.get('/api/organization-settings/laboratory')).json()).settings;
  expect(stored.testRequestWorkflowId).toBe(workflowId); expect(stored.jobWorkflowId).toBe(workflowId);
  await workflow(page).selectOption(''); expect((await save(page)).status()).toBe(200); await expect(workflow(page).locator(`option[value="${workflowId}"]`)).toHaveCount(0);
});

test('failed and stale saves preserve the chosen workflow and reload restores the saved common value', async ({ page }) => {
  const account = await createAccount(owner, { permissions }); const fixture = await createLaboratoryFixture(owner, account, { repeated: false });
  const alternate = await createLaboratoryFixture(owner, account, { repeated: false, configureSampleWorkflows: false });
  await login(page, account); await openSettings(page); await workflow(page).selectOption(alternate.workflowRecords[1].workflow.id);
  const pattern = '**/api/organization-settings/laboratory';
  await page.route(pattern, route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic request workflow failure' } }) }) : route.continue());
  expect((await save(page)).status()).toBe(503); await expect(workflow(page)).toHaveValue(alternate.workflowRecords[1].workflow.id);
  await page.unroute(pattern); expect((await save(page)).status()).toBe(200);
  await workflow(page).selectOption(fixture.workflowRecords[1].workflow.id);
  expect((await updateThroughApi(page, { allowReceivingDateEdit: true })).status()).toBe(200);
  expect((await save(page)).status()).toBe(409); await expect(workflow(page)).toHaveValue(fixture.workflowRecords[1].workflow.id);
  await page.getByRole('button', { name: 'Reload settings', exact: true }).click(); await expect(workflow(page)).toHaveValue(alternate.workflowRecords[1].workflow.id);
});
