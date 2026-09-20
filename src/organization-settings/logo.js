import { createHash } from 'node:crypto';
import { HttpError } from '../auth/errors.js';
import { requirePermission, uuid } from '../templates/input.js';
import { customFieldAttachmentMetadata } from '../custom-fields/attachments.js';

export const organizationLogoByteLimit = 2 * 1024 * 1024;
const allowedLogoTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const checksum = (content) => createHash('sha256').update(content).digest('hex');
const columns = 'id,original_name AS "originalName",media_type AS "mediaType",byte_length AS "byteLength",sha256,uploaded_at AS "uploadedAt"';

export async function readLogoUpload(request) {
  let originalName;
  try { originalName = decodeURIComponent(request.headers.get('x-file-name') ?? ''); }
  catch { throw new HttpError(400, 'invalid_attachment_name', 'The logo filename is invalid.'); }
  const details = customFieldAttachmentMetadata(originalName, request.headers.get('content-type')?.split(';')[0]);
  if (!allowedLogoTypes.has(details.mediaType)) throw new HttpError(415, 'invalid_logo_type', 'The logo must be a PNG, JPEG, or WebP image.');
  const length = request.headers.get('content-length');
  if (length !== null && !/^\d+$/.test(length)) throw new HttpError(400, 'invalid_attachment_length', 'The logo upload length is invalid.');
  if (length !== null && Number(length) > organizationLogoByteLimit) throw new HttpError(413, 'attachment_size_limit', 'The logo must be at most 2 MiB.');
  const reader = request.body?.getReader(); const chunks = []; let size = 0;
  try {
    if (reader) while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > organizationLogoByteLimit) { await reader.cancel().catch(() => {}); throw new HttpError(413, 'attachment_size_limit', 'The logo must be at most 2 MiB.'); }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'incomplete_attachment', 'The logo upload did not finish. Please try again.');
  } finally { reader?.releaseLock(); }
  if (length !== null && size !== Number(length)) throw new HttpError(400, 'incomplete_attachment', 'The logo upload did not finish. Please try again.');
  if (!size) throw new HttpError(400, 'invalid_attachment', 'The logo file is empty.');
  return { ...details, content: Buffer.concat(chunks, size) };
}

export async function uploadOrganizationLogo(client, identity, input) {
  requirePermission(identity, 'settings.manage');
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO organization_logo_files(organization_id,id,original_name,media_type,content,byte_length,sha256,uploaded_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT(organization_id) DO UPDATE SET id=excluded.id,original_name=excluded.original_name,media_type=excluded.media_type,
       content=excluded.content,byte_length=excluded.byte_length,sha256=excluded.sha256,uploaded_by=excluded.uploaded_by,uploaded_at=now()`,
    [identity.organization_id, id, input.originalName, input.mediaType, input.content, input.content.length, checksum(input.content), identity.user_id]);
  return { id, originalName: input.originalName, mediaType: input.mediaType, byteLength: input.content.length, url: `/api/organization-settings/logo/${id}` };
}

export async function loadOrganizationLogoMetadata(client, identity) {
  if (!['settings.read', 'settings.manage'].some((permission) => identity.permission_codes?.includes(permission))) return null;
  const row = (await client.query(`SELECT ${columns} FROM organization_logo_files WHERE organization_id=$1`, [identity.organization_id])).rows[0];
  return row ? { ...row, url: `/api/organization-settings/logo/${row.id}` } : null;
}

// Gated to settings.read/settings.manage for now: nothing outside the settings page consumes the
// logo yet (header/report branding is a later, separate step), so there is no broader-visibility
// requirement to weigh against keeping this consistent with the rest of organization settings.
export async function readOrganizationLogo(client, identity, fileId) {
  if (!['settings.read', 'settings.manage'].some((permission) => identity.permission_codes?.includes(permission))) {
    throw new HttpError(403, 'forbidden', 'You cannot view the organization logo.');
  }
  const id = uuid(fileId, 'Logo').toLowerCase();
  const record = (await client.query(`SELECT ${columns},content FROM organization_logo_files WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id])).rows[0];
  if (!record) throw new HttpError(404, 'logo_not_found', 'The organization logo was not found.');
  return record;
}
