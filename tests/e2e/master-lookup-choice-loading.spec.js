import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';
import { saveLookupSourceObservation } from '../../src/custom-fields/lookup-sources.js';
import { saveProduct, loadProduct } from '../../src/masters/products.js';
import { saveTestParameter, loadTestParameter } from '../../src/masters/test-parameters.js';

let owner; test.beforeAll(() => { owner = ownerPool(); }); test.afterAll(async () => { await closePool(); await owner.end(); });
const apis = { product: { save: saveProduct, load: loadProduct, resource: 'products', page: 'products' },
  parameter: { save: saveTestParameter, load: loadTestParameter, resource: 'test-parameters', page: 'test_parameters' } };
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
const lines = [{ id: 'original-A', label: 'Current Alpha' }, { id: 'original-B', label: 'Current Beta' }, { id: 'original-C', label: 'Current Gamma' }];
async function fixture(page, kind) {
  const author = await createAccount(owner, { permissions: ['masters.manage'] });
  author.token = (await signIn({ identifier: author.username, password: author.password })).token;
  const manager = await createAccount(owner, { organizationId: author.organizationId, permissions: ['masters.manage'] });
  manager.token = (await signIn({ identifier: manager.username, password: manager.password })).token;
  const source = { id: randomUUID(), requestId: randomUUID(), revision: 0, sourceId: 'Original-' + randomUUID(), name: 'Shared master choices',
    lines: lines.map(line => ({ ...line, label: line.label.replace('Current', 'Captured') })) };
  await work(author, (c, i) => saveLookupSourceObservation(c, i, source)); let sourceRevision = 1;
  const observe = async choices => {
    const result = await work(author, (c, i) => saveLookupSourceObservation(c, i, { ...source, requestId: randomUUID(), revision: sourceRevision, lines: choices }));
    sourceRevision = result.revision; return result;
  };
  const fields = [];
  for (const [key, label, fieldType, extra] of [['single', 'Single location', 'lookup', {}], ['multiple', 'Multiple locations', 'lookup', { allowsMultiple: true }], ['note', 'Lookup note', 'text', {}]]) {
    fields.push(await work(author, (c, i) => saveCustomField(c, i, { id: randomUUID(), requestId: randomUUID(), revision: 0, key, label, fieldType,
      associatedWith: kind, displayOrder: fields.length, ...(fieldType === 'lookup' ? { lookupSourceId: source.id } : {}), ...extra })));
  }
  const api = apis[kind]; const id = randomUUID();
  await work(manager, (c, i) => api.save(c, i, { id, requestId: randomUUID(), revision: 0, name: 'Lookup form master', key: randomUUID(),
    ...(kind === 'parameter' ? { schemeAbbreviation: 'Lookup' } : {}),
    customFields: fields.map((field, index) => ({ fieldId: field.id, fieldRevision: 1, value: index === 0 ? 'original-A' : index === 1 ? ['original-A', 'original-A', 'original-B'] : 'Saved note' })) }));
  await observe(lines);
  await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(manager.username);
  await page.getByLabel('Password', { exact: true }).fill(manager.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/me$/);
  return { kind, api, author, manager, fields, source, observe, id, url: `/${api.page}/${id}/edit`,
    lookupPath: `/api/masters/${api.resource}/custom-fields/lookup-options`,
    read: atRevision => work(manager, (c, i) => api.load(c, i, id, { atRevision }), true) };
}
const group = (page, label) => page.locator('.smplfy-form-field').filter({ has: page.getByLabel(label, { exact: true }) });
const byKey = record => new Map(record.customFields.map(field => [field.key, field]));
const focus = page => page.evaluate(() => window.dispatchEvent(new Event('focus')));
async function edit(page, f) { await page.goto(f.url); await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeEnabled(); }
async function refresh(page, f) {
  const response = page.waitForResponse(result => new URL(result.url()).pathname === f.lookupPath);
  await focus(page); await response;
}
for (const kind of ['product', 'parameter']) test(`${kind} configured catalogs use complete filtered bulk choices and preserve frozen labels`, async ({ page }, info) => {
  const f = await fixture(page, kind); const requests = [];
  page.on('request', request => { if (new URL(request.url()).pathname === f.lookupPath) requests.push(new URL(request.url()).searchParams); });
  await page.goto(f.url); await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeEnabled();
  await expect(group(page, 'Single location').getByText('Current Alpha', { exact: true })).toBeVisible();
  expect(requests.length).toBe(1); expect(requests[0].get('sourceId')).toBe(f.source.id);
  await page.getByLabel('Multiple locations', { exact: true }).fill('Gamma');
  await expect(page.getByRole('option', { name: 'Current Gamma', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Current Alpha', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Select visible', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Clear all (4)', exact: true })).toBeVisible();
  await page.getByLabel('Single location', { exact: true }).fill('Beta'); await page.getByRole('option', { name: 'Current Beta', exact: true }).click();
  await page.getByLabel('Lookup note', { exact: true }).fill('Saved through full master catalog');
  await page.screenshot({ path: info.outputPath(`${kind}-lookup-bulk.png`), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page).toHaveURL(new RegExp(`/${f.api.page}(?:\\?|$)`));
  const saved = byKey(await f.read()); expect(saved.get('single').value).toBe('original-B');
  expect(saved.get('multiple').value).toEqual(['original-A', 'original-A', 'original-B', 'original-C']);
  expect(saved.get('multiple').displayValue).toBe('Current Alpha, Current Alpha, Current Beta, Current Gamma');
  expect(byKey(await f.read(1)).get('multiple').displayValue).toBe('Captured Alpha, Captured Alpha, Captured Beta');
});

for (const kind of ['product', 'parameter']) {
  test(`${kind} 500-field HTTP captures fit the supported bound and oversized requests preserve history`, async ({ page }, info) => {
    test.setTimeout(90_000);
    const f = await fixture(page, kind);
    const choices = Array.from({ length: 10 }, (_, index) => ({ id: `http-original-${index}`.padEnd(80, 'v'), label: `HTTP choice ${index}` }));
    await f.observe([...lines, ...choices]);
    await work(f.author, async (c, i) => {
      for (let index = 3; index < 500; index++) f.fields.push(await saveCustomField(c, i, {
        id: randomUUID(), revision: 0, requestId: randomUUID(), associatedWith: kind, fieldType: 'lookup',
        key: `http_lookup_${index}`, label: `HTTP lookup ${index}`, displayOrder: index,
        lookupSourceId: f.source.id, allowsMultiple: true,
      }));
    });
    const command = { id: f.id, revision: 1, requestId: randomUUID(), name: 'Large HTTP lookup capture', key: randomUUID(),
      ...(kind === 'parameter' ? { schemeAbbreviation: 'HTTP_Lookup' } : {}),
      customFields: f.fields.map((field, index) => ({ fieldId: field.id, fieldRevision: 1,
        value: index === 0 ? 'original-A' : index === 1 ? ['original-A', 'original-A', 'original-B']
          : index === 2 ? 'Saved note' : choices.map(choice => choice.id) })) };
    const bytes = Buffer.byteLength(JSON.stringify(command)); expect(bytes).toBeGreaterThan(256 * 1024); expect(bytes).toBeLessThan(8 * 1_048_576);
    const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'sampleify_csrf').value;
    const headers = { Origin: 'http://127.0.0.1:3100', 'X-CSRF-Token': csrf };
    const response = await page.request.post(`/api/masters/${f.api.resource}`, { headers, data: command });
    const current = await f.read();
    await info.attach('master-http-payload', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
      kind, fieldCount: command.customFields.length, itemCount: 4975, requestBytes: bytes, status: response.status(), currentRevision: current.revision,
    })) });
    expect(response.status()).toBe(200); const saved = await response.json();
    expect(saved.revision).toBe(2); expect(saved.customFields).toHaveLength(500); expect(current.customFields).toEqual(saved.customFields);
    for (const field of saved.customFields.slice(3)) {
      expect(field.value).toEqual(choices.map(choice => choice.id)); expect(field.displayValue).toBe(choices.map(choice => choice.label).join(', '));
      expect(field.items.every(item => item.lookupSourceId === f.source.id && item.lookupRevision === 3)).toBe(true);
    }
    expect(byKey(await f.read(1)).get('single').displayValue).toBe('Captured Alpha');
    const oversized = await page.request.post(`/api/masters/${f.api.resource}`, { headers,
      data: { ...command, requestId: randomUUID(), revision: 2, description: 'x'.repeat(8 * 1_048_576) } });
    expect(oversized.status()).toBe(413); expect((await oversized.json()).error.code).toBe('input_too_large');
    expect((await f.read()).revision).toBe(2); expect((await f.read(2)).customFields).toEqual(saved.customFields);
  });

  test(`${kind} refresh keeps lookup drafts by key across replacement and resets a renamed key`, async ({ page }) => {
    const f = await fixture(page, kind); await edit(page, f);
    await page.getByLabel('Lookup note', { exact: true }).fill('Unsaved note');
    await page.getByLabel('Single location', { exact: true }).fill('Beta'); await page.getByRole('option', { name: 'Current Beta', exact: true }).click();
    await work(f.author, (c, i) => retireCustomField(c, i, { id: f.fields[0].id, revision: 1, requestId: randomUUID() }));
    const definition = { id: randomUUID(), revision: 0, requestId: randomUUID(), associatedWith: kind, key: 'single', label: 'Single location',
      fieldType: 'lookup', lookupSourceId: f.source.id, displayOrder: 0 };
    const replacement = await work(f.author, (c, i) => saveCustomField(c, i, definition)); await refresh(page, f);
    await expect(page.getByLabel('Single location', { exact: true })).toHaveAttribute('id', `${kind}-custom-field-${replacement.id}`);
    await expect(group(page, 'Single location').getByText('Current Beta', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Lookup note', { exact: true })).toHaveValue('Unsaved note');
    await work(f.author, (c, i) => saveCustomField(c, i, { ...definition, revision: 1, requestId: randomUUID(), key: 'renamed' })); await refresh(page, f);
    await expect(group(page, 'Single location').getByText('Current Beta', { exact: true })).toHaveCount(0);
    await expect(group(page, 'Single location').getByText('Select Single location', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page).toHaveURL(new RegExp(`/${f.api.page}(?:\\?|$)`));
    const saved = byKey(await f.read()); expect(saved.has('single')).toBe(false); expect(saved.get('renamed').value).toBe('');
    expect(saved.get('note').value).toBe('Unsaved note'); expect(byKey(await f.read(1)).get('single').value).toBe('original-A');
  });

  test(`${kind} catalog failures keep drafts and Retry handles source clearing and reappearance`, async ({ page }) => {
    const f = await fixture(page, kind); const match = `**${f.lookupPath}?*`;
    const fail = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic catalog failure' } }) });
    await page.route(match, fail); await page.goto(f.url);
    await expect(page.getByRole('alert').filter({ hasText: 'Synthetic catalog failure' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
    await page.getByLabel(kind === 'product' ? 'Name' : 'Parameter Name', { exact: true }).fill('Name kept through Retry');
    await page.unroute(match, fail); await page.getByRole('button', { name: 'Retry loading fields', exact: true }).click();
    await expect(group(page, 'Single location').getByText('Current Alpha', { exact: true })).toBeVisible();
    await page.getByLabel('Lookup note', { exact: true }).fill('Note kept through refresh failure');
    await page.route(match, fail); await refresh(page, f);
    await expect(page.getByRole('alert').filter({ hasText: 'Synthetic catalog failure' })).toBeVisible();
    await expect(page.getByLabel('Lookup note', { exact: true })).toHaveValue('Note kept through refresh failure');
    await expect(group(page, 'Single location').getByText('Current Alpha', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
    await f.observe([]); await page.unroute(match, fail); await page.getByRole('button', { name: 'Retry loading fields', exact: true }).click();
    await expect(group(page, 'Single location').getByText('original-A', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page).toHaveURL(new RegExp(`/${f.api.page}(?:\\?|$)`));
    const saved = byKey(await f.read()); expect(saved.get('single').value).toBe('original-A'); expect(saved.get('single').items[0].lookupSourceId).toBeNull();
    expect(saved.get('note').value).toBe('Note kept through refresh failure');
    await f.observe(lines); await edit(page, f); await expect(group(page, 'Single location').getByText('Current Alpha', { exact: true })).toBeVisible();
    await expect(page.getByLabel(kind === 'product' ? 'Name' : 'Parameter Name', { exact: true })).toHaveValue('Name kept through Retry');
    await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page).toHaveURL(new RegExp(`/${f.api.page}(?:\\?|$)`));
    expect(byKey(await f.read()).get('single').items[0].lookupRevision).toBe(4);
  });

  test(`${kind} an unknown save result retains the exact request through later source changes`, async ({ page }) => {
    const f = await fixture(page, kind); await edit(page, f); const commands = [];
    await page.getByLabel('Lookup note', { exact: true }).fill('Exact authored lookup save');
    const savePath = `/api/masters/${f.api.resource}`;
    const lose = async route => {
      if (route.request().method() !== 'POST') return route.continue();
      commands.push(route.request().postDataJSON()); const response = await route.fetch(); expect(response.status()).toBe(200);
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic lost lookup save response' } }) });
    };
    await page.route(`**${savePath}`, lose); await page.getByRole('button', { name: 'Update', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Synthetic lost lookup save response' })).toBeVisible();
    await f.observe([]);
    await page.unroute(`**${savePath}`, lose); await page.route(`**${savePath}`, async route => {
      if (route.request().method() === 'POST') commands.push(route.request().postDataJSON()); await route.continue();
    });
    let refreshed = 0; page.on('request', request => { if (new URL(request.url()).pathname === f.lookupPath) refreshed++; });
    await focus(page); await page.getByRole('button', { name: 'Update', exact: true }).click(); await expect(page).toHaveURL(new RegExp(`/${f.api.page}(?:\\?|$)`));
    expect(refreshed).toBe(0); expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0]);
    const result = await f.read(); expect(result.revision).toBe(2); expect(byKey(result).get('single').items[0].lookupRevision).toBe(2);
  });

  test(`${kind} a slow initial catalog completes without refresh starvation`, async ({ page }) => {
    test.setTimeout(45_000);
    const f = await fixture(page, kind); let release; const held = new Promise(resolve => { release = resolve; }); let requests = 0;
    await page.route(`**${f.lookupPath}?*`, async route => { requests++; const response = await route.fetch(); await held; await route.fulfill({ response }); });
    try {
      await page.goto(f.url); await expect.poll(() => requests).toBe(1);
      await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
      await page.waitForTimeout(11_000); expect(requests).toBe(1);
    } finally { release(); }
    await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeEnabled();
    await expect(group(page, 'Single location').getByText('Current Alpha', { exact: true })).toBeVisible();
  });

  test(`${kind} large lookup menus keep full catalogs and enforce the existing selection bound`, async ({ page }) => {
    const f = await fixture(page, kind); const choices = [...lines, ...Array.from({ length: 9997 }, (_, index) => ({ id: `large-${index}`, label: `Large choice ${index}` }))];
    choices.at(-1).label = 'Last master catalog choice'; await f.observe(choices); await edit(page, f);
    const multiple = page.getByLabel('Multiple locations', { exact: true }); await multiple.click();
    expect(await page.getByRole('option').count()).toBeLessThan(50); await multiple.press('End');
    await expect.poll(() => multiple.evaluate(input => {
      const option = document.getElementById(input.getAttribute('aria-activedescendant')); return [option?.textContent, option?.getAttribute('aria-setsize')];
    })).toEqual(['Last master catalog choice', '10000']);
    await multiple.press('Enter'); await expect(page.getByRole('button', { name: 'Clear all (4)', exact: true })).toBeVisible();
    await multiple.fill('Last master catalog choice'); await page.getByRole('button', { name: 'Select visible', exact: true }).click();
    await expect(page.getByText('Select at most 500 items.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clear all (4)', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Clear all (4)', exact: true }).click();
    await page.getByLabel('Lookup note', { exact: true }).focus(); await page.getByRole('button', { name: 'Update', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${f.api.page}(?:\\?|$)`)); expect(byKey(await f.read()).get('multiple').value).toEqual([]);
  });
}
