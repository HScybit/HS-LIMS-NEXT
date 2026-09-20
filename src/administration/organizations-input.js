import { HttpError } from '../auth/errors.js';
import { dateOnly, decimal, fieldsOnly, integer, text } from '../templates/input.js';

const detailFields = ['domain', 'status', 'activeFromDate', 'activeTillDate', 'accountType', 'purchaseOrderNumber',
  'address', 'contactPerson', 'contactPhone', 'projectManager', 'salesPerson', 'pricingPlan', 'subscriptionCost', 'customDevelopmentCost'];

function email(value) {
  const result = text(value, 'Administrator email', 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw new HttpError(400, 'invalid_organization', 'Enter a valid administrator email address.');
  return result;
}

function username(value) {
  const result = text(value, 'Administrator username', 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result)) {
    throw new HttpError(400, 'invalid_organization', 'Administrator username must start with a letter or number and contain only letters, numbers, dots, underscores or hyphens.');
  }
  return result;
}

function optionalText(value, label, max) {
  if (value === null || value === undefined || value === '') return null;
  return text(value, label, max);
}

function optionalDecimal(value, label) {
  const result = decimal(value, label, { optional: true });
  if (result === null) return null;
  if (Number(result) < 0) throw new HttpError(400, 'invalid_organization', `${label} cannot be negative.`);
  return result;
}

function optionalDate(value) {
  if (value === null || value === undefined || value === '') return null;
  return dateOnly(value);
}

function organizationDetails(input) {
  const domain = optionalText(input.domain, 'Domain', 200);
  if (domain === null) throw new HttpError(400, 'invalid_organization', 'Domain is required.');
  const status = input.status === undefined ? 'active' : input.status;
  if (!['active', 'suspended', 'archived'].includes(status)) throw new HttpError(400, 'invalid_organization', 'Select a supported status.');
  const accountType = input.accountType === undefined ? 'saas' : input.accountType;
  if (!['saas', 'enterprise'].includes(accountType)) throw new HttpError(400, 'invalid_organization', 'Select a supported account type.');
  const activeFromDate = optionalDate(input.activeFromDate);
  const activeTillDate = optionalDate(input.activeTillDate);
  if (activeFromDate && activeTillDate && activeFromDate > activeTillDate) throw new HttpError(400, 'invalid_organization', 'Active To must be on or after Active From.');
  return {
    domain, status, accountType, activeFromDate, activeTillDate,
    purchaseOrderNumber: optionalText(input.purchaseOrderNumber, 'PO Number', 100),
    address: optionalText(input.address, 'Address', 4000),
    contactPerson: optionalText(input.contactPerson, 'Contact Person', 200),
    contactPhone: optionalText(input.contactPhone, 'Contact Phone', 50),
    projectManager: optionalText(input.projectManager, 'Project Manager', 200),
    salesPerson: optionalText(input.salesPerson, 'Sales Person', 200),
    pricingPlan: optionalText(input.pricingPlan, 'Pricing Plan', 200),
    subscriptionCost: optionalDecimal(input.subscriptionCost, 'Subscription Cost'),
    customDevelopmentCost: optionalDecimal(input.customDevelopmentCost, 'Custom Dev Cost'),
  };
}

export function createOrganizationInput(input) {
  fieldsOnly(input, ['name', 'adminUsername', 'adminEmail', 'adminDisplayName', 'seedDemoData', ...detailFields]);
  return {
    name: text(input.name, 'Organization name', 200),
    adminUsername: username(input.adminUsername),
    adminEmail: email(input.adminEmail),
    adminDisplayName: text(input.adminDisplayName, 'Administrator name', 200),
    seedDemoData: Boolean(input.seedDemoData),
    ...organizationDetails(input),
  };
}

// The organization code is derived server-side and never user-facing (matches PERN);
// it stays fixed after creation, so update never accepts or changes it.
export function updateOrganizationInput(input) {
  fieldsOnly(input, ['name', ...detailFields]);
  return { name: text(input.name, 'Organization name', 200), ...organizationDetails(input) };
}

export function organizationListInput(input) {
  fieldsOnly(input, ['search', 'status', 'page', 'pageSize']);
  const search = text(input.search ?? '', 'Search', 200, { optional: true }).trim();
  if (!search.isWellFormed() || search.includes('\0')) throw new HttpError(400, 'invalid_input', 'Search must contain valid text.');
  const status = input.status ?? 'all';
  if (!['all', 'active', 'suspended', 'archived'].includes(status)) throw new HttpError(400, 'invalid_input', 'Select a supported status filter.');
  return { search, status, page: integer(input.page ?? 1, 'Page', 1, 1_000_000), pageSize: integer(input.pageSize ?? 20, 'Page size', 1, 100) };
}
