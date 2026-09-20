import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { listDocumentCategories, getDocumentCategory, createDocumentCategory, updateDocumentCategory,
  listDocuments, getDocument, createDocument, listDocumentVersions, uploadDocumentFile, readDocumentFile } from '../../src/documents/service.js';

const owner = ownerPool(); let admin; let granted; let outsider;
const work = (action, user = admin) => withSession(user.token, action, { csrfToken: user.csrfToken });
before(async () => {
  const account = async (options = {}) => {
    const user = await createAccount(owner, options);
    return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  };
  admin = await account({ permissions: ['documents.manage'] });
  granted = await account({ organizationId: admin.organizationId, permissions: ['documents.read'] });
  outsider = await account({ organizationId: admin.organizationId, permissions: ['documents.read'] });
});
after(async () => { await closePool(); await owner.end(); });

async function categoryWithAccess(userIds) {
  return work((client, identity) => createDocumentCategory(client, identity, { name: `SOP ${randomUUID()}`, expiryApplicable: false, accessUserIds: userIds }));
}
async function uploadedFile(actor = admin) {
  return work((client, identity) => uploadDocumentFile(client, identity, { requestId: randomUUID(), originalName: 'sop.pdf', mediaType: 'application/pdf', content: Buffer.from('synthetic document bytes') }), actor);
}

test('a document category can be created with an access list, listed, fetched and updated with a new roster', async () => {
  const created = await categoryWithAccess([admin.userId, granted.userId]);
  assert.equal(created.revision, 1); assert.deepEqual(new Set(created.accessUserIds), new Set([admin.userId, granted.userId]));
  const listed = await work((client, identity) => listDocumentCategories(client, identity), granted);
  assert(listed.items.some((item) => item.id === created.id));
  await assert.rejects(work((client, identity) => getDocumentCategory(client, identity, created.id), outsider), { code: 'document_category_not_found' });
  const updated = await work((client, identity) => updateDocumentCategory(client, identity, created.id, { revision: created.revision, name: created.name, expiryApplicable: true, accessUserIds: [admin.userId] }));
  assert.equal(updated.expiryApplicable, true); assert.deepEqual(updated.accessUserIds, [admin.userId]);
  await assert.rejects(work((client, identity) => getDocumentCategory(client, identity, created.id), granted), { code: 'document_category_not_found' });
});

test('a document can be uploaded and created in an accessible category, but not one the actor lacks access to', async () => {
  const category = await categoryWithAccess([admin.userId, granted.userId]);
  const file = await uploadedFile(granted);
  const created = await work((client, identity) => createDocument(client, identity, { name: 'SOP-001', documentCategoryId: category.id, fileId: file.id }), granted);
  assert.equal(created.isLatest, true); assert.equal(created.parentDocumentId, null); assert.equal(created.revision, 1);
  const fetched = await work((client, identity) => getDocument(client, identity, created.id), granted);
  assert.equal(fetched.name, 'SOP-001');
  const listed = await work((client, identity) => listDocuments(client, identity, { documentCategoryId: category.id }), granted);
  assert.equal(listed.items.length, 1);
  const outsiderFile = await uploadedFile(outsider);
  // outsider can't even see the category exists (RLS-filtered), so this
  // surfaces as a clean not-found rather than reaching the insert's own RLS check.
  await assert.rejects(work((client, identity) => createDocument(client, identity, { name: 'Should fail', documentCategoryId: category.id, fileId: outsiderFile.id }), outsider), { code: 'document_category_not_found' });
});

test('a new version stays in its source category, flips the parent to not-latest, and a category mismatch is rejected', async () => {
  const category = await categoryWithAccess([admin.userId]);
  const otherCategory = await categoryWithAccess([admin.userId]);
  const file = await uploadedFile();
  const original = await work((client, identity) => createDocument(client, identity, { name: 'SOP-002', documentCategoryId: category.id, fileId: file.id }));
  const nextFile = await uploadedFile();
  await assert.rejects(work((client, identity) => createDocument(client, identity,
    { name: 'SOP-002', documentCategoryId: otherCategory.id, fileId: nextFile.id, parentDocumentId: original.id })), { code: 'category_mismatch' });
  const version2 = await work((client, identity) => createDocument(client, identity,
    { name: 'SOP-002', documentCategoryId: category.id, fileId: nextFile.id, parentDocumentId: original.id, versionLabel: 'v2' }));
  assert.equal(version2.parentDocumentId, original.id); assert.equal(version2.isLatest, true);
  const originalAfter = await work((client, identity) => getDocument(client, identity, original.id));
  assert.equal(originalAfter.isLatest, false);
  const versions = await work((client, identity) => listDocumentVersions(client, identity, version2.id));
  assert.deepEqual(versions.items.map((item) => item.id), [original.id, version2.id]);
});

test('an uploaded file can be downloaded back exactly, and a category-inaccessible actor cannot read a document\'s file', async () => {
  const category = await categoryWithAccess([admin.userId]);
  const content = Buffer.from('synthetic controlled document content');
  const file = await work((client, identity) => uploadDocumentFile(client, identity, { requestId: randomUUID(), originalName: 'sop.pdf', mediaType: 'application/pdf', content }));
  const document = await work((client, identity) => createDocument(client, identity, { name: 'SOP-003', documentCategoryId: category.id, fileId: file.id }));
  const read = await work((client, identity) => readDocumentFile(client, identity, document.fileId));
  assert.deepEqual(read.content, content);
  await assert.rejects(work((client, identity) => readDocumentFile(client, identity, document.fileId), outsider), { code: 'document_file_not_found' });
});
