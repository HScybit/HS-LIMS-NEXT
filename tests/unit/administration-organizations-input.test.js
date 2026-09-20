import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrganizationInput, updateOrganizationInput, organizationListInput } from '../../src/administration/organizations-input.js';

const valid = () => ({ name: 'Acme Laboratory', adminUsername: 'acme.admin', adminEmail: 'admin@acme.example',
  adminDisplayName: 'Acme Administrator', domain: 'acme.example' });

test('createOrganizationInput normalizes a valid submission, defaults status/accountType/seedDemoData', () => {
  const result = createOrganizationInput(valid());
  assert.equal(result.name, 'Acme Laboratory'); assert.equal(result.adminEmail, 'admin@acme.example'); assert.equal(result.seedDemoData, false);
  assert.equal(result.domain, 'acme.example'); assert.equal(result.status, 'active'); assert.equal(result.accountType, 'saas');
  assert.equal(result.activeFromDate, null); assert.equal(result.purchaseOrderNumber, null); assert.equal(result.subscriptionCost, null);
  assert.equal(createOrganizationInput({ ...valid(), seedDemoData: true }).seedDemoData, true);
  assert.equal(Object.hasOwn(result, 'code'), false);
});

test('createOrganizationInput normalizes optional detail fields when supplied', () => {
  const result = createOrganizationInput({ ...valid(), status: 'suspended', accountType: 'enterprise', activeFromDate: '2026-01-01',
    activeTillDate: '2026-12-31', purchaseOrderNumber: 'PO-1', address: '221B Baker Street', contactPerson: 'Contact', contactPhone: '000',
    projectManager: 'PM', salesPerson: 'Sales', pricingPlan: 'Gold', subscriptionCost: '199.5', customDevelopmentCost: '0' });
  assert.equal(result.status, 'suspended'); assert.equal(result.accountType, 'enterprise');
  assert.equal(result.activeFromDate, '2026-01-01'); assert.equal(result.activeTillDate, '2026-12-31');
  assert.equal(result.purchaseOrderNumber, 'PO-1'); assert.equal(result.address, '221B Baker Street');
  assert.equal(result.contactPerson, 'Contact'); assert.equal(result.contactPhone, '000');
  assert.equal(result.projectManager, 'PM'); assert.equal(result.salesPerson, 'Sales'); assert.equal(result.pricingPlan, 'Gold');
  assert.equal(result.subscriptionCost, '199.5'); assert.equal(result.customDevelopmentCost, '0');
});

test('createOrganizationInput rejects malformed usernames, emails, domain, an explicit code and unsupported fields', () => {
  const invalid = (changes) => assert.throws(() => createOrganizationInput({ ...valid(), ...changes }), (error) => error.status === 400);
  invalid({ adminUsername: '-bad' }); invalid({ adminEmail: 'not-an-email' });
  invalid({ name: '' }); invalid({ adminDisplayName: '' }); invalid({ domain: '' });
  invalid({ status: 'deleted' }); invalid({ accountType: 'trial' });
  invalid({ activeFromDate: '2026-06-01', activeTillDate: '2026-01-01' });
  invalid({ subscriptionCost: '-1' }); invalid({ subscriptionCost: 'not-a-number' });
  invalid({ code: 'ACME-LAB' }); // the code is always derived server-side, never accepted from a caller
  assert.throws(() => createOrganizationInput({ ...valid(), extra: true }), (error) => error.status === 400);
});

test('updateOrganizationInput normalizes fields, requires domain, rejects a code, and organizationListInput bounds pagination/status', () => {
  const updated = updateOrganizationInput({ name: 'Acme', domain: 'acme.example', pricingPlan: 'Silver' });
  assert.equal(updated.name, 'Acme'); assert.equal(updated.domain, 'acme.example'); assert.equal(updated.status, 'active'); assert.equal(updated.pricingPlan, 'Silver');
  assert.equal(Object.hasOwn(updated, 'code'), false);
  assert.throws(() => updateOrganizationInput({ name: 'Acme' }), (error) => error.status === 400);
  assert.throws(() => updateOrganizationInput({ name: 'Acme', domain: 'acme.example', code: 'ACME' }), (error) => error.status === 400);
  assert.deepEqual(organizationListInput({}), { search: '', status: 'all', page: 1, pageSize: 20 });
  assert.deepEqual(organizationListInput({ search: ' acme ', status: 'active', page: 2, pageSize: 5 }), { search: 'acme', status: 'active', page: 2, pageSize: 5 });
  assert.throws(() => organizationListInput({ pageSize: 0 }), (error) => error.status === 400);
  assert.throws(() => organizationListInput({ status: 'deleted' }), (error) => error.status === 400);
});
