import test from 'node:test';
import assert from 'node:assert/strict';
import { blankOrganizationForm, organizationToForm, organizationFormPayload, validateOrganizationForm } from '../../src/administration/organization-form-model.js';

const valid = () => ({
  ...blankOrganizationForm(),
  name: 'Contoso Labs', domain: 'lab.contoso.com',
  adminUsername: 'contoso.admin', adminEmail: 'admin@contoso.com', adminDisplayName: 'Contoso Administrator',
});

test('a complete creation form reports no errors, and an edit form does not require administrator details', () => {
  assert.deepEqual(validateOrganizationForm(valid()), {});
  const withoutAdmin = { ...valid(), adminUsername: '', adminEmail: '', adminDisplayName: '' };
  assert.deepEqual(Object.keys(validateOrganizationForm(withoutAdmin)).sort(), ['adminDisplayName', 'adminEmail', 'adminUsername']);
  assert.deepEqual(validateOrganizationForm(withoutAdmin, { editing: true }), {});
});

test('name and domain are required, and the domain must look like a hostname', () => {
  assert.equal(validateOrganizationForm({ ...valid(), name: '   ' }).name, 'Organization name is required.');
  assert.equal(validateOrganizationForm({ ...valid(), domain: '' }).domain, 'Domain is required.');
  for (const domain of ['contoso', 'lab..contoso.com', 'http://lab.contoso.com', '-lab.contoso.com', 'lab.contoso.com/path']) {
    assert.equal(validateOrganizationForm({ ...valid(), domain }).domain, 'Enter a domain such as lab.example.com.', domain);
  }
  for (const domain of ['lab.contoso.com', 'contoso.co.uk', 'a1.b2.example.org']) {
    assert.equal(validateOrganizationForm({ ...valid(), domain }).domain, undefined, domain);
  }
});

test('administrator credentials accept the characters the server accepts and reject the rest', () => {
  for (const adminUsername of ['admin', 'contoso.admin', 'contoso_admin', 'contoso-admin', 'admin99']) {
    assert.equal(validateOrganizationForm({ ...valid(), adminUsername }).adminUsername, undefined, adminUsername);
  }
  for (const adminUsername of ['.admin', '-admin', 'admin user', 'admin!', '_admin']) {
    assert.equal(validateOrganizationForm({ ...valid(), adminUsername }).adminUsername, 'Use letters, numbers, dots, underscores or hyphens.', adminUsername);
  }
  assert.equal(validateOrganizationForm({ ...valid(), adminEmail: 'not-an-email' }).adminEmail, 'Enter a valid email address.');
});

test('the active date range must be ordered and costs must be zero or more', () => {
  assert.equal(validateOrganizationForm({ ...valid(), activeFromDate: '2026-05-01', activeTillDate: '2026-04-30' }).activeTillDate,
    'Active to must be on or after active from.');
  assert.equal(validateOrganizationForm({ ...valid(), activeFromDate: '2026-05-01', activeTillDate: '2026-05-01' }).activeTillDate, undefined);
  // An open-ended range is allowed.
  assert.equal(validateOrganizationForm({ ...valid(), activeFromDate: '2026-05-01', activeTillDate: '' }).activeTillDate, undefined);
  assert.equal(validateOrganizationForm({ ...valid(), subscriptionCost: '-1' }).subscriptionCost, 'Subscription cost must be a number of zero or more.');
  assert.equal(validateOrganizationForm({ ...valid(), customDevelopmentCost: 'free' }).customDevelopmentCost, 'Custom development cost must be a number of zero or more.');
  for (const subscriptionCost of ['', '0', '12.50']) {
    assert.equal(validateOrganizationForm({ ...valid(), subscriptionCost }).subscriptionCost, undefined, subscriptionCost);
  }
});

test('the payload trims text, collapses blank optional fields to null and omits administrator fields when editing', () => {
  const payload = organizationFormPayload({ ...valid(), name: '  Contoso Labs  ', pricingPlan: '   ', subscriptionCost: '', contactPerson: ' Dana ' });
  assert.equal(payload.name, 'Contoso Labs');
  assert.equal(payload.pricingPlan, null);
  assert.equal(payload.subscriptionCost, null);
  assert.equal(payload.contactPerson, 'Dana');
  assert.equal(payload.adminUsername, 'contoso.admin');
  assert.equal(payload.seedDemoData, false);
  assert.equal('adminUsername' in organizationFormPayload(valid(), { editing: true }), false);
});

test('an existing organization loads into the form with nulls shown as empty fields', () => {
  const form = organizationToForm({ name: 'Contoso', domain: null, status: 'suspended', accountType: 'enterprise',
    activeFromDate: '2026-01-01', activeTillDate: null, subscriptionCost: '10.00', contactPerson: null });
  assert.equal(form.domain, '');
  assert.equal(form.activeTillDate, '');
  assert.equal(form.contactPerson, '');
  assert.equal(form.status, 'suspended');
  assert.equal(form.subscriptionCost, '10.00');
  assert.equal(form.seedDemoData, false);
});
