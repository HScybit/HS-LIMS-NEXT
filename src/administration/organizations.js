import { randomBytes } from 'node:crypto';
import { HttpError } from '../auth/errors.js';
import { uuid } from '../templates/input.js';
import { hashPassword } from '../auth/passwords.js';
import { roleCapabilityKeys } from '../roles/capabilities.js';
import { PERMISSION_CATALOG } from '../auth/permission-catalog.js';
import { createOrganizationInput, updateOrganizationInput, organizationListInput } from './organizations-input.js';

const organizationColumns = `id,code,name,active,domain,status,active_from_date::text AS "activeFromDate",active_till_date::text AS "activeTillDate",
  account_type AS "accountType",purchase_order_number AS "purchaseOrderNumber",address,contact_person AS "contactPerson",
  contact_phone AS "contactPhone",project_manager AS "projectManager",sales_person AS "salesPerson",pricing_plan AS "pricingPlan",
  subscription_cost AS "subscriptionCost",custom_development_cost AS "customDevelopmentCost",
  created_at AS "createdAt",updated_at AS "updatedAt"`;

async function requirePlatformAdministrator(client) {
  const result = await client.query('SELECT auth_is_platform_administrator() AS allowed');
  if (!result.rows[0].allowed) throw new HttpError(403, 'platform_administrator_required', 'Platform administrator access is required.');
}

function organizationError(error) {
  if (error instanceof HttpError) return error;
  if (error.code === '42501' && error.constraint === 'platform_administrator_required') {
    return new HttpError(403, 'platform_administrator_required', 'Platform administrator access is required.');
  }
  if (error.constraint === 'organizations_code_key') return new HttpError(409, 'duplicate_organization_code', 'This organization code is already in use.');
  if (error.constraint === 'organizations_domain_key') return new HttpError(409, 'duplicate_organization_domain', 'This domain is already in use.');
  if (error.constraint === 'users_username_key') return new HttpError(409, 'duplicate_admin_username', 'This administrator username is already in use.');
  if (error.constraint === 'platform_organization_values') return new HttpError(400, 'invalid_organization', 'Check the organization and administrator details.');
  if (error.constraint === 'platform_organization_not_found') return new HttpError(404, 'organization_not_found', 'Organization was not found.');
  return error;
}

export function createTemporaryPassword() {
  return randomBytes(15).toString('base64url');
}

export async function listOrganizations(client, identity, rawInput = {}) {
  await requirePlatformAdministrator(client);
  const input = organizationListInput(rawInput);
  const conditions = []; const args = [];
  if (input.search) { args.push(`%${input.search.replace(/[\\%_]/g, '\\$&')}%`); conditions.push(`(code ILIKE $${args.length} OR name ILIKE $${args.length} OR domain ILIKE $${args.length} OR contact_person ILIKE $${args.length})`); }
  if (input.status !== 'all') { args.push(input.status); conditions.push(`status=$${args.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = (await client.query(`SELECT count(*)::integer AS count FROM organizations ${where}`, args)).rows[0].count;
  const rows = (await client.query(`SELECT ${organizationColumns} FROM organizations ${where}
    ORDER BY created_at DESC,id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
  [...args, input.pageSize, (input.page - 1) * input.pageSize])).rows;
  return { items: rows, page: input.page, pageSize: input.pageSize, total };
}

export async function loadOrganization(client, identity, organizationId) {
  await requirePlatformAdministrator(client);
  const id = uuid(organizationId, 'Organization').toLowerCase();
  const result = await client.query(`SELECT ${organizationColumns} FROM organizations WHERE id=$1`, [id]);
  if (!result.rowCount) throw new HttpError(404, 'organization_not_found', 'Organization was not found.');
  return result.rows[0];
}

export async function createOrganization(client, identity, rawInput) {
  const input = createOrganizationInput(rawInput);
  try {
    const temporaryPassword = createTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    const result = await client.query(
      `SELECT * FROM platform_create_organization($1,$2,$3,$4,$5,$6::text[],$7::text[],$8::text[],$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [input.name, input.adminUsername, input.adminEmail, input.adminDisplayName, passwordHash,
        PERMISSION_CATALOG.map(([permissionCode]) => permissionCode), PERMISSION_CATALOG.map(([, description]) => description), [...roleCapabilityKeys],
        input.domain, input.status, input.activeFromDate, input.activeTillDate, input.accountType, input.purchaseOrderNumber,
        input.address, input.contactPerson, input.contactPhone, input.projectManager, input.salesPerson, input.pricingPlan,
        input.subscriptionCost, input.customDevelopmentCost]);
    const { organization_id: organizationId, admin_user_id: adminUserId } = result.rows[0];
    return { organizationId, admin: { id: adminUserId, username: input.adminUsername, temporaryPassword }, seedDemoData: input.seedDemoData };
  } catch (error) { throw organizationError(error); }
}

export async function updateOrganization(client, identity, organizationId, rawInput) {
  const id = uuid(organizationId, 'Organization').toLowerCase();
  const input = updateOrganizationInput(rawInput);
  try {
    await client.query(
      `SELECT platform_update_organization($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [id, input.name, input.domain, input.status, input.activeFromDate, input.activeTillDate, input.accountType,
        input.purchaseOrderNumber, input.address, input.contactPerson, input.contactPhone, input.projectManager, input.salesPerson,
        input.pricingPlan, input.subscriptionCost, input.customDevelopmentCost]);
  } catch (error) { throw organizationError(error); }
  return loadOrganization(client, identity, id);
}
