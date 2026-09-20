import { HttpError } from '../auth/errors.js';
import { uuid } from '../templates/input.js';
import { projectTabKeys } from './settings-fields.js';

export const allocatedFieldKeys = ['disciplines', 'customer', 'retained', 'generate_url', 'blind', 'product'];
export const sampleListingFieldKeys = ['customer', 'product', 'created_date', 'category', 'status', 'ulr_number'];

function enumListInput(input, key, allowed, label) {
  if (!Object.hasOwn(input, key)) return undefined;
  const value = input[key];
  if (!Array.isArray(value) || value.length > allowed.length) throw new HttpError(400, 'invalid_input', `${label} contains an unsupported selection.`);
  const unique = [...new Set(value)];
  if (unique.some((item) => !allowed.includes(item))) throw new HttpError(400, 'invalid_input', `${label} contains an unsupported selection.`);
  return unique;
}

export function accessListSettingsInput(input) {
  return {
    allocatedFields: enumListInput(input, 'allocatedFields', allocatedFieldKeys, 'Allocated Fields'),
    sampleListingFields: enumListInput(input, 'sampleListingFields', sampleListingFieldKeys, 'Sample Listing Page Fields'),
    projectTabs: enumListInput(input, 'projectTabs', projectTabKeys, 'Project Tabs'),
    customTableRoleIds: Object.hasOwn(input, 'customTableRoleIds')
      ? [...new Set(input.customTableRoleIds.map((id) => uuid(id, 'Custom-table role').toLowerCase()))]
      : undefined,
  };
}

async function replaceEnumList(client, organizationId, table, column, values) {
  if (values === undefined) return;
  await client.query(`DELETE FROM ${table} WHERE organization_id=$1`, [organizationId]);
  if (values.length) await client.query(`INSERT INTO ${table}(organization_id,${column}) SELECT $1,value FROM unnest($2::text[]) AS value`, [organizationId, values]);
}

export async function loadAccessListSettings(client, identity) {
  const [allocated, listing, tabs, roles] = await Promise.all([
    client.query('SELECT field_key FROM organization_allocated_fields WHERE organization_id=$1 ORDER BY field_key', [identity.organization_id]),
    client.query('SELECT field_key FROM organization_sample_listing_fields WHERE organization_id=$1 ORDER BY field_key', [identity.organization_id]),
    client.query('SELECT tab_key FROM organization_project_tabs WHERE organization_id=$1 ORDER BY tab_key', [identity.organization_id]),
    client.query('SELECT role_id FROM organization_custom_table_roles WHERE organization_id=$1 ORDER BY role_id', [identity.organization_id]),
  ]);
  return {
    allocatedFields: allocated.rows.map((row) => row.field_key), sampleListingFields: listing.rows.map((row) => row.field_key),
    projectTabs: tabs.rows.map((row) => row.tab_key), customTableRoleIds: roles.rows.map((row) => row.role_id),
  };
}

export async function saveAccessListSettings(client, identity, lists) {
  await replaceEnumList(client, identity.organization_id, 'organization_allocated_fields', 'field_key', lists.allocatedFields);
  await replaceEnumList(client, identity.organization_id, 'organization_sample_listing_fields', 'field_key', lists.sampleListingFields);
  await replaceEnumList(client, identity.organization_id, 'organization_project_tabs', 'tab_key', lists.projectTabs);
  if (lists.customTableRoleIds !== undefined) {
    await client.query('DELETE FROM organization_custom_table_roles WHERE organization_id=$1', [identity.organization_id]);
    if (lists.customTableRoleIds.length) {
      const inserted = await client.query(
        `INSERT INTO organization_custom_table_roles(organization_id,role_id)
         SELECT $1,role.id FROM roles role WHERE role.organization_id=$1 AND role.id=ANY($2::uuid[]) AND role.active
         RETURNING role_id`, [identity.organization_id, lists.customTableRoleIds]);
      if (inserted.rowCount !== lists.customTableRoleIds.length) throw new HttpError(422, 'invalid_custom_table_role', 'A selected custom-table role is unavailable.');
    }
  }
}
