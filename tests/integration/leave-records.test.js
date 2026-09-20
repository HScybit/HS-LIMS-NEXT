import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { listLeaveRecords, getLeaveRecord, createLeaveRecord, updateLeaveRecord, deleteLeaveRecord,
  uploadLeaveAttachment, readLeaveAttachment } from '../../src/leave/service.js';

const owner = ownerPool(); let manager; let reader; let foreign;
const work = (action, user = manager) => withSession(user.token, action, { csrfToken: user.csrfToken });
before(async () => {
  const account = async (options = {}) => {
    const user = await createAccount(owner, options);
    return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  };
  manager = await account({ permissions: ['leave_records.manage', 'leave_records.read'] });
  reader = await account({ organizationId: manager.organizationId, permissions: ['leave_records.read'] });
  foreign = await account({ permissions: ['leave_records.manage', 'leave_records.read'] });
});
after(async () => { await closePool(); await owner.end(); });

test('a leave record can be created, listed, updated and deleted with revision locking', async () => {
  const created = await work((client, identity) => createLeaveRecord(client, identity, { userId: manager.userId, fromDate: '2026-03-10', toDate: '2026-03-12', remark: 'Family event' }));
  assert.equal(created.userId, manager.userId); assert.equal(created.revision, 1);
  const listed = await work((client, identity) => listLeaveRecords(client, identity), reader);
  assert(listed.items.some((item) => item.id === created.id));
  const fetched = await work((client, identity) => getLeaveRecord(client, identity, created.id), reader);
  assert.equal(fetched.remark, 'Family event');
  const updated = await work((client, identity) => updateLeaveRecord(client, identity, created.id,
    { revision: created.revision, userId: manager.userId, fromDate: '2026-03-10', toDate: '2026-03-13', remark: 'Extended by a day' }));
  assert.equal(updated.revision, 2); assert.equal(updated.toDate, '2026-03-13');
  await assert.rejects(work((client, identity) => updateLeaveRecord(client, identity, created.id,
    { revision: created.revision, userId: manager.userId, fromDate: '2026-03-10', toDate: '2026-03-13', remark: 'Stale' })), { code: 'leave_record_changed' });
  await assert.rejects(work((client, identity) => deleteLeaveRecord(client, identity, created.id, created.revision)), { code: 'leave_record_changed' });
  await work((client, identity) => deleteLeaveRecord(client, identity, created.id, updated.revision));
  await assert.rejects(work((client, identity) => getLeaveRecord(client, identity, created.id)), { code: 'leave_record_not_found' });
});

test('an end date before the start date is rejected, matching PERN rather than Meteor\'s silent acceptance', async () => {
  await assert.rejects(work((client, identity) => createLeaveRecord(client, identity, { userId: manager.userId, fromDate: '2026-04-05', toDate: '2026-04-01' })),
    { code: 'invalid_leave_dates' });
});

test('permission and tenant boundaries are enforced', async () => {
  await assert.rejects(work((client, identity) => createLeaveRecord(client, identity, { userId: reader.userId, fromDate: '2026-05-01', toDate: '2026-05-02' }), reader), { status: 403 });
  const created = await work((client, identity) => createLeaveRecord(client, identity, { userId: manager.userId, fromDate: '2026-05-01', toDate: '2026-05-02' }));
  await assert.rejects(work((client, identity) => getLeaveRecord(client, identity, created.id), foreign), { code: 'leave_record_not_found' });
  await assert.rejects(work((client, identity) => createLeaveRecord(client, identity, { userId: randomUUID(), fromDate: '2026-05-01', toDate: '2026-05-02' })),
    { code: 'invalid_employee' });
});

test('an attachment can be uploaded, linked to a leave record and read back, and a foreign attachment reference is rejected', async () => {
  const content = Buffer.from('synthetic medical certificate');
  const uploaded = await work((client, identity) => uploadLeaveAttachment(client, identity, { requestId: randomUUID(), originalName: 'certificate.pdf', mediaType: 'application/pdf', content }));
  assert.equal(uploaded.replayed, false);
  const created = await work((client, identity) => createLeaveRecord(client, identity, { userId: manager.userId, fromDate: '2026-06-01', toDate: '2026-06-02', attachmentId: uploaded.id }));
  assert.equal(created.attachmentId, uploaded.id);
  const read = await work((client, identity) => readLeaveAttachment(client, identity, uploaded.id), reader);
  assert.deepEqual(read.content, content);
  const foreignUpload = await work((client, identity) => uploadLeaveAttachment(client, identity, { requestId: randomUUID(), originalName: 'other.pdf', mediaType: 'application/pdf', content }), foreign);
  await assert.rejects(work((client, identity) => createLeaveRecord(client, identity, { userId: manager.userId, fromDate: '2026-06-05', toDate: '2026-06-06', attachmentId: foreignUpload.id })),
    { code: 'attachment_not_found' });
});
