import { createHash } from 'node:crypto';
import { HttpError } from '../auth/errors.js';
import { fieldsOnly, requirePermission, uuid } from '../templates/input.js';
import { customFieldAttachmentMetadata } from '../custom-fields/attachments.js';
import { documentCategoryInput, documentInput } from './input.js';
import { startDocumentWorkflow } from '../workflows/start.js';

const checksum = (content) => createHash('sha256').update(content).digest('hex');
const attachmentByteLimit = 26_214_400;

function requireRead(identity) {
  if (!identity.permission_codes?.some((code) => ['documents.read', 'documents.manage'].includes(code))) {
    throw new HttpError(403, 'forbidden', 'You cannot view documents.');
  }
}

const categoryColumns = `id, name, description, expiry_applicable AS "expiryApplicable", workflow_id AS "workflowId", revision,
  created_by AS "createdBy", created_at AS "createdAt", updated_by AS "updatedBy", updated_at AS "updatedAt"`;

async function assertDocumentWorkflow(client, organizationId, workflowId) {
  if (!workflowId) return;
  const workflow = await client.query("SELECT 1 FROM workflows WHERE organization_id=$1 AND id=$2 AND active AND applies_to='document'", [organizationId, workflowId]);
  if (!workflow.rowCount) throw new HttpError(422, 'invalid_document_workflow', 'Select an active Document workflow.');
}

async function accessListOf(client, organizationId, categoryId) {
  const result = await client.query('SELECT user_id AS "userId" FROM document_category_access WHERE organization_id=$1 AND document_category_id=$2 ORDER BY user_id',
    [organizationId, categoryId]);
  return result.rows.map((row) => row.userId);
}

async function assertMembers(client, organizationId, userIds) {
  const found = await client.query('SELECT user_id FROM memberships WHERE organization_id=$1 AND user_id=ANY($2::uuid[])', [organizationId, userIds]);
  if (found.rowCount !== new Set(userIds).size) throw new HttpError(422, 'invalid_access_user', 'Grant access only to members of this organization.');
}

// RLS already restricts every row returned here to categories this actor
// can see (documents.manage sees all; documents.read sees only categories
// they are granted access to) — no separate application-layer filter needed.
export async function listDocumentCategories(client, identity) {
  requireRead(identity);
  const result = await client.query(`SELECT ${categoryColumns} FROM document_categories WHERE organization_id=$1 ORDER BY name`, [identity.organization_id]);
  return { items: await Promise.all(result.rows.map(async (row) => ({ ...row, accessUserIds: await accessListOf(client, identity.organization_id, row.id) }))) };
}

export async function getDocumentCategory(client, identity, categoryId) {
  requireRead(identity); const id = uuid(categoryId, 'Document category').toLowerCase();
  const result = await client.query(`SELECT ${categoryColumns} FROM document_categories WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id]);
  if (!result.rowCount) throw new HttpError(404, 'document_category_not_found', 'Document category was not found.');
  return { ...result.rows[0], accessUserIds: await accessListOf(client, identity.organization_id, id) };
}

export async function createDocumentCategory(client, identity, rawInput) {
  requirePermission(identity, 'documents.manage');
  const input = documentCategoryInput(rawInput);
  await assertMembers(client, identity.organization_id, input.accessUserIds);
  await assertDocumentWorkflow(client, identity.organization_id, input.workflowId);
  const result = await client.query(`INSERT INTO document_categories(organization_id, name, description, expiry_applicable, workflow_id, created_by, updated_by)
    VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING ${categoryColumns}`,
  [identity.organization_id, input.name, input.description, input.expiryApplicable, input.workflowId, identity.user_id]);
  const category = result.rows[0];
  for (const userId of input.accessUserIds) await client.query('INSERT INTO document_category_access(organization_id, document_category_id, user_id) VALUES($1,$2,$3)',
    [identity.organization_id, category.id, userId]);
  return { ...category, accessUserIds: input.accessUserIds };
}

export async function updateDocumentCategory(client, identity, categoryId, rawInput) {
  requirePermission(identity, 'documents.manage'); const id = uuid(categoryId, 'Document category').toLowerCase();
  const input = documentCategoryInput(rawInput, { partial: true });
  await assertMembers(client, identity.organization_id, input.accessUserIds);
  await assertDocumentWorkflow(client, identity.organization_id, input.workflowId);
  const result = await client.query(`UPDATE document_categories SET name=$3, description=$4, expiry_applicable=$5, workflow_id=$6, revision=revision+1, updated_by=$7, updated_at=now()
    WHERE organization_id=$1 AND id=$2 AND revision=$8 RETURNING ${categoryColumns}`,
  [identity.organization_id, id, input.name, input.description, input.expiryApplicable, input.workflowId, identity.user_id, input.revision]);
  if (!result.rowCount) {
    const exists = await client.query('SELECT 1 FROM document_categories WHERE organization_id=$1 AND id=$2', [identity.organization_id, id]);
    throw exists.rowCount ? new HttpError(409, 'document_category_changed', 'This category changed. Reload before saving.')
      : new HttpError(404, 'document_category_not_found', 'Document category was not found.');
  }
  await client.query('DELETE FROM document_category_access WHERE organization_id=$1 AND document_category_id=$2', [identity.organization_id, id]);
  for (const userId of input.accessUserIds) await client.query('INSERT INTO document_category_access(organization_id, document_category_id, user_id) VALUES($1,$2,$3)',
    [identity.organization_id, id, userId]);
  return { ...result.rows[0], accessUserIds: input.accessUserIds };
}

const documentColumns = `id, name, description, document_category_id AS "documentCategoryId", file_id AS "fileId", parent_document_id AS "parentDocumentId",
  version_label AS "versionLabel", is_latest AS "isLatest", expiry_date::text AS "expiryDate",
  revision, created_by AS "createdBy", created_at AS "createdAt", updated_by AS "updatedBy", updated_at AS "updatedAt"`;

export async function listDocuments(client, identity, { documentCategoryId } = {}) {
  requireRead(identity);
  const result = documentCategoryId
    ? await client.query(`SELECT ${documentColumns} FROM documents WHERE organization_id=$1 AND document_category_id=$2 ORDER BY created_at DESC, id`,
      [identity.organization_id, uuid(documentCategoryId, 'Document category').toLowerCase()])
    : await client.query(`SELECT ${documentColumns} FROM documents WHERE organization_id=$1 ORDER BY created_at DESC, id`, [identity.organization_id]);
  return { items: result.rows };
}

export async function getDocument(client, identity, documentId) {
  requireRead(identity); const id = uuid(documentId, 'Document').toLowerCase();
  const result = await client.query(`SELECT ${documentColumns} FROM documents WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id]);
  if (!result.rowCount) throw new HttpError(404, 'document_not_found', 'Document was not found.');
  return result.rows[0];
}

// Version chains are linear (Meteor's own latest/prev_version model, not a
// branching tree), so the whole family can be found with one recursive
// query over parent_document_id without needing to special-case direction.
export async function listDocumentVersions(client, identity, documentId) {
  requireRead(identity); const id = uuid(documentId, 'Document').toLowerCase();
  const exists = await client.query('SELECT 1 FROM documents WHERE organization_id=$1 AND id=$2', [identity.organization_id, id]);
  if (!exists.rowCount) throw new HttpError(404, 'document_not_found', 'Document was not found.');
  const versions = await client.query(`WITH RECURSIVE ancestors AS (
      SELECT id, parent_document_id FROM documents WHERE organization_id=$1 AND id=$2
      UNION ALL SELECT parent.id, parent.parent_document_id FROM documents parent JOIN ancestors ON ancestors.parent_document_id=parent.id WHERE parent.organization_id=$1
    ), root AS (SELECT id FROM ancestors WHERE parent_document_id IS NULL),
    family AS (
      SELECT id FROM root
      UNION ALL SELECT child.id FROM documents child JOIN family ON family.id=child.parent_document_id WHERE child.organization_id=$1
    )
    SELECT ${documentColumns} FROM documents WHERE organization_id=$1 AND id IN (SELECT id FROM family) ORDER BY created_at`, [identity.organization_id, id]);
  return { items: versions.rows };
}

// Creating a document is either the first version of a new logical document
// (parentDocumentId omitted) or a new version of an existing one — a
// version must stay in its parent's category (matching Meteor's own rule)
// and flips the parent to is_latest=false in the same transaction.
export async function createDocument(client, identity, rawInput) {
  if (!identity.permission_codes?.some((code) => ['documents.read', 'documents.manage'].includes(code))) throw new HttpError(403, 'forbidden', 'You cannot create documents.');
  const input = documentInput(rawInput);
  const file = await client.query('SELECT 1 FROM document_files WHERE organization_id=$1 AND id=$2', [identity.organization_id, input.fileId]);
  if (!file.rowCount) throw new HttpError(404, 'document_file_not_found', 'The uploaded file was not found.');
  let documentCategoryId = input.documentCategoryId; let workflowId = null;
  if (input.parentDocumentId) {
    const parent = await client.query('SELECT document_category_id AS "documentCategoryId" FROM documents WHERE organization_id=$1 AND id=$2 FOR UPDATE',
      [identity.organization_id, input.parentDocumentId]);
    if (!parent.rowCount) throw new HttpError(404, 'document_not_found', 'The document being versioned was not found.');
    if (parent.rows[0].documentCategoryId !== input.documentCategoryId) throw new HttpError(422, 'category_mismatch', 'A new version must stay in its source document\'s category.');
    documentCategoryId = parent.rows[0].documentCategoryId;
  }
  const category = await client.query('SELECT workflow_id AS "workflowId" FROM document_categories WHERE organization_id=$1 AND id=$2', [identity.organization_id, documentCategoryId]);
  if (!category.rowCount) throw new HttpError(404, 'document_category_not_found', 'Document category was not found.');
  workflowId = category.rows[0].workflowId;
  const result = await client.query(`INSERT INTO documents(organization_id, name, description, document_category_id, file_id, parent_document_id, version_label, expiry_date, created_by, updated_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING ${documentColumns}`,
  [identity.organization_id, input.name, input.description, documentCategoryId, input.fileId, input.parentDocumentId, input.versionLabel, input.expiryDate, identity.user_id]);
  if (input.parentDocumentId) {
    await client.query('UPDATE documents SET is_latest=false, updated_by=$3, updated_at=now() WHERE organization_id=$1 AND id=$2',
      [identity.organization_id, input.parentDocumentId, identity.user_id]);
  }
  const document = result.rows[0];
  // Every new version gets its own fresh run — a new version starts its own
  // approval cycle rather than inheriting the previous version's approved state.
  const run = await startDocumentWorkflow(client, identity, document.id, workflowId);
  return { ...document, workflowRunId: run?.id ?? null };
}

export async function loadDocumentWorkflow(client, identity, documentId) {
  requireRead(identity); const id = uuid(documentId, 'Document').toLowerCase();
  const result = await client.query('SELECT id FROM documents WHERE organization_id=$1 AND id=$2', [identity.organization_id, id]);
  if (!result.rowCount) throw new HttpError(404, 'document_not_found', 'Document was not found.');
  const run = await client.query('SELECT id FROM workflow_runs WHERE organization_id=$1 AND document_id=$2', [identity.organization_id, id]);
  return { workflowRunId: run.rows[0]?.id ?? null };
}

const attachmentColumns = `id, original_name AS "originalName", media_type AS "mediaType", byte_length AS "byteLength", sha256, uploaded_by AS "uploadedBy", uploaded_at AS "uploadedAt"`;

export async function uploadDocumentFile(client, identity, input) {
  if (!identity.permission_codes?.some((code) => ['documents.read', 'documents.manage'].includes(code))) throw new HttpError(403, 'forbidden', 'You cannot upload documents.');
  fieldsOnly(input, ['requestId', 'originalName', 'mediaType', 'content']);
  const id = uuid(input.requestId, 'Attachment upload request').toLowerCase();
  const details = customFieldAttachmentMetadata(input.originalName, input.mediaType);
  if (!Buffer.isBuffer(input.content)) throw new HttpError(400, 'invalid_attachment', 'File content is required.');
  if (input.content.length > attachmentByteLimit) throw new HttpError(413, 'attachment_size_limit', 'Files can be at most 25 MiB.');
  const sha256 = checksum(input.content);
  const previous = (await client.query(`SELECT ${attachmentColumns} FROM document_files WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id])).rows[0];
  if (previous) {
    if (previous.uploadedBy !== identity.user_id || previous.originalName !== details.originalName || previous.mediaType !== details.mediaType
      || previous.sha256 !== sha256 || previous.byteLength !== input.content.length) {
      throw new HttpError(409, 'attachment_request_reused', 'This upload request was already used with different details.');
    }
    return { ...previous, replayed: true };
  }
  const row = (await client.query(`INSERT INTO document_files(organization_id, id, original_name, media_type, content, byte_length, sha256, uploaded_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${attachmentColumns}`,
  [identity.organization_id, id, details.originalName, details.mediaType, input.content, input.content.length, sha256, identity.user_id])).rows[0];
  return { ...row, replayed: false };
}

export async function readDocumentFile(client, identity, fileId) {
  requireRead(identity); const id = uuid(fileId, 'File').toLowerCase();
  const record = (await client.query(`SELECT ${attachmentColumns}, encode(content,'base64') AS "encodedContent"
    FROM document_files WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id])).rows[0];
  if (!record) throw new HttpError(404, 'document_file_not_found', 'The file was not found.');
  const { encodedContent, ...row } = record;
  const content = typeof encodedContent === 'string' ? Buffer.from(encodedContent, 'base64') : null;
  if (!content || content.length !== row.byteLength || checksum(content) !== row.sha256) throw new HttpError(409, 'attachment_unavailable', 'The stored file is unavailable.');
  return { ...row, content };
}
