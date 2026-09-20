import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, uuid, text, dateOnly } from '../templates/input.js';

export function trainingScheduleInput(input, { partial = false } = {}) {
  fieldsOnly(input, [...(partial ? ['revision'] : []), 'name', 'description', 'fromDate', 'toDate', 'trainerName', 'attendeeIds']);
  const name = text(input.name, 'Name', 200);
  const description = input.description == null || input.description === '' ? null : text(input.description, 'Description', 10000);
  const fromDate = dateOnly(input.fromDate);
  const toDate = dateOnly(input.toDate);
  if (toDate < fromDate) throw new HttpError(400, 'invalid_training_dates', 'The end date cannot be before the start date.');
  const trainerName = input.trainerName == null || input.trainerName === '' ? null : text(input.trainerName, 'Trainer name', 200);
  if (!Array.isArray(input.attendeeIds) || !input.attendeeIds.length || input.attendeeIds.length > 500) throw new HttpError(400, 'invalid_attendees', 'Select between 1 and 500 attendees.');
  const attendeeIds = input.attendeeIds.map((id) => uuid(id, 'Attendee').toLowerCase());
  if (new Set(attendeeIds).size !== attendeeIds.length) throw new HttpError(400, 'duplicate_attendee', 'Select each attendee only once.');
  return { name, description, fromDate, toDate, trainerName, attendeeIds,
    ...(partial ? { revision: integer(input.revision, 'Training schedule revision', 1, 2_147_483_647) } : {}) };
}

export function trainingAttendanceInput(input) {
  fieldsOnly(input, ['userId', 'attendanceDate', 'checkInAt', 'checkOutAt']);
  const userId = uuid(input.userId, 'Attendee').toLowerCase();
  const attendanceDate = dateOnly(input.attendanceDate);
  const checkInAt = input.checkInAt == null ? null : new Date(input.checkInAt);
  const checkOutAt = input.checkOutAt == null ? null : new Date(input.checkOutAt);
  if (checkInAt !== null && !Number.isFinite(checkInAt.getTime())) throw new HttpError(400, 'invalid_input', 'Check-in time is invalid.');
  if (checkOutAt !== null && !Number.isFinite(checkOutAt.getTime())) throw new HttpError(400, 'invalid_input', 'Check-out time is invalid.');
  if (checkOutAt !== null && checkInAt === null) throw new HttpError(400, 'invalid_input', 'Check-out requires a check-in time.');
  if (checkOutAt !== null && checkInAt !== null && checkOutAt < checkInAt) throw new HttpError(400, 'invalid_input', 'Check-out cannot be before check-in.');
  return { userId, attendanceDate, checkInAt, checkOutAt };
}

export function userCertificationInput(input, { partial = false } = {}) {
  fieldsOnly(input, [...(partial ? ['revision'] : []), 'userId', 'methodId', 'certificationName', 'completionStatus', 'validFrom', 'validTill', 'certificateFileId', 'reviewerId']);
  const userId = uuid(input.userId, 'User').toLowerCase();
  const methodId = input.methodId == null ? null : uuid(input.methodId, 'Method of Analysis').toLowerCase();
  const certificationName = text(input.certificationName, 'Certification name', 200);
  const completionStatus = input.completionStatus ?? 'pending';
  if (!['pending', 'completed', 'expired'].includes(completionStatus)) throw new HttpError(400, 'invalid_input', 'Select a valid completion status.');
  const validFrom = dateOnly(input.validFrom);
  const validTill = input.validTill == null || input.validTill === '' ? null : dateOnly(input.validTill);
  if (validTill !== null && validTill < validFrom) throw new HttpError(400, 'invalid_certification_dates', 'The valid-till date cannot be before the valid-from date.');
  const certificateFileId = input.certificateFileId == null ? null : uuid(input.certificateFileId, 'Certificate').toLowerCase();
  const reviewerId = input.reviewerId == null ? null : uuid(input.reviewerId, 'Reviewer').toLowerCase();
  return { userId, methodId, certificationName, completionStatus, validFrom, validTill, certificateFileId, reviewerId,
    ...(partial ? { revision: integer(input.revision, 'Certification revision', 1, 2_147_483_647) } : {}) };
}
