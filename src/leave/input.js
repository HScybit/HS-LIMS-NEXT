import { HttpError } from '../auth/errors.js';
import { fieldsOnly, dateOnly, integer, text, uuid } from '../templates/input.js';

export function leaveRecordInput(input, { partial = false } = {}) {
  fieldsOnly(input, [...(partial ? ['revision'] : []), 'userId', 'fromDate', 'toDate', 'remark', 'attachmentId']);
  const userId = uuid(input.userId, 'Employee').toLowerCase();
  const fromDate = dateOnly(input.fromDate);
  const toDate = dateOnly(input.toDate);
  if (toDate < fromDate) throw new HttpError(400, 'invalid_leave_dates', 'The end date cannot be before the start date.');
  const remark = input.remark == null || input.remark === '' ? null : text(input.remark, 'Remark', 5000);
  const attachmentId = input.attachmentId == null ? null : uuid(input.attachmentId, 'Attachment').toLowerCase();
  return { userId, fromDate, toDate, remark, attachmentId,
    ...(partial ? { revision: integer(input.revision, 'Leave record revision', 1, 2_147_483_647) } : {}) };
}
