// Client-side shape and validation for the organization form. The server
// re-validates everything in organizations-input.js; these rules exist so the
// form can report problems per field before a request is sent, the way the
// reference application does.

const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HOSTNAME_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const COST_FIELDS = Object.freeze([['subscriptionCost', 'Subscription cost'], ['customDevelopmentCost', 'Custom development cost']]);

export function blankOrganizationForm() {
  return {
    name: '', domain: '', status: 'active', accountType: 'saas',
    activeFromDate: new Date().toISOString().slice(0, 10), activeTillDate: '',
    purchaseOrderNumber: '', pricingPlan: '', subscriptionCost: '', customDevelopmentCost: '',
    address: '', contactPerson: '', contactPhone: '', projectManager: '', salesPerson: '',
    adminUsername: '', adminEmail: '', adminDisplayName: '', seedDemoData: false,
  };
}

export function organizationToForm(organization) {
  const text = (value) => value ?? '';
  return {
    ...blankOrganizationForm(),
    name: organization.name, domain: text(organization.domain), status: organization.status,
    accountType: organization.accountType, activeFromDate: text(organization.activeFromDate),
    activeTillDate: text(organization.activeTillDate), purchaseOrderNumber: text(organization.purchaseOrderNumber),
    pricingPlan: text(organization.pricingPlan), subscriptionCost: text(organization.subscriptionCost),
    customDevelopmentCost: text(organization.customDevelopmentCost), address: text(organization.address),
    contactPerson: text(organization.contactPerson), contactPhone: text(organization.contactPhone),
    projectManager: text(organization.projectManager), salesPerson: text(organization.salesPerson),
  };
}

export function validateOrganizationForm(values, { editing = false } = {}) {
  const errors = {};
  const trimmed = (key) => String(values[key] ?? '').trim();

  if (!trimmed('name')) errors.name = 'Organization name is required.';

  const domain = trimmed('domain');
  if (!domain) errors.domain = 'Domain is required.';
  else if (!HOSTNAME_PATTERN.test(domain)) errors.domain = 'Enter a domain such as lab.example.com.';

  if (!editing) {
    const adminUsername = trimmed('adminUsername');
    if (!adminUsername) errors.adminUsername = 'Administrator username is required.';
    else if (!USERNAME_PATTERN.test(adminUsername)) errors.adminUsername = 'Use letters, numbers, dots, underscores or hyphens.';

    const adminEmail = trimmed('adminEmail');
    if (!adminEmail) errors.adminEmail = 'Administrator email is required.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) errors.adminEmail = 'Enter a valid email address.';

    if (!trimmed('adminDisplayName')) errors.adminDisplayName = 'Administrator name is required.';
  }

  if (trimmed('activeFromDate') && trimmed('activeTillDate') && trimmed('activeFromDate') > trimmed('activeTillDate')) {
    errors.activeTillDate = 'Active to must be on or after active from.';
  }

  for (const [field, label] of COST_FIELDS) {
    const value = values[field];
    if (value === '' || value === null || value === undefined) continue;
    if (!Number.isFinite(Number(value)) || Number(value) < 0) errors[field] = `${label} must be a number of zero or more.`;
  }

  return errors;
}

// The payload the API expects, with blank optional text collapsed to null.
export function organizationFormPayload(values, { editing = false } = {}) {
  const optional = (key) => (String(values[key] ?? '').trim() || null);
  const detail = {
    name: String(values.name ?? '').trim(),
    domain: String(values.domain ?? '').trim(),
    status: values.status,
    accountType: values.accountType,
    activeFromDate: optional('activeFromDate'),
    activeTillDate: optional('activeTillDate'),
    purchaseOrderNumber: optional('purchaseOrderNumber'),
    pricingPlan: optional('pricingPlan'),
    subscriptionCost: values.subscriptionCost === '' ? null : values.subscriptionCost,
    customDevelopmentCost: values.customDevelopmentCost === '' ? null : values.customDevelopmentCost,
    address: optional('address'),
    contactPerson: optional('contactPerson'),
    contactPhone: optional('contactPhone'),
    projectManager: optional('projectManager'),
    salesPerson: optional('salesPerson'),
  };
  if (editing) return detail;
  return {
    ...detail,
    adminUsername: String(values.adminUsername ?? '').trim(),
    adminEmail: String(values.adminEmail ?? '').trim(),
    adminDisplayName: String(values.adminDisplayName ?? '').trim(),
    seedDemoData: Boolean(values.seedDemoData),
  };
}
