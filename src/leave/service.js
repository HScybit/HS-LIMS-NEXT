import { randomUUID, createHash } from 'node:crypto';
import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, requirePermission, uuid } from '../templates/input.js';
import { customFieldAttachmentMetadata } from '../custom-fields/attachments.js';
import { leaveRecordInput } from './input.js';

const checksum = (content) => createHash('sha256').update(content).digest('hex');
const attachmentByteLimit = 20 * 1024 * 1024;
const columns = `id, user_id AS "userId", from_date::text AS "fromDate", to_date::text AS "toDate", remark, attachment_id AS "attachmentId",
  revision, created_by AS "createdBy", created_at AS "createdAt", updated_by AS "updatedBy", updated_at AS "updatedAt"`;

function requireRead(identity) {
  if (!identity.permission_codes?.some((code) => ['leave_records.read', 'leave_records.manage'].includes(code))) {
    throw new HttpError(403, 'forbidden', 'You cannot view leave records.');
  }
}

export async function listLeaveRecords(client, identity) {
  requireRead(identity);
  const result = await client.query(`SELECT ${columns} FROM leave_records WHERE organization_id=$1 ORDER BY from_date DESC, id`, [identity.organization_id]);
  return { items: result.rows };
}

export async function getLeaveRecord(client, identity, recordId) {
  requireRead(identity); const id = uuid(recordId, 'Leave record').toLowerCase();
  const result = await client.query(`SELECT ${columns} FROM leave_records WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id]);
  if (!result.rowCount) throw new HttpError(404, 'leave_record_not_found', 'Leave record was not found.');
  return result.rows[0];
}

export async function createLeaveRecord(client, identity, rawInput) {
  requirePermission(identity, 'leave_records.manage');
  const input = leaveRecordInput(rawInput);
  if (input.userId !== identity.user_id) {
    const member = await client.query('SELECT 1 FROM memberships WHERE organization_id=$1 AND user_id=$2', [identity.organization_id, input.userId]);
    if (!member.rowCount) throw new HttpError(422, 'invalid_employee', 'Select a member of this organization.');
  }
  if (input.attachmentId) {
    const owned = await client.query('SELECT 1 FROM leave_record_attachments WHERE organization_id=$1 AND id=$2', [identity.organization_id, input.attachmentId]);
    if (!owned.rowCount) throw new HttpError(404, 'attachment_not_found', 'The attachment was not found.');
  }
  const result = await client.query(`INSERT INTO leave_records(organization_id, user_id, from_date, to_date, remark, attachment_id, created_by, updated_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING ${columns}`,
  [identity.organization_id, input.userId, input.fromDate, input.toDate, input.remark, input.attachmentId, identity.user_id]);
  return result.rows[0];
}

export async function updateLeaveRecord(client, identity, recordId, rawInput) {
  requirePermission(identity, 'leave_records.manage'); const id = uuid(recordId, 'Leave record').toLowerCase();
  const input = leaveRecordInput(rawInput, { partial: true });
  if (input.userId !== identity.user_id) {
    const member = await client.query('SELECT 1 FROM memberships WHERE organization_id=$1 AND user_id=$2', [identity.organization_id, input.userId]);
    if (!member.rowCount) throw new HttpError(422, 'invalid_employee', 'Select a member of this organization.');
  }
  if (input.attachmentId) {
    const owned = await client.query('SELECT 1 FROM leave_record_attachments WHERE organization_id=$1 AND id=$2', [identity.organization_id, input.attachmentId]);
    if (!owned.rowCount) throw new HttpError(404, 'attachment_not_found', 'The attachment was not found.');
  }
  const result = await client.query(`UPDATE leave_records SET user_id=$3, from_date=$4, to_date=$5, remark=$6, attachment_id=$7, revision=revision+1, updated_by=$8, updated_at=now()
    WHERE organization_id=$1 AND id=$2 AND revision=$9 RETURNING ${columns}`,
  [identity.organization_id, id, input.userId, input.fromDate, input.toDate, input.remark, input.attachmentId, identity.user_id, input.revision]);
  if (!result.rowCount) {
    const exists = await client.query('SELECT 1 FROM leave_records WHERE organization_id=$1 AND id=$2', [identity.organization_id, id]);
    throw exists.rowCount ? new HttpError(409, 'leave_record_changed', 'This leave record changed. Reload before saving.')
      : new HttpError(404, 'leave_record_not_found', 'Leave record was not found.');
  }
  return result.rows[0];
}

export async function deleteLeaveRecord(client, identity, recordId, expectedRevision) {
  requirePermission(identity, 'leave_records.manage'); const id = uuid(recordId, 'Leave record').toLowerCase();
  const revision = integer(expectedRevision, 'Leave record revision', 1, 2_147_483_647);
  const result = await client.query('DELETE FROM leave_records WHERE organization_id=$1 AND id=$2 AND revision=$3', [identity.organization_id, id, revision]);
  if (!result.rowCount) {
    const exists = await client.query('SELECT 1 FROM leave_records WHERE organization_id=$1 AND id=$2', [identity.organization_id, id]);
    throw exists.rowCount ? new HttpError(409, 'leave_record_changed', 'This leave record changed. Reload before deleting.')
      : new HttpError(404, 'leave_record_not_found', 'Leave record was not found.');
  }
}

const attachmentColumns = `id, original_name AS "originalName", media_type AS "mediaType", byte_length AS "byteLength", sha256, uploaded_by AS "uploadedBy", uploaded_at AS "uploadedAt"`;

export async function uploadLeaveAttachment(client, identity, input) {
  requirePermission(identity, 'leave_records.manage');
  fieldsOnly(input, ['requestId', 'originalName', 'mediaType', 'content']);
  const id = uuid(input.requestId, 'Attachment upload request').toLowerCase();
  const details = customFieldAttachmentMetadata(input.originalName, input.mediaType);
  if (!Buffer.isBuffer(input.content)) throw new HttpError(400, 'invalid_attachment', 'Attachment content is required.');
  if (input.content.length > attachmentByteLimit) throw new HttpError(413, 'attachment_size_limit', 'Attachments can be at most 20 MiB.');
  const sha256 = checksum(input.content);
  const previous = (await client.query(`SELECT ${attachmentColumns} FROM leave_record_attachments WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id])).rows[0];
  if (previous) {
    if (previous.uploadedBy !== identity.user_id || previous.originalName !== details.originalName || previous.mediaType !== details.mediaType
      || previous.sha256 !== sha256 || previous.byteLength !== input.content.length) {
      throw new HttpError(409, 'attachment_request_reused', 'This upload request was already used with different details.');
    }
    return { ...previous, replayed: true };
  }
  const row = (await client.query(`INSERT INTO leave_record_attachments(organization_id, id, original_name, media_type, content, byte_length, sha256, uploaded_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${attachmentColumns}`,
  [identity.organization_id, id, details.originalName, details.mediaType, input.content, input.content.length, sha256, identity.user_id])).rows[0];
  return { ...row, replayed: false };
}

export async function readLeaveAttachment(client, identity, attachmentId) {
  requireRead(identity); const id = uuid(attachmentId, 'Attachment').toLowerCase();
  const record = (await client.query(`SELECT ${attachmentColumns}, encode(content,'base64') AS "encodedContent"
    FROM leave_record_attachments WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id])).rows[0];
  if (!record) throw new HttpError(404, 'attachment_not_found', 'The attachment was not found.');
  const { encodedContent, ...row } = record;
  const content = typeof encodedContent === 'string' ? Buffer.from(encodedContent, 'base64') : null;
  if (!content || content.length !== row.byteLength || checksum(content) !== row.sha256) throw new HttpError(409, 'attachment_unavailable', 'The stored attachment is unavailable.');
  return { ...row, content };
}
