import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createWorkflowCloneFixture, workflowGraphValues } from '../helpers/workflow-clones.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { createWorkflowMaster } from '../../src/workflows/metadata.js';
import { saveWorkflowState, saveWorkflowTransition, patchWorkflowTransition } from '../../src/workflows/authoring.js';
import { loadWorkflowDefinition } from '../../src/workflows/definition.js';
import { createChecklist, updateChecklist } from '../../src/checklists/service.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
const work = (actor, callback, readOnly = false) => withSession(actor.token, callback, { csrfToken: actor.csrfToken, readOnly });
const load = (actor, versionId) => work(actor, (client, identity) => loadWorkflowDefinition(client, identity, versionId), true);
async function account(options = {}) { const value = await createAccount(owner, { permissions: ['workflows.manage', 'workflows.read'], ...options });
  return { ...value, ...await signIn({ identifier: value.username, password: value.password }) }; }
async function login(page, actor) {
  await page.context().clearCookies(); await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(actor.username);
  await page.getByLabel('Password', { exact: true }).fill(actor.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
async function fixture() {
  const actor = await account();
  const graph = await work(actor, async (client, identity) => {
    const graph = await createWorkflowMaster(client, identity, { id: randomUUID(), requestId: randomUUID(), metadataRevision: 0, name: 'Connection browser workflow' });
    const first = await saveWorkflowState(client, identity, graph.versionId, 1, { code: 'REGISTERED', name: 'Registered', stateType: 'initial', canvasX: 120, canvasY: 120, inputCount: 1, outputCount: 8 });
    const last = await saveWorkflowState(client, identity, graph.versionId, first.revision, { code: 'COMPLETE', name: 'Complete', stateType: 'final', canvasX: 620, canvasY: 280, inputCount: 8, outputCount: 0 });
    return { ...graph, first: first.id, last: last.id, revision: last.revision };
  });
  return { actor, graph };
}
async function edge(actor, graph, extra = {}) {
  return work(actor, (client, identity) => saveWorkflowTransition(client, identity, graph.versionId, graph.revision, {
    code: 'FINISH', name: 'Finish', sourceStateId: graph.first, targetStateId: graph.last, sourcePort: 8, targetPort: 2, ...extra,
  }));
}
const dialog = (page) => page.getByRole('dialog', { name: 'Assign Approvers', exact: true });
const versionFrom = (page, fallback) => new URL(page.url()).searchParams.get('versionId') ?? fallback;
async function link(page) { await page.getByRole('button', { name: 'Registered output 8', exact: true }).click(); await page.getByRole('button', { name: 'Complete input 2', exact: true }).click(); }
async function open(page, name = 'Finish', code = 'FINISH') { await page.getByRole('button', { name: `Edit connection ${name} (${code})`, exact: true }).press('Enter'); await expect(dialog(page)).toBeVisible(); }
async function save(page) { await dialog(page).getByRole('button', { name: 'Save Connection', exact: true }).click(); await expect(dialog(page)).toHaveCount(0); }
async function choice(page, label, name) { await dialog(page).getByRole('combobox', { name: new RegExp(`^${label}`) }).click(); await page.getByRole('option', { name, exact: true }).click(); }

test('port selection creates source defaults, cancels without writes and saves explicit approvals and email normalization', async ({ page }, testInfo) => {
  const { actor, graph } = await fixture(); const requests = [];
  await login(page, actor); await page.goto(`/workflow_management/${graph.workflowId}`);
  await page.route(`**/api/workflows/${graph.workflowId}/commands`, async (route) => { requests.push(route.request().postDataJSON()); await route.continue(); });
  const output = page.getByRole('button', { name: 'Registered output 8', exact: true });
  await output.click(); await expect(output).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Registered input 1', exact: true }).click(); await expect(dialog(page)).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(output).toHaveAttribute('aria-pressed', 'false');
  await output.click(); await page.getByRole('region', { name: 'Workflow canvas' }).click({ position: { x: 350, y: 40 } });
  await expect(output).toHaveAttribute('aria-pressed', 'false'); await page.getByRole('button', { name: 'Complete input 2', exact: true }).click(); await expect(dialog(page)).toHaveCount(0);
  await link(page); await expect(dialog(page)).toContainText('No approval required'); await expect(dialog(page).getByLabel('Approver Roles', { exact: true })).toBeDisabled();
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click(); expect(requests).toHaveLength(0);
  expect((await load(actor, graph.versionId)).version.revision).toBe(graph.revision);
  await link(page); await choice(page, 'Condition', 'Any one can approve');
  await dialog(page).getByRole('button', { name: 'Save Connection', exact: true }).click(); await expect(dialog(page).getByRole('alert')).toContainText('approver roles');
  await choice(page, 'Approver Roles', `Reader ${actor.roleId}`); await dialog(page).getByRole('combobox', { name: 'Approver Roles', exact: true }).press('Escape');
  await choice(page, 'Creator Roles', `Reader ${actor.roleId}`); await dialog(page).getByRole('combobox', { name: 'Creator Roles', exact: true }).press('Escape');
  await choice(page, 'Auto Move', 'all_trs_allocated');
  await dialog(page).getByRole('textbox', { name: 'CC Emails', exact: true }).fill('invalid'); await dialog(page).getByRole('button', { name: 'Save Connection' }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('valid CC email');
  await dialog(page).getByRole('textbox', { name: 'CC Emails', exact: true }).fill(' FIRST@EXAMPLE.INVALID,first@example.invalid, second@example.invalid, ');
  await dialog(page).screenshot({ path: testInfo.outputPath('connection-desktop.png') }); await save(page);
  const current = await load(actor, graph.versionId); expect(current.transitions).toHaveLength(1);
  expect(current.transitions[0]).toMatchObject({ code: 'REGISTERED-COMPLETE', name: 'Registered → Complete', sourcePort: 8, targetPort: 2,
    approvalMode: 'any', autoMoveMode: 'all_trs_allocated', autoExecute: false, creatorRoleIds: [actor.roleId],
    approverStages: [{ stageNumber: 1, roleIds: [actor.roleId] }], ccEmails: ['first@example.invalid', 'second@example.invalid'] });
  expect(requests).toHaveLength(1); await page.reload(); await expect(page.locator('.workflow-line')).toHaveCount(1);
});

test('published connection no-ops create no draft and email-only edits preserve inactive roles and every hidden graph value', async ({ page }) => {
  const actor = await account(); const roleId = randomUUID();
  await owner.query('INSERT INTO roles(organization_id,id,name) VALUES($1,$2,$3)', [actor.organizationId, roleId, 'Inactive approver']);
  const graph = await work(actor, (client, identity) => createWorkflowCloneFixture(client, identity, { roleId, edges: 2 }));
  await owner.query('UPDATE roles SET active=false WHERE organization_id=$1 AND id=$2', [actor.organizationId, roleId]);
  const before = await load(actor, graph.versionId); const requests = [];
  await login(page, actor); await page.goto(`/workflow_management/${graph.workflowId}?versionId=${graph.versionId}`);
  await page.route(`**/api/workflows/${graph.workflowId}/commands`, async (route) => { requests.push(route.request().postDataJSON()); await route.continue(); });
  await open(page, 'Synthetic transition 1', 'edge-1'); await expect(dialog(page)).toContainText('Inactive approver (inactive)'); await save(page);
  expect(requests).toHaveLength(0); expect((await owner.query("SELECT count(*)::int count FROM workflow_versions WHERE organization_id=$1 AND workflow_id=$2 AND status='draft'", [actor.organizationId, graph.workflowId])).rows[0].count).toBe(0);
  await open(page, 'Synthetic transition 1', 'edge-1'); await dialog(page).getByRole('textbox', { name: 'CC Emails' }).fill('changed@example.invalid'); await save(page);
  const draftId = versionFrom(page, graph.versionId); expect(draftId).not.toBe(graph.versionId); expect(requests[0].input).toEqual({ ccEmails: ['changed@example.invalid'] });
  const expected = workflowGraphValues(before); expected.transitions[1].ccEmails = ['changed@example.invalid'];
  expect(workflowGraphValues(await load(actor, draftId))).toEqual(expected); expect(workflowGraphValues(await load(actor, graph.versionId))).toEqual(workflowGraphValues(before));
});

test('a matching port pair edits its existing connection and multiple matches require an exact connection control', async ({ page }) => {
  const { actor, graph } = await fixture(); const first = await edge(actor, graph);
  await login(page, actor); await page.goto(`/workflow_management/${graph.workflowId}`); await link(page);
  await expect(dialog(page).getByRole('button', { name: 'Delete Connection', exact: true })).toBeVisible(); await save(page);
  expect((await load(actor, graph.versionId)).version.revision).toBe(first.revision);
  await edge(actor, { ...graph, revision: first.revision }, { code: 'SECOND', name: 'Second connection' }); await page.reload(); await link(page);
  await expect(dialog(page)).toHaveCount(0); await expect(page.getByRole('alert').filter({ hasText: 'More than one connection' })).toBeVisible();
  await open(page, 'Second connection', 'SECOND'); await dialog(page).getByRole('textbox', { name: 'CC Emails' }).fill('second@example.invalid'); await save(page);
  const current = await load(actor, graph.versionId); expect(current.transitions).toHaveLength(2);
  expect(current.transitions.find((transition) => transition.code === 'FINISH').ccEmails).toEqual([]);
  expect(current.transitions.find((transition) => transition.code === 'SECOND').ccEmails).toEqual(['second@example.invalid']);
});

test('connection creates and deletes keep exact retries, including deletion of a form with invalid unsaved input', async ({ page }) => {
  const { actor, graph } = await fixture(); const bodies = []; let lose = true;
  await login(page, actor); await page.goto(`/workflow_management/${graph.workflowId}`);
  await page.route(`**/api/workflows/${graph.workflowId}/commands`, async (route) => {
    bodies.push(route.request().postDataJSON()); if (lose) { lose = false; await route.fetch(); await route.abort('failed'); } else await route.continue();
  });
  await link(page); await dialog(page).getByRole('button', { name: 'Save Connection' }).click(); await expect(dialog(page).getByRole('button', { name: 'Retry Save' })).toBeVisible();
  await expect(dialog(page).getByRole('textbox', { name: 'CC Emails' })).toHaveAttribute('readonly', '');
  await dialog(page).getByRole('button', { name: 'Retry Save' }).click(); await expect(dialog(page)).toHaveCount(0); expect(bodies[1]).toEqual(bodies[0]);
  await open(page, 'Registered → Complete', 'REGISTERED-COMPLETE'); await dialog(page).getByRole('textbox', { name: 'CC Emails' }).fill('invalid unsaved email');
  lose = true; page.once('dialog', (question) => question.accept()); await dialog(page).getByRole('button', { name: 'Delete Connection' }).click();
  await expect(dialog(page).getByRole('button', { name: 'Retry Delete' })).toBeVisible(); await dialog(page).getByRole('button', { name: 'Retry Delete' }).click();
  await expect(dialog(page)).toHaveCount(0); expect(bodies[3]).toEqual(bodies[2]); expect(bodies[2].operation).toBe('delete_transition');
  expect((await load(actor, graph.versionId)).transitions).toEqual([]);
  expect((await owner.query('SELECT count(*)::int count FROM workflow_editor_commands WHERE organization_id=$1 AND workflow_id=$2', [actor.organizationId, graph.workflowId])).rows[0].count).toBe(2);
});

test('saved connection checklists retain history until explicit refresh or clear and inactive bindings survive unrelated edits', async ({ page }) => {
  const { actor, graph } = await fixture(); const author = await account({ organizationId: actor.organizationId, permissions: ['checklists.manage'] });
  const checklist = { id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Connection checklist', items: [{ id: randomUUID(), prompt: 'Original check' }] };
  await work(author, (client, identity) => createChecklist(client, identity, checklist));
  await edge(actor, graph, { checklistMasterId: checklist.id }); const before = await load(actor, graph.versionId);
  await work(author, (client, identity) => updateChecklist(client, identity, { id: checklist.id, requestId: randomUUID(), revision: 1, items: [{ id: checklist.items[0].id, prompt: 'Changed check' }] }));
  await login(page, actor); await page.goto(`/workflow_management/${graph.workflowId}`); await open(page); await expect(dialog(page)).toContainText(checklist.name);
  await dialog(page).getByRole('textbox', { name: 'CC Emails' }).fill('preserve@example.invalid'); await save(page);
  let current = await load(actor, graph.versionId); expect(current.transitions[0].checklist).toEqual(before.transitions[0].checklist); expect(current.transitions[0].checklistMasterRevision).toBe(1);
  await open(page); await dialog(page).getByRole('button', { name: 'Refresh checklist', exact: true }).click(); await save(page);
  current = await load(actor, graph.versionId); expect(current.transitions[0].checklistMasterRevision).toBe(2); expect(current.transitions[0].checklist[0].prompt).toBe('Changed check');
  const copied = current.transitions[0].checklist;
  await work(author, (client, identity) => updateChecklist(client, identity, { id: checklist.id, requestId: randomUUID(), revision: 2, isActive: false }));
  await open(page); await expect(dialog(page)).toContainText('Connection checklist (inactive)'); await expect(dialog(page).getByRole('button', { name: 'Refresh checklist' })).toBeDisabled();
  await dialog(page).getByRole('textbox', { name: 'CC Emails' }).fill('inactive@example.invalid'); await save(page);
  expect((await load(actor, graph.versionId)).transitions[0].checklist).toEqual(copied);
  await open(page); await dialog(page).getByRole('combobox', { name: 'Node Checklist', exact: true }).focus(); await page.keyboard.press('Backspace'); await save(page);
  current = await load(actor, graph.versionId); expect(current.transitions[0].checklistMasterId).toBeNull(); expect(current.transitions[0].checklist).toEqual([]);
});

test('stale connection edits and revoked writers retain the form without overwriting saved values', async ({ page }) => {
  const { actor, graph } = await fixture(); const created = await edge(actor, graph);
  await login(page, actor); await page.goto(`/workflow_management/${graph.workflowId}`); await open(page);
  await dialog(page).getByRole('textbox', { name: 'CC Emails' }).fill('stale@example.invalid');
  await work(actor, (client, identity) => patchWorkflowTransition(client, identity, graph.versionId, created.revision, created.id, { ccEmails: ['other@example.invalid'] }));
  await dialog(page).getByRole('button', { name: 'Save Connection' }).click(); await expect(dialog(page).getByRole('button', { name: 'Reload workflow' })).toBeVisible();
  await expect(dialog(page).getByRole('textbox', { name: 'CC Emails' })).toHaveValue('stale@example.invalid');
  await dialog(page).getByRole('button', { name: 'Reload workflow' }).click(); await expect(dialog(page)).toHaveCount(0); await open(page);
  await expect(dialog(page).getByRole('textbox', { name: 'CC Emails' })).toHaveValue('other@example.invalid'); await dialog(page).getByRole('textbox', { name: 'CC Emails' }).fill('forbidden@example.invalid');
  await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_code=$3', [actor.organizationId, actor.roleId, 'workflows.manage']);
  await dialog(page).getByRole('button', { name: 'Save Connection' }).click(); await expect(dialog(page).getByRole('alert')).toBeVisible();
  expect((await load(actor, graph.versionId)).transitions[0].ccEmails).toEqual(['other@example.invalid']);
  page.once('dialog', (question) => question.accept()); await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await page.reload();
  await expect(page.getByRole('button', { name: 'Registered output 8', exact: true })).toHaveCount(0); await expect(page.locator('.workflow-line')).toHaveAttribute('style', 'cursor: default;');
});

test('a real path click opens the connection and a confirmed save can finish its read after management access is removed', async ({ page }) => {
  const { actor, graph } = await fixture(); await edge(actor, graph); let commands = 0; let failRead = true;
  await login(page, actor); await page.goto(`/workflow_management/${graph.workflowId}`);
  const path = page.locator('.workflow-line'); await expect(path).toHaveCount(1);
  const point = await path.evaluate((element) => { const point = element.getPointAtLength(element.getTotalLength() / 2); const matrix = element.getScreenCTM();
    return { x: point.x * matrix.a + point.y * matrix.c + matrix.e, y: point.x * matrix.b + point.y * matrix.d + matrix.f }; });
  await page.mouse.click(point.x, point.y); await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole('textbox', { name: 'CC Emails' }).fill('saved@example.invalid');
  await page.route(`**/api/workflows/${graph.workflowId}/commands`, async (route) => { commands++; await route.continue(); });
  await page.route(`**/api/workflows/${graph.workflowId}/definition*`, async (route) => {
    if (failRead) { failRead = false; await route.fulfill({ status: 503, json: { error: { message: 'Synthetic connection read failure' } } }); } else await route.continue();
  });
  await dialog(page).getByRole('button', { name: 'Save Connection' }).click(); await expect(dialog(page).getByRole('button', { name: 'Retry Reload' })).toBeVisible();
  await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_code=$3', [actor.organizationId, actor.roleId, 'workflows.manage']);
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(page.getByRole('button', { name: 'Add Node', exact: true })).toHaveCount(0);
  await dialog(page).getByRole('button', { name: 'Retry Reload' }).click(); await expect(dialog(page)).toHaveCount(0); expect(commands).toBe(1);
  expect((await load(actor, graph.versionId)).transitions[0].ccEmails).toEqual(['saved@example.invalid']);
});

test('failed checklist labels retry and an explicit new selection copies the chosen master through scoped lookups', async ({ page }) => {
  const { actor, graph } = await fixture(); const author = await account({ organizationId: actor.organizationId, permissions: ['checklists.manage'] });
  const checklist = { id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Selected connection checklist', items: [{ id: randomUUID(), prompt: 'Selected prompt' }] };
  await work(author, (client, identity) => createChecklist(client, identity, checklist));
  await login(page, actor); await page.goto(`/workflow_management/${graph.workflowId}`); let fail = true;
  await page.route('**/api/workflows/checklists?*', async (route) => {
    if (fail) { fail = false; await route.fulfill({ status: 503, json: { error: { message: 'Synthetic checklist labels failure' } } }); } else await route.continue();
  });
  await link(page); await expect(dialog(page)).toContainText('Selections could not be loaded');
  await expect(dialog(page).getByLabel('Node Checklist', { exact: true })).toBeDisabled(); await dialog(page).getByRole('button', { name: 'Retry selections' }).click();
  await choice(page, 'Node Checklist', checklist.name); await save(page);
  const current = await load(actor, graph.versionId); expect(current.transitions[0]).toMatchObject({ checklistMasterId: checklist.id, checklistMasterRevision: 1 });
  expect(current.transitions[0].checklist[0]).toMatchObject({ prompt: 'Selected prompt', isRequired: true });
  expect((await page.request.get(`/api/checklists/${checklist.id}`)).status()).toBe(403);
});

test('explicit sequential-role changes follow source stages while unrelated edits retain an unknown Auto Move mode', async ({ page }) => {
  const { actor, graph } = await fixture(); const nextRole = randomUUID();
  await owner.query('INSERT INTO roles(organization_id,id,name) VALUES($1,$2,$3)', [actor.organizationId, nextRole, 'Additional approver']);
  const created = await edge(actor, graph, { approvalMode: 'sequential', approverStages: [{ stageNumber: 1, roleIds: [actor.roleId] }, { stageNumber: 3, roleIds: [actor.roleId] }] });
  await work(actor, (client, identity) => client.query('UPDATE workflow_transitions SET auto_move_mode=NULL WHERE organization_id=$1 AND id=$2', [identity.organization_id, created.id]));
  await login(page, actor); await page.goto(`/workflow_management/${graph.workflowId}`); await open(page);
  await expect(dialog(page)).toContainText('Not recorded'); await dialog(page).getByRole('textbox', { name: 'CC Emails' }).fill('legacy@example.invalid'); await save(page);
  let current = await load(actor, graph.versionId); expect(current.transitions[0].autoMoveMode).toBeNull(); expect(current.transitions[0].approverStages.map((stage) => stage.stageNumber)).toEqual([1, 3]);
  await open(page); await expect(dialog(page)).toContainText('Changing the approver roles replaces'); await choice(page, 'Approver Roles', 'Additional approver');
  await dialog(page).getByRole('combobox', { name: 'Approver Roles', exact: true }).press('Escape'); await save(page);
  current = await load(actor, graph.versionId); expect(current.transitions[0].approverStages).toHaveLength(1); expect(current.transitions[0].approverStages[0].stageNumber).toBe(1);
  expect(current.transitions[0].approverStages[0].roleIds.sort()).toEqual([actor.roleId, nextRole].sort());
  await open(page); await choice(page, 'Condition', 'No approval required'); await choice(page, 'Auto Move', 'all_trs_approved'); await save(page);
  current = await load(actor, graph.versionId); expect(current.transitions[0]).toMatchObject({ approvalMode: 'none', approverStages: [], autoMoveMode: 'all_trs_approved', autoExecute: false });
});

test('500-role connection forms fit narrow phones, guard unsaved navigation and support native touch port selection', async ({ page }) => {
  const { actor, graph } = await fixture();
  const roles = [actor.roleId, ...(await owner.query(`INSERT INTO roles(organization_id,id,name)
    SELECT $1,gen_random_uuid(),'Connection mobile role '||n FROM generate_series(1,499) n RETURNING id`, [actor.organizationId])).rows.map((row) => row.id)];
  const created = await edge(actor, graph, { approvalMode: 'any', approverStages: [{ stageNumber: 1, roleIds: roles }] });
  await login(page, actor); await page.goto('/workflow_management'); await page.getByRole('link', { name: 'Flow', exact: true }).click();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 }); await open(page); await expect(dialog(page).getByRole('combobox', { name: 'Approver Roles', exact: true })).toBeEnabled();
    await expect(dialog(page)).toContainText('+498 more');
    for (const selector of ['.modal-body', '.modal-footer']) {
      const geometry = await dialog(page).locator(selector).evaluate((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
      expect(geometry.scrollWidth, `${selector} at ${width}px`).toBeLessThanOrEqual(geometry.width + 1);
    }
    await dialog(page).screenshot({ path: `.local/m04-workflow-connection-mobile-${width}.png`, animations: 'disabled' });
    await dialog(page).getByRole('textbox', { name: 'CC Emails' }).fill('unsaved@example.invalid');
    const refused = new Promise((resolve) => page.once('dialog', async (question) => { await question.dismiss(); resolve(); }));
    await page.evaluate(() => window.history.back()); await refused; await expect(dialog(page)).toBeVisible();
    page.once('dialog', (question) => question.accept()); await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  }
  expect((await load(actor, graph.versionId)).version.revision).toBe(created.revision);
  const session = await page.context().newCDPSession(page); await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  for (const label of ['Registered output 8', 'Complete input 2']) {
    const port = page.getByRole('button', { name: label, exact: true }); await port.scrollIntoViewIfNeeded(); const box = await port.boundingBox();
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  await expect(dialog(page)).toBeVisible(); await save(page); expect((await load(actor, graph.versionId)).version.revision).toBe(created.revision);
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: false }); await session.detach();
});

test('large sequential selections load role labels in bounded batches and preserve all stage assignments on unrelated saves', async ({ page }) => {
  const { actor, graph } = await fixture();
  const roles = [actor.roleId, ...(await owner.query(`INSERT INTO roles(organization_id,id,name)
    SELECT $1,gen_random_uuid(),'Batched approver '||n FROM generate_series(1,1499) n RETURNING id`, [actor.organizationId])).rows.map((row) => row.id)];
  await edge(actor, graph, { approvalMode: 'sequential', approverStages: [0, 1, 2].map((stage) => ({ stageNumber: stage + 1, roleIds: roles.slice(stage * 500, stage * 500 + 500) })) });
  const before = await load(actor, graph.versionId); const lookups = []; const commands = [];
  await login(page, actor); await page.goto(`/workflow_management/${graph.workflowId}`);
  await page.route('**/api/workflows/lookups/roles', async (route) => { lookups.push(route.request().postDataJSON()); await route.continue(); });
  await page.route(`**/api/workflows/${graph.workflowId}/commands`, async (route) => { commands.push(route.request().postDataJSON()); await route.continue(); });
  await open(page); await expect(dialog(page).getByRole('combobox', { name: 'Approver Roles', exact: true })).toBeEnabled(); await expect(dialog(page)).toContainText('+1498 more');
  expect(lookups).toHaveLength(3); expect(lookups.map((lookup) => lookup.selectedIds.length)).toEqual([500, 500, 500]);
  expect(new Set(lookups.flatMap((lookup) => lookup.selectedIds)).size).toBe(1500);
  await dialog(page).getByRole('textbox', { name: 'CC Emails' }).fill('batched@example.invalid'); await save(page);
  expect(commands).toHaveLength(1); expect(commands[0].input).toEqual({ ccEmails: ['batched@example.invalid'] });
  const expected = workflowGraphValues(before); expected.transitions[0].ccEmails = ['batched@example.invalid'];
  expect(workflowGraphValues(await load(actor, graph.versionId))).toEqual(expected);
});

test('node and connection modals prevent background focus and restore canvas interaction after closing', async ({ page }) => {
  const { actor, graph } = await fixture(); const created = await edge(actor, graph);
  await login(page, actor); await page.goto(`/workflow_management/${graph.workflowId}`);
  for (const type of ['node', 'connection']) {
    if (type === 'node') await page.getByRole('button', { name: 'Edit Registered', exact: true }).click(); else await open(page);
    const modal = page.getByRole('dialog', { name: type === 'node' ? 'Node Details' : 'Assign Approvers', exact: true });
    await modal.getByRole('textbox', { name: type === 'node' ? /^Name/ : 'CC Emails' }).focus();
    expect(await page.evaluate(() => { const canvas = document.querySelector('.workflow-canvas-shell'); canvas.querySelector('.workflow-port--output').focus();
      return document.querySelector('[role="dialog"]').contains(document.activeElement); })).toBe(true);
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(modal).toHaveCount(0);
    await page.getByRole('button', { name: 'Registered output 8', exact: true }).focus();
    expect(await page.locator('.workflow-canvas-shell').evaluate((canvas) => canvas.contains(document.activeElement))).toBe(true);
  }
  expect((await load(actor, graph.versionId)).version.revision).toBe(created.revision);
});

test('refreshed management revocation gives unsaved node and connection forms a reload error without sending a command', async ({ page }) => {
  for (const type of ['node', 'connection']) {
    const { actor, graph } = await fixture(); const created = await edge(actor, graph); let commands = 0;
    await login(page, actor); await page.goto(`/workflow_management/${graph.workflowId}`);
    await page.route(`**/api/workflows/${graph.workflowId}/commands`, async (route) => { commands++; await route.continue(); });
    if (type === 'node') await page.getByRole('button', { name: 'Edit Registered', exact: true }).click(); else await open(page);
    const modal = page.getByRole('dialog', { name: type === 'node' ? 'Node Details' : 'Assign Approvers', exact: true });
    const field = modal.getByRole('textbox', { name: type === 'node' ? /^Name/ : 'CC Emails' }); const value = type === 'node' ? 'Unsaved node name' : 'unsaved@example.invalid';
    await field.fill(value);
    await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_code=$3', [actor.organizationId, actor.roleId, 'workflows.manage']);
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(page.getByRole('button', { name: 'Add Node', exact: true })).toHaveCount(0);
    await modal.getByRole('button', { name: type === 'node' ? 'Save Node' : 'Save Connection', exact: true }).click();
    await expect(modal.getByRole('alert')).toContainText('Workflow editing is no longer available'); await expect(field).toHaveValue(value); expect(commands).toBe(0);
    await modal.getByRole('button', { name: 'Reload workflow' }).click(); await expect(modal).toHaveCount(0);
    expect((await load(actor, graph.versionId)).version.revision).toBe(created.revision);
  }
});
