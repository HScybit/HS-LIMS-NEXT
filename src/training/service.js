import { randomUUID, createHash } from 'node:crypto';
import { HttpError } from '../auth/errors.js';
import { fieldsOnly, requirePermission, uuid } from '../templates/input.js';
import { customFieldAttachmentMetadata } from '../custom-fields/attachments.js';
import { trainingScheduleInput, trainingAttendanceInput, userCertificationInput } from './input.js';

const checksum = (content) => createHash('sha256').update(content).digest('hex');
const attachmentByteLimit = 20 * 1024 * 1024;

function requireRead(identity) {
  if (!identity.permission_codes?.some((code) => ['training.read', 'training.manage'].includes(code))) {
    throw new HttpError(403, 'forbidden', 'You cannot view training records.');
  }
}

async function assertMembers(client, organizationId, userIds) {
  const found = await client.query('SELECT user_id FROM memberships WHERE organization_id=$1 AND user_id=ANY($2::uuid[])', [organizationId, userIds]);
  if (found.rowCount !== new Set(userIds).size) throw new HttpError(422, 'invalid_attendee', 'Select only members of this organization.');
}

const scheduleColumns = `id, name, description, from_date::text AS "fromDate", to_date::text AS "toDate", trainer_name AS "trainerName",
  revision, created_by AS "createdBy", created_at AS "createdAt", updated_by AS "updatedBy", updated_at AS "updatedAt"`;

async function attendeesOf(client, organizationId, scheduleId) {
  const result = await client.query('SELECT user_id AS "userId" FROM training_schedule_attendees WHERE organization_id=$1 AND training_schedule_id=$2 ORDER BY user_id',
    [organizationId, scheduleId]);
  return result.rows.map((row) => row.userId);
}

export async function listTrainingSchedules(client, identity) {
  requireRead(identity);
  const result = await client.query(`SELECT ${scheduleColumns} FROM training_schedules WHERE organization_id=$1 ORDER BY from_date DESC, id`, [identity.organization_id]);
  return { items: await Promise.all(result.rows.map(async (row) => ({ ...row, attendeeIds: await attendeesOf(client, identity.organization_id, row.id) }))) };
}

export async function getTrainingSchedule(client, identity, scheduleId) {
  requireRead(identity); const id = uuid(scheduleId, 'Training schedule').toLowerCase();
  const result = await client.query(`SELECT ${scheduleColumns} FROM training_schedules WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id]);
  if (!result.rowCount) throw new HttpError(404, 'training_schedule_not_found', 'Training schedule was not found.');
  return { ...result.rows[0], attendeeIds: await attendeesOf(client, identity.organization_id, id) };
}

export async function createTrainingSchedule(client, identity, rawInput) {
  requirePermission(identity, 'training.manage');
  const input = trainingScheduleInput(rawInput);
  await assertMembers(client, identity.organization_id, input.attendeeIds);
  const result = await client.query(`INSERT INTO training_schedules(organization_id, name, description, from_date, to_date, trainer_name, created_by, updated_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING ${scheduleColumns}`,
  [identity.organization_id, input.name, input.description, input.fromDate, input.toDate, input.trainerName, identity.user_id]);
  const schedule = result.rows[0];
  for (const userId of input.attendeeIds) {
    await client.query('INSERT INTO training_schedule_attendees(organization_id, training_schedule_id, user_id) VALUES($1,$2,$3)', [identity.organization_id, schedule.id, userId]);
  }
  return { ...schedule, attendeeIds: input.attendeeIds };
}

export async function updateTrainingSchedule(client, identity, scheduleId, rawInput) {
  requirePermission(identity, 'training.manage'); const id = uuid(scheduleId, 'Training schedule').toLowerCase();
  const input = trainingScheduleInput(rawInput, { partial: true });
  await assertMembers(client, identity.organization_id, input.attendeeIds);
  const result = await client.query(`UPDATE training_schedules SET name=$3, description=$4, from_date=$5, to_date=$6, trainer_name=$7, revision=revision+1, updated_by=$8, updated_at=now()
    WHERE organization_id=$1 AND id=$2 AND revision=$9 RETURNING ${scheduleColumns}`,
  [identity.organization_id, id, input.name, input.description, input.fromDate, input.toDate, input.trainerName, identity.user_id, input.revision]);
  if (!result.rowCount) {
    const exists = await client.query('SELECT 1 FROM training_schedules WHERE organization_id=$1 AND id=$2', [identity.organization_id, id]);
    throw exists.rowCount ? new HttpError(409, 'training_schedule_changed', 'This training schedule changed. Reload before saving.')
      : new HttpError(404, 'training_schedule_not_found', 'Training schedule was not found.');
  }
  await client.query('DELETE FROM training_schedule_attendees WHERE organization_id=$1 AND training_schedule_id=$2', [identity.organization_id, id]);
  for (const userId of input.attendeeIds) {
    await client.query('INSERT INTO training_schedule_attendees(organization_id, training_schedule_id, user_id) VALUES($1,$2,$3)', [identity.organization_id, id, userId]);
  }
  return { ...result.rows[0], attendeeIds: input.attendeeIds };
}

const attendanceColumns = `id, training_schedule_id AS "trainingScheduleId", user_id AS "userId", attendance_date::text AS "attendanceDate",
  check_in_at AS "checkInAt", check_out_at AS "checkOutAt", revision, recorded_by AS "recordedBy", created_at AS "createdAt", updated_at AS "updatedAt"`;

export async function listTrainingAttendance(client, identity, scheduleId) {
  requireRead(identity); const id = uuid(scheduleId, 'Training schedule').toLowerCase();
  const result = await client.query(`SELECT ${attendanceColumns} FROM training_attendance WHERE organization_id=$1 AND training_schedule_id=$2 ORDER BY attendance_date, user_id`,
    [identity.organization_id, id]);
  return { items: result.rows };
}

// One row per (schedule, attendee, date): recording attendance for the same
// person/day again updates that existing row rather than creating a
// duplicate, mirroring Meteor's own upsert-by-key behaviour.
export async function recordTrainingAttendance(client, identity, scheduleId, rawInput) {
  requirePermission(identity, 'training.manage'); const id = uuid(scheduleId, 'Training schedule').toLowerCase();
  const input = trainingAttendanceInput(rawInput);
  const attendee = await client.query('SELECT 1 FROM training_schedule_attendees WHERE organization_id=$1 AND training_schedule_id=$2 AND user_id=$3',
    [identity.organization_id, id, input.userId]);
  if (!attendee.rowCount) throw new HttpError(422, 'invalid_attendee', 'This user is not scheduled for this training.');
  const result = await client.query(`INSERT INTO training_attendance(organization_id, training_schedule_id, user_id, attendance_date, check_in_at, check_out_at, recorded_by)
    VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (organization_id, training_schedule_id, user_id, attendance_date)
    DO UPDATE SET check_in_at=excluded.check_in_at, check_out_at=excluded.check_out_at, revision=training_attendance.revision+1, updated_at=now()
    RETURNING ${attendanceColumns}`,
  [identity.organization_id, id, input.userId, input.attendanceDate, input.checkInAt, input.checkOutAt, identity.user_id]);
  return result.rows[0];
}

const certificationColumns = `id, user_id AS "userId", method_id AS "methodId", certification_name AS "certificationName", completion_status AS "completionStatus",
  valid_from::text AS "validFrom", valid_till::text AS "validTill", certificate_file_id AS "certificateFileId", reviewer_id AS "reviewerId",
  revision, created_by AS "createdBy", created_at AS "createdAt", updated_by AS "updatedBy", updated_at AS "updatedAt"`;

export async function listUserCertifications(client, identity, { userId } = {}) {
  requireRead(identity);
  const result = userId
    ? await client.query(`SELECT ${certificationColumns} FROM user_certifications WHERE organization_id=$1 AND user_id=$2 ORDER BY valid_from DESC, id`,
      [identity.organization_id, uuid(userId, 'User').toLowerCase()])
    : await client.query(`SELECT ${certificationColumns} FROM user_certifications WHERE organization_id=$1 ORDER BY valid_from DESC, id`, [identity.organization_id]);
  return { items: result.rows };
}

export async function getUserCertification(client, identity, certificationId) {
  requireRead(identity); const id = uuid(certificationId, 'Certification').toLowerCase();
  const result = await client.query(`SELECT ${certificationColumns} FROM user_certifications WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id]);
  if (!result.rowCount) throw new HttpError(404, 'certification_not_found', 'Certification was not found.');
  return result.rows[0];
}

async function assertCertificationReferences(client, organizationId, input) {
  const members = [input.userId, ...(input.reviewerId ? [input.reviewerId] : [])];
  const found = await client.query('SELECT user_id FROM memberships WHERE organization_id=$1 AND user_id=ANY($2::uuid[])', [organizationId, members]);
  if (found.rowCount !== new Set(members).size) throw new HttpError(422, 'invalid_member_reference', 'Select only members of this organization.');
  if (input.methodId) {
    const method = await client.query('SELECT 1 FROM methods_of_analysis WHERE organization_id=$1 AND id=$2', [organizationId, input.methodId]);
    if (!method.rowCount) throw new HttpError(404, 'method_not_found', 'Method of Analysis was not found.');
  }
  if (input.certificateFileId) {
    const file = await client.query('SELECT 1 FROM user_certification_files WHERE organization_id=$1 AND id=$2', [organizationId, input.certificateFileId]);
    if (!file.rowCount) throw new HttpError(404, 'attachment_not_found', 'The certificate file was not found.');
  }
}

export async function createUserCertification(client, identity, rawInput) {
  requirePermission(identity, 'training.manage');
  const input = userCertificationInput(rawInput);
  await assertCertificationReferences(client, identity.organization_id, input);
  const result = await client.query(`INSERT INTO user_certifications(organization_id, user_id, method_id, certification_name, completion_status,
      valid_from, valid_till, certificate_file_id, reviewer_id, created_by, updated_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING ${certificationColumns}`,
  [identity.organization_id, input.userId, input.methodId, input.certificationName, input.completionStatus,
    input.validFrom, input.validTill, input.certificateFileId, input.reviewerId, identity.user_id]);
  return result.rows[0];
}

export async function updateUserCertification(client, identity, certificationId, rawInput) {
  requirePermission(identity, 'training.manage'); const id = uuid(certificationId, 'Certification').toLowerCase();
  const input = userCertificationInput(rawInput, { partial: true });
  await assertCertificationReferences(client, identity.organization_id, input);
  const result = await client.query(`UPDATE user_certifications SET user_id=$3, method_id=$4, certification_name=$5, completion_status=$6,
      valid_from=$7, valid_till=$8, certificate_file_id=$9, reviewer_id=$10, revision=revision+1, updated_by=$11, updated_at=now()
    WHERE organization_id=$1 AND id=$2 AND revision=$12 RETURNING ${certificationColumns}`,
  [identity.organization_id, id, input.userId, input.methodId, input.certificationName, input.completionStatus,
    input.validFrom, input.validTill, input.certificateFileId, input.reviewerId, identity.user_id, input.revision]);
  if (!result.rowCount) {
    const exists = await client.query('SELECT 1 FROM user_certifications WHERE organization_id=$1 AND id=$2', [identity.organization_id, id]);
    throw exists.rowCount ? new HttpError(409, 'certification_changed', 'This certification changed. Reload before saving.')
      : new HttpError(404, 'certification_not_found', 'Certification was not found.');
  }
  return result.rows[0];
}

const attachmentColumns = `id, original_name AS "originalName", media_type AS "mediaType", byte_length AS "byteLength", sha256, uploaded_by AS "uploadedBy", uploaded_at AS "uploadedAt"`;

export async function uploadUserCertificationFile(client, identity, input) {
  requirePermission(identity, 'training.manage');
  fieldsOnly(input, ['requestId', 'originalName', 'mediaType', 'content']);
  const id = uuid(input.requestId ?? randomUUID(), 'Attachment upload request').toLowerCase();
  const details = customFieldAttachmentMetadata(input.originalName, input.mediaType);
  if (!Buffer.isBuffer(input.content)) throw new HttpError(400, 'invalid_attachment', 'Attachment content is required.');
  if (input.content.length > attachmentByteLimit) throw new HttpError(413, 'attachment_size_limit', 'Attachments can be at most 20 MiB.');
  const sha256 = checksum(input.content);
  const previous = (await client.query(`SELECT ${attachmentColumns} FROM user_certification_files WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id])).rows[0];
  if (previous) {
    if (previous.uploadedBy !== identity.user_id || previous.originalName !== details.originalName || previous.mediaType !== details.mediaType
      || previous.sha256 !== sha256 || previous.byteLength !== input.content.length) {
      throw new HttpError(409, 'attachment_request_reused', 'This upload request was already used with different details.');
    }
    return { ...previous, replayed: true };
  }
  const row = (await client.query(`INSERT INTO user_certification_files(organization_id, id, original_name, media_type, content, byte_length, sha256, uploaded_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${attachmentColumns}`,
  [identity.organization_id, id, details.originalName, details.mediaType, input.content, input.content.length, sha256, identity.user_id])).rows[0];
  return { ...row, replayed: false };
}

export async function readUserCertificationFile(client, identity, attachmentId) {
  requireRead(identity); const id = uuid(attachmentId, 'Attachment').toLowerCase();
  const record = (await client.query(`SELECT ${attachmentColumns}, encode(content,'base64') AS "encodedContent"
    FROM user_certification_files WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id])).rows[0];
  if (!record) throw new HttpError(404, 'attachment_not_found', 'The attachment was not found.');
  const { encodedContent, ...row } = record;
  const content = typeof encodedContent === 'string' ? Buffer.from(encodedContent, 'base64') : null;
  if (!content || content.length !== row.byteLength || checksum(content) !== row.sha256) throw new HttpError(409, 'attachment_unavailable', 'The stored attachment is unavailable.');
  return { ...row, content };
}
