import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { listDynamicApis, getDynamicApi, createDynamicApi, updateDynamicApiDraft, publishDynamicApi,
  listDynamicApiTokens, createDynamicApiToken, revokeDynamicApiToken, testRunDynamicApi, listDynamicApiInvocations, invokeDynamicApi } from '../../src/dynamic-apis/service.js';

const owner = ownerPool(); let manager; let reader; let outsider;
const work = (action, user = manager) => withSession(user.token, action, { csrfToken: user.csrfToken });
before(async () => {
  const account = async (options = {}) => {
    const user = await createAccount(owner, options);
    return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  };
  manager = await account({ permissions: ['dynamic_apis.manage'] });
  reader = await account({ organizationId: manager.organizationId, permissions: ['dynamic_apis.read'] });
  outsider = await account({ permissions: ['dynamic_apis.manage'] });
});
after(async () => { await closePool(); await owner.end(); });

async function customer(organizationId, name) {
  const id = randomUUID();
  await owner.query('INSERT INTO customers(organization_id,id,code,name,legal_name) VALUES($1,$2,$3,$4,$4)', [organizationId, id, id, name]);
  return id;
}
async function api(overrides = {}) {
  return work((client, identity) => createDynamicApi(client, identity, {
    name: 'Synthetic API', urlKey: `synthetic-${randomUUID()}`, httpMethod: 'GET', draftCode: 'return { ok: true };', enabled: true, ...overrides,
  }));
}
const draftFields = ({ name, urlKey, httpMethod, draftCode, enabled }) => ({ name, urlKey, httpMethod, draftCode, enabled });

test('a dynamic API can be created, listed and fetched, but only with dynamic_apis.manage', async () => {
  const created = await api();
  assert.equal(created.enabled, true); assert.equal(created.liveCode, null); assert.equal(created.revision, 1);
  const listed = await work((client, identity) => listDynamicApis(client, identity), reader);
  assert(listed.items.some((item) => item.id === created.id));
  await assert.rejects(work((client, identity) => createDynamicApi(client, identity, { name: 'x', urlKey: 'x', httpMethod: 'GET', draftCode: 'return 1;' }), reader), { code: 'forbidden' });
  await assert.rejects(work((client, identity) => getDynamicApi(client, identity, created.id), outsider), { code: 'dynamic_api_not_found' });
});

test('a duplicate url key and method within the same organization is rejected', async () => {
  const urlKey = `dup-${randomUUID()}`;
  await api({ urlKey });
  await assert.rejects(api({ urlKey }), { code: 'dynamic_api_route_exists' });
  const otherMethod = await api({ urlKey, httpMethod: 'POST' });
  assert.equal(otherMethod.urlKey, urlKey);
});

test('a malformed url key or unsupported method is rejected', async () => {
  await assert.rejects(api({ urlKey: 'Not Valid!' }), { code: 'invalid_url_key' });
  await assert.rejects(api({ httpMethod: 'TRACE' }), { code: 'invalid_http_method' });
});

test('updating a draft enforces optimistic concurrency and publishing copies the draft into live code', async () => {
  const created = await api({ draftCode: 'return { version: 1 };' });
  await assert.rejects(work((client, identity) => updateDynamicApiDraft(client, identity, created.id, { ...draftFields(created), revision: created.revision + 1, draftCode: 'return { version: 2 };' })),
    { code: 'dynamic_api_changed' });
  const updated = await work((client, identity) => updateDynamicApiDraft(client, identity, created.id, { ...draftFields(created), revision: created.revision, draftCode: 'return { version: 2 };' }));
  assert.equal(updated.revision, 2); assert.equal(updated.liveCode, null);
  const published = await work((client, identity) => publishDynamicApi(client, identity, created.id, updated.revision));
  assert.equal(published.liveCode, 'return { version: 2 };'); assert.ok(published.publishedAt);
  await assert.rejects(work((client, identity) => publishDynamicApi(client, identity, created.id, updated.revision)), { code: 'dynamic_api_changed' });
});

test('a token is returned once at creation, never leaks its raw value on listing, and can be revoked', async () => {
  const created = await api();
  const token = await work((client, identity) => createDynamicApiToken(client, identity, created.id, { label: 'Synthetic token' }));
  assert.match(token.token, /^dak_[0-9a-f]{64}$/);
  const listed = await work((client, identity) => listDynamicApiTokens(client, identity, created.id));
  assert.equal(listed.items.length, 1); assert.equal(listed.items[0].token, undefined); assert.equal(listed.items[0].revokedAt, null);
  const revoked = await work((client, identity) => revokeDynamicApiToken(client, identity, created.id, token.id));
  assert.ok(revoked.revokedAt);
  await assert.rejects(work((client, identity) => revokeDynamicApiToken(client, identity, created.id, token.id)), { code: 'token_not_found' });
});

test('a test run executes the draft code in the sandbox and records the invocation', async () => {
  const created = await api({ draftCode: 'console.log("running"); return { doubled: input.value * 2 };' });
  const result = await work((client, identity) => testRunDynamicApi(client, identity, created.id, { input: { value: 21 } }));
  assert.deepEqual(result.result, { doubled: 42 });
  assert.match(result.logs, /running/);
  const invocations = await work((client, identity) => listDynamicApiInvocations(client, identity, created.id));
  assert.equal(invocations.items.length, 1); assert.equal(invocations.items[0].isTestRun, true); assert.equal(invocations.items[0].status, 'succeeded');
});

test('a test run that throws is reported as failed and still recorded', async () => {
  const created = await api({ draftCode: 'throw new Error("synthetic failure");' });
  await assert.rejects(work((client, identity) => testRunDynamicApi(client, identity, created.id, {})), { code: 'dynamic_api_execution_failed' });
  const invocations = await work((client, identity) => listDynamicApiInvocations(client, identity, created.id));
  assert.equal(invocations.items[0].status, 'failed'); assert.match(invocations.items[0].errorMessage, /synthetic failure/);
});

test('the live bearer-token dispatch path enforces method/url match, enabled state, publication, and tenant-scoped queries', async () => {
  const created = await api({ draftCode: 'return await api.query("customers", { limit: 10 });' });
  const ownName = `Synthetic Own ${randomUUID()}`; const foreignName = `Synthetic Foreign ${randomUUID()}`;
  await customer(manager.organizationId, ownName);
  await customer(outsider.organizationId, foreignName);

  const token = await work((client, identity) => createDynamicApiToken(client, identity, created.id, { label: 'Live token' }));
  await assert.rejects((async () => { const c = await owner.connect(); try { return await invokeDynamicApi(c, token.token, 'GET', created.urlKey, {}); } finally { c.release(); } })(),
    { code: 'dynamic_api_not_published' });

  const published = await work((client, identity) => publishDynamicApi(client, identity, created.id, created.revision));
  const invoke = async (rawToken, method, urlKey) => { const c = await owner.connect(); try { return await invokeDynamicApi(c, rawToken, method, urlKey, {}); } finally { c.release(); } };

  const result = await invoke(token.token, 'GET', published.urlKey);
  assert.deepEqual(result.map((row) => row.name), [ownName]);

  await assert.rejects(invoke(token.token, 'POST', published.urlKey), { code: 'dynamic_api_not_found' });
  await assert.rejects(invoke(token.token, 'GET', 'not-a-real-key'), { code: 'dynamic_api_not_found' });
  await assert.rejects(invoke('not-a-real-token', 'GET', published.urlKey), { code: 'invalid_token' });

  await work((client, identity) => revokeDynamicApiToken(client, identity, created.id, token.id));
  await assert.rejects(invoke(token.token, 'GET', published.urlKey), { code: 'invalid_token' });

  const secondToken = await work((client, identity) => createDynamicApiToken(client, identity, created.id, { label: 'Second' }));
  await work((client, identity) => updateDynamicApiDraft(client, identity, created.id, { ...draftFields(published), revision: published.revision, enabled: false }));
  await assert.rejects(invoke(secondToken.token, 'GET', published.urlKey), { code: 'dynamic_api_disabled' });

  const invocations = await work((client, identity) => listDynamicApiInvocations(client, identity, created.id));
  assert.ok(invocations.items.some((item) => item.isTestRun === false && item.status === 'succeeded'));
});

test('the sandbox rejects a request to an unknown resource', async () => {
  const created = await api({ draftCode: 'return await api.query("secrets", {});' });
  await assert.rejects(work((client, identity) => testRunDynamicApi(client, identity, created.id, {})), { code: 'dynamic_api_execution_failed' });
});
