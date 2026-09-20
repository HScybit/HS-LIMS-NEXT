import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { and, eq } from 'drizzle-orm';
import { HttpError } from '../auth/errors.js';
import { database } from '../db/pool.js';
import { reportImageAssets } from '../db/report-assets-schema.js';
import { requirePermission, uuid } from '../templates/input.js';
import { validateReportSvg } from './svg.js';

export const reportImageByteLimit = 10 * 1024 * 1024;
const mediaTypes = new Map([['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp'], ['svg', 'image/svg+xml']]);
const summary = (row) => ({ id: row.id, originalName: row.originalName, mediaType: row.mediaType, byteLength: row.byteLength,
  sha256: row.sha256, width: row.width, height: row.height, url: `/api/report-assets/images/${row.id}` });

export async function validateReportImage(content, declaredType) {
  if (!Buffer.isBuffer(content) || !content.length) throw new HttpError(422, 'empty_report_image', 'Select a non-empty report image.');
  if (content.length > reportImageByteLimit) throw new HttpError(413, 'report_image_size_limit', 'Report images can be at most 10 MiB.');
  if (![...mediaTypes.values()].includes(declaredType)) throw new HttpError(415, 'report_image_type', 'Use a PNG, JPEG, WebP or static SVG report image.');
  if (declaredType === 'image/svg+xml') validateReportSvg(content);
  const decoder = sharp(content, { failOn: 'error', limitInputPixels: 40_000_000 });
  try {
    const metadata = await decoder.metadata();
    if (mediaTypes.get(metadata.format) !== declaredType) throw new HttpError(415, 'report_image_type', 'The image content does not match its declared type.');
    if (!metadata.width || !metadata.height || metadata.width > 10_000 || metadata.height > 10_000 || metadata.width * metadata.height > 40_000_000) {
      throw new HttpError(422, 'report_image_dimensions', 'Report images must fit within 10,000 pixels per side and 40 megapixels.');
    }
    if ((metadata.pages ?? 1) !== 1) throw new HttpError(422, 'animated_report_image', 'Use a static image for printed reports.');
    // Metadata alone does not decode compressed pixels or find truncated data.
    await decoder.stats();
    return { width: metadata.width, height: metadata.height, mediaType: declaredType, byteLength: content.length, sha256: createHash('sha256').update(content).digest('hex') };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, 'invalid_report_image', 'The image could not be decoded. Select a valid PNG, JPEG, WebP or static SVG file.');
  } finally { decoder.destroy(); }
}

export async function uploadReportImage(client, identity, { requestId, originalName, mediaType, content }) {
  requirePermission(identity, 'report_settings.manage');
  const id = uuid(requestId, 'Image upload request').toLowerCase();
  if (typeof originalName !== 'string' || !originalName.trim() || originalName.trim().length > 255 || /[\u0000-\u001f\u007f/\\]/.test(originalName)) {
    throw new HttpError(400, 'invalid_image_name', 'Provide an image filename of at most 255 characters.');
  }
  const details = await validateReportImage(content, mediaType);
  const values = { organizationId: identity.organization_id, id, originalName: originalName.trim(), content, ...details, uploadedBy: identity.user_id };
  const db = database(client);
  // A stable request ID survives a lost response; bytes remain immutable.
  const inserted = await db.insert(reportImageAssets).values(values).onConflictDoNothing().returning({ id: reportImageAssets.id });
  const [stored] = await db.select().from(reportImageAssets).where(and(eq(reportImageAssets.organizationId, identity.organization_id), eq(reportImageAssets.id, id)));
  if (!stored || stored.uploadedBy !== identity.user_id || stored.originalName !== values.originalName || stored.mediaType !== mediaType || stored.sha256 !== details.sha256) {
    throw new HttpError(409, 'image_request_reused', 'This upload request was already used with different details.');
  }
  return { ...summary(stored), replayed: !inserted.length };
}

export async function readReportImage(client, identity, imageId) {
  if (!identity.permission_codes.some((code) => ['report_settings.read', 'report_settings.manage'].includes(code))) throw new HttpError(403, 'forbidden', 'You cannot view report assets.');
  const id = uuid(imageId, 'Report image').toLowerCase();
  const [row] = await database(client).select().from(reportImageAssets).where(and(eq(reportImageAssets.organizationId, identity.organization_id), eq(reportImageAssets.id, id)));
  if (!row) throw new HttpError(404, 'report_image_not_found', 'Report image was not found.');
  if (row.mediaType === 'image/svg+xml') validateReportSvg(row.content);
  return { ...summary(row), content: row.content };
}
