import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';

let owner; test.beforeAll(() => { owner = ownerPool(); }); test.afterAll(async () => { await owner.end(); });
const url = '/api/users/custom-fields/user-options';
async function login(page, actor) {
  await page.context().clearCookies(); await page.goto('/login'); await page.getByLabel('Username', { exact: true }).fill(actor.username);
  await page.getByLabel('Password', { exact: true }).fill(actor.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/me$/);
}
const read = (page, query = '') => page.evaluate(async url => {
  const response = await fetch(url); return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() };
}, url + query);

test('user choices expose source-compatible current name and ID searches over real HTTP', async ({ page }) => {
  const reader = await createAccount(owner, { permissions: ['users.read'] }); const selected = await createAccount(owner, { organizationId: reader.organizationId, permissions: [] });
  const foreign = await createAccount(owner, { permissions: [] });
  await owner.query('UPDATE users SET display_name=$2,active=false WHERE id=$1', [selected.userId, ' Élodie_Straße/Åsa-\tJOSÉ ']);
  await login(page, reader);
  for (const search of ['ELODIE', 'strase', '  asa jose  ', selected.userId.toUpperCase()]) {
    expect(await read(page, '?search=' + encodeURIComponent(search))).toEqual({ status: 200, cache: 'no-store', body: { rows: [{ id: selected.userId, name: ' Élodie_Straße/Åsa-\tJOSÉ ' }], hasMore: false } });
  }
  for (const search of ['asa  jose', 'strasse', foreign.userId, '%', '@example.invalid']) expect((await read(page, '?search=' + encodeURIComponent(search))).body).toEqual({ rows: [], hasMore: false });
});

test('user choices limit results and return a late match beyond the first fixed batch', async ({ page }) => {
  const reader = await createAccount(owner, { permissions: ['users.read'] }); const prefix = randomUUID();
  const people = (await owner.query(`INSERT INTO users(id,username,email,display_name)
    SELECT ($1||'-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$2||n,$2||n||'@example.invalid',CASE WHEN n=601 THEN 'Late_HTTP_choice' ELSE 'Other person' END
    FROM generate_series(1,601) n RETURNING id,display_name AS name`, [prefix.slice(0, 8), prefix])).rows;
  await owner.query('INSERT INTO memberships(organization_id,user_id) SELECT $1,unnest($2::uuid[])', [reader.organizationId, people.map(row => row.id)]);
  await login(page, reader);
  const first = await read(page); expect(first.status).toBe(200); expect(first.body.rows).toHaveLength(50); expect(first.body.hasMore).toBe(true);
  expect((await read(page, '?search=late%20http%20choice')).body).toEqual({ rows: [people.find(row => row.name === 'Late_HTTP_choice')], hasMore: false });
});

test('user choices enforce authentication, actual permission and strict query shapes', async ({ page }) => {
  await page.goto('/login'); expect((await read(page)).status).toBe(401);
  const master = await createAccount(owner, { permissions: ['masters.manage'] }); await login(page, master); expect((await read(page)).status).toBe(403);
  const reader = await createAccount(owner, { permissions: ['users.read'] }); await login(page, reader);
  for (const query of ['?organizationId=' + randomUUID(), '?search=a&search=b', '?limit=5000', '?search=%00', '?search=' + 'x'.repeat(201)]) expect((await read(page, query)).status).toBe(400);
  expect((await read(page, '?search=' + 'x'.repeat(200))).status).toBe(200);
  await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [reader.userId]); expect((await read(page)).status).toBe(401);
});

test('server-side user filtering keeps React Select controls server-renderable before and after API calls', async ({ page }) => {
  const manager = await createAccount(owner, { permissions: ['masters.manage', 'users.manage'] });
  await owner.query('UPDATE users SET display_name=$2 WHERE id=$1', [manager.userId, 'Élodie_Straße']);
  const errors = []; page.on('pageerror', error => errors.push(error.message)); await login(page, manager);
  for (let index = 0; index < 2; index++) {
    const choices = await read(page, '?search=elodie%20strase'); expect(choices.status).toBe(200);
    expect(choices.body.rows).toEqual([{ id: manager.userId, name: 'Élodie_Straße' }]);
    const response = await page.goto('/test_parameters/new'); expect(response.status()).toBe(200);
    const html = await response.text(); expect(html).not.toContain('data-dgst='); expect(html).toContain('Lab Name');
    await expect(page.getByLabel('Lab Name', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Parameter Name', { exact: true })).toBeVisible();
  }
  expect(errors).toEqual([]);
});
