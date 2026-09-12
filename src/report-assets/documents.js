import { HttpError } from '../auth/errors.js';
import { fieldsOnly, uuid, integer, bool, text, requirePermission } from '../templates/input.js';
import { reportContentHtml } from './markup.js';

function requireRead(identity) {
  if (!identity.permission_codes?.some((permission) => ['report_settings.read', 'report_settings.manage'].includes(permission))) {
    throw new HttpError(403, 'forbidden', 'You cannot view report templates.');
  }
}
function documentType(value) {
  if (!['header', 'footer'].includes(value)) throw new HttpError(400, 'invalid_document_type', 'Choose a header or footer template.');
  return value;
}
const selection = `document.id,document.type,version.id AS "versionId",version.revision,version.name,
  version.template_html AS "templateHtml",version.is_retired AS "isRetired",version.saved_by AS "savedBy",version.saved_at AS "savedAt",
  coalesce(defaults.default_header_id=document.id,false) AS "isDefault",
  ARRAY(SELECT image.image_id FROM report_document_images image WHERE image.organization_id=version.organization_id AND image.version_id=version.id ORDER BY image.image_id) AS "imageIds"`;
const currentDocuments = `SELECT document.*,version.id AS version_id,version.name,version.template_html,version.saved_at,version.is_retired
  FROM report_documents document JOIN LATERAL (SELECT * FROM report_document_versions item
    WHERE item.organization_id=document.organization_id AND item.document_id=document.id ORDER BY item.revision DESC LIMIT 1) version ON true
  WHERE document.organization_id=$1 AND document.type=$2 AND NOT version.is_retired`;

function checkedDocument(row) {
  const parsed = reportContentHtml(row.templateHtml);
  if (parsed.imageIds.slice().sort().join(',') !== row.imageIds.slice().sort().join(',')) {
    throw new HttpError(409, 'report_document_images_changed', 'The template image references do not match its saved version.');
  }
  return { ...row, templateHtml: parsed.html };
}

export async function listReportDocuments(client, identity, input = {}) {
  requireRead(identity);
  const type = documentType(input.type); const query = text(input.query ?? '', 'Search', 200, { optional: true }).trim();
  const page = integer(input.page ?? 1, 'Page', 1, 1_000_000); const pageSize = integer(input.pageSize ?? 10, 'Page size', 1, 100);
  const search = query.toLowerCase();
  const filter = `position($3 in lower(name||' '||regexp_replace(template_html,'<[^>]+>',' ','g')))>0`;
  const totals = (await client.query(`WITH current AS (${currentDocuments}) SELECT count(*)::integer AS total,
    count(*) FILTER(WHERE ${filter})::integer AS "filteredTotal",
    (SELECT current.id FROM current JOIN report_document_defaults defaults ON defaults.organization_id=current.organization_id AND defaults.default_header_id=current.id) AS "defaultHeaderId",
    (SELECT current.name FROM current JOIN report_document_defaults defaults ON defaults.organization_id=current.organization_id AND defaults.default_header_id=current.id) AS "defaultHeaderName"
    FROM current`, [identity.organization_id, type, search])).rows[0];
  const currentPage = Math.min(page, Math.max(1, Math.ceil(totals.filteredTotal / pageSize)));
  const rows = (await client.query(`WITH current AS (${currentDocuments}), selected AS (
    SELECT * FROM current WHERE ${filter} ORDER BY saved_at DESC,name,id LIMIT $4 OFFSET $5)
    SELECT ${selection} FROM selected document JOIN report_document_versions version ON version.organization_id=document.organization_id AND version.id=document.version_id
    LEFT JOIN report_document_defaults defaults ON defaults.organization_id=document.organization_id ORDER BY version.saved_at DESC,version.name,document.id`,
  [identity.organization_id, type, search, pageSize, (currentPage - 1) * pageSize])).rows;
  return { items: rows.map(checkedDocument), total: totals.total, filteredTotal: totals.filteredTotal, page: currentPage, pageSize,
    defaultHeader: totals.defaultHeaderId ? { id: totals.defaultHeaderId, name: totals.defaultHeaderName } : null,
    canManage: identity.permission_codes.includes('report_settings.manage') };
}

export async function loadReportDocument(client, identity, documentId, { versionId, includeRetired = false } = {}) {
  requireRead(identity); uuid(documentId, 'Report template'); if (versionId) uuid(versionId, 'Report template version');
  const row = (await client.query(`SELECT ${selection} FROM report_documents document
    JOIN report_document_versions version ON version.organization_id=document.organization_id AND version.document_id=document.id
    LEFT JOIN report_document_defaults defaults ON defaults.organization_id=document.organization_id
    WHERE document.organization_id=$1 AND document.id=$2 AND ($3::uuid IS NULL OR version.id=$3) ORDER BY version.revision DESC LIMIT 1`,
  [identity.organization_id, documentId, versionId ?? null])).rows[0];
  if (!row || row.isRetired && !includeRetired) throw new HttpError(404, 'report_document_not_found', 'Report template was not found.');
  return checkedDocument(row);
}

async function saveVersion(client, identity, input, retired) {
  const parsed = reportContentHtml(input.templateHtml);
  if (parsed.imageIds.length > 100) throw new HttpError(422, 'report_document_image_limit', 'A report template may reference at most 100 images.');
  let saved;
  try {
    saved = (await client.query('SELECT * FROM report_save_document($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [input.documentId, input.requestId, input.revision, input.type, input.name, parsed.html, input.isDefault, retired, parsed.imageIds])).rows[0];
  } catch (error) {
    if (error.code === '40001') throw new HttpError(409, 'stale_report_document', 'This template changed. Reload it before saving.');
    if (error.constraint === 'report_document_request_reused') throw new HttpError(409, 'report_document_request_reused', 'This save request was already used with different content.');
    if (error.constraint === 'report_document_retired') throw new HttpError(409, 'report_document_retired', 'This template has been deleted. Reload the list.');
    if (error.constraint === 'report_document_images') throw new HttpError(422, 'report_document_images', 'Upload the referenced images in this organization. Their total size must fit within 25 MiB.');
    throw error;
  }
  return { document: await loadReportDocument(client, identity, input.documentId, { versionId: saved.version_id, includeRetired: true }), replayed: saved.replayed };
}

export async function saveReportDocument(client, identity, input) {
  requirePermission(identity, 'report_settings.manage');
  fieldsOnly(input, ['documentId', 'requestId', 'revision', 'type', 'name', 'templateHtml', 'isDefault']);
  const value = { documentId: uuid(input.documentId, 'Report template').toLowerCase(), requestId: uuid(input.requestId, 'Save request').toLowerCase(),
    revision: integer(input.revision, 'Revision', 0, 2_147_483_646), type: documentType(input.type), name: text(input.name, 'Template name', 200),
    templateHtml: input.templateHtml === undefined ? '' : input.templateHtml, isDefault: input.isDefault === undefined ? false : bool(input.isDefault, 'Default header') };
  if (value.type !== 'header' && value.isDefault) throw new HttpError(400, 'invalid_default_header', 'Only a header can be the default header.');
  return saveVersion(client, identity, value, false);
}

export async function deleteReportDocument(client, identity, documentId, input) {
  requirePermission(identity, 'report_settings.manage'); fieldsOnly(input, ['requestId', 'revision']);
  const requestId = uuid(input.requestId, 'Delete request').toLowerCase(); const revision = integer(input.revision, 'Revision', 1, 2_147_483_646);
  // Read the stated revision, so a retry after later activity compares against
  // its original content instead of silently substituting a newer version.
  const version = (await client.query('SELECT id FROM report_document_versions WHERE organization_id=$1 AND document_id=$2 AND revision=$3',
    [identity.organization_id, uuid(documentId, 'Report template'), revision])).rows[0];
  if (!version) throw new HttpError(404, 'report_document_not_found', 'Report template was not found.');
  const previous = await loadReportDocument(client, identity, documentId, { versionId: version.id });
  return saveVersion(client, identity, { documentId, requestId, revision, type: previous.type, name: previous.name, templateHtml: previous.templateHtml, isDefault: false }, true);
}
