import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, text, uuid } from '../templates/input.js';
import { requireServiceAgreementRead } from './service-agreements.js';

const catalogs = Object.freeze({ vendors: 'service_agreement_vendor_catalog', instruments: 'service_agreement_instrument_catalog' });

export async function serviceAgreementOptions(client, identity, input) {
  await requireServiceAgreementRead(client, identity); fieldsOnly(input, ['kind', 'search', 'page', 'selectedIds']);
  if (!Object.hasOwn(catalogs, input.kind)) throw new HttpError(400, 'invalid_agreement_options', 'Select a supported Service Agreement choice.');
  const search = text(input.search, 'Search', 500, { optional: true }).trim();
  if (!search.isWellFormed() || search.includes('\0')) throw new HttpError(400, 'invalid_input', 'Search must contain valid text.');
  const page = integer(input.page ?? 1, 'Page', 1, 1_000_000); const selected = input.selectedIds ?? [];
  if (!Array.isArray(selected) || selected.length > 500) throw new HttpError(400, 'invalid_input', 'Select at most 500 choices.');
  const ids = Array.from(selected, id => uuid(id, 'Selected choice').toLowerCase());
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'invalid_input', 'Select distinct choices.');
  const table = catalogs[input.kind];
  const retained = ids.length ? (await client.query(`SELECT id,name,active FROM ${table} WHERE organization_id=$1 AND id=ANY($2::uuid[]) ORDER BY name,id`, [identity.organization_id, ids])).rows : [];
  const { matchesModuleAccessOption } = await import('../organization-settings/module-access-filter.js');
  const rows = []; let cursor = null; let matches = 0;
  while (true) {
    const batch = (await client.query(`SELECT id,name,active FROM ${table} WHERE organization_id=$1
      ${cursor ? 'AND (name,id)>($2,$3::uuid)' : ''} ORDER BY name,id LIMIT 1001`, cursor ? [identity.organization_id, cursor.name, cursor.id] : [identity.organization_id])).rows;
    for (const row of batch.slice(0, 1000)) {
      if (!matchesModuleAccessOption(row, search) || matches++ < (page - 1) * 100) continue;
      rows.push(row);
      if (rows.length > 100) return { rows: rows.slice(0, 100), retained, page, hasMore: true };
    }
    if (batch.length <= 1000) return { rows, retained, page, hasMore: false };
    cursor = batch[999];
  }
}
