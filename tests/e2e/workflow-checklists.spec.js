import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { createChecklist } from '../../src/checklists/service.js';
import { createWorkflow, saveWorkflowState, saveWorkflowTransition } from '../../src/workflows/authoring.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
async function login(page, account) {
  await page.context().clearCookies(); await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(account.username); await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
const lookup = (page, input = {}) => page.request.get(`/api/workflows/checklists?query=${encodeURIComponent(JSON.stringify(input))}`);

test('workflow checklist HTTP choices are bounded, literal and scoped without exposing checklist master contents', async ({ page, browser }) => {
  const account = await createAccount(owner, { permissions: ['workflows.manage'] }); const ids = Array.from({ length: 105 }, () => randomUUID());
  await owner.query('INSERT INTO checklists(organization_id,id,name) SELECT $1,id,$3||ordinal FROM unnest($2::uuid[]) WITH ORDINALITY items(id,ordinal)',
    [account.organizationId, ids, 'Lookup choice ']);
  const inactive = randomUUID(); const literal = randomUUID();
  await owner.query('INSERT INTO checklists(organization_id,id,name,is_active) VALUES($1,$2,$3,false),($1,$4,$5,true)',
    [account.organizationId, inactive, 'Inactive selected label', literal, 'Literal %_\\ choice']);
  await login(page, account);
  const response = await lookup(page, { search: 'Lookup choice', selectedIds: [inactive] }); expect(response.status()).toBe(200);
  const result = await response.json(); expect(result.rows).toHaveLength(100); expect(result.hasMore).toBe(true);
  expect(result.selected).toEqual([{ id: inactive, name: 'Inactive selected label', isActive: false, revision: 0 }]);
  expect(Object.keys(result.rows[0]).sort()).toEqual(['id', 'isActive', 'name', 'revision']);
  expect((await (await lookup(page, { search: '%_\\' })).json()).rows.map((row) => row.id)).toEqual([literal]);
  expect((await page.request.get(`/api/checklists/${literal}`)).status()).toBe(403);
  for (const input of [null, { search: 'x'.repeat(501) }, { selectedIds: [''] }, { selectedIds: ids }, { organizationId: account.organizationId }]) {
    expect((await lookup(page, input)).status()).toBe(400);
  }
  expect((await page.request.get('/api/workflows/checklists?query=broken')).status()).toBe(400);
  expect([413, 431]).toContain((await lookup(page, { search: 'x'.repeat(17000) })).status());
  const reader = await createAccount(owner, { organizationId: account.organizationId, permissions: ['workflows.read'] }); await login(page, reader);
  expect((await lookup(page, { selectedIds: [inactive] })).status()).toBe(200);
  expect((await page.request.get(`/api/checklists/${inactive}?revision=1`)).status()).toBe(403);
  const checklistReader = await createAccount(owner, { organizationId: account.organizationId, permissions: ['checklists.read'] }); await login(page, checklistReader);
  expect((await lookup(page)).status()).toBe(403);
  const foreign = await createAccount(owner, { permissions: ['workflows.manage'] }); await login(page, foreign);
  expect(await (await lookup(page, { selectedIds: [inactive, literal] })).json()).toEqual({ rows: [], hasMore: false, selected: [] });
  const anonymous = await browser.newContext();
  try { expect((await anonymous.request.get('http://127.0.0.1:3100/api/workflows/checklists')).status()).toBe(401); }
  finally { await anonymous.close(); }
});

test('Checklist Master keeps its delete dialog and request when a workflow reference prevents deletion', async ({ page }) => {
  const account = await createAccount(owner, { permissions: ['workflows.manage', 'checklists.manage'] });
  const session = await signIn({ identifier: account.username, password: account.password });
  const work = (action) => withSession(session.token, action, { csrfToken: session.csrfToken });
  const checklist = { id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Checklist in a saved workflow', items: [{ id: randomUUID(), prompt: 'Verify identity' }] };
  const fixture = await work(async (client, identity) => {
    await createChecklist(client, identity, checklist);
    const workflow = await createWorkflow(client, identity, { code: randomUUID(), name: 'Referenced checklist workflow', appliesTo: 'sample' });
    const initial = await saveWorkflowState(client, identity, workflow.versionId, 1, { code: 'initial', name: 'Initial', stateType: 'initial' });
    const final = await saveWorkflowState(client, identity, workflow.versionId, initial.revision, { code: 'final', name: 'Complete', stateType: 'final' });
    const input = { code: 'finish', name: 'Finish', sourceStateId: initial.id, targetStateId: final.id, checklistMasterId: checklist.id };
    const edge = await saveWorkflowTransition(client, identity, workflow.versionId, final.revision, input);
    return { ...workflow, edge, input };
  });
  await login(page, account); await page.goto('/checklists');
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: checklist.name, exact: true }) });
  await row.getByRole('button', { name: 'Delete', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'Delete Checklist', exact: true });
  const failed = page.waitForResponse((response) => response.request().method() === 'DELETE');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click(); const failure = await failed; expect(failure.status()).toBe(409);
  await expect(dialog).toContainText('This checklist is used by a workflow and cannot be deleted.'); await expect(row).toBeVisible();
  expect((await page.request.get(`/api/checklists/${checklist.id}`)).status()).toBe(200);
  await work((client, identity) => saveWorkflowTransition(client, identity, fixture.versionId, fixture.edge.revision,
    { ...fixture.input, checklistMasterId: null }, fixture.edge.id));
  const retry = page.waitForResponse((response) => response.request().method() === 'DELETE');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click(); const retired = await retry;
  expect(retired.status()).toBe(200); expect(retired.request().postDataJSON()).toEqual(failure.request().postDataJSON());
  await expect(dialog).toBeHidden(); await expect(row).toHaveCount(0);
  const history = await (await page.request.get(`/api/checklists/${checklist.id}?revision=2`)).json(); expect(history.operation).toBe('retire'); expect(history.savedBy).toBe(account.userId);
});
