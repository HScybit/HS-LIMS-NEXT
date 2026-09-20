import { HttpError } from '../auth/errors.js';
import { dateOnly, fieldsOnly, integer, uuid } from '../templates/input.js';
import { materialText } from './input.js';
import { loadMaterial, materialColumns, materialJoins, requireMaterialRead } from './service.js';

const literal = value => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
const columns = { name: 'material.name', classification: 'category.name', description: 'material.description', code: 'material.code', created_at: 'material.created_at' };

export async function listMaterials(client, identity, input = {}) {
  await requireMaterialRead(client, identity); fieldsOnly(input, ['page', 'pageSize', 'search', 'filters', 'sort']);
  const page = integer(input.page ?? 1, 'Page', 1, 1_000_000); const pageSize = integer(input.pageSize ?? 10, 'Page size', 1, 100);
  const search = materialText(input.search, 'Search', 500, true); const args = [identity.organization_id];
  const conditions = ['material.organization_id=$1', 'material.active'];
  const bind = value => { args.push(value); return `$${args.length}`; };
  if (search) {
    const value = bind(literal(search)); conditions.push(`(material.name ILIKE ${value} OR material.code ILIKE ${value} OR material.description ILIKE ${value} OR category.name ILIKE ${value})`);
  }
  const filters = input.filters ?? {}; fieldsOnly(filters, Object.keys(columns));
  for (const [key, filter] of Object.entries(filters)) {
    if (key === 'created_at') {
      fieldsOnly(filter, ['type', 'from', 'to']);
      if (filter.type !== 'date') throw new HttpError(400, 'invalid_filter', 'Created requires calendar dates.');
      const from = filter.from == null || filter.from === '' ? null : dateOnly(filter.from);
      const to = filter.to == null || filter.to === '' ? null : dateOnly(filter.to);
      if (from && to && from > to) throw new HttpError(400, 'invalid_filter', 'The date range is reversed.');
      if (from) conditions.push(`material.created_at>=${bind(from + 'T00:00:00Z')}::timestamptz`);
      if (to) conditions.push(`material.created_at<(${bind(to + 'T00:00:00Z')}::timestamptz+interval '24 hours')`);
    } else {
      fieldsOnly(filter, ['type', 'value']);
      if (filter.type !== 'text') throw new HttpError(400, 'invalid_filter', 'This column requires a text filter.');
      const value = materialText(filter.value, 'Filter', 500, true);
      if (value) conditions.push(`${columns[key]} ILIKE ${bind('%' + value.split(/\s+/).map(word => word.replace(/[\\%_]/g, '\\$&')).join('%') + '%')}`);
    }
  }
  const sort = input.sort ?? { key: 'created_at', dir: 'desc' }; fieldsOnly(sort, ['key', 'dir']);
  if (!Object.hasOwn(columns, sort.key) || !['asc', 'desc'].includes(sort.dir)) throw new HttpError(400, 'invalid_sort', 'Select an available sort column.');
  const where = conditions.join(' AND ');
  const totalCount = Number((await client.query(`SELECT count(*) FROM ${materialJoins} WHERE ${where}`, args)).rows[0].count);
  const rows = await client.query(`SELECT ${materialColumns} FROM ${materialJoins} WHERE ${where}
    ORDER BY ${columns[sort.key]} ${sort.dir},material.id LIMIT ${bind(pageSize)} OFFSET ${bind((page - 1) * pageSize)}`, args);
  return { rows: rows.rows.map(row => ({ ...row, _id: row.id, classification: row.categoryName, created_at: row.createdAt })), totalCount, page, pageSize };
}

// Opening quantity has one stored authority in the material record. The source transaction view includes that opening entry.
export const materialEntries = `SELECT id,transaction_type,quantity,cost,supplier,batch_serial_number,expiry_date,created_at,created_by,false AS initial
  FROM material_transactions WHERE organization_id=$1 AND material_id=$2
  UNION ALL SELECT initial_stock_id,'in',initial_quantity,NULL::numeric,'Initial Stock','Initial Stock',NULL::date,initial_stock_created_at,initial_stock_created_by,true
  FROM materials WHERE organization_id=$1 AND id=$2 AND initial_quantity>0`;

export async function listMaterialTransactions(client, identity, materialId, input = {}) {
  await requireMaterialRead(client, identity); uuid(materialId, 'Material'); fieldsOnly(input, ['page', 'pageSize', 'type']);
  const page = integer(input.page ?? 1, 'Page', 1, 1_000_000); const pageSize = integer(input.pageSize ?? 10, 'Page size', 1, 100); const type = input.type ?? 'all';
  if (!['all', 'in', 'out', 'out_damaged'].includes(type)) throw new HttpError(400, 'invalid_input', 'Select a valid transaction filter.');
  const args = [identity.organization_id, materialId, type];
  const totalCount = Number((await client.query(`WITH entries AS (${materialEntries}) SELECT count(*) FROM entries WHERE $3='all' OR transaction_type=$3`, args)).rows[0].count);
  const result = await client.query(`WITH entries AS (${materialEntries}), page_entries AS (
    SELECT * FROM entries WHERE $3='all' OR transaction_type=$3 ORDER BY created_at DESC,id LIMIT $4 OFFSET $5
    ) SELECT entry.id,entry.transaction_type AS type,entry.quantity,entry.cost,entry.supplier,entry.batch_serial_number AS "batchSerialNumber",
    entry.expiry_date::text AS "expiryDate",entry.created_at AS "createdAt",entry.created_by AS "createdBy",entry.initial,actor.display_name AS "createdByName"
    FROM page_entries entry LEFT JOIN method_access_user_labels actor ON actor.organization_id=$1 AND actor.user_id=entry.created_by
    ORDER BY entry.created_at DESC,entry.id`, [...args, pageSize, (page - 1) * pageSize]);
  return { items: result.rows, totalCount, page, pageSize };
}

const batchQuery = `WITH entries AS (${materialEntries}), balances AS (
  SELECT batch_serial_number,sum(CASE WHEN transaction_type='in' THEN quantity ELSE -quantity END) AS available FROM entries GROUP BY batch_serial_number
), recent AS (
  SELECT batch_serial_number,row_number() OVER(ORDER BY max(created_at) DESC,batch_serial_number) AS rank FROM entries
  WHERE transaction_type IN ('out','out_damaged') GROUP BY batch_serial_number ORDER BY max(created_at) DESC,batch_serial_number LIMIT 3
), receipts AS (
  SELECT entry.id,entry.batch_serial_number,entry.supplier,entry.expiry_date,entry.created_at,
    least(entry.quantity,greatest(balance.available,0)) AS available,coalesce(recent.rank,2147483647) AS rank,
    entry.expiry_date IS NOT NULL AND row_number() OVER(ORDER BY entry.expiry_date NULLS LAST,entry.created_at,entry.id)=1 AS warning
  FROM entries entry JOIN balances balance USING(batch_serial_number) LEFT JOIN recent USING(batch_serial_number)
  WHERE entry.transaction_type='in'
)`;
const batchColumns = `id,batch_serial_number AS label,batch_serial_number AS "batchSerialNumber",supplier,expiry_date::text AS "expiryDate",
  available AS "availableQuantity",available<=0 AS exhausted,warning`;

export async function materialChoices(client, identity, input = {}) {
  await requireMaterialRead(client, identity); fieldsOnly(input, ['kind', 'page', 'search', 'selectedId', 'materialId']);
  if (!['category', 'unit', 'batch'].includes(input.kind)) throw new HttpError(400, 'invalid_input', 'Select an available material lookup.');
  const page = integer(input.page ?? 1, 'Page', 1, 1_000_000); const search = materialText(input.search, 'Search', 500, true);
  const selectedId = input.selectedId ? uuid(input.selectedId, 'Selected option').toLowerCase() : null;
  const pageSize = 50; let rows; let selected;
  if (input.kind === 'batch') {
    const materialId = uuid(input.materialId, 'Material'); await loadMaterial(client, identity, materialId);
    rows = (await client.query(`${batchQuery} SELECT ${batchColumns} FROM receipts WHERE batch_serial_number ILIKE $3
      ORDER BY rank,expiry_date NULLS LAST,created_at,batch_serial_number,id LIMIT $4 OFFSET $5`, [identity.organization_id, materialId, literal(search), pageSize + 1, (page - 1) * pageSize])).rows;
    if (selectedId && !rows.slice(0, pageSize).some(row => row.id === selectedId)) selected = (await client.query(`${batchQuery} SELECT ${batchColumns} FROM receipts WHERE id=$3`, [identity.organization_id, materialId, selectedId])).rows[0];
  } else {
    const table = input.kind === 'category' ? 'material_categories' : 'measurement_units';
    rows = (await client.query(`SELECT id,name AS label,active FROM ${table} WHERE organization_id=$1 AND active AND name ILIKE $2
      ORDER BY lower(name),id LIMIT $3 OFFSET $4`, [identity.organization_id, literal(search), pageSize + 1, (page - 1) * pageSize])).rows;
    if (selectedId && !rows.slice(0, pageSize).some(row => row.id === selectedId)) selected = (await client.query(`SELECT id,name AS label,active FROM ${table} WHERE organization_id=$1 AND id=$2`, [identity.organization_id, selectedId])).rows[0];
  }
  return { items: rows.slice(0, pageSize), selected: selected ?? null, hasMore: rows.length > pageSize, page };
}

export async function checkIncomingMaterialBatch(client, identity, materialId, value) {
  await requireMaterialRead(client, identity); uuid(materialId, 'Material'); const batch = materialText(value, 'Batch/Serial No', 150, true);
  await loadMaterial(client, identity, materialId);
  const result = await client.query(`SELECT EXISTS(SELECT 1 FROM material_transactions WHERE organization_id=$1 AND material_id=$2 AND transaction_type='in' AND lower(batch_serial_number)=lower($3))
    OR EXISTS(SELECT 1 FROM materials WHERE organization_id=$1 AND id=$2 AND initial_quantity>0 AND lower($3)='initial stock') AS exists`, [identity.organization_id, materialId, batch]);
  return { exists: result.rows[0].exists };
}
