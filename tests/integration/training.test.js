import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { listTrainingSchedules, getTrainingSchedule, createTrainingSchedule, updateTrainingSchedule,
  listTrainingAttendance, recordTrainingAttendance,
  listUserCertifications, getUserCertification, createUserCertification, updateUserCertification,
  uploadUserCertificationFile, readUserCertificationFile } from '../../src/training/service.js';

const owner = ownerPool(); let manager; let trainee;
const work = (action, user = manager) => withSession(user.token, action, { csrfToken: user.csrfToken });
before(async () => {
  const account = async (options = {}) => {
    const user = await createAccount(owner, options);
    return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  };
  manager = await account({ permissions: ['training.manage', 'training.read'] });
  trainee = await account({ organizationId: manager.organizationId, permissions: ['training.read'] });
});
after(async () => { await closePool(); await owner.end(); });

test('a training schedule can be created, listed, fetched and updated with a new attendee roster', async () => {
  const created = await work((client, identity) => createTrainingSchedule(client, identity,
    { name: 'GLP Refresher', fromDate: '2026-05-01', toDate: '2026-05-02', trainerName: 'Synthetic Trainer', attendeeIds: [manager.userId, trainee.userId] }));
  assert.equal(created.revision, 1); assert.deepEqual(new Set(created.attendeeIds), new Set([manager.userId, trainee.userId]));
  const listed = await work((client, identity) => listTrainingSchedules(client, identity), trainee);
  assert(listed.items.some((item) => item.id === created.id));
  const fetched = await work((client, identity) => getTrainingSchedule(client, identity, created.id), trainee);
  assert.equal(fetched.name, 'GLP Refresher');
  const updated = await work((client, identity) => updateTrainingSchedule(client, identity, created.id,
    { revision: created.revision, name: 'GLP Refresher', fromDate: '2026-05-01', toDate: '2026-05-02', attendeeIds: [manager.userId] }));
  assert.equal(updated.revision, 2); assert.deepEqual(updated.attendeeIds, [manager.userId]);
  await assert.rejects(work((client, identity) => updateTrainingSchedule(client, identity, created.id,
    { revision: created.revision, name: 'Stale', fromDate: '2026-05-01', toDate: '2026-05-02', attendeeIds: [manager.userId] })), { code: 'training_schedule_changed' });
});

test('reversed dates and non-member/unlisted attendees are rejected', async () => {
  await assert.rejects(work((client, identity) => createTrainingSchedule(client, identity,
    { name: 'Invalid', fromDate: '2026-05-10', toDate: '2026-05-01', attendeeIds: [manager.userId] })), { code: 'invalid_training_dates' });
  await assert.rejects(work((client, identity) => createTrainingSchedule(client, identity,
    { name: 'Invalid', fromDate: '2026-05-01', toDate: '2026-05-02', attendeeIds: [randomUUID()] })), { code: 'invalid_attendee' });
});

test('attendance can be recorded per attendee per date, upserting on repeat, and rejects a non-scheduled user', async () => {
  const schedule = await work((client, identity) => createTrainingSchedule(client, identity,
    { name: 'Method Training', fromDate: '2026-06-01', toDate: '2026-06-01', attendeeIds: [manager.userId] }));
  await assert.rejects(work((client, identity) => recordTrainingAttendance(client, identity, schedule.id,
    { userId: trainee.userId, attendanceDate: '2026-06-01' })), { code: 'invalid_attendee' });
  const recorded = await work((client, identity) => recordTrainingAttendance(client, identity, schedule.id,
    { userId: manager.userId, attendanceDate: '2026-06-01', checkInAt: '2026-06-01T09:00:00Z' }));
  assert.equal(recorded.revision, 1); assert.equal(recorded.checkOutAt, null);
  const updated = await work((client, identity) => recordTrainingAttendance(client, identity, schedule.id,
    { userId: manager.userId, attendanceDate: '2026-06-01', checkInAt: '2026-06-01T09:00:00Z', checkOutAt: '2026-06-01T17:00:00Z' }));
  assert.equal(updated.id, recorded.id); assert.equal(updated.revision, 2); assert.ok(updated.checkOutAt);
  const listed = await work((client, identity) => listTrainingAttendance(client, identity, schedule.id), trainee);
  assert.equal(listed.items.length, 1);
});

test('a certification can be recorded with an uploaded certificate, listed by user and updated', async () => {
  const content = Buffer.from('synthetic certificate bytes');
  const uploaded = await work((client, identity) => uploadUserCertificationFile(client, identity, { requestId: randomUUID(), originalName: 'certificate.pdf', mediaType: 'application/pdf', content }));
  const created = await work((client, identity) => createUserCertification(client, identity,
    { userId: trainee.userId, certificationName: 'Method X Competency', validFrom: '2026-01-01', validTill: '2027-01-01', certificateFileId: uploaded.id, reviewerId: manager.userId }));
  assert.equal(created.completionStatus, 'pending'); assert.equal(created.certificateFileId, uploaded.id);
  const listed = await work((client, identity) => listUserCertifications(client, identity, { userId: trainee.userId }), trainee);
  assert.equal(listed.items.length, 1);
  const fetched = await work((client, identity) => getUserCertification(client, identity, created.id), trainee);
  const read = await work((client, identity) => readUserCertificationFile(client, identity, uploaded.id), trainee);
  assert.deepEqual(read.content, content);
  const updated = await work((client, identity) => updateUserCertification(client, identity, created.id,
    { revision: fetched.revision, userId: trainee.userId, certificationName: 'Method X Competency', completionStatus: 'completed', validFrom: '2026-01-01', validTill: '2027-01-01' }));
  assert.equal(updated.completionStatus, 'completed'); assert.equal(updated.certificateFileId, null);
});

test('a valid-till date before valid-from is rejected', async () => {
  await assert.rejects(work((client, identity) => createUserCertification(client, identity,
    { userId: trainee.userId, certificationName: 'Invalid', validFrom: '2026-03-01', validTill: '2026-01-01' })), { code: 'invalid_certification_dates' });
});
