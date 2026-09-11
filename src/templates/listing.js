import { HttpError } from '../auth/errors.js';
import { requirePermission, fieldsOnly, integer, text, dateOnly } from './input.js';

const columns = { name: 'name', description: 'description', uuid: 'code', created_at: 'created_at' };
const literalSearch = (value) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;

export async function listTemplateRows(client, identity, input = {}) {
  requirePermission(identity, 'templates.read');
  fieldsOnly(input, ['page', 'pageSize', 'search', 'filters', 'sort']);
  const page = integer(input.page ?? 1, 'Page', 1, 1_000_000);
  const pageSize = integer(input.pageSize ?? 10, 'Page size', 1, 100);
  const search = text(input.search, 'Search', 500, { optional: true }).trim();
  const parameters = [identity.organization_id];
  const conditions = [];
  const bind = (value) => { parameters.push(value); return `$${parameters.length}`; };
  if (search) {
    const parameter = bind(literalSearch(search));
    conditions.push(`(name ILIKE ${parameter} OR description ILIKE ${parameter} OR code ILIKE ${parameter})`);
  }
  const filters = input.filters ?? {};
  fieldsOnly(filters, Object.keys(columns));
  for (const [key, filter] of Object.entries(filters)) {
    fieldsOnly(filter, key === 'created_at' ? ['type', 'from', 'to'] : ['type', 'value']);
    if (key === 'created_at') {
      if (filter.type !== 'date') throw new HttpError(400, 'invalid_filter', 'Date filter is invalid.');
      if (filter.from) conditions.push(`created_at >= ${bind(dateOnly(filter.from))}::date`);
      if (filter.to) conditions.push(`created_at < ${bind(dateOnly(filter.to))}::date + interval '1 day'`);
    } else {
      if (filter.type !== 'text') throw new HttpError(400, 'invalid_filter', 'Text filter is invalid.');
      const value = text(filter.value, 'Filter', 500, { optional: true }).trim();
      if (value) conditions.push(`${columns[key]} ILIKE ${bind(literalSearch(value))}`);
    }
  }
  const sort = input.sort;
  if (sort) {
    fieldsOnly(sort, ['key', 'dir']);
    if (!Object.hasOwn(columns, sort.key) || !['asc', 'desc'].includes(sort.dir)) throw new HttpError(400, 'invalid_sort', 'Sort column or direction is invalid.');
  }
  const order = sort ? `${columns[sort.key]} ${sort.dir}` : 'created_at DESC';
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const latest = `WITH latest AS (SELECT DISTINCT ON (t.id) t.id, t.code, t.created_at, v.id AS version_id,
    v.name, v.description, v.kind, v.status, v.number, v.revision FROM templates t JOIN template_versions v
    ON v.organization_id = t.organization_id AND v.template_id = t.id
    WHERE t.organization_id = $1 AND t.active AND v.status <> 'building' ORDER BY t.id, (v.status = 'draft') DESC, v.number DESC)`;
  const count = await client.query(`${latest} SELECT count(*)::integer AS total FROM latest ${where}`, parameters);
  const pageParameters = [...parameters, pageSize, (page - 1) * pageSize];
  const rows = await client.query(`${latest} SELECT id AS _id, name, description, code AS uuid, created_at, version_id AS "versionId", kind, status
    FROM latest ${where} ORDER BY ${order}, id LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`, pageParameters);
  return { rows: rows.rows, totalCount: count.rows[0].total };
}
