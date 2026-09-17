import { HttpError } from '../auth/errors.js';
import { dateOnly, fieldsOnly, integer, text, uuid } from '../templates/input.js';
import { requireServiceAgreementRead } from './service-agreements.js';

const columns = { vendor_id: 'vendor.name', equipment_ids: 'equipment_names', start_date: 'agreement.start_date', end_date: 'agreement.end_date', cost: 'agreement.cost' };
const literalSearch = value => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
function searchText(value, label) {
  const result = text(value, label, 500, { optional: true }).trim();
  if (!result.isWellFormed() || result.includes('\0')) throw new HttpError(400, 'invalid_input', `${label} must contain valid text.`);
  return result;
}
const instrumentFrom = `FROM service_agreement_version_instruments selected LEFT JOIN service_agreement_instrument_catalog instrument
  ON instrument.organization_id=selected.organization_id AND instrument.id=selected.instrument_id
  WHERE selected.organization_id=agreement.organization_id AND selected.agreement_id=agreement.id AND selected.revision=agreement.revision`;

export async function listServiceAgreements(client, identity, input = {}) {
  await requireServiceAgreementRead(client, identity); fieldsOnly(input, ['page', 'pageSize', 'search', 'filters', 'sort']);
  const page = integer(input.page ?? 1, 'Page', 1, 1_000_000); const pageSize = integer(input.pageSize ?? 10, 'Page size', 1, 100);
  const args = [identity.organization_id]; const bind = value => { args.push(value); return `$${args.length}`; };
  const conditions = ['agreement.organization_id=$1', 'NOT agreement.retired']; const search = searchText(input.search, 'Search');
  if (search) {
    const match = bind(literalSearch(search));
    conditions.push(`(vendor.name ILIKE ${match} OR agreement.cost::text ILIKE ${match}
      OR agreement.start_date::text ILIKE ${match} OR agreement.end_date::text ILIKE ${match}
      OR to_char(agreement.start_date,'DD/MM/YYYY') ILIKE ${match} OR to_char(agreement.end_date,'DD/MM/YYYY') ILIKE ${match}
      OR EXISTS(SELECT 1 ${instrumentFrom} AND coalesce(instrument.name,selected.instrument_name) ILIKE ${match}))`);
  }
  const filters = input.filters ?? {}; fieldsOnly(filters, Object.keys(columns));
  for (const [key, filter] of Object.entries(filters)) {
    if (['vendor_id', 'equipment_ids'].includes(key)) {
      fieldsOnly(filter, ['type', 'value', 'labels']);
      if (filter.type !== 'relation' || !Array.isArray(filter.value) || filter.value.length > 500) throw new HttpError(400, 'invalid_filter', 'Select at most 500 references.');
      const ids = Array.from(filter.value, id => uuid(id, 'Filter choice').toLowerCase());
      if (new Set(ids).size !== ids.length) throw new HttpError(400, 'invalid_filter', 'Select distinct filter choices.');
      if (ids.length) conditions.push(key === 'vendor_id' ? `agreement.vendor_id=ANY(${bind(ids)}::uuid[])`
        : `EXISTS(SELECT 1 ${instrumentFrom} AND selected.instrument_id=ANY(${bind(ids)}::uuid[]))`);
    } else if (['start_date', 'end_date'].includes(key)) {
      fieldsOnly(filter, ['type', 'from', 'to']);
      if (filter.type !== 'date') throw new HttpError(400, 'invalid_filter', 'Use a calendar date filter.');
      const from = filter.from ? dateOnly(filter.from) : null; const to = filter.to ? dateOnly(filter.to) : null;
      if (from && to && from > to) throw new HttpError(400, 'invalid_filter', 'The filter end date cannot be before its start date.');
      if (from) conditions.push(`${columns[key]}>=${bind(from)}::date`);
      if (to) conditions.push(`${columns[key]}<=${bind(to)}::date`);
    } else {
      fieldsOnly(filter, ['type', 'value']);
      if (filter.type !== 'text') throw new HttpError(400, 'invalid_filter', 'Use a text filter for Cost.');
      const value = searchText(filter.value, 'Cost filter'); if (value) conditions.push(`agreement.cost::text ILIKE ${bind(literalSearch(value))}`);
    }
  }
  const sort = input.sort;
  if (sort) {
    fieldsOnly(sort, ['key', 'dir']);
    if (!Object.hasOwn(columns, sort.key) || !['asc', 'desc'].includes(sort.dir)) throw new HttpError(400, 'invalid_sort', 'Sort column or direction is invalid.');
  }
  const from = `FROM service_agreements agreement JOIN service_agreement_vendor_catalog vendor ON vendor.organization_id=agreement.organization_id AND vendor.id=agreement.vendor_id
    WHERE ${conditions.join(' AND ')}`;
  const totalCount = (await client.query(`SELECT count(*)::integer AS total ${from}`, args)).rows[0].total;
  const equipmentOrder = sort?.key === 'equipment_ids';
  const rows = (await client.query(`SELECT agreement.id AS _id,agreement.revision,vendor.name AS vendor_id,agreement.vendor_id AS "vendorId",
    agreement.start_date::text AS start_date,agreement.end_date::text AS end_date,agreement.cost
    ${equipmentOrder ? `,(SELECT string_agg(coalesce(instrument.name,selected.instrument_name),', ' ORDER BY selected.position) ${instrumentFrom}) AS equipment_names` : ''}
    ${from} ORDER BY ${sort ? `${columns[sort.key]} ${sort.dir} NULLS LAST` : 'agreement.created_at DESC'},agreement.id DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
  [...args, pageSize, (page - 1) * pageSize])).rows;
  const selected = rows.length ? (await client.query(`SELECT selection.agreement_id AS id,selection.instrument_id AS "instrumentId",selection.position,
    coalesce(instrument.name,selection.instrument_name) AS name FROM service_agreement_version_instruments selection
    JOIN service_agreements agreement ON agreement.organization_id=selection.organization_id AND agreement.id=selection.agreement_id AND agreement.revision=selection.revision
    LEFT JOIN service_agreement_instrument_catalog instrument ON instrument.organization_id=selection.organization_id AND instrument.id=selection.instrument_id
    WHERE selection.organization_id=$1 AND selection.agreement_id=ANY($2::uuid[]) ORDER BY selection.agreement_id,selection.position LIMIT 50001`,
  [identity.organization_id, rows.map(row => row._id)])).rows : [];
  if (selected.length > 50000) throw new HttpError(409, 'incomplete_service_agreement_history', 'Service Agreement selections exceed the supported size.');
  const grouped = new Map();
  for (const item of selected) { if (!grouped.has(item.id)) grouped.set(item.id, []); grouped.get(item.id).push(item); }
  return { rows: rows.map(({ equipment_names: _order, ...row }) => ({ ...row, equipment_ids: (grouped.get(row._id) ?? []).map(item => item.name) })), totalCount };
}
