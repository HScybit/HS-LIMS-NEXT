import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, uuid, requirePermission } from '../templates/input.js';
import { customCssImageIds, currentCustomCss } from './css-resources.js';
import { validateReportImage } from './images.js';

function requireRead(identity) {
  if (!identity.permission_codes?.some((permission) => ['report_settings.read', 'report_settings.manage'].includes(permission))) {
    throw new HttpError(403, 'forbidden', 'You cannot view Custom CSS settings.');
  }
}

// Authored CSS is content. Preserve the source newline normalization and raw-tag
// check; publication/rendering separately resolves its captured dependencies.
export function customCssInput(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new HttpError(400, 'invalid_custom_css', 'Enter raw CSS text.');
  const css = value.replace(/\r\n/g, '\n');
  if (css.length > 1_000_000) throw new HttpError(413, 'custom_css_size_limit', 'Custom CSS may contain at most 1000000 characters.');
  if (/<\/?\s*(script|style)\b/i.test(css)) throw new HttpError(400, 'invalid_custom_css', 'Only raw CSS is supported. Remove style and script tags.');
  return css;
}

export async function loadCustomCss(client, identity, { versionId } = {}) {
  requireRead(identity); if (versionId) uuid(versionId, 'Custom CSS version');
  const row = (await client.query(`SELECT id AS "versionId",revision,css_content AS "cssContent",saved_by AS "savedBy",saved_at AS "updatedAt"
    FROM organization_custom_css_versions WHERE organization_id=$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY revision DESC LIMIT 1`,
  [identity.organization_id, versionId ?? null])).rows[0];
  if (!row && versionId) throw new HttpError(404, 'custom_css_not_found', 'Custom CSS version was not found.');
  return row ?? { versionId: null, revision: 0, cssContent: '', savedBy: null, updatedAt: null };
}

export async function saveCustomCss(client, identity, input) {
  requirePermission(identity, 'report_settings.manage'); fieldsOnly(input, ['requestId', 'revision', 'cssContent']);
  const requestId = uuid(input.requestId, 'Save request').toLowerCase(); const revision = integer(input.revision, 'Revision', 0, 2_147_483_646);
  const css = customCssInput(input.cssContent); const imageIds = customCssImageIds(css); let saved;
  try {
    saved = (await client.query('SELECT * FROM report_save_custom_css($1,$2,$3,$4)', [requestId, revision, css, imageIds])).rows[0];
  } catch (error) {
    if (error.code === '40001') throw new HttpError(409, 'stale_custom_css', 'Custom CSS changed. Reload it before saving.');
    if (error.constraint === 'custom_css_request_reused') throw new HttpError(409, 'custom_css_request_reused', 'This save request was already used with different CSS.');
    if (error.constraint === 'custom_css_images') throw new HttpError(422, 'custom_css_images', 'A stylesheet image is unavailable or the images exceed 24 MiB.');
    throw error;
  }
  return { ...await loadCustomCss(client, identity, { versionId: saved.version_id }), replayed: saved.replayed };
}

export async function loadCurrentCustomCss(client) {
  const rows = (await client.query('SELECT * FROM report_current_custom_css()')).rows;
  const version = rows.find((row) => row.kind === 'stylesheet');
  if (!version) return { versionId: null, revision: 0, cssContent: '', updatedAt: null };
  if (Number(version.image_bytes) > 24 * 1024 * 1024) throw new HttpError(422, 'report_asset_size_limit', 'The stylesheet images exceed 24 MiB.');
  const images = new Map();
  for (const row of rows.filter((item) => item.kind === 'image')) {
    await validateReportImage(row.content, row.media_type);
    images.set(row.id, `data:${row.media_type};base64,${row.content.toString('base64')}`);
  }
  const parsed = currentCustomCss(version.css_content, images);
  if (parsed.imageIds.join(',') !== version.image_ids.slice().sort().join(',')) throw new HttpError(409, 'report_asset_history_unavailable', 'The stylesheet image references do not match its saved content.');
  return { versionId: version.id, revision: version.revision, cssContent: parsed.css, updatedAt: version.saved_at };
}
