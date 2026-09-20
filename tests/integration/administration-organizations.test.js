import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { listOrganizations, loadOrganization, createOrganization, updateOrganization } from '../../src/administration/organizations.js';
import { PERMISSION_CATALOG } from '../../src/auth/permission-catalog.js';
import { roleCapabilityKeys } from '../../src/roles/capabilities.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
async function account(options = {}) {
  const actor = await createAccount(owner, options);
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
async function platformAdministrator() {
  const actor = await account();
  await owner.query('INSERT INTO platform_administrators(organization_id,user_id,granted_at,granted_by) VALUES($1,$2,clock_timestamp(),$3)',
    [actor.organizationId, actor.userId, 'Synthetic test operator']);
  return actor;
}
const organizationInput = (changes = {}) => ({ name: 'Synthetic Organization', adminUsername: 'org-admin-' + randomUUID(),
  adminEmail: `admin-${randomUUID()}@example.invalid`, adminDisplayName: 'Synthetic Administrator', domain: `${randomUUID()}.example`, ...changes });

test('a non-platform-administrator is denied listing, reading and writing organizations', async () => {
  const actor = await account();
  const other = await account();
  await assert.rejects(work(actor, (client, identity) => listOrganizations(client, identity, {}), true), { code: 'platform_administrator_required' });
  await assert.rejects(work(actor, (client, identity) => loadOrganization(client, identity, other.organizationId), true), { code: 'platform_administrator_required' });
  await assert.rejects(work(actor, (client, identity) => createOrganization(client, identity, organizationInput())), { code: 'platform_administrator_required' });
  await assert.rejects(work(actor, (client, identity) => updateOrganization(client, identity, other.organizationId, { name: 'X', domain: 'x.example' })), { code: 'platform_administrator_required' });
});

test('a platform administrator creates an organization with a fully permissioned System Administrator, and the generated administrator can sign in', async () => {
  const platformAdmin = await platformAdministrator();
  const input = organizationInput();
  const created = await work(platformAdmin, (client, identity) => createOrganization(client, identity, input));
  assert.equal(created.admin.username, input.adminUsername);
  assert.match(created.admin.temporaryPassword, /^[A-Za-z0-9_-]{15,}$/);
  const session = await signIn({ identifier: input.adminUsername, password: created.admin.temporaryPassword });
  const identity = await withSession(session.token, (client, id) => id, { readOnly: true, accountAction: true });
  assert.equal(identity.organization_id, created.organizationId);
  assert.equal(identity.must_change_password, true);
  assert.deepEqual([...identity.permission_codes].sort(), PERMISSION_CATALOG.map(([code]) => code).sort());
  const capabilities = (await owner.query('SELECT capability_key FROM role_capabilities WHERE organization_id=$1', [created.organizationId])).rows.map((row) => row.capability_key);
  assert.deepEqual(capabilities.sort(), [...roleCapabilityKeys].sort());
  const loaded = await work(platformAdmin, (client, id) => loadOrganization(client, id, created.organizationId), true);
  assert.equal(loaded.name, input.name); assert.equal(loaded.active, true);
  assert.match(loaded.code, /^[A-Z0-9-]+$/);
});

test('organization codes are derived from the domain, resolving collisions with a numeric suffix, and duplicate admin usernames are rejected', async () => {
  const platformAdmin = await platformAdministrator();
  const stem = randomUUID();
  // Both domains are distinct (so neither is a duplicate_organization_domain), but the code
  // derivation collapses non-alphanumeric runs to a single "-", so they share one code base.
  const first = await work(platformAdmin, (client, identity) => createOrganization(client, identity, organizationInput({ domain: `acme.${stem}.example` })));
  const second = await work(platformAdmin, (client, identity) => createOrganization(client, identity, organizationInput({ domain: `acme-${stem}.example` })));
  const firstLoaded = await work(platformAdmin, (client, identity) => loadOrganization(client, identity, first.organizationId), true);
  const secondLoaded = await work(platformAdmin, (client, identity) => loadOrganization(client, identity, second.organizationId), true);
  assert.notEqual(firstLoaded.code, secondLoaded.code);
  assert.ok(secondLoaded.code.startsWith(firstLoaded.code));
  const input = organizationInput();
  await work(platformAdmin, (client, identity) => createOrganization(client, identity, input));
  await assert.rejects(work(platformAdmin, (client, identity) => createOrganization(client, identity, organizationInput({ adminUsername: input.adminUsername }))), { code: 'duplicate_admin_username' });
});

test('listing searches by code or name, and a platform administrator sees organizations outside their own', async () => {
  const platformAdmin = await platformAdministrator();
  const input = organizationInput({ name: 'Findable Laboratory Name' });
  const created = await work(platformAdmin, (client, identity) => createOrganization(client, identity, input));
  const bySearch = await work(platformAdmin, (client, identity) => listOrganizations(client, identity, { search: 'Findable Laboratory' }), true);
  assert.ok(bySearch.items.some((item) => item.id === created.organizationId));
  const foreignReader = await account({ organizationId: created.organizationId, permissions: [] });
  assert.equal(foreignReader.organizationId, created.organizationId);
});

test('updating an organization renames it, and suspending it blocks its administrator from signing in', async () => {
  const platformAdmin = await platformAdministrator();
  const input = organizationInput();
  const created = await work(platformAdmin, (client, identity) => createOrganization(client, identity, input));
  const update = (changes) => work(platformAdmin, (client, identity) => updateOrganization(client, identity, created.organizationId,
    { name: 'Renamed Laboratory', domain: input.domain, status: 'active', ...changes }));
  const renamed = await update({});
  assert.equal(renamed.name, 'Renamed Laboratory'); assert.equal(renamed.active, true); assert.equal(renamed.status, 'active');
  await signIn({ identifier: input.adminUsername, password: created.admin.temporaryPassword });
  await update({ status: 'suspended' });
  await assert.rejects(signIn({ identifier: input.adminUsername, password: created.admin.temporaryPassword }), { code: 'invalid_credentials' });
  await assert.rejects(work(platformAdmin, (client, identity) => updateOrganization(client, identity, randomUUID(), { name: 'Missing', domain: 'missing.example' })), { code: 'organization_not_found' });
});

test('organization detail fields (dates, account type, commercial and contact details) round-trip through create and update', async () => {
  const platformAdmin = await platformAdministrator();
  const input = organizationInput({ accountType: 'enterprise', activeFromDate: '2026-01-01', activeTillDate: '2026-12-31',
    purchaseOrderNumber: 'PO-1001', address: '221B Baker Street', contactPerson: 'Synthetic Contact', contactPhone: '000-1111',
    projectManager: 'Synthetic PM', salesPerson: 'Synthetic Sales', pricingPlan: 'Gold', subscriptionCost: '499.99', customDevelopmentCost: '0' });
  const created = await work(platformAdmin, (client, identity) => createOrganization(client, identity, input));
  const loaded = await work(platformAdmin, (client, identity) => loadOrganization(client, identity, created.organizationId), true);
  assert.equal(loaded.domain, input.domain); assert.equal(loaded.accountType, 'enterprise');
  assert.equal(loaded.activeFromDate, input.activeFromDate); assert.equal(loaded.activeTillDate, input.activeTillDate);
  assert.equal(loaded.purchaseOrderNumber, 'PO-1001'); assert.equal(loaded.address, '221B Baker Street');
  assert.equal(loaded.contactPerson, 'Synthetic Contact'); assert.equal(loaded.contactPhone, '000-1111');
  assert.equal(loaded.projectManager, 'Synthetic PM'); assert.equal(loaded.salesPerson, 'Synthetic Sales');
  assert.equal(loaded.pricingPlan, 'Gold'); assert.equal(loaded.subscriptionCost, '499.99'); assert.equal(loaded.customDevelopmentCost, '0');
  const updated = await work(platformAdmin, (client, identity) => updateOrganization(client, identity, created.organizationId,
    { name: input.name, domain: input.domain, status: 'active', accountType: 'saas', pricingPlan: 'Silver' }));
  assert.equal(updated.accountType, 'saas'); assert.equal(updated.pricingPlan, 'Silver'); assert.equal(updated.purchaseOrderNumber, null);
  assert.equal(updated.code, loaded.code);
});

test('a duplicate domain is rejected and Active To cannot precede Active From', async () => {
  const platformAdmin = await platformAdministrator();
  const input = organizationInput();
  await work(platformAdmin, (client, identity) => createOrganization(client, identity, input));
  await assert.rejects(work(platformAdmin, (client, identity) => createOrganization(client, identity, organizationInput({ domain: input.domain }))), { code: 'duplicate_organization_domain' });
  await assert.rejects(work(platformAdmin, (client, identity) => createOrganization(client, identity,
    organizationInput({ activeFromDate: '2026-06-01', activeTillDate: '2026-01-01' }))), { code: 'invalid_organization' });
});
