import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, requirePermission, text, uuid } from '../templates/input.js';

function requireRead(identity) {
  if (!identity.permission_codes?.some((permission) => ['masters.read', 'masters.manage'].includes(permission))) throw new HttpError(403, 'forbidden', 'You cannot view products.');
}

export function productInput(input) {
  fieldsOnly(input, ['id', 'requestId', 'revision', 'name', 'key', 'description', 'abbreviation', 'jobTemplateId', 'tagIds']);
  const name = text(input.name, 'Name', 200); const key = text(input.key, 'Unique Key', 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(key)) throw new HttpError(400, 'invalid_product_key', 'Unique Key must start with a letter or number and contain only letters, numbers, dots, slashes, underscores or hyphens.');
  const description = text(input.description, 'Description', 16000, { optional: true });
  const abbreviation = input.abbreviation == null ? null : text(input.abbreviation, 'Abbreviation', 64, { optional: true }).trim();
  if ([name, description, abbreviation].some((value) => value?.includes('\0'))) throw new HttpError(400, 'invalid_input', 'Product text cannot contain null characters.');
  const tags = input.tagIds === undefined ? [] : input.tagIds;
  if (!Array.isArray(tags) || tags.length > 500) throw new HttpError(400, 'invalid_product_tags', 'Select at most 500 tags.');
  const tagIds = tags.map((id) => uuid(id, 'Tag').toLowerCase());
  if (new Set(tagIds).size !== tagIds.length) throw new HttpError(400, 'invalid_product_tags', 'Each tag can be selected only once.');
  return { id: uuid(input.id, 'Product').toLowerCase(), requestId: uuid(input.requestId, 'Save request').toLowerCase(),
    revision: integer(input.revision, 'Revision', 0, 2_147_483_646), name, key, description, abbreviation,
    jobTemplateId: input.jobTemplateId == null || input.jobTemplateId === '' ? null : uuid(input.jobTemplateId, 'Job Template').toLowerCase(), tagIds };
}

export async function loadProduct(client, identity, productId, { atRevision } = {}) {
  requireRead(identity); uuid(productId, 'Product');
  if (atRevision !== undefined) integer(atRevision, 'Revision', 1, 2_147_483_647);
  const history = atRevision !== undefined;
  const record = (await client.query(`SELECT product.${history ? 'product_id' : 'id'} AS id,product.revision,product.code AS key,product.name,
    product.description,product.abbreviation,product.job_template_id AS "jobTemplateId",product.active,
    label.name AS "jobTemplateName",label.active AS "jobTemplateActive"
    ${history ? ',product.saved_by AS "savedBy",product.saved_at AS "savedAt",product.previous_revision AS "previousRevision",product.operation' : ''}
    FROM ${history ? 'product_versions' : 'products'} product LEFT JOIN product_template_labels label
      ON label.organization_id=product.organization_id AND label.template_id=product.job_template_id
    WHERE product.organization_id=$1 AND product.${history ? 'product_id' : 'id'}=$2 ${history ? 'AND product.revision=$3' : 'AND product.active'}`,
  history ? [identity.organization_id, productId, atRevision] : [identity.organization_id, productId])).rows[0];
  if (!record) throw new HttpError(404, 'product_not_found', 'Product was not found.');
  const tags = (await client.query(history
    ? `SELECT link.tag_id AS id,tag.name,tag.active FROM product_version_tags link LEFT JOIN tags tag
      ON tag.organization_id=link.organization_id AND tag.id=link.tag_id
      WHERE link.organization_id=$1 AND link.product_id=$2 AND link.revision=$3 ORDER BY link.position`
    : `SELECT link.tag_id AS id,tag.name,tag.active FROM product_tags link LEFT JOIN tags tag
      ON tag.organization_id=link.organization_id AND tag.id=link.tag_id LEFT JOIN product_version_tags saved
      ON saved.organization_id=link.organization_id AND saved.product_id=link.product_id AND saved.tag_id=link.tag_id AND saved.revision=$3
      WHERE link.organization_id=$1 AND link.product_id=$2 ORDER BY saved.position NULLS LAST,lower(tag.name),link.tag_id`,
  [identity.organization_id, productId, record.revision])).rows;
  const categories = (await client.query(`SELECT sample_category_id AS id FROM ${history ? 'product_version_sample_categories' : 'product_sample_categories'}
    WHERE organization_id=$1 AND product_id=$2 ${history ? 'AND revision=$3' : ''} ORDER BY sample_category_id`,
  history ? [identity.organization_id, productId, record.revision] : [identity.organization_id, productId])).rows;
  return { ...record, tags, tagIds: tags.map((tag) => tag.id), sampleCategoryIds: categories.map((category) => category.id) };
}

const authoredFields = (value) => ({ name: value.name, key: value.key, description: value.description, abbreviation: value.abbreviation,
  jobTemplateId: value.jobTemplateId, tagIds: value.tagIds });

async function priorSave(client, identity, id, revision, requestId, operation) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('product-save:'||$1::text||':'||$2::text,0))", [identity.organization_id, requestId]);
  const prior = (await client.query('SELECT product_id,revision,previous_revision,operation,saved_by FROM product_versions WHERE organization_id=$1 AND request_id=$2', [identity.organization_id, requestId])).rows[0];
  if (!prior) return null;
  if (prior.product_id !== id || (prior.previous_revision ?? 0) !== revision || prior.operation !== operation || prior.saved_by !== identity.user_id) {
    throw new HttpError(409, 'save_request_reused', 'This save request was already used for another change.');
  }
  return loadProduct(client, identity, id, { atRevision: prior.revision });
}

async function appendTags(client, organizationId, productId, revision, tagIds) {
  if (!tagIds.length) return;
  await client.query(`INSERT INTO product_version_tags(organization_id,product_id,revision,tag_id,position)
    SELECT $1,$2,$3,tag_id,position-1 FROM unnest($4::uuid[]) WITH ORDINALITY AS tags(tag_id,position)`, [organizationId, productId, revision, tagIds]);
}

export async function saveProduct(client, identity, value) {
  requirePermission(identity, 'masters.manage'); const input = productInput(value);
  const prior = await priorSave(client, identity, input.id, input.revision, input.requestId, input.revision ? 'update' : 'create');
  if (prior) {
    if (JSON.stringify(authoredFields(prior)) !== JSON.stringify(authoredFields(input))) throw new HttpError(409, 'save_request_reused', 'This save request was already used for different values.');
    return prior;
  }
  const current = (await client.query('SELECT revision,active FROM products WHERE organization_id=$1 AND id=$2 FOR UPDATE', [identity.organization_id, input.id])).rows[0];
  if (input.revision && !current?.active) throw new HttpError(404, 'product_not_found', 'Product was not found.');
  if ((current?.revision ?? 0) !== input.revision) throw new HttpError(409, 'stale_product', 'The product changed. Reload before saving.');
  if (input.tagIds.length) {
    const tags = await client.query('SELECT id FROM tags WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND active ORDER BY id FOR SHARE', [identity.organization_id, input.tagIds]);
    if (tags.rowCount !== input.tagIds.length) throw new HttpError(400, 'invalid_product_tags', 'Select active tags in this organization.');
  }
  if (input.jobTemplateId && !(await client.query('SELECT 1 FROM product_template_labels WHERE organization_id=$1 AND template_id=$2 AND active', [identity.organization_id, input.jobTemplateId])).rowCount) {
    throw new HttpError(400, 'invalid_product_template', 'Select an active template in this organization.');
  }
  const args = [identity.organization_id, input.id, input.name, input.key, input.description, input.abbreviation, input.jobTemplateId, input.tagIds.length, input.requestId];
  try {
    if (!input.revision) await client.query(`INSERT INTO products(organization_id,id,name,code,description,abbreviation,job_template_id,tag_count,save_request_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, args);
    else await client.query(`UPDATE products SET name=$3,code=$4,description=$5,abbreviation=$6,job_template_id=$7,tag_count=$8,save_request_id=$9,
      revision=revision+1,updated_at=transaction_timestamp() WHERE organization_id=$1 AND id=$2`, args);
    await appendTags(client, identity.organization_id, input.id, input.revision + 1, input.tagIds);
    if (input.revision) await client.query('DELETE FROM product_tags WHERE organization_id=$1 AND product_id=$2', [identity.organization_id, input.id]);
    if (input.tagIds.length) await client.query('INSERT INTO product_tags(organization_id,product_id,tag_id) SELECT $1,$2,tag_id FROM unnest($3::uuid[]) AS tags(tag_id)', [identity.organization_id, input.id, input.tagIds]);
  } catch (error) {
    if (error.constraint === 'product_save_request_key') throw new HttpError(409, 'save_request_reused', 'This save request was already used for another change.');
    if (error.code === '23505') throw new HttpError(409, 'duplicate_product', 'The product key or identifier is already in use.');
    if (error.constraint === 'product_active_tag') throw new HttpError(400, 'invalid_product_tags', 'Select active tags in this organization.');
    if (error.constraint === 'product_active_template') throw new HttpError(400, 'invalid_product_template', 'Select an active template in this organization.');
    throw error;
  }
  return loadProduct(client, identity, input.id);
}

export async function retireProduct(client, identity, input) {
  requirePermission(identity, 'masters.manage'); fieldsOnly(input, ['id', 'requestId', 'revision']);
  const id = uuid(input.id, 'Product').toLowerCase(); const requestId = uuid(input.requestId, 'Delete request').toLowerCase();
  const revision = integer(input.revision, 'Revision', 1, 2_147_483_646);
  const prior = await priorSave(client, identity, id, revision, requestId, 'retire');
  if (prior) return { id, revision: prior.revision };
  const current = (await client.query('SELECT revision,active FROM products WHERE organization_id=$1 AND id=$2 FOR UPDATE', [identity.organization_id, id])).rows[0];
  if (!current?.active) throw new HttpError(404, 'product_not_found', 'Product was not found.');
  if (current.revision !== revision) throw new HttpError(409, 'stale_product', 'The product changed. Reload before deleting.');
  const record = await loadProduct(client, identity, id);
  await client.query(`UPDATE products SET active=false,save_request_id=$3,tag_count=$4,revision=revision+1,updated_at=transaction_timestamp()
    WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id, requestId, record.tagIds.length]);
  await appendTags(client, identity.organization_id, id, revision + 1, record.tagIds);
  return { id, revision: revision + 1 };
}

const literalSearch = (value) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
const columnSearch = (value) => literalSearch(value).replace(/\s+/g, '%');
function searchText(value, label) {
  const result = text(value, label, 500, { optional: true }).trim();
  if (result.includes('\0')) throw new HttpError(400, 'invalid_input', `${label} cannot contain null characters.`);
  return result;
}

const listColumns = { name: 'product.name', description: 'product.description', key: 'product.code', job_template_id: 'label.name', tags: 'selected.names' };
const tagNameMatch = (match) => `EXISTS (SELECT 1 FROM product_tags link JOIN tags tag ON tag.organization_id=link.organization_id AND tag.id=link.tag_id
  WHERE link.organization_id=product.organization_id AND link.product_id=product.id AND tag.name ILIKE ${match})`;

export async function listProducts(client, identity, input = {}) {
  requireRead(identity); fieldsOnly(input, ['page', 'pageSize', 'search', 'filters', 'sort']);
  const page = integer(input.page ?? 1, 'Page', 1, 1_000_000); const pageSize = integer(input.pageSize ?? 10, 'Page size', 1, 100);
  const search = searchText(input.search, 'Search'); const args = [identity.organization_id];
  const conditions = ['product.organization_id=$1', 'product.active'];
  const bind = (value) => { args.push(value); return `$${args.length}`; };
  if (search) {
    const match = bind(literalSearch(search));
    conditions.push(`(product.name ILIKE ${match} OR product.description ILIKE ${match} OR product.code ILIKE ${match} OR label.name ILIKE ${match} OR ${tagNameMatch(match)})`);
  }
  const filters = input.filters ?? {}; fieldsOnly(filters, Object.keys(listColumns));
  for (const [key, filter] of Object.entries(filters)) {
    fieldsOnly(filter, key === 'tags' ? ['type', 'value', 'labels'] : ['type', 'value']);
    if (key === 'tags') {
      if (filter.type !== 'relation' || !Array.isArray(filter.value) || filter.value.length > 500) throw new HttpError(400, 'invalid_filter', 'Select at most 500 tag filters.');
      const ids = filter.value.map((value) => uuid(value, 'Tag filter').toLowerCase());
      if (new Set(ids).size !== ids.length) throw new HttpError(400, 'invalid_filter', 'Each tag filter can be selected only once.');
      // Labels only restore the source filter control; they never participate in SQL matching.
      if (filter.labels !== undefined) {
        fieldsOnly(filter.labels, filter.value);
        for (const label of Object.values(filter.labels)) searchText(label, 'Tag filter label');
      }
      if (ids.length) conditions.push(`EXISTS (SELECT 1 FROM product_tags link WHERE link.organization_id=product.organization_id AND link.product_id=product.id AND link.tag_id=ANY(${bind(ids)}::uuid[]))`);
    } else {
      if (filter.type !== 'text') throw new HttpError(400, 'invalid_filter', 'Product filters require text.');
      const value = searchText(filter.value, 'Filter');
      if (value) conditions.push(`${listColumns[key]} ILIKE ${bind(columnSearch(value))}`);
    }
  }
  const sort = input.sort;
  if (sort) {
    fieldsOnly(sort, ['key', 'dir']);
    if (!Object.hasOwn(listColumns, sort.key) || !['asc', 'desc'].includes(sort.dir)) throw new HttpError(400, 'invalid_sort', 'Sort column or direction is invalid.');
  }
  const order = sort ? `${listColumns[sort.key]} ${sort.dir} NULLS LAST` : 'product.created_at DESC';
  const from = `FROM products product LEFT JOIN product_template_labels label ON label.organization_id=product.organization_id AND label.template_id=product.job_template_id`;
  const where = `WHERE ${conditions.join(' AND ')}`;
  const totalCount = (await client.query(`SELECT count(*)::integer AS total ${from} ${where}`, args)).rows[0].total;
  const rows = (await client.query(`SELECT product.id AS _id,product.revision,product.name,product.description,product.code AS key,label.name AS job_template_id,selected.names AS tags
    ${from} LEFT JOIN LATERAL (
      SELECT string_agg(tag.name, ', ' ORDER BY saved.position NULLS LAST,lower(tag.name),link.tag_id) AS names
      FROM product_tags link JOIN tags tag ON tag.organization_id=link.organization_id AND tag.id=link.tag_id
      LEFT JOIN product_version_tags saved ON saved.organization_id=link.organization_id AND saved.product_id=link.product_id AND saved.tag_id=link.tag_id AND saved.revision=product.revision
      WHERE link.organization_id=product.organization_id AND link.product_id=product.id
    ) selected ON true ${where} ORDER BY ${order},product.id DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
  [...args, pageSize, (page - 1) * pageSize])).rows;
  return { rows, totalCount };
}

export async function productTags(client, identity, input = {}) {
  requireRead(identity); fieldsOnly(input, ['search']);
  const search = searchText(input.search, 'Tag search');
  const rows = (await client.query(`SELECT id,name FROM tags WHERE organization_id=$1 AND active AND name ILIKE $2 ORDER BY name,id LIMIT 101`,
    [identity.organization_id, literalSearch(search)])).rows;
  return { rows: rows.slice(0, 100), hasMore: rows.length > 100 };
}

export async function productTemplates(client, identity, input = {}) {
  requireRead(identity); fieldsOnly(input, ['search']);
  const search = searchText(input.search, 'Template search');
  const rows = (await client.query(`SELECT template_id AS id,name FROM product_template_labels WHERE organization_id=$1 AND active AND name ILIKE $2 ORDER BY name,template_id LIMIT 101`,
    [identity.organization_id, literalSearch(search)])).rows;
  return { rows: rows.slice(0, 100), hasMore: rows.length > 100 };
}
