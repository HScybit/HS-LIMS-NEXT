import { HttpError } from '../auth/errors.js';
import { fieldsOnly, uuid, integer, text, dateOnly, requirePermission } from '../templates/input.js';

function requireRead(identity) {
  if (!identity.permission_codes?.some((permission) => ['report_settings.read', 'report_settings.manage'].includes(permission))) {
    throw new HttpError(403, 'forbidden', 'You cannot view watermarks.');
  }
}
const columns = { name: 'name', created_at: 'created_at' };
const literalSearch = (value) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
const currentWatermarks = `WITH current AS (SELECT watermark.id,watermark.created_at,version.name,version.revision,version.is_retired
  FROM report_watermarks watermark JOIN LATERAL (SELECT * FROM report_watermark_versions item
    WHERE item.organization_id=watermark.organization_id AND item.watermark_id=watermark.id ORDER BY item.revision DESC LIMIT 1) version ON true
  WHERE watermark.organization_id=$1)`;

export async function listWatermarks(client, identity, input = {}) {
  requireRead(identity); fieldsOnly(input, ['page', 'pageSize', 'search', 'filters', 'sort']);
  const page = integer(input.page ?? 1, 'Page', 1, 1_000_000); const pageSize = integer(input.pageSize ?? 10, 'Page size', 1, 100);
  const search = text(input.search, 'Search', 500, { optional: true }).trim();
  const parameters = [identity.organization_id]; const conditions = ['NOT is_retired'];
  const bind = (value) => { parameters.push(value); return `$${parameters.length}`; };
  if (search) conditions.push(`name ILIKE ${bind(literalSearch(search))}`);
  const filters = input.filters ?? {}; fieldsOnly(filters, Object.keys(columns));
  for (const [key, filter] of Object.entries(filters)) {
    fieldsOnly(filter, key === 'created_at' ? ['type', 'from', 'to'] : ['type', 'value']);
    if (key === 'created_at') {
      if (filter.type !== 'date') throw new HttpError(400, 'invalid_filter', 'Date filter is invalid.');
      if (filter.from) conditions.push(`created_at >= ${bind(dateOnly(filter.from))}::date`);
      if (filter.to) conditions.push(`created_at < ${bind(dateOnly(filter.to))}::date + interval '1 day'`);
    } else {
      if (filter.type !== 'text') throw new HttpError(400, 'invalid_filter', 'Text filter is invalid.');
      const value = text(filter.value, 'Filter', 500, { optional: true }).trim();
      if (value) conditions.push(`name ILIKE ${bind(literalSearch(value))}`);
    }
  }
  const sort = input.sort;
  if (sort) {
    fieldsOnly(sort, ['key', 'dir']);
    if (!Object.hasOwn(columns, sort.key) || !['asc', 'desc'].includes(sort.dir)) throw new HttpError(400, 'invalid_sort', 'Sort column or direction is invalid.');
  }
  const order = sort ? `${columns[sort.key]} ${sort.dir}` : 'created_at DESC';
  const where = `WHERE ${conditions.join(' AND ')}`;
  const count = (await client.query(`${currentWatermarks} SELECT count(*)::integer AS total FROM current ${where}`, parameters)).rows[0].total;
  const rows = (await client.query(`${currentWatermarks} SELECT id AS _id,name,created_at,revision FROM current ${where}
    ORDER BY ${order},id DESC LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`, [...parameters, pageSize, (page - 1) * pageSize])).rows;
  return { rows, totalCount: count };
}

export async function loadWatermark(client, identity, watermarkId, { versionId, includeRetired = false } = {}) {
  requireRead(identity); uuid(watermarkId, 'Watermark'); if (versionId) uuid(versionId, 'Watermark version');
  const row = (await client.query(`SELECT watermark.id,watermark.created_at AS "createdAt",watermark.created_by AS "createdBy",
    version.id AS "versionId",version.revision,version.name,version.image_id AS "imageId",version.opacity,version.width,version.height,version.rotation,
    version.is_retired AS "isRetired",version.saved_by AS "savedBy",version.saved_at AS "savedAt",image.original_name AS "imageName"
    FROM report_watermarks watermark JOIN report_watermark_versions version ON version.organization_id=watermark.organization_id AND version.watermark_id=watermark.id
    JOIN report_image_assets image ON image.organization_id=version.organization_id AND image.id=version.image_id
    WHERE watermark.organization_id=$1 AND watermark.id=$2 AND ($3::uuid IS NULL OR version.id=$3) ORDER BY version.revision DESC LIMIT 1`,
  [identity.organization_id, watermarkId, versionId ?? null])).rows[0];
  if (!row || row.isRetired && !includeRetired) throw new HttpError(404, 'watermark_not_found', 'Watermark was not found.');
  return { ...row, opacity: Number(row.opacity), imageUrl: `/api/report-assets/images/${row.imageId}` };
}

async function saveVersion(client, identity, input, retired) {
  let saved;
  try {
    saved = (await client.query('SELECT * FROM report_save_watermark($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [input.watermarkId, input.requestId, input.revision, input.name, input.imageId, input.opacity, input.width, input.height, input.rotation, retired])).rows[0];
  } catch (error) {
    if (error.code === '40001') throw new HttpError(409, 'stale_watermark', 'This watermark changed. Reload it before saving.');
    if (error.constraint === 'report_watermark_request_reused') throw new HttpError(409, 'watermark_request_reused', 'This save request was already used with different content.');
    if (error.constraint === 'report_watermark_retired') throw new HttpError(409, 'watermark_retired', 'This watermark has been deleted. Reload the list.');
    if (error.constraint === 'report_watermark_image') throw new HttpError(422, 'watermark_image', 'Upload the watermark image in this organization.');
    throw error;
  }
  return { watermark: await loadWatermark(client, identity, input.watermarkId, { versionId: saved.version_id, includeRetired: true }), replayed: saved.replayed };
}

export async function saveWatermark(client, identity, input) {
  requirePermission(identity, 'report_settings.manage');
  fieldsOnly(input, ['watermarkId', 'requestId', 'revision', 'name', 'imageId', 'opacity', 'width', 'height', 'rotation']);
  if (typeof input.opacity !== 'number' || !Number.isFinite(input.opacity) || input.opacity < 0 || input.opacity > 1) {
    throw new HttpError(400, 'invalid_input', 'Opacity must be a number between 0 and 1.');
  }
  if (![0, 90, 180, 270, 360].includes(input.rotation)) throw new HttpError(400, 'invalid_input', 'Rotation must be 0, 90, 180, 270 or 360 degrees.');
  return saveVersion(client, identity, { watermarkId: uuid(input.watermarkId, 'Watermark').toLowerCase(), requestId: uuid(input.requestId, 'Save request').toLowerCase(),
    revision: integer(input.revision, 'Revision', 0, 2_147_483_646), name: text(input.name, 'Name', 200), imageId: uuid(input.imageId, 'Image').toLowerCase(),
    opacity: input.opacity, width: integer(input.width, 'Width', 1, 10_000), height: integer(input.height, 'Height', 1, 10_000), rotation: input.rotation }, false);
}

export async function deleteWatermark(client, identity, watermarkId, input) {
  requirePermission(identity, 'report_settings.manage'); fieldsOnly(input, ['requestId', 'revision']);
  const requestId = uuid(input.requestId, 'Delete request').toLowerCase(); const revision = integer(input.revision, 'Revision', 1, 2_147_483_646);
  const version = (await client.query('SELECT id FROM report_watermark_versions WHERE organization_id=$1 AND watermark_id=$2 AND revision=$3',
    [identity.organization_id, uuid(watermarkId, 'Watermark'), revision])).rows[0];
  if (!version) throw new HttpError(404, 'watermark_not_found', 'Watermark was not found.');
  // Use the stated version so a lost deletion response can replay unchanged.
  const previous = await loadWatermark(client, identity, watermarkId, { versionId: version.id });
  return saveVersion(client, identity, { ...previous, watermarkId, requestId, revision }, true);
}
