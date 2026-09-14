import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createWorkflowCloneFixture, workflowGraphValues } from '../helpers/workflow-clones.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { createWorkflowMaster } from '../../src/workflows/metadata.js';
import { loadWorkflowDefinition } from '../../src/workflows/definition.js';
import { patchWorkflowState, saveWorkflowState, saveWorkflowTransition } from '../../src/workflows/authoring.js';
import { createTemplate } from '../../src/templates/authoring.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { csrfToken: actor.csrfToken, readOnly });
async function account(options) { const value = await createAccount(owner, options); return { ...value, ...await signIn({ identifier: value.username, password: value.password }) }; }
async function fixture(permissions = ['workflows.manage']) {
  const manager = await account({ permissions });
  const graph = await work(manager, (client, identity) => createWorkflowMaster(client, identity, {
    id: randomUUID(), requestId: randomUUID(), metadataRevision: 0, name: `Browser node workflow ${randomUUID()}` }));
  return { manager, graph };
}
async function login(page, actor) {
  await page.context().clearCookies(); await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(actor.username); await page.getByLabel('Password', { exact: true }).fill(actor.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
const dialog = (page) => page.getByRole('dialog', { name: 'Node Details', exact: true });
const load = (actor, versionId) => work(actor, (client, identity) => loadWorkflowDefinition(client, identity, versionId), true);
const versionFrom = (page, fallback) => new URL(page.url()).searchParams.get('versionId') ?? fallback;
async function addNode(page, name) {
  await page.getByRole('button', { name: 'Add Node', exact: true }).click();
  await dialog(page).getByRole('textbox', { name: /^Name/ }).fill(name);
  await dialog(page).getByRole('button', { name: 'Save Node', exact: true }).click(); await expect(dialog(page)).toHaveCount(0);
}

test('node controls create source defaults, validate ports, save deltas and avoid no-op revisions', async ({ page }, testInfo) => {
  const { manager, graph } = await fixture(); const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await login(page, manager); await page.goto(`/workflow_management/${graph.workflowId}`);
  await page.getByRole('button', { name: 'Add Node', exact: true }).click();
  await expect(dialog(page).getByRole('spinbutton', { name: /^Inputs/ })).toHaveValue('0');
  await expect(dialog(page).getByRole('spinbutton', { name: /^Outputs/ })).toHaveValue('1');
  await dialog(page).getByRole('textbox', { name: /^Name/ }).fill('   '); await dialog(page).getByRole('button', { name: 'Save Node' }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('Node name is required');
  await dialog(page).getByRole('textbox', { name: /^Name/ }).fill(' Registered ');
  await dialog(page).getByRole('spinbutton', { name: /^Outputs/ }).fill('9'); await dialog(page).getByRole('button', { name: 'Save Node' }).click();
  expect(await dialog(page).getByRole('spinbutton', { name: /^Outputs/ }).evaluate((input) => input.validity.rangeOverflow)).toBe(true);
  await dialog(page).getByRole('spinbutton', { name: /^Outputs/ }).fill('8');
  await dialog(page).getByRole('button', { name: 'green badge color' }).click(); await dialog(page).getByRole('button', { name: 'Dark', exact: true }).click();
  await dialog(page).getByLabel('Generate Test Request', { exact: true }).check();
  await dialog(page).screenshot({ path: testInfo.outputPath('node-details.png') });
  await dialog(page).getByRole('button', { name: 'Save Node' }).click(); await expect(dialog(page)).toHaveCount(0);
  let current = await load(manager, graph.versionId); expect(current.states).toHaveLength(1);
  expect(current.states[0]).toMatchObject({ code: 'REGISTERED', name: 'Registered', stateType: 'initial', canvasX: 120, inputCount: 0, outputCount: 8,
    color: 'green', badgeStyle: 'dark', generateTestRequests: true });
  const revision = current.version.revision;
  await page.getByRole('button', { name: 'Edit Registered', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Save Node' }).click(); await expect(dialog(page)).toHaveCount(0);
  expect((await load(manager, graph.versionId)).version.revision).toBe(revision);
  await page.getByRole('button', { name: 'Edit Registered', exact: true }).click();
  await dialog(page).getByRole('textbox', { name: /^Name/ }).fill('Should be discarded');
  page.once('dialog', (question) => question.accept()); await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Registered', exact: true })).toBeVisible();
  expect((await load(manager, graph.versionId)).version.revision).toBe(revision); expect(errors).toEqual([]);
});

test('node saves retain an identical request after response loss and retry only the read after a known save', async ({ page }) => {
  const { manager, graph } = await fixture(); await login(page, manager); await page.goto(`/workflow_management/${graph.workflowId}`);
  const bodies = []; let lose = true;
  await page.route(`**/api/workflows/${graph.workflowId}/commands`, async (route) => {
    bodies.push(route.request().postDataJSON());
    if (lose) { lose = false; await route.fetch(); await route.abort('failed'); } else await route.continue();
  });
  await page.getByRole('button', { name: 'Add Node', exact: true }).click(); await dialog(page).getByRole('textbox', { name: /^Name/ }).fill('Lost response node');
  await dialog(page).getByRole('button', { name: 'Save Node' }).click(); await expect(dialog(page).getByRole('button', { name: 'Retry Save' })).toBeVisible();
  await expect(dialog(page).getByRole('textbox', { name: /^Name/ })).toHaveAttribute('readonly', '');
  await dialog(page).getByRole('button', { name: 'Retry Save' }).click(); await expect(dialog(page)).toHaveCount(0);
  expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]); expect((await load(manager, graph.versionId)).states).toHaveLength(1);
  await page.getByRole('button', { name: 'Edit Lost response node', exact: true }).click();
  await dialog(page).getByRole('textbox', { name: /^Name/ }).fill('Confirmed save'); let failRead = true;
  await page.route(`**/api/workflows/${graph.workflowId}/definition*`, async (route) => {
    if (failRead) { failRead = false; await route.fulfill({ status: 503, json: { error: { message: 'Synthetic post-save read failure' } } }); } else await route.continue();
  });
  await dialog(page).getByRole('button', { name: 'Save Node' }).click(); await expect(dialog(page).getByRole('alert')).toContainText('The change was saved');
  expect(bodies).toHaveLength(3); await dialog(page).getByRole('button', { name: 'Retry Reload' }).click(); await expect(dialog(page)).toHaveCount(0);
  expect(bodies).toHaveLength(3); await expect(page.getByRole('button', { name: 'Edit Confirmed save', exact: true })).toBeVisible();
  expect((await owner.query('SELECT count(*)::integer count FROM workflow_editor_commands WHERE organization_id=$1 AND workflow_id=$2', [manager.organizationId, graph.workflowId])).rows[0].count).toBe(2);
});

test('a stale node save requires explicit reload and never overwrites the other editor', async ({ page }) => {
  const { manager, graph } = await fixture(); await login(page, manager); await page.goto(`/workflow_management/${graph.workflowId}`); await addNode(page, 'Before');
  const original = await load(manager, graph.versionId);
  await page.getByRole('button', { name: 'Edit Before', exact: true }).click(); await dialog(page).getByRole('textbox', { name: /^Name/ }).fill('Stale local name');
  await work(manager, (client, identity) => patchWorkflowState(client, identity, graph.versionId, original.version.revision, original.states[0].id, { name: 'Other editor' }));
  await dialog(page).getByRole('button', { name: 'Save Node' }).click(); await expect(dialog(page).getByRole('button', { name: 'Save Node' })).toBeDisabled();
  await expect(dialog(page).getByRole('textbox', { name: /^Name/ })).toHaveValue('Stale local name');
  page.once('dialog', (question) => question.accept()); await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0); await expect(page.getByRole('button', { name: 'Add Node', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Reload workflow' }).click(); await expect(page.getByRole('button', { name: 'Edit Other editor', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit Other editor', exact: true }).click(); await dialog(page).getByRole('textbox', { name: /^Name/ }).fill('Another stale name');
  await work(manager, (client, identity) => patchWorkflowState(client, identity, graph.versionId, original.version.revision + 1, original.states[0].id, { name: 'Latest editor' }));
  await dialog(page).getByRole('button', { name: 'Save Node' }).click(); await expect(dialog(page).getByRole('button', { name: 'Save Node' })).toBeDisabled();
  await dialog(page).getByRole('button', { name: 'Reload workflow' }).click(); await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit Latest editor', exact: true })).toBeVisible();
  expect((await load(manager, graph.versionId)).version.revision).toBe(original.version.revision + 2);
});

test('editing a published node clones once, preserves inactive selections and hidden history, and remains publishable after reload', async ({ page }) => {
  const manager = await account({ permissions: ['workflows.manage'] });
  const author = await account({ organizationId: manager.organizationId, permissions: ['templates.manage'] });
  const template = await work(author, (client, identity) => createTemplate(client, identity, { name: 'Inactive node template', kind: 'datasheet' }));
  const roleId = randomUUID(); await owner.query('INSERT INTO roles(organization_id,id,name) VALUES($1,$2,$3)', [manager.organizationId, roleId, 'Inactive node role']);
  const graph = await work(manager, (client, identity) => createWorkflowCloneFixture(client, identity, { edges: 5, roleId, templateId: template.templateId }));
  await owner.query('UPDATE roles SET active=false WHERE organization_id=$1 AND id=$2', [manager.organizationId, roleId]);
  await work(author, (client, identity) => client.query('UPDATE templates SET active=false WHERE organization_id=$1 AND id=$2', [identity.organization_id, template.templateId]));
  const original = workflowGraphValues(await load(manager, graph.versionId));
  await login(page, manager); await page.goto(`/workflow_management/${graph.workflowId}?versionId=${graph.versionId}`);
  await page.getByRole('button', { name: 'Edit Synthetic state 5', exact: true }).click();
  await expect(dialog(page)).toContainText('Inactive node role (inactive)'); await expect(dialog(page)).toContainText('Inactive node template (inactive)');
  expect((await owner.query("SELECT count(*)::integer count FROM workflow_versions WHERE organization_id=$1 AND workflow_id=$2 AND status='draft'", [manager.organizationId, graph.workflowId])).rows[0].count).toBe(0);
  await dialog(page).getByRole('button', { name: 'Save Node' }).click(); await expect(dialog(page)).toHaveCount(0);
  expect((await owner.query("SELECT count(*)::integer count FROM workflow_versions WHERE organization_id=$1 AND workflow_id=$2 AND status='draft'", [manager.organizationId, graph.workflowId])).rows[0].count).toBe(0);
  await page.getByRole('button', { name: 'Edit Synthetic state 5', exact: true }).click();
  await dialog(page).getByRole('textbox', { name: /^Name/ }).fill('Renamed final'); await dialog(page).getByRole('button', { name: 'Save Node' }).click();
  await expect(dialog(page)).toHaveCount(0); const draftId = versionFrom(page, graph.versionId); expect(draftId).not.toBe(graph.versionId);
  const copy = workflowGraphValues(await load(manager, draftId)); const expected = structuredClone(original); expected.states[5].name = 'Renamed final';
  expect(copy).toEqual(expected); expect(workflowGraphValues(await load(manager, graph.versionId))).toEqual(original);
  await page.reload(); await expect(page.getByRole('button', { name: 'Save Flow', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Save Flow', exact: true }).click(); await expect(page.locator('.workflow-pill').filter({ hasText: /^Published$/ })).toBeVisible();
  expect((await load(manager, draftId)).version.status).toBe('published'); expect(workflowGraphValues(await load(manager, graph.versionId))).toEqual(original);
});

test('port reduction and node deletion remove affected draft connections while invalid SaveFlow stays a draft', async ({ page }) => {
  const { manager, graph } = await fixture();
  const nodes = await work(manager, async (client, identity) => {
    const first = await saveWorkflowState(client, identity, graph.versionId, 1, { code: 'initial', name: 'Initial', stateType: 'initial', canvasX: 120, canvasY: 120, inputCount: 0, outputCount: 8 });
    const last = await saveWorkflowState(client, identity, graph.versionId, first.revision, { code: 'final', name: 'Final', stateType: 'final', canvasX: 500, canvasY: 120, inputCount: 8, outputCount: 0 });
    await saveWorkflowTransition(client, identity, graph.versionId, last.revision, { code: 'edge', name: 'Approve', sourceStateId: first.id, targetStateId: last.id, sourcePort: 8, targetPort: 8, approvalMode: 'none' });
    return { first, last };
  });
  await login(page, manager); await page.goto(`/workflow_management/${graph.workflowId}`); await page.getByRole('button', { name: 'Edit Initial', exact: true }).click();
  await dialog(page).getByRole('spinbutton', { name: /^Outputs/ }).fill('0'); await dialog(page).getByRole('button', { name: 'Save Node' }).click(); await expect(dialog(page)).toHaveCount(0);
  const incomplete = await load(manager, graph.versionId); expect(incomplete.transitions).toHaveLength(0);
  const publication = page.waitForResponse((response) => response.url().endsWith(`/api/workflows/${graph.workflowId}/commands`)
    && response.request().method() === 'POST' && response.request().postDataJSON().operation === 'publish');
  await page.getByRole('button', { name: 'Save Flow', exact: true }).click();
  const rejected = await publication; expect(rejected.status()).toBe(422); expect((await rejected.json()).error.code).toBe('workflow_validation_failed');
  await expect(page.getByRole('alert').filter({ hasText: 'Add exactly one initial and final state' }))
    .toHaveText('Add exactly one initial and final state, and connect every initial or normal state.');
  expect((await load(manager, graph.versionId)).version).toMatchObject({ status: 'draft', revision: incomplete.version.revision });
  page.once('dialog', (question) => question.accept()); await page.getByRole('button', { name: 'Delete Final', exact: true }).click();
  await expect(page.locator('.workflow-node')).toHaveCount(1); expect((await load(manager, graph.versionId)).states.map((state) => state.id)).toEqual([nodes.first.id]);
});

test('node reference controls recover failed labels and submit explicit role and template selections', async ({ page }) => {
  const { manager, graph } = await fixture(); const author = await account({ organizationId: manager.organizationId, permissions: ['templates.manage'] });
  const template = await work(author, (client, identity) => createTemplate(client, identity, { name: 'Selected node template', kind: 'datasheet' }));
  const roleId = randomUUID(); await owner.query('INSERT INTO roles(organization_id,id,name) VALUES($1,$2,$3)', [manager.organizationId, roleId, 'Selected node role']);
  await login(page, manager); await page.goto(`/workflow_management/${graph.workflowId}`); let fail = true;
  await page.route('**/api/workflows/lookups/roles', async (route) => {
    if (fail) { fail = false; await route.fulfill({ status: 503, json: { error: { message: 'Synthetic selection failure' } } }); } else await route.continue();
  });
  await page.getByRole('button', { name: 'Add Node', exact: true }).click(); await expect(dialog(page)).toContainText('Selections could not be loaded');
  await expect(dialog(page).getByLabel('Access Roles', { exact: true })).toBeDisabled();
  await dialog(page).getByRole('button', { name: 'Retry selections' }).click(); await expect(dialog(page).getByRole('combobox', { name: 'Access Roles', exact: true })).toBeEnabled();
  await dialog(page).getByRole('combobox', { name: 'Access Roles', exact: true }).fill('Selected node role'); await page.getByRole('option', { name: 'Selected node role', exact: true }).click();
  await dialog(page).getByRole('combobox', { name: 'Access Roles', exact: true }).press('Escape');
  await dialog(page).getByRole('combobox', { name: 'Template', exact: true }).click(); await page.getByRole('option', { name: 'Selected node template', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Save Node' }).click(); await expect(dialog(page)).toHaveCount(0);
  const current = await load(manager, graph.versionId); expect(current.states[0].templateId).toBe(template.templateId);
  expect(current.states[0].capabilityRoles).toContainEqual({ capability: 'view', roleId });
});

test('unsaved node forms guard browser history and permission revocation prevents the pending edit', async ({ page }) => {
  const { manager, graph } = await fixture(); await login(page, manager); await page.goto('/workflow_management');
  await page.getByRole('link', { name: 'Flow', exact: true }).click(); await expect(page).toHaveURL(new RegExp(`/workflow_management/${graph.workflowId}$`));
  await addNode(page, 'Protected');
  await page.getByRole('button', { name: 'Edit Protected', exact: true }).click(); await dialog(page).getByRole('textbox', { name: /^Name/ }).fill('Unsaved');
  const refused = new Promise((resolve) => page.once('dialog', async (question) => { await question.dismiss(); resolve(); }));
  await page.evaluate(() => window.history.back()); await refused; await expect(dialog(page)).toBeVisible();
  await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_code=$3', [manager.organizationId, manager.roleId, 'workflows.manage']);
  await dialog(page).getByRole('button', { name: 'Save Node' }).click(); await expect(dialog(page).getByRole('alert')).toBeVisible();
  expect((await owner.query('SELECT name FROM workflow_states WHERE organization_id=$1 AND workflow_version_id=$2', [manager.organizationId, graph.versionId])).rows).toEqual([{ name: 'Protected' }]);
});

test('workflow readers have no node or publication controls and another tenant cannot open the editor', async ({ page }) => {
  const { manager, graph } = await fixture(); const reader = await account({ organizationId: manager.organizationId, permissions: ['workflows.read'] });
  const foreign = await account({ permissions: ['workflows.manage'] });
  await work(manager, (client, identity) => saveWorkflowState(client, identity, graph.versionId, 1, { code: 'read', name: 'Reader node' }));
  await login(page, reader); await page.goto(`/workflow_management/${graph.workflowId}`); await expect(page.locator('.workflow-node')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Add Node', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Edit Reader node', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save Flow', exact: true })).toHaveCount(0);
  await login(page, foreign); await page.goto(`/workflow_management/${graph.workflowId}`); await expect(page.getByRole('alert').filter({ hasText: 'Workflow was not found' })).toBeVisible();
  await expect(page.locator('.workflow-node')).toHaveCount(0);
});

test('a confirmed save can finish its authorized read after management access is removed', async ({ page }) => {
  const { manager, graph } = await fixture(['workflows.manage', 'workflows.read']);
  await login(page, manager); await page.goto(`/workflow_management/${graph.workflowId}`); await addNode(page, 'Permission change');
  await page.getByRole('button', { name: 'Edit Permission change', exact: true }).click();
  await dialog(page).getByRole('textbox', { name: /^Name/ }).fill('Saved before access changed');
  let commands = 0; let failRead = true;
  await page.route(`**/api/workflows/${graph.workflowId}/commands`, async (route) => { commands++; await route.continue(); });
  await page.route(`**/api/workflows/${graph.workflowId}/definition*`, async (route) => {
    if (failRead) { failRead = false; await route.fulfill({ status: 503, json: { error: { message: 'Synthetic read failure' } } }); }
    else await route.continue();
  });
  await dialog(page).getByRole('button', { name: 'Save Node' }).click(); await expect(dialog(page).getByRole('button', { name: 'Retry Reload' })).toBeVisible();
  await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_code=$3', [manager.organizationId, manager.roleId, 'workflows.manage']);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: 'Add Node', exact: true })).toHaveCount(0); await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Retry Reload' }).click(); await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('.workflow-node')).toContainText('Saved before access changed'); expect(commands).toBe(1);
  await expect(page.getByRole('button', { name: 'Save Flow', exact: true })).toHaveCount(0);
});

test('node dialogs fit narrow phones with 500 selected roles and retain all selections', async ({ page }) => {
  const { manager, graph } = await fixture();
  const roles = (await owner.query(`INSERT INTO roles(organization_id,id,name)
    SELECT $1,gen_random_uuid(),'Mobile selected role '||lpad(n::text,4,'0') FROM generate_series(1,500) n RETURNING id`, [manager.organizationId])).rows.map((row) => row.id);
  const created = await work(manager, (client, identity) => saveWorkflowState(client, identity, graph.versionId, 1,
    { code: 'mobile', name: 'Mobile node', stateType: 'initial', canvasX: 120, canvasY: 120, accessRoleIds: roles }));
  await login(page, manager); await page.goto(`/workflow_management/${graph.workflowId}`);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 }); await expect(page.locator('.lims-main')).toHaveCSS('margin-left', '0px');
    await page.getByRole('button', { name: 'Edit Mobile node', exact: true }).click();
    await expect(dialog(page).getByRole('combobox', { name: 'Access Roles', exact: true })).toBeEnabled();
    const body = dialog(page).locator('.modal-body');
    const geometry = await body.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return { width: element.clientWidth, scrollWidth: element.scrollWidth,
        overflowing: [...element.querySelectorAll('*')].filter((child) => child.getBoundingClientRect().right > bounds.right + 1)
          .slice(0, 8).map((child) => ({ tag: child.tagName, className: String(child.className), width: child.getBoundingClientRect().width })) };
    });
    expect(geometry.scrollWidth, JSON.stringify({ viewport: width, ...geometry })).toBeLessThanOrEqual(geometry.width + 1);
    await dialog(page).getByRole('combobox', { name: 'Access Roles', exact: true }).scrollIntoViewIfNeeded();
    await expect(dialog(page)).toContainText('+498 more');
    await dialog(page).screenshot({ path: `.local/m04-workflow-node-mobile-permissions-${width}.png`, animations: 'disabled' });
    await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(dialog(page)).toHaveCount(0);
  }
  const current = await load(manager, graph.versionId); expect(current.version.revision).toBe(created.revision);
  expect(current.states[0].capabilityRoles.filter((role) => role.capability === 'view')).toHaveLength(500);
});
