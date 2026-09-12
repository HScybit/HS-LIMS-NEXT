import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { database } from '../db/pool.js';
import { templateFields, templateImageAssets } from '../db/template-schema.js';
import { HttpError } from '../auth/errors.js';
import { requirePermission, uuid, revision } from '../templates/input.js';
import { loadDefinition } from '../templates/loader.js';
import { validateTemplateImage } from './images.js';

const checksum = (content) => createHash('sha256').update(content).digest('hex');
export function templateImageSources(row) {
  if (!Buffer.isBuffer(row.content) || !Buffer.isBuffer(row.print_content)
    || checksum(row.content) !== row.sha256 || checksum(row.print_content) !== row.print_sha256) {
    throw new HttpError(409, 'template_image_history_unavailable', 'The stored template image is unavailable.');
  }
  return { src: `data:${row.media_type};base64,${row.content.toString('base64')}`, printSrc: `data:image/png;base64,${row.print_content.toString('base64')}` };
}

export async function withTemplateImages(client, organizationId, loaded, capture) {
  const imageCounts = new Map();
  const add = (id) => { if (id) imageCounts.set(id, (imageCounts.get(id) ?? 0) + 1); };
  const fields = Object.values(loaded.model.fieldsById).filter((field) => field.widget === 'template_image_widget');
  if (capture) {
    const values = new Map(capture.values.map((value) => [`${value.fieldId}:${value.occurrenceId}`, value]));
    const groups = new Map();
    for (const field of fields) { const group = field.repeatGroupId ?? null; if (!groups.has(group)) groups.set(group, []); groups.get(group).push(field); }
    for (const occurrence of capture.occurrences) for (const field of groups.get(occurrence.groupId ?? null) ?? []) {
      const value = values.get(`${field.id}:${occurrence.id}`);
      add(value?.state === 'present' && value.imageId ? value.imageId : field.defaultImageId);
    }
  } else for (const field of fields) add(field.defaultImageId);
  const ids = [...imageCounts.keys()];
  if (!ids.length) return loaded;
  const started = performance.now();
  const rows = (await client.query(`WITH images AS MATERIALIZED (SELECT id,media_type,byte_length,print_byte_length,content,print_content,sha256,print_sha256
    FROM template_image_assets WHERE organization_id=$1 AND id=ANY($2::uuid[])), size AS (SELECT coalesce(sum(byte_length::bigint+print_byte_length),0) AS bytes FROM images)
    SELECT id,media_type,sha256,print_sha256,(SELECT bytes FROM size) AS bytes,
      CASE WHEN (SELECT bytes FROM size)<=25165824 THEN content END AS content,
      CASE WHEN (SELECT bytes FROM size)<=25165824 THEN print_content END AS print_content FROM images`, [organizationId, ids])).rows;
  const databaseMs = performance.now() - started;
  if (rows.some((row) => Number(row.bytes) > 24 * 1024 * 1024)) throw new HttpError(422, 'template_image_batch_size_limit', 'The template images exceed 24 MiB.');
  if (rows.length !== ids.length) throw new HttpError(409, 'template_image_history_unavailable', 'A stored template image is unavailable.');
  const imageSources = Object.fromEntries(rows.map((row) => [row.id, templateImageSources(row)]));
  const renderedBytes = ids.reduce((sum, id) => sum + imageCounts.get(id) * (imageSources[id].src.length + imageSources[id].printSrc.length), 0);
  if (renderedBytes > 32 * 1024 * 1024) throw new HttpError(422, 'template_image_batch_size_limit', 'The expanded template images exceed 32 MiB.');
  return { ...loaded, model: { ...loaded.model, imageSources }, metrics: { ...loaded.metrics,
    assets: { queryCount: 1, databaseMs, images: rows.length, bytes: Number(rows[0]?.bytes ?? 0), renderedBytes } } };
}

export async function uploadTemplateImage(client, identity, versionId, fieldId, expectedRevision, input) {
  requirePermission(identity, 'templates.manage');
  versionId = uuid(versionId, 'Template version').toLowerCase(); fieldId = uuid(fieldId, 'Image field').toLowerCase(); revision(expectedRevision);
  const id = uuid(input.requestId, 'Image upload request').toLowerCase();
  if (typeof input.originalName !== 'string' || !input.originalName.trim() || input.originalName.trim().length > 255 || /[\u0000-\u001f\u007f/\\]/.test(input.originalName)) {
    throw new HttpError(400, 'invalid_image_name', 'Provide an image filename of at most 255 characters.');
  }
  const details = await validateTemplateImage(input.content, input.mediaType);
  // The same version lock serializes replacement with authoring, cloning and freezing.
  const version = (await client.query('SELECT revision,status FROM template_versions WHERE organization_id=$1 AND id=$2 FOR UPDATE', [identity.organization_id, versionId])).rows[0];
  const db = database(client);
  const [field] = await db.select().from(templateFields).where(and(eq(templateFields.organizationId, identity.organization_id), eq(templateFields.versionId, versionId), eq(templateFields.id, fieldId)));
  if (!version || !field || field.widget !== 'template_image_widget') throw new HttpError(404, 'template_image_field_not_found', 'The template image field was not found.');
  const [existing] = await db.select({ id: templateImageAssets.id, sha256: templateImageAssets.sha256, mediaType: templateImageAssets.mediaType,
    originalName: templateImageAssets.originalName, uploadedBy: templateImageAssets.uploadedBy }).from(templateImageAssets)
    .where(and(eq(templateImageAssets.organizationId, identity.organization_id), eq(templateImageAssets.id, id)));
  if (existing) {
    if (existing.sha256 !== details.sha256 || existing.mediaType !== details.mediaType || existing.originalName !== input.originalName.trim() || existing.uploadedBy !== identity.user_id) {
      throw new HttpError(409, 'image_request_reused', 'This image upload request was already used with different details.');
    }
    if (field.defaultImageId !== id) throw new HttpError(409, 'stale_template', 'The image changed. Reload the template before uploading again.');
    return { ...await withTemplateImages(client, identity.organization_id, await loadDefinition(client, identity.organization_id, versionId)), replayed: true };
  }
  if (version.status !== 'draft' || version.revision !== expectedRevision) throw new HttpError(409, 'stale_template', 'This template changed or was frozen. Reload before uploading again.');
  const inserted = await db.insert(templateImageAssets).values({ organizationId: identity.organization_id, id, originalName: input.originalName.trim(),
    content: input.content, uploadedBy: identity.user_id, ...details }).onConflictDoNothing().returning({ id: templateImageAssets.id });
  if (!inserted.length) throw new HttpError(409, 'image_request_reused', 'This image upload request was already used.');
  await client.query('UPDATE template_versions SET revision=revision+1 WHERE organization_id=$1 AND id=$2', [identity.organization_id, versionId]);
  await db.update(templateFields).set({ defaultState: 'present', defaultImageId: id }).where(and(eq(templateFields.organizationId, identity.organization_id), eq(templateFields.versionId, versionId), eq(templateFields.id, fieldId)));
  // Loading also checks the combined asset budget before this atomic replacement commits.
  return { ...await withTemplateImages(client, identity.organization_id, await loadDefinition(client, identity.organization_id, versionId)), replayed: false };
}
