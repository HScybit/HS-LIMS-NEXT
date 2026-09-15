import { createHash } from 'node:crypto';
import { HttpError } from '../auth/errors.js';
import { fieldsOnly, uuid } from '../templates/input.js';
import { customFieldAttachmentMetadata } from '../custom-fields/attachments.js';
import { validateTemplateImage } from '../template-assets/images.js';

export const sampleImageByteLimit = 10 * 1024 * 1024;
const checksum = content => createHash('sha256').update(content).digest('hex');
const columns = `id,original_name AS "originalName",media_type AS "mediaType",byte_length AS "byteLength",sha256,
  width,height,frame_count AS "frameCount",uploaded_by AS "uploadedBy",uploaded_at AS "uploadedAt"`;
const metadata = row => ({ ...row, url: `/api/samples/images/${row.id}` });

export function requireSampleImageUpload(identity) {
  if (!identity.permission_codes?.some(code => ['samples.create', 'samples.manage'].includes(code))) {
    throw new HttpError(403, 'forbidden', 'You cannot upload sample images.');
  }
}

export async function validateSampleImage(content, mediaType) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mediaType)) throw new HttpError(415, 'sample_image_type', 'Product images must be JPEG, PNG or WebP files.');
  try {
    const { printContent: _content, printByteLength: _length, printSha256: _hash, ...details } = await validateTemplateImage(content, mediaType);
    return details;
  } catch (error) {
    if (error instanceof HttpError) throw new HttpError(error.status, error.code.replace('template_image', 'sample_image'), error.message.replace('Template images', 'Sample images').replace('JPEG, PNG, GIF or WebP', 'JPEG, PNG or WebP'));
    throw error;
  }
}

export async function uploadSampleImage(client, identity, input) {
  requireSampleImageUpload(identity);
  fieldsOnly(input, ['requestId', 'originalName', 'mediaType', 'content']);
  const id = uuid(input.requestId, 'Image upload request').toLowerCase();
  const name = customFieldAttachmentMetadata(input.originalName, input.mediaType);
  const details = await validateSampleImage(input.content, name.mediaType);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('sample-image:'||$1::text||':'||$2::text,0))", [identity.organization_id, id]);
  const stored = (await client.query(`SELECT ${columns} FROM sample_image_assets WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id])).rows[0];
  if (stored) {
    if (stored.uploadedBy !== identity.user_id || stored.originalName !== name.originalName || stored.mediaType !== details.mediaType
      || stored.byteLength !== details.byteLength || stored.sha256 !== details.sha256) {
      throw new HttpError(409, 'sample_image_request_reused', 'This upload request was already used for another image.');
    }
    return { ...metadata(stored), replayed: true };
  }
  try {
    const row = (await client.query(`INSERT INTO sample_image_assets(organization_id,id,original_name,media_type,content,byte_length,sha256,width,height,frame_count,uploaded_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${columns}`, [identity.organization_id, id, name.originalName, details.mediaType,
      input.content, details.byteLength, details.sha256, details.width, details.height, details.frameCount, identity.user_id])).rows[0];
    return { ...metadata(row), replayed: false };
  } catch (error) {
    if (error.constraint === 'sample_image_asset_pk') throw new HttpError(409, 'sample_image_request_reused', 'This upload request was already used for another image.');
    throw error;
  }
}

export async function readSampleImage(client, identity, imageId) {
  if (!identity.permission_codes?.some(code => ['samples.read', 'samples.create', 'samples.manage'].includes(code))) {
    throw new HttpError(403, 'forbidden', 'You cannot view sample images.');
  }
  const id = uuid(imageId, 'Sample image').toLowerCase();
  const row = (await client.query(`SELECT ${columns},encode(content,'base64') AS "encodedContent" FROM sample_image_assets
    WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id])).rows[0];
  if (!row) throw new HttpError(404, 'sample_image_not_found', 'The sample image was not found.');
  const { encodedContent, ...details } = row;
  const content = typeof encodedContent === 'string' ? Buffer.from(encodedContent, 'base64') : null;
  if (!content || content.length !== details.byteLength || checksum(content) !== details.sha256) throw new HttpError(409, 'sample_image_unavailable', 'The stored sample image is unavailable.');
  return { ...metadata(details), content };
}

// Immutable references need no row locks and one query for every Product line.
export async function sampleImageReferences(client, organizationId, products) {
  const ids = [...new Set(products.map(product => product.imageFileId).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = (await client.query(`SELECT ${columns} FROM sample_image_assets WHERE organization_id=$1 AND id=ANY($2::uuid[])`, [organizationId, ids])).rows;
  if (rows.length !== ids.length) throw new HttpError(422, 'invalid_product_image', 'A selected Product image is unavailable.');
  return new Map(rows.map(row => [row.id, metadata(row)]));
}
