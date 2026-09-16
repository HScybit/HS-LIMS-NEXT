import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { closePool } from '../../src/db/pool.js';
import { sampleWorkflowTypes } from '../../src/organization-settings/sample-workflows.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
const permissions = ['settings.manage', 'samples.create', 'samples.read'];
async function login(page, account) {
  await page.context().clearCookies(); await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(account.username); await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
async function openSettings(page) {
  await page.goto('/organization_settings'); await page.getByRole('tab', { name: 'Workflow Configs', exact: true }).click();
  await expect(page.getByLabel('Base Sample', { exact: true })).toBeVisible();
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
    autoCreateJobs: settings.autoCreateJobs, resultSummaryTemplateId: settings.resultSummaryTemplateId, jobWorkflowId: settings.jobWorkflowId, ...changes } });
}

test('six source workflow controls persist, gate new samples, clear explicitly and remain read-only for viewers', async ({ page }, testInfo) => {
  const account = await createAccount(owner, { permissions });
  const fixture = await createLaboratoryFixture(owner, account, { repeated: false, configureSampleWorkflows: false });
  const workflowId = fixture.workflowRecords[0].workflow.id; const errors = []; page.on('pageerror', error => errors.push(error.message));
  await login(page, account); await openSettings(page);
  const warning = page.locator('#tabpanel-workflow_configs .alert-warning');
  for (const { label } of sampleWorkflowTypes) {
    await expect(warning).toContainText(label); await expect(page.getByLabel(label, { exact: true })).toHaveValue('');
  }
  const create = () => headers(page).then(requestHeaders => page.request.post('/api/samples', { headers: requestHeaders, data: fixture.registration }));
  expect((await create()).status()).toBe(422);
  for (const { label } of sampleWorkflowTypes) await page.getByLabel(label, { exact: true }).selectOption(workflowId);
  await expect(warning).toHaveCount(0); expect((await save(page)).status()).toBe(200); await openSettings(page);
  for (const { label } of sampleWorkflowTypes) await expect(page.getByLabel(label, { exact: true })).toHaveValue(workflowId);
  const response = await create(); expect(response.status()).toBe(201); const sample = await response.json();
  await page.screenshot({ path: testInfo.outputPath('sample-workflows-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('sample-workflows-mobile.png'), fullPage: true, animations: 'disabled' });
  for (const { label } of sampleWorkflowTypes) {
    const control = page.getByLabel(label, { exact: true }); await control.scrollIntoViewIfNeeded(); await expect(control).toBeInViewport();
  }
  await page.screenshot({ path: testInfo.outputPath('sample-workflows-mobile-lower.png'), fullPage: true, animations: 'disabled' });
  await page.getByLabel('Base Sample', { exact: true }).selectOption(''); expect((await save(page)).status()).toBe(200);
  expect((await create()).status()).toBe(422); expect((await page.request.get(`/api/samples/${sample.id}`)).status()).toBe(200);
  await openSettings(page); await expect(page.getByLabel('Base Sample', { exact: true })).toHaveValue('');
  const viewer = await createAccount(owner, { organizationId: account.organizationId, permissions: ['settings.read'] });
  await login(page, viewer); await openSettings(page);
  for (const { label } of sampleWorkflowTypes) await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save Settings', exact: true })).toHaveCount(0);
  expect((await updateThroughApi(page, { sampleWorkflows: Object.fromEntries(sampleWorkflowTypes.map(({ key }) => [key, workflowId])) })).status()).toBe(403);
  expect(errors).toEqual([]);
});

test('workflow drafts survive failed saves and a stale assignment requires reloading', async ({ page }) => {
  const account = await createAccount(owner, { permissions });
  const fixture = await createLaboratoryFixture(owner, account, { repeated: false, configureSampleWorkflows: false });
  await login(page, account); await openSettings(page);
  await page.getByLabel('Base Sample', { exact: true }).selectOption(fixture.workflowRecords[0].workflow.id);
  const pattern = '**/api/organization-settings/laboratory';
  await page.route(pattern, route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic workflow save failure' } }) }) : route.continue());
  expect((await save(page)).status()).toBe(503); await expect(page.getByLabel('Base Sample', { exact: true })).toHaveValue(fixture.workflowRecords[0].workflow.id);
  await page.unroute(pattern); expect((await save(page)).status()).toBe(200);
  await page.getByLabel('Base Sample', { exact: true }).selectOption('');
  expect((await updateThroughApi(page, { allowReceivingDateEdit: true })).status()).toBe(200);
  expect((await save(page)).status()).toBe(409); await expect(page.getByLabel('Base Sample', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Reload settings', exact: true }).click();
  await expect(page.getByLabel('Base Sample', { exact: true })).toHaveValue(fixture.workflowRecords[0].workflow.id);
});

test('retained unavailable workflows are visible only in their saved field and can be cleared', async ({ page }) => {
  const account = await createAccount(owner, { permissions });
  const fixture = await createLaboratoryFixture(owner, account, { repeated: false }); const workflowId = fixture.workflowRecords[0].workflow.id;
  await owner.query("UPDATE workflow_versions SET status='retired',retired_at=now(),revision=revision+1 WHERE organization_id=$1 AND workflow_id=$2 AND status='published'", [account.organizationId, workflowId]);
  await login(page, account); await openSettings(page);
  const base = page.getByLabel('Base Sample', { exact: true });
  await expect(base.locator(`option[value="${workflowId}"]`)).toContainText('(unavailable)');
  expect((await save(page)).status()).toBe(200);
  await base.selectOption(''); await expect(base.locator(`option[value="${workflowId}"]`)).toHaveCount(0);
  expect((await save(page)).status()).toBe(200); await openSettings(page); await expect(base).toHaveValue('');
  await expect(page.getByLabel('IQC Sample', { exact: true }).locator(`option[value="${workflowId}"]`)).toContainText('(unavailable)');
});
