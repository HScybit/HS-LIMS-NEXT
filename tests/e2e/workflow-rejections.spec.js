import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { prepareSampleRejection } from '../helpers/workflow-rejections.js';
import { signIn } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function fixture() {
  const manager = await createAccount(owner, { permissions: ['samples.create', 'samples.manage', 'workflows.manage'] });
  const first = await createAccount(owner, { organizationId: manager.organizationId, permissions: ['approvals.respond', 'samples.read'] });
  const second = await createAccount(owner, { organizationId: manager.organizationId, permissions: ['approvals.respond', 'samples.read'] });
  Object.assign(manager, await signIn({ identifier: manager.username, password: manager.password }));
  const flow = await prepareSampleRejection(owner, manager, [first, second], { mode: 'sequential', stages: [
    { stageNumber: 1, roleIds: [first.roleId, second.roleId] }, { stageNumber: 3, roleIds: [second.roleId] },
  ] });
  return { ...flow, manager, first, second };
}
async function login(page, user) {
  expect((await page.request.post('/api/auth/login', { headers: { Origin: 'http://127.0.0.1:3100' }, data: { identifier: user.username, password: user.password } })).status()).toBe(200);
}
async function headers(context) {
  return { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': (await context.cookies()).find((cookie) => cookie.name === 'sampleify_csrf').value };
}

test('first rejection accepts unchecked positive checks, recovers a lost response and displays actual cancelled responders', async ({ page, context }, testInfo) => {
  const flow = await fixture(); const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 }); await login(page, flow.first); await page.goto(`/samples/${flow.sample.id}`);
  await page.getByRole('button', { name: 'Take action', exact: true }).click(); const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(dialog.getByText('Please add a comment to respond.', { exact: true })).toBeVisible();
  await dialog.getByPlaceholder('Add a comment to respond', { exact: true }).fill('Synthetic rejection: sample identity requires correction');
  await expect(dialog.getByRole('checkbox', { name: 'Synthetic approval check 1', exact: true })).not.toBeChecked();
  const id = flow.assignments.find((row) => row.assigned_user_id === flow.first.userId).id;
  const url = `/api/approval-assignments/${id}/reject`; const requestHeaders = await headers(context);
  expect((await page.request.post(url, { headers: { Origin: requestHeaders.Origin }, data: { comment: 'No CSRF', checklistItemIds: [] } })).status()).toBe(403);
  expect((await page.request.post(url, { headers: { ...requestHeaders, Origin: 'https://example.invalid' }, data: { comment: 'Foreign origin', checklistItemIds: [] } })).status()).toBe(403);
  let lost = true; const outcomes = [];
  await page.route(`**${url}`, async (route) => {
    const response = await route.fetch(); outcomes.push(await response.json()); expect(response.status()).toBe(200);
    if (lost) { lost = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost rejection response' } }) }); }
    else await route.fulfill({ response });
  });
  await page.screenshot({ path: testInfo.outputPath('workflow-reject-desktop.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Synthetic lost rejection response');
  await expect(dialog.getByPlaceholder('Add a comment to respond', { exact: true })).toHaveValue('Synthetic rejection: sample identity requires correction');
  await dialog.getByRole('button', { name: 'Reject', exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect(outcomes).toHaveLength(2); expect(outcomes[1]).toEqual(outcomes[0]);
  await page.getByRole('button', { name: 'See all', exact: true }).click();
  const closed = page.getByRole('dialog'); await expect(closed.getByRole('button', { name: 'Reject', exact: true })).toHaveCount(0);
  await expect(closed.getByRole('cell', { name: 'Rejected', exact: true })).toHaveCount(1);
  await expect(closed.getByRole('cell', { name: 'Cancelled', exact: true })).toHaveCount(2);
  const cancelledRows = closed.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Cancelled', exact: true }) });
  for (const row of await cancelledRows.all()) { await expect(row.getByRole('cell').nth(4)).toHaveText('-'); await expect(row.getByRole('cell').nth(5)).toHaveText('-'); }
  await closed.getByText('Checklist', { exact: true }).click(); await expect(closed.getByText('Synthetic approval check 1: Not checked', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('mobile rejection closes the request for the remaining assigned user', async ({ page, browser }, testInfo) => {
  const flow = await fixture(); await page.setViewportSize({ width: 390, height: 844 }); await login(page, flow.first); await page.goto(`/samples/${flow.sample.id}`);
  await page.getByRole('button', { name: 'Take action', exact: true }).click(); const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('Add a comment to respond', { exact: true }).fill('Synthetic mobile rejection');
  await page.screenshot({ path: testInfo.outputPath('workflow-reject-mobile.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Reject', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const otherContext = await browser.newContext(); const other = await otherContext.newPage();
  try {
    await login(other, flow.second); await other.goto(`/samples/${flow.sample.id}`);
    await expect(other.getByRole('button', { name: 'Take action', exact: true })).toHaveCount(0);
    await other.getByRole('button', { name: 'See all', exact: true }).click();
    await expect(other.getByRole('dialog').getByRole('cell', { name: 'Cancelled', exact: true })).toHaveCount(2);
    const id = flow.assignments.find((row) => row.assigned_user_id === flow.second.userId && row.stage_number === 1).id;
    expect((await other.request.post(`/api/approval-assignments/${id}/reject`, { headers: await headers(otherContext), data: { comment: 'Late response', checklistItemIds: [] } })).status()).toBe(409);
  } finally { await otherContext.close(); }
});
