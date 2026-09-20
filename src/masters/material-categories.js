import { HttpError } from '../auth/errors.js';
import { bool, dateOnly, fieldsOnly, integer, requirePermission, text, uuid } from '../templates/input.js';

async function requireRead(client, identity) {
  if (!identity.permission_codes?.some(permission => ['masters.read', 'masters.manage'].includes(permission))) throw new HttpError(403, 'forbidden', 'You cannot view material categories.');
  if (!(await client.query("SELECT masters_can_read_party('inventory') AS allowed")).rows[0]?.allowed) {
    throw new HttpError(403, 'inventory_module_access_required', 'Inventory module access is required.');
  }
}

export function materialCategoryInput(input) {
  fieldsOnly(input, ['id', 'requestId', 'revision', 'name', 'description', 'reusable', 'expirable']);
  const name = text(typeof input.name === 'string' ? input.name.trim() : input.name, 'Name', 200);
  const description = text(typeof input.description === 'string' ? input.description.trim() : input.description, 'Description', 16000, { optional: true });
  if ([name, description].some(value => value.includes('\0'))) throw new HttpError(400, 'invalid_input', 'Category text cannot contain null characters.');
  return { id: uuid(input.id, 'Material category').toLowerCase(), requestId: uuid(input.requestId, 'Save request').toLowerCase(),
    revision: integer(input.revision, 'Revision', 0, 2_147_483_646), name, description,
    reusable: bool(input.reusable === undefined ? false : input.reusable, 'Reusable'), expirable: bool(input.expirable === undefined ? false : input.expirable, 'Expirable') };
}

export async function loadMaterialCategory(client, identity, categoryId, { atRevision } = {}) {
  await requireRead(client, identity); uuid(categoryId, 'Material category');
  if (atRevision !== undefined) integer(atRevision, 'Revision', 1, 2_147_483_647);
  const history = atRevision !== undefined;
  const result = await client.query(`SELECT ${history ? 'category_id' : 'id'} AS id,revision,name,description,reusable,expirable,active
    ${history ? ',request_id AS "requestId",saved_by AS "savedBy",saved_at AS "savedAt",previous_revision AS "previousRevision",operation'
      : ',created_by AS "createdBy",updated_by AS "updatedBy",created_at AS "createdAt",updated_at AS "updatedAt"'}
    FROM ${history ? 'material_category_versions' : 'material_categories'}
    WHERE organization_id=$1 AND ${history ? 'category_id' : 'id'}=$2 ${history ? 'AND revision=$3' : 'AND active'}`,
  history ? [identity.organization_id, categoryId, atRevision] : [identity.organization_id, categoryId]);
  if (!result.rowCount) throw new HttpError(404, 'material_category_not_found', 'Material category was not found.');
  return result.rows[0];
}

const authoredFields = value => ({ name: value.name, description: value.description, reusable: value.reusable, expirable: value.expirable });
async function priorSave(client, identity, id, revision, requestId, operation) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('material-category-save:'||$1::text||':'||$2::text,0))", [identity.organization_id, requestId]);
  const prior = (await client.query('SELECT category_id,revision,previous_revision,operation,saved_by FROM material_category_versions WHERE organization_id=$1 AND request_id=$2', [identity.organization_id, requestId])).rows[0];
  if (!prior) return null;
  if (prior.category_id !== id || (prior.previous_revision ?? 0) !== revision || prior.operation !== operation || prior.saved_by !== identity.user_id) {
    throw new HttpError(409, 'save_request_reused', 'This save request was already used for another change.');
  }
  return loadMaterialCategory(client, identity, id, { atRevision: prior.revision });
}

export async function saveMaterialCategory(client, identity, value) {
  requirePermission(identity, 'masters.manage'); const input = materialCategoryInput(value);
  await client.query('SELECT masters_lock_field_writer()');
  const prior = await priorSave(client, identity, input.id, input.revision, input.requestId, input.revision ? 'update' : 'create');
  if (prior) {
    if (JSON.stringify(authoredFields(prior)) !== JSON.stringify(authoredFields(input))) throw new HttpError(409, 'save_request_reused', 'This save request was already used for different values.');
    return prior;
  }
  const current = (await client.query('SELECT revision,active FROM material_categories WHERE organization_id=$1 AND id=$2 FOR UPDATE', [identity.organization_id, input.id])).rows[0];
  if (input.revision && !current?.active) throw new HttpError(404, 'material_category_not_found', 'Material category was not found.');
  if ((current?.revision ?? 0) !== input.revision) throw new HttpError(409, 'stale_material_category', 'The category changed. Reload before saving.');
  const args = [identity.organization_id, input.id, input.name, input.description, input.reusable, input.expirable, input.requestId, identity.user_id];
  try {
    if (!input.revision) await client.query(`INSERT INTO material_categories(organization_id,id,name,description,reusable,expirable,save_request_id,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)`, args);
    else await client.query(`UPDATE material_categories SET name=$3,description=$4,reusable=$5,expirable=$6,save_request_id=$7,updated_by=$8,
      revision=revision+1,updated_at=transaction_timestamp() WHERE organization_id=$1 AND id=$2`, args);
  } catch (error) {
    if (error.constraint === 'material_category_active_name') throw new HttpError(409, 'material_category_name_exists', 'A material category with this name already exists.');
    if (error.constraint === 'organization_module_access_required') throw new HttpError(403, 'inventory_module_access_required', 'Inventory module access is required.');
    throw error;
  }
  return loadMaterialCategory(client, identity, input.id);
}

export async function retireMaterialCategory(client, identity, input) {
  requirePermission(identity, 'masters.manage'); fieldsOnly(input, ['id', 'requestId', 'revision']);
  const id = uuid(input.id, 'Material category').toLowerCase(); const requestId = uuid(input.requestId, 'Delete request').toLowerCase();
  const revision = integer(input.revision, 'Revision', 1, 2_147_483_646);
  await client.query('SELECT masters_lock_field_writer()');
  const prior = await priorSave(client, identity, id, revision, requestId, 'retire');
  if (prior) return { id, revision: prior.revision };
  const current = (await client.query('SELECT revision,active FROM material_categories WHERE organization_id=$1 AND id=$2 FOR UPDATE', [identity.organization_id, id])).rows[0];
  if (!current?.active) throw new HttpError(404, 'material_category_not_found', 'Material category was not found.');
  if (current.revision !== revision) throw new HttpError(409, 'stale_material_category', 'The category changed. Reload before deleting.');
  try {
    await client.query(`UPDATE material_categories SET active=false,save_request_id=$3,updated_by=$4,revision=revision+1,updated_at=transaction_timestamp()
      WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id, requestId, identity.user_id]);
  } catch (error) {
    if (error.constraint === 'material_category_in_use') throw new HttpError(409, 'material_category_in_use', 'This category is assigned to one or more materials.');
    if (error.constraint === 'organization_module_access_required') throw new HttpError(403, 'inventory_module_access_required', 'Inventory module access is required.');
    throw error;
  }
  return { id, revision: revision + 1 };
}

const columns = { name: 'category.name', description: 'category.description', reusable: 'category.reusable', expirable: 'category.expirable', created_at: 'category.created_at' };
const literalSearch = value => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
function searchText(value, label) {
  const result = text(value, label, 500, { optional: true }).trim();
  if (result.includes('\0')) throw new HttpError(400, 'invalid_input', `${label} cannot contain null characters.`);
  return result;
}

export async function listMaterialCategories(client, identity, input = {}) {
  await requireRead(client, identity); fieldsOnly(input, ['page', 'pageSize', 'search', 'filters', 'sort']);
  const page = integer(input.page ?? 1, 'Page', 1, 1_000_000); const pageSize = integer(input.pageSize ?? 10, 'Page size', 1, 100);
  const search = searchText(input.search, 'Search'); const args = [identity.organization_id]; const conditions = ['category.organization_id=$1', 'category.active'];
  const bind = value => { args.push(value); return `$${args.length}`; };
  if (search) { const value = bind(literalSearch(search)); conditions.push(`(category.name ILIKE ${value} OR category.description ILIKE ${value})`); }
  const filters = input.filters ?? {}; fieldsOnly(filters, Object.keys(columns));
  for (const [key, filter] of Object.entries(filters)) {
    if (key === 'created_at') {
      fieldsOnly(filter, ['type', 'from', 'to']);
      if (filter.type !== 'date') throw new HttpError(400, 'invalid_filter', 'Created At requires calendar dates.');
      const from = filter.from == null || filter.from === '' ? null : dateOnly(filter.from);
      const to = filter.to == null || filter.to === '' ? null : dateOnly(filter.to);
      if (from && to && from > to) throw new HttpError(400, 'invalid_filter', 'The date range is reversed.');
      if (from) conditions.push(`category.created_at>=${bind(from + 'T00:00:00Z')}::timestamptz`);
      if (to) conditions.push(`category.created_at<(${bind(to + 'T00:00:00Z')}::timestamptz+interval '24 hours')`);
    } else {
      fieldsOnly(filter, ['type', 'value']);
      if (['reusable', 'expirable'].includes(key)) {
        if (filter.type !== 'boolean' || !['true', 'false'].includes(filter.value)) throw new HttpError(400, 'invalid_filter', 'Category flags require Yes or No.');
        conditions.push(`${columns[key]}=${bind(filter.value === 'true')}`);
      } else {
        if (filter.type !== 'text') throw new HttpError(400, 'invalid_filter', 'Category text filters require text.');
        const value = searchText(filter.value, 'Filter'); if (value) conditions.push(`${columns[key]} ILIKE ${bind(literalSearch(value).replace(/\s+/g, '%'))}`);
      }
    }
  }
  if (input.sort) {
    fieldsOnly(input.sort, ['key', 'dir']);
    if (!Object.hasOwn(columns, input.sort.key) || !['asc', 'desc'].includes(input.sort.dir)) throw new HttpError(400, 'invalid_sort', 'Sort column or direction is invalid.');
  }
  const order = input.sort ? `${columns[input.sort.key]} ${input.sort.dir}` : 'category.created_at DESC';
  const from = `FROM material_categories category WHERE ${conditions.join(' AND ')}`;
  const totalCount = (await client.query(`SELECT count(*)::integer AS total ${from}`, args)).rows[0].total;
  const rows = (await client.query(`SELECT category.id AS _id,category.revision,category.name,category.description,category.reusable,category.expirable,category.created_at
    ${from} ORDER BY ${order},category.id DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, pageSize, (page - 1) * pageSize])).rows;
  return { rows, totalCount };
}
