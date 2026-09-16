import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { registerSample } from '../../src/samples/register.js';
import { generateTestRequests } from '../../src/test-requests/generate.js';
import { loadLaboratorySettings, saveLaboratorySettings } from '../../src/organization-settings/service.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function prepare(page) {
  const account = await createAccount(owner, { permissions: ['samples.create', 'samples.manage', 'samples.read', 'test_requests.allocate', 'settings.manage'] });
  const session = await signIn({ identifier: account.username, password: account.password });
  const work = callback => withSession(session.token, callback, { csrfToken: session.csrfToken });
  const fixture = await createLaboratoryFixture(owner, account, { repeated: false });
  const { settings } = await work(loadLaboratorySettings);
  await work((client, identity) => saveLaboratorySettings(client, identity, { revision: settings.revision,
    autoCreateJobs: false, resultSummaryTemplateId: fixture.template.templateId, jobWorkflowId: settings.jobWorkflowId,
    testRequestWorkflowId: settings.testRequestWorkflowId }));
  const sample = await work((client, identity) => registerSample(client, identity, fixture.registration));
  const generated = await work((client, identity) => generateTestRequests(client, identity, sample.id));
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
  return { account, fixture, sample, request: generated.items[0] };
}
async function select(page, sample, request) {
  await page.goto(`/samples/${sample.id}/test_requests`);
  await page.getByRole('button', { name: 'Create Job', exact: true }).click();
  await page.getByRole('checkbox', { name: `Select ${request.requestNumber}`, exact: true }).check();
  await page.getByRole('combobox', { name: 'Assignee:', exact: true }).fill('Synthetic Analyst');
  await page.getByRole('option', { name: 'Synthetic Analyst', exact: true }).click();
}

test('new dynamic requests create Jobs without a category workflow or reviewer', async ({ page }) => {
  const { account, fixture, sample, request } = await prepare(page);
  await owner.query("DELETE FROM sample_category_workflows WHERE organization_id=$1 AND sample_category_id=$2 AND applies_to='test_request'", [account.organizationId, fixture.category.id]);
  await select(page, sample, request);
  await expect(page.getByRole('combobox', { name: 'Reviewer:', exact: true })).toHaveCount(0);
  const created = page.waitForResponse(response => response.url().endsWith('/api/test-requests/jobs') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create Job', exact: true }).click();
  const response = await created; expect(response.status()).toBe(201);
  const result = await response.json(); expect(result.items).toHaveLength(1);
  await expect(page.getByRole('link', { name: result.items[0].requestNumber, exact: true })).toBeVisible();
});

test('legacy and mixed selections require a reviewer even with a category workflow', async ({ page }) => {
  const { account, sample, request } = await prepare(page);
  const legacy = { id: randomUUID(), requestNumber: request.requestNumber + '-legacy' };
  await owner.query(`INSERT INTO test_requests(organization_id,id,request_number,sample_test_id,specification_id,attempt_number,datasheet_template_id,created_by,using_dynamic_workflow)
    SELECT organization_id,$3,$4,sample_test_id,specification_id,2,datasheet_template_id,created_by,false
    FROM test_requests WHERE organization_id=$1 AND id=$2`, [account.organizationId, request.id, legacy.id, legacy.requestNumber]);
  await select(page, sample, legacy);
  const reviewer = page.getByRole('combobox', { name: 'Reviewer:', exact: true });
  await expect(reviewer).toBeVisible();
  await page.getByRole('button', { name: 'Create Job', exact: true }).click();
  await expect(page.getByText('Select reviewer.', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: `Select ${request.requestNumber}`, exact: true }).check();
  await expect(reviewer).toBeVisible();
  await page.getByRole('checkbox', { name: `Select ${legacy.requestNumber}`, exact: true }).uncheck();
  await expect(reviewer).toHaveCount(0);
});
