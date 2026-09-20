import { test, expect } from '@playwright/test';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createWorkflowCloneFixture, workflowGraphValues } from '../helpers/workflow-clones.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { cloneWorkflowDraft, patchWorkflowState } from '../../src/workflows/authoring.js';
import { loadWorkflowDefinition } from '../../src/workflows/definition.js';
import { workflowCanvasModel } from '../../src/workflows/canvas.js';

let owner;
test.beforeAll(() => { owner = ownerPool(); });
test.afterAll(async () => { await closePool(); await owner.end(); });
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { csrfToken: actor.csrfToken, readOnly });
const load = (actor, versionId) => work(actor, (client, identity) => loadWorkflowDefinition(client, identity, versionId), true);
async function fixture(draft = false) {
  const account = await createAccount(owner, { permissions: ['workflows.manage', 'workflows.read'] });
  const actor = { ...account, ...await signIn({ identifier: account.username, password: account.password }) };
  const graph = await work(actor, async (client, identity) => {
    const source = await createWorkflowCloneFixture(client, identity, { roleId: actor.roleId });
    return draft ? cloneWorkflowDraft(client, identity, source.versionId) : source;
  });
  return { actor, graph, before: await load(actor, graph.versionId) };
}
async function login(page, actor) {
  await page.context().clearCookies(); await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(actor.username); await page.getByLabel('Password', { exact: true }).fill(actor.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
const node = (page) => page.locator('.workflow-node').last();
async function start(page) {
  const title = node(page).locator('.workflow-node__title'); await title.scrollIntoViewIfNeeded();
  const box = await title.boundingBox(); const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(point.x, point.y); await page.mouse.down(); return point;
}
async function move(page, dx, dy) { const point = await start(page); await page.mouse.move(point.x + dx, point.y + dy, { steps: 4 }); await page.mouse.up(); }
async function ready(page) { await expect(page.getByRole('button', { name: 'Add Node', exact: true })).toBeEnabled(); }
async function position(page, x, y) { await expect(node(page)).toHaveCSS('left', `${x}px`); await expect(node(page)).toHaveCSS('top', `${y}px`); }
const currentVersion = (page, fallback) => new URL(page.url()).searchParams.get('versionId') ?? fallback;

test('published node gestures preview connected paths, cancel without writes and clone only on a real move', async ({ page }) => {
  const { actor, graph, before } = await fixture(); const bodies = []; const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page, actor); await page.goto(`/workflow_management/${graph.workflowId}`); await ready(page);
  await page.route(`**/api/workflows/${graph.workflowId}/commands`, async (route) => { bodies.push(route.request().postDataJSON()); await route.continue(); });
  await node(page).locator('.workflow-node__title').click(); await position(page, 20, 120);
  await node(page).locator('.workflow-node__title').click({ button: 'right' }); await page.keyboard.press('Escape');
  let point = await start(page); await page.mouse.move(point.x + 45, point.y + 35); await page.mouse.move(point.x, point.y); await page.mouse.up();
  for (const cancellation of ['Escape', 'blur', 'pointercancel', 'lostpointercapture']) {
    point = await start(page); await page.mouse.move(point.x + 80, point.y + 50); await position(page, 100, 170);
    await expect(page.getByRole('button', { name: 'Add Node', exact: true })).toBeDisabled();
    if (cancellation === 'Escape') await page.keyboard.press('Escape');
    else if (cancellation === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    else await node(page).dispatchEvent(cancellation, { pointerId: 1, bubbles: true });
    await page.mouse.up(); await position(page, 20, 120); await ready(page);
  }
  expect(bodies).toHaveLength(0); expect(workflowGraphValues(await load(actor, graph.versionId))).toEqual(workflowGraphValues(before));
  expect((await owner.query('SELECT count(*)::int count FROM workflow_versions WHERE organization_id=$1 AND workflow_id=$2', [actor.organizationId, graph.workflowId])).rows[0].count).toBe(1);
  point = await start(page); await page.mouse.move(point.x + 150, point.y + 80); await position(page, 170, 200);
  expect(bodies).toHaveLength(0);
  const preview = workflowCanvasModel(before.states.map((state, index) => index === 1 ? { ...state, canvasX: 170, canvasY: 200 } : state), before.transitions);
  await expect(page.locator('.workflow-line')).toHaveAttribute('d', preview.connections[0].path);
  await page.mouse.up(); await ready(page); await position(page, 170, 200);
  const versionId = currentVersion(page, graph.versionId); expect(versionId).not.toBe(graph.versionId);
  expect(bodies).toHaveLength(1); expect(bodies[0]).toMatchObject({ operation: 'patch_state', elementId: before.states[1].id, input: { canvasX: 170, canvasY: 200 } });
  const current = await load(actor, versionId); const expected = workflowGraphValues(before); expected.states[1].canvasX = 170; expected.states[1].canvasY = 200;
  expect(workflowGraphValues(current)).toEqual(expected); expect(workflowGraphValues(await load(actor, graph.versionId))).toEqual(workflowGraphValues(before));
  expect((await owner.query('SELECT count(*)::int count FROM workflow_editor_commands WHERE organization_id=$1 AND workflow_id=$2', [actor.organizationId, graph.workflowId])).rows[0].count).toBe(1);
  await page.reload(); await position(page, 170, 200); expect(errors).toEqual([]);
});

test('draft dragging includes scroll during a gesture, clamps bounds and preserves all hidden graph fields', async ({ page }) => {
  const { actor, graph, before } = await fixture(true);
  await work(actor, (client, identity) => patchWorkflowState(client, identity, graph.versionId, before.version.revision, before.states[1].id, { canvasX: 600, canvasY: 300 }));
  const initial = await load(actor, graph.versionId); const bodies = [];
  await login(page, actor); await page.goto(`/workflow_management/${graph.workflowId}`); await ready(page);
  await page.route(`**/api/workflows/${graph.workflowId}/commands`, async (route) => { bodies.push(route.request().postDataJSON()); await route.continue(); });
  const shell = page.getByRole('region', { name: 'Workflow canvas' });
  await shell.evaluate((element) => { element.scrollLeft = 100; element.scrollTop = 20; });
  const point = await start(page);
  const scroll = await shell.evaluate((element) => { const x = element.scrollLeft; const y = element.scrollTop;
    element.scrollLeft += 40; element.scrollTop += 30; return { x: element.scrollLeft - x, y: element.scrollTop - y }; });
  expect(scroll).toEqual({ x: 40, y: 30 });
  await page.mouse.move(point.x + 60, point.y + 20); await page.mouse.up(); await ready(page); await position(page, 700, 350);
  expect(bodies[0].input).toEqual({ canvasX: 700, canvasY: 350 });
  await shell.evaluate((element) => { element.scrollLeft = 0; element.scrollTop = 0; });
  await start(page); await page.mouse.move(0, 0, { steps: 4 }); await page.mouse.up(); await ready(page); await position(page, 8, 8);
  expect(bodies).toHaveLength(2); expect(bodies[1].input).toEqual({ canvasX: 8, canvasY: 8 });
  const current = await load(actor, graph.versionId); const expected = workflowGraphValues(initial); expected.states[1].canvasX = 8; expected.states[1].canvasY = 8;
  expect(workflowGraphValues(current)).toEqual(expected); expect(current.version.revision).toBe(initial.version.revision + 2);
});

test('drag saves recover an unknown result with the same command and a confirmed save with only a read', async ({ page }) => {
  const { actor, graph } = await fixture(true); const bodies = []; let lose = true;
  await login(page, actor); await page.goto(`/workflow_management/${graph.workflowId}`); await ready(page);
  await page.route(`**/api/workflows/${graph.workflowId}/commands`, async (route) => {
    bodies.push(route.request().postDataJSON());
    if (lose) { lose = false; await route.fetch(); await route.abort('failed'); } else await route.continue();
  });
  await move(page, 100, 50); await expect(page.getByRole('button', { name: 'Retry Save', exact: true })).toBeVisible(); await position(page, 120, 170);
  await expect(node(page)).toHaveCSS('cursor', 'default'); await expect(page.getByRole('button', { name: 'Add Node', exact: true })).toBeDisabled();
  await move(page, 50, 50); expect(bodies).toHaveLength(1); await position(page, 120, 170);
  await page.getByRole('button', { name: 'Retry Save', exact: true }).click(); await ready(page); expect(bodies[1]).toEqual(bodies[0]);
  let failRead = true;
  await page.route(`**/api/workflows/${graph.workflowId}/definition*`, async (route) => {
    if (failRead) { failRead = false; await route.fulfill({ status: 503, json: { error: { message: 'Synthetic drag read failure' } } }); } else await route.continue();
  });
  await move(page, 80, 20); await expect(page.getByRole('button', { name: 'Retry Reload', exact: true })).toBeVisible(); await position(page, 200, 190);
  expect(bodies).toHaveLength(3); await page.getByRole('button', { name: 'Retry Reload', exact: true }).click(); await ready(page);
  expect(bodies).toHaveLength(3); expect((await load(actor, graph.versionId)).states[1]).toMatchObject({ canvasX: 200, canvasY: 190 });
  expect((await owner.query('SELECT count(*)::int count FROM workflow_editor_commands WHERE organization_id=$1 AND workflow_id=$2', [actor.organizationId, graph.workflowId])).rows[0].count).toBe(2);
});

test('stale moves revert their preview and require reload before another edit', async ({ page }) => {
  const { actor, graph, before } = await fixture(true); const bodies = [];
  await login(page, actor); await page.goto(`/workflow_management/${graph.workflowId}`); await ready(page);
  await page.route(`**/api/workflows/${graph.workflowId}/commands`, async (route) => { bodies.push(route.request().postDataJSON()); await route.continue(); });
  const point = await start(page); await page.mouse.move(point.x + 60, point.y + 40);
  await work(actor, (client, identity) => patchWorkflowState(client, identity, graph.versionId, before.version.revision, before.states[1].id, { name: 'Other editor name' }));
  await page.mouse.up(); await expect(page.getByRole('button', { name: 'Reload workflow', exact: true })).toBeVisible(); await position(page, 20, 120);
  await move(page, 50, 50); expect(bodies).toHaveLength(1);
  await page.getByRole('button', { name: 'Reload workflow', exact: true }).click(); await ready(page); await expect(node(page)).toContainText('Other editor name');
  const current = await load(actor, graph.versionId); expect(current.version.revision).toBe(before.version.revision + 1);
  expect(current.states[1]).toMatchObject({ name: 'Other editor name', canvasX: 20, canvasY: null });
});

test('actual permission revocation rejects a move and a refreshed read-only view cancels an in-flight gesture', async ({ page }) => {
  for (const refresh of [false, true]) {
    const { actor, graph, before } = await fixture(true); const bodies = [];
    await login(page, actor); await page.goto(`/workflow_management/${graph.workflowId}`); await ready(page);
    await page.route(`**/api/workflows/${graph.workflowId}/commands`, async (route) => { bodies.push(route.request().postDataJSON()); await route.continue(); });
    const point = await start(page); await page.mouse.move(point.x + 90, point.y + 20); await position(page, 110, 140);
    await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_code=$3', [actor.organizationId, actor.roleId, 'workflows.manage']);
    if (refresh) {
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(page.getByRole('button', { name: 'Add Node', exact: true })).toHaveCount(0); await position(page, 20, 120);
    }
    await page.mouse.up();
    if (!refresh) await expect(page.getByRole('alert').filter({ hasText: /permission|not found/i })).toBeVisible();
    await position(page, 20, 120); expect(bodies).toHaveLength(refresh ? 0 : 1);
    expect(workflowGraphValues(await load(actor, graph.versionId))).toEqual(workflowGraphValues(before));
    await page.reload(); await expect(node(page)).toHaveCSS('cursor', 'default');
    await move(page, 50, 40); await position(page, 20, 120); expect(bodies).toHaveLength(refresh ? 0 : 1);
  }
});

test('zero-coordinate clicks, node action buttons and double-click editing never move a node', async ({ page }) => {
  const { actor, graph, before } = await fixture(); const bodies = [];
  await login(page, actor); await page.goto(`/workflow_management/${graph.workflowId}`); await ready(page);
  await page.route(`**/api/workflows/${graph.workflowId}/commands`, async (route) => { bodies.push(route.request().postDataJSON()); await route.continue(); });
  await page.locator('.workflow-node').first().click({ position: { x: 80, y: 20 } });
  await expect(page.locator('.workflow-node').first()).toHaveCSS('left', '0px');
  await node(page).locator('.workflow-node__title').dblclick();
  await expect(page.getByRole('dialog', { name: 'Node Details', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Synthetic state 1', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(bodies).toHaveLength(0); expect(workflowGraphValues(await load(actor, graph.versionId))).toEqual(workflowGraphValues(before));
});

test('an active drag guards same-document navigation and native touch moves save once on phones', async ({ page }) => {
  const { actor, graph } = await fixture(true); const bodies = [];
  await login(page, actor); await page.goto('/workflow_management'); await page.getByRole('link', { name: 'Flow', exact: true }).click(); await ready(page);
  await page.route(`**/api/workflows/${graph.workflowId}/commands`, async (route) => { bodies.push(route.request().postDataJSON()); await route.continue(); });
  const point = await start(page); await page.mouse.move(point.x + 50, point.y + 40);
  expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(true);
  await page.evaluate(() => window.history.back());
  await expect(page).toHaveURL(new RegExp(`/workflow_management/${graph.workflowId}$`));
  await page.keyboard.press('Escape'); await page.mouse.up(); await ready(page); await position(page, 20, 120); expect(bodies).toHaveLength(0);
  await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator('.lims-main')).toHaveCSS('margin-left', '0px');
  await node(page).locator('.workflow-node__title').scrollIntoViewIfNeeded(); const box = await node(page).locator('.workflow-node__title').boundingBox();
  const touch = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...touch, x: touch.x + 80, y: touch.y + 60 }] });
  await position(page, 100, 180); expect(bodies).toHaveLength(0);
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await ready(page); await position(page, 100, 180);
  expect(bodies).toHaveLength(1); expect(bodies[0].input).toEqual({ canvasX: 100, canvasY: 180 });
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: false }); await session.detach();
});
