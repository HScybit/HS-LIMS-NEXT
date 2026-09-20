import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, uuid, text, dateOnly } from '../templates/input.js';

export function documentCategoryInput(input, { partial = false } = {}) {
  fieldsOnly(input, [...(partial ? ['revision'] : []), 'name', 'description', 'expiryApplicable', 'accessUserIds', 'workflowId']);
  const name = text(input.name, 'Name', 200);
  const description = input.description == null || input.description === '' ? null : text(input.description, 'Description', 10000);
  if (typeof input.expiryApplicable !== 'boolean') throw new HttpError(400, 'invalid_input', 'Expiry applicable must be true or false.');
  if (!Array.isArray(input.accessUserIds) || !input.accessUserIds.length || input.accessUserIds.length > 500) throw new HttpError(400, 'invalid_access_list', 'Grant access to between 1 and 500 users.');
  const accessUserIds = input.accessUserIds.map((id) => uuid(id, 'User').toLowerCase());
  if (new Set(accessUserIds).size !== accessUserIds.length) throw new HttpError(400, 'duplicate_access_user', 'List each user only once.');
  const workflowId = input.workflowId == null ? null : uuid(input.workflowId, 'Workflow').toLowerCase();
  return { name, description, expiryApplicable: input.expiryApplicable, accessUserIds, workflowId,
    ...(partial ? { revision: integer(input.revision, 'Category revision', 1, 2_147_483_647) } : {}) };
}

export function documentInput(input) {
  fieldsOnly(input, ['name', 'description', 'documentCategoryId', 'fileId', 'versionLabel', 'expiryDate', 'parentDocumentId']);
  const name = text(input.name, 'Name', 200);
  const description = input.description == null || input.description === '' ? null : text(input.description, 'Description', 10000);
  const documentCategoryId = uuid(input.documentCategoryId, 'Document category').toLowerCase();
  const fileId = uuid(input.fileId, 'File').toLowerCase();
  const versionLabel = input.versionLabel == null || input.versionLabel === '' ? null : text(input.versionLabel, 'Version label', 100);
  const expiryDate = input.expiryDate == null || input.expiryDate === '' ? null : dateOnly(input.expiryDate);
  const parentDocumentId = input.parentDocumentId == null ? null : uuid(input.parentDocumentId, 'Parent document').toLowerCase();
  return { name, description, documentCategoryId, fileId, versionLabel, expiryDate, parentDocumentId };
}
