import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createLaboratoryFixture } from '../helpers/laboratory.js';
import { createAlternateMethod } from '../helpers/methods.js';
import { addTestRequestMethod } from '../../src/test-requests/methods.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { editTemplate } from '../../src/templates/authoring.js';
import { cloneWorkflowDraft, saveWorkflowTransition, publishWorkflow } from '../../src/workflows/authoring.js';
import { loadWorkflowDefinition } from '../../src/workflows/definition.js';
import { registerSample } from '../../src/samples/register.js';
import { generateTestRequests } from '../../src/test-requests/generate.js';
import { allocateTestRequest } from '../../src/test-requests/allocate.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });

async function fixture() {
  const analyst = await createAccount(owner, { permissions: ['samples.read', 'samples.create', 'samples.manage', 'templates.manage', 'workflows.manage', 'test_requests.allocate', 'datasheets.execute'] });
  const approver = await createAccount(owner, { organizationId: analyst.organizationId, permissions: ['approvals.respond'] });
  const source = await createLaboratoryFixture(owner, analyst);
  const session = await signIn({ identifier: analyst.username, password: analyst.password });
  const work = (action) => withSession(session.token, action, { csrfToken: session.csrfToken });
  await work((client, identity) => editTemplate(client, identity, source.template.versionId, 1,
    { type: 'configureColumn', id: source.template.records.columns.at(-1).id, span: 6, isFinalResult: true }));
  const original = source.workflowRecords.find((item) => item.workflow.appliesTo === 'test_request');
  const draft = await work((client, identity) => cloneWorkflowDraft(client, identity, original.version.id));
  const definition = await work((client, identity) => loadWorkflowDefinition(client, identity, draft.versionId));
  const edge = definition.transitions[0];
  const saved = await work((client, identity) => saveWorkflowTransition(client, identity, draft.versionId, draft.revision, {
    code: edge.code, name: edge.name, sourceStateId: edge.sourceStateId, targetStateId: edge.targetStateId,
    approvalMode: 'all', approverStages: [{ stageNumber: 1, roleIds: [approver.roleId] }], creatorRoleIds: [analyst.roleId], requireComment: true,
    checklist: [{ prompt: 'Confirm the analytical result', isRequired: true }, { prompt: 'Additional review note', isRequired: false }],
  }, edge.id));
  await work((client, identity) => publishWorkflow(client, identity, draft.versionId, saved.revision, 'Synthetic browser review'));
  const sample = await work((client, identity) => registerSample(client, identity, source.registration));
  const generated = await work((client, identity) => generateTestRequests(client, identity, sample.id));
  const requestId = generated.items[0].id;
  const allocated = await work((client, identity) => allocateTestRequest(client, identity, requestId, { revision: 1, assignmentType: 'analyst', assignedUserId: analyst.userId }));
  const method = await createAlternateMethod(owner, analyst, source);
  const added = await work((client, identity) => addTestRequestMethod(client, identity, requestId, { revision: allocated.revision, methodId: method.id }));
  return { analyst, approver, source, sample, requestId, ...allocated, datasheetId: added.datasheetId, originalDatasheetId: allocated.datasheetId,
    requestPath: `/samples/${sample.id}/test_requests/${requestId}`, datasheetPath: `/samples/${sample.id}/data_sheets/${added.datasheetId}` };
}
async function login(page, user) {
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(user.username);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
}
async function requestHeaders(context) {
  const csrf = (await context.cookies()).find((cookie) => cookie.name === 'sampleify_csrf');
  return { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': csrf.value };
}

test('source workflow dialogs submit results, preserve failed comments/checks and show actual approval evidence', async ({ page, browser, context }, testInfo) => {
  const source = await fixture(); const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page, source.analyst); await page.goto(source.datasheetPath);
  await page.getByRole('spinbutton', { name: 'raw_0', exact: true }).nth(0).fill('0');
  await page.getByRole('spinbutton', { name: 'raw_0', exact: true }).nth(1).fill('2.5');
  await page.getByRole('spinbutton', { name: 'raw_1', exact: true }).fill('0');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page).toHaveURL(`${source.requestPath}?datasheetId=${source.datasheetId}`);
  await page.getByRole('button', { name: 'Request Approval', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Request Approval', exact: true });
  await dialog.getByRole('button', { name: 'Send Request', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Add a comment');
  await dialog.getByLabel('Comments', { exact: true }).fill('Synthetic analyst request');
  await dialog.getByRole('button', { name: 'Send Request', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('required checklist');
  await dialog.getByRole('checkbox', { name: 'Confirm the analytical result', exact: true }).check();
  let fail = true;
  await page.route(`**/api/workflow-runs/${source.workflowRunId}/datasheet-transitions`, async (route) => {
    if (fail) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic workflow interruption' } }) });
    else await route.continue();
  });
  await dialog.getByRole('button', { name: 'Send Request', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Synthetic workflow interruption');
  await expect(dialog.getByLabel('Comments', { exact: true })).toHaveValue('Synthetic analyst request');
  await expect(dialog.getByRole('checkbox', { name: 'Confirm the analytical result', exact: true })).toBeChecked();
  const headers = await requestHeaders(context);
  const forged = await page.request.post(`/api/datasheets/${source.datasheetId}/submit`, { headers, data: { revision: 1, captureRevision: 1, finalResultHtml: '<b>forged</b>' } });
  expect(forged.status()).toBe(400);
  const noCsrf = await page.request.post(`/api/workflow-runs/${source.workflowRunId}/transitions`, { headers: { Origin: 'http://127.0.0.1:3100' }, data: {} });
  expect(noCsrf.status()).toBe(403);
  fail = false;
  await page.screenshot({ path: testInfo.outputPath('workflow-request-desktop.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Send Request', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'View details', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add Results', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add Method', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete method', exact: true })).toHaveCount(0);
  const pending = await page.request.get(`/api/test-requests/${source.requestId}`).then((response) => response.json());
  const changePending = await page.request.delete(`/api/test-requests/${source.requestId}/methods/${source.originalDatasheetId}`, { headers, data: { revision: pending.revision } });
  expect(changePending.status()).toBe(409);
  expect((await page.request.get(`/api/datasheets/${source.originalDatasheetId}`).then((response) => response.json())).canExecute).toBe(false);

  const approvalContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const approvalPage = await approvalContext.newPage(); approvalPage.on('pageerror', (error) => errors.push(error.message));
  try {
    await login(approvalPage, source.approver); await approvalPage.goto(source.requestPath);
    await approvalPage.getByRole('button', { name: 'Take action', exact: true }).click();
    const review = approvalPage.getByRole('dialog');
    await review.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(review.getByText('Please add a comment to respond.', { exact: true })).toBeVisible();
    await review.getByRole('textbox', { name: 'Comment', exact: true }).fill('Synthetic result independently approved');
    await review.getByRole('checkbox', { name: 'Confirm the analytical result', exact: true }).check();
    await expect(review.getByRole('checkbox', { name: 'Additional review note', exact: true })).not.toBeChecked();
    await approvalPage.screenshot({ path: testInfo.outputPath('workflow-review-desktop.png'), fullPage: true });
    await approvalPage.setViewportSize({ width: 390, height: 844 });
    await approvalPage.screenshot({ path: testInfo.outputPath('workflow-review-mobile.png'), fullPage: true });
    await review.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(review).toHaveCount(0);
    await expect(approvalPage.locator('.tr-details-page-header__title-row')).toContainText('Completed');
    const workflow = await approvalPage.request.get(`/api/workflow-runs/${source.workflowRunId}`).then((response) => response.json());
    expect(workflow.status).toBe('completed');
    expect(workflow.approvalRequest.approvalRows[0].decidedBy).toBe(source.approver.userId);
    expect(workflow.approvalRequest.approvalRows[0].checklistItems.map((item) => item.isChecked)).toEqual([true, false]);
    await approvalPage.getByRole('button', { name: 'See all', exact: true }).click();
    await expect(approvalPage.getByRole('dialog')).toContainText('Synthetic result independently approved');
    await expect(approvalPage.getByRole('dialog').getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  } finally { await approvalContext.close(); }
  await page.reload();
  await expect(page.locator('.tr-details-page-header__title-row')).toContainText('Completed');
  const persisted = await page.request.get(`/api/datasheets/${source.datasheetId}`).then((response) => response.json());
  expect(persisted.datasheet.status).toBe('approved'); expect(persisted.capture.instance.status).toBe('frozen'); expect(persisted.canExecute).toBe(false);
  expect((await page.request.get(`/api/datasheets/${source.originalDatasheetId}`).then((response) => response.json())).datasheet.status).toBe('in_progress');
  expect(errors).toEqual([]);
});
