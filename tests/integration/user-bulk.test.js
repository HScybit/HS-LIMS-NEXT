import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { parseMasterBulkCsv } from '../../src/masters/bulk-csv.js';
import { correctMasterBulkRow, findMasterBulkUpload, listMasterBulk, loadMasterBulkPreview, stageMasterBulk } from '../../src/masters/bulk-store.js';
import { processMasterBulk, reviewMasterBulk } from '../../src/masters/bulk-service.js';
import { masterBulkOriginal, masterBulkRejected, masterBulkTemplate } from '../../src/masters/bulk-export.js';
import { prepareUserBulkDecoded, userBulkSourceFingerprint } from '../../src/users/bulk-credentials.js';
import { userBulkHeaders } from '../../src/users/bulk-input.js';
import { createUser } from '../../src/users/create.js';
import { loadUserProfile } from '../../src/users/profiles.js';

const owner = ownerPool(); after(async () => { await closePool(); await owner.end(); });
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
const account = async options => { const actor = await createAccount(owner, options); return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) }; };
async function fixture() {
  const actor = await account({ permissions: ['users.manage'] }); const reader = await account({ organizationId: actor.organizationId, permissions: ['users.read'] });
  const lab = randomUUID(); const unit = randomUUID();
  await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Bulk Lab')", [actor.organizationId, lab]);
  await owner.query("INSERT INTO business_units(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Bulk Unit')", [actor.organizationId, unit]);
  const row = (extra = {}) => { const token = randomUUID(); return { name: 'Bulk Person', email: `bulk-${token}@example.invalid`, username: `bulk-${token}`,
    phone: '00123', designation: 'Analyst', unit_name: 'Bulk Unit', role_name: `Reader ${reader.roleId}`, password: '  Synthetic imported password  ', lab_name: 'Bulk Lab', ...extra }; };
  return { actor, reader, lab, unit, row };
}
async function stage(actor, rows, { headers = userBulkHeaders, id = randomUUID() } = {}) {
  const source = [headers.join(','), ...rows.map(row => headers.map(header => row[header] ?? '').join(','))].join('\n');
  const decoded = parseMasterBulkCsv(source); const prepared = await prepareUserBulkDecoded(decoded);
  const input = { id, resource: 'users', fileName: 'Synthetic users.csv', format: 'csv', timeZone: 'UTC', sourceHmacSha256: userBulkSourceFingerprint(Buffer.from(source)) };
  await work(actor, (client, identity) => stageMasterBulk(client, identity, input, prepared.decoded, { credentials: prepared.credentials }));
  return { id, input, prepared, source };
}
const preview = (actor, batch) => work(actor, (client, identity) => loadMasterBulkPreview(client, identity, batch), true);
async function review(actor, id) {
  const state = await preview(actor, id);
  const result = await work(actor, (client, identity) => reviewMasterBulk(client, identity, id, {
    rows: state.rows.filter(row => !row.committed).map(row => ({ id: row.id, revision: row.revision, requestId: randomUUID() })),
  }));
  return { result, preview: await preview(actor, id) };
}
const processing = state => ({ rows: state.rows.filter(row => row.valid && !row.committed).map(row => ({ id: row.id, revision: row.revision, reviewId: row.reviewId, requestId: randomUUID() })) });
const process = (actor, id, input) => work(actor, (client, identity) => processMasterBulk(client, identity, id, input));
const correct = (actor, id, input) => work(actor, (client, identity) => correctMasterBulkRow(client, identity, id, input));
async function denied(client, action, code) {
  await client.query('SAVEPOINT denied'); await assert.rejects(action, error => error.code === code); await client.query('ROLLBACK TO SAVEPOINT denied'); await client.query('RELEASE SAVEPOINT denied');
}

test('User upload stages only redacted rows and creates actual usable native accounts after explicit review', async () => {
  const f = await fixture(); const input = f.row(); const batch = await stage(f.actor, [input]);
  assert.equal((await owner.query('SELECT id FROM users WHERE username=$1', [input.username])).rowCount, 0);
  const initial = await preview(f.actor, batch.id); assert.equal(initial.rows[0].passwordState, 'valid'); assert.equal(initial.rows[0].values[7], '');
  assert.equal(Object.hasOwn(initial.batch, 'sourceHmacSha256'), false); assert.equal(JSON.stringify(initial).includes(input.password.trim()), false);
  assert.equal(JSON.stringify(initial).includes(batch.prepared.credentials[0].passwordHash), false);
  const history = await work(f.actor, (client, identity) => listMasterBulk(client, identity, 'users'), true);
  assert.equal(history.totalCount, 1); assert.equal(Object.hasOwn(history.rows[0], 'sourceHmacSha256'), false);
  const checked = await review(f.actor, batch.id); assert.equal(checked.preview.summary.ready, 1, JSON.stringify(checked.result));
  const command = processing(checked.preview); const result = await process(f.actor, batch.id, command); assert.equal(result.committed, 1, JSON.stringify(result));
  const target = result.rows[0].resultId;
  const profile = await work(f.actor, (client, identity) => loadUserProfile(client, identity, target), true);
  assert.equal(profile.laboratoryId, f.lab); assert.equal(profile.businessUnitId, f.unit); assert.equal(profile.defaultRoleId, f.reader.roleId); assert.equal(profile.phone, '00123');
  assert.equal(profile.canManagePeople, false); assert.equal(profile.savedBy, f.actor.userId);
  const receipt = (await owner.query('SELECT user_id,request_id,created_by,profile_revision FROM user_creation_commands WHERE user_id=$1', [target])).rows[0];
  assert.equal(receipt.request_id, checked.preview.rows[0].reviewId); assert.equal(receipt.created_by, f.actor.userId); assert.equal(receipt.profile_revision, 1);
  const session = await signIn({ identifier: input.username, password: input.password.trim() }); assert(session.token);
  await assert.rejects(signIn({ identifier: input.username, password: input.password }), { code: 'invalid_credentials' });
  assert.deepEqual(await process(f.actor, batch.id, command), result);
  assert.equal((await owner.query('SELECT * FROM master_bulk_attempts WHERE batch_id=$1 AND committed', [batch.id])).rowCount, 1);
  assert.deepEqual(await work(f.actor, (client, identity) => findMasterBulkUpload(client, identity, batch.input), true), { id: batch.id, rowCount: 1 });
});

test('User preview, templates and raw tables enforce User management separately from master management and tenant scope', async () => {
  const f = await fixture(); const batch = await stage(f.actor, [f.row()]);
  const master = await account({ organizationId: f.actor.organizationId, permissions: ['masters.manage'] }); const foreign = await fixture();
  assert.deepEqual((await work(f.actor, (client, identity) => masterBulkTemplate(client, identity, 'users'), true)).headers, [...userBulkHeaders]);
  await assert.rejects(work(master, (client, identity) => masterBulkTemplate(client, identity, 'users'), true), { status: 403 });
  await assert.rejects(work(f.actor, (client, identity) => masterBulkTemplate(client, identity, 'products'), true), { status: 403 });
  await assert.rejects(preview(master, batch.id), { status: 404 }); await assert.rejects(preview(foreign.actor, batch.id), { status: 404 });
  await assert.rejects(preview(f.reader, batch.id), { status: 403 });
  await assert.rejects(work(master, (client, identity) => listMasterBulk(client, identity, 'users'), true), { status: 403 });
  await work(f.actor, async client => { await denied(client, () => client.query('SELECT * FROM master_bulk_user_credentials'), '42501'); });
  await work(master, async client => {
    for (const table of ['master_bulk_batches', 'master_bulk_rows', 'master_bulk_row_versions', 'master_bulk_cells', 'master_bulk_reviews', 'master_bulk_attempts', 'master_bulk_user_credential_states']) {
      assert.equal((await client.query(`SELECT * FROM ${table} WHERE ${table === 'master_bulk_batches' ? 'id' : 'batch_id'}=$1`, [batch.id])).rowCount, 0, table);
    }
  });
  const source = 'name,key\nProduct,PERMISSION-PROBE'; const productId = randomUUID();
  await work(master, (client, identity) => stageMasterBulk(client, identity, { id: productId, resource: 'products', fileName: 'Product.csv', format: 'csv', timeZone: 'UTC', sourceSha256: createHash('sha256').update(source).digest('hex') }, parseMasterBulkCsv(source)));
  assert.equal((await work(f.actor, (client, identity) => listMasterBulk(client, identity, 'all'), true)).totalCount, 1);
  assert.equal((await work(master, (client, identity) => listMasterBulk(client, identity, 'all'), true)).totalCount, 1);
});

test('User password corrections preserve untouched credentials, support explicit clears and reject a changed exact retry', async () => {
  const f = await fixture(); const batch = await stage(f.actor, [f.row({ password: '' })]);
  let state = (await review(f.actor, batch.id)).preview; assert.equal(state.summary.rejected, 1); assert.equal(state.rows[0].passwordState, 'missing');
  const row = state.rows[0]; const nameChange = { id: row.id, revision: 1, requestId: randomUUID(), cells: [{ columnNumber: 1, value: 'Corrected User' }] };
  assert.deepEqual(await correct(f.actor, batch.id, nameChange), { id: row.id, revision: 2 }); assert.deepEqual(await correct(f.actor, batch.id, nameChange), { id: row.id, revision: 2 });
  state = await preview(f.actor, batch.id); assert.equal(state.rows[0].passwordState, 'missing');
  const password = 'New synthetic password'; const passwordChange = { id: row.id, revision: 2, requestId: randomUUID(), cells: [{ columnNumber: 8, value: password }] };
  assert.deepEqual(await correct(f.actor, batch.id, passwordChange), { id: row.id, revision: 3 }); assert.deepEqual(await correct(f.actor, batch.id, passwordChange), { id: row.id, revision: 3 });
  await assert.rejects(correct(f.actor, batch.id, { ...passwordChange, cells: [{ columnNumber: 8, value: 'Different synthetic password' }] }), { code: 'bulk_request_reused' });
  state = (await review(f.actor, batch.id)).preview; assert.equal(state.summary.ready, 1); assert.equal(state.rows[0].passwordState, 'valid');
  await correct(f.actor, batch.id, { id: row.id, revision: 3, requestId: randomUUID(), cells: [{ columnNumber: 8, value: '' }] });
  state = (await review(f.actor, batch.id)).preview; assert.equal(state.summary.rejected, 1); assert.equal(state.rows[0].passwordState, 'missing');
  const rejected = await work(f.actor, (client, identity) => masterBulkRejected(client, identity, batch.id), true);
  const original = await work(f.actor, (client, identity) => masterBulkOriginal(client, identity, batch.id), true);
  assert.equal(rejected.rows[0][7], ''); assert.equal(original.rows[0][7], '');
  const cells = (await owner.query('SELECT text_value,formula,hyperlink FROM master_bulk_cells WHERE batch_id=$1 AND column_number=8', [batch.id])).rows;
  assert(cells.every(cell => cell.text_value === '' && cell.formula === null && cell.hyperlink === null));
  assert.equal((await owner.query('SELECT input_revision FROM master_bulk_user_credentials WHERE batch_id=$1', [batch.id])).rowCount, 4);
});

test('User duplicate and crossed aliases are blocked per row without converting existing accounts into updates', async () => {
  const f = await fixture(); const first = f.row(); const second = f.row({ username: first.email.toUpperCase() });
  const batch = await stage(f.actor, [first, second]); const checked = await review(f.actor, batch.id); assert.equal(checked.preview.summary.rejected, 2);
  const existing = await stage(f.actor, [f.row({ email: f.reader.email })]);
  const duplicate = await review(f.actor, existing.id); assert.equal(duplicate.preview.rows[0].validationCode, 'sign_in_identifier_taken');
  assert.equal((await owner.query('SELECT * FROM user_creation_commands WHERE user_id=$1', [f.reader.userId])).rowCount, 0);
  const same = f.row(); same.username = same.email; const allowed = await stage(f.actor, [same]);
  const valid = await review(f.actor, allowed.id); assert.equal(valid.preview.summary.ready, 1); assert.equal((await process(f.actor, allowed.id, processing(valid.preview))).committed, 1);
});

test('retired or changed references and later global aliases prevent a stale User review from creating an account', async () => {
  const f = await fixture(); const row = f.row(); const batch = await stage(f.actor, [row]); const checked = await review(f.actor, batch.id);
  await owner.query('UPDATE laboratories SET active=false,revision=revision+1 WHERE organization_id=$1 AND id=$2', [f.actor.organizationId, f.lab]);
  const failed = await process(f.actor, batch.id, processing(checked.preview)); assert.equal(failed.rejected, 1); assert.equal(failed.rows[0].error.code, 'invalid_user_bulk_row');
  assert.equal((await owner.query('SELECT id FROM users WHERE username=$1', [row.username])).rowCount, 0);
  const next = await fixture(); const target = next.row(); const upload = await stage(next.actor, [target]); const before = await review(next.actor, upload.id);
  const other = await fixture(); const id = randomUUID();
  await work(other.actor, (client, identity) => createUser(client, identity, { id, requestId: randomUUID(), revision: 0, username: target.username,
    email: `other-${id}@example.invalid`, displayName: 'Concurrent account', password: 'Concurrent account password', defaultRoleId: other.reader.roleId, laboratoryId: other.lab }));
  const command = processing(before.preview); const result = await process(next.actor, upload.id, command); assert.equal(result.rejected, 1); assert.equal(result.rows[0].error.code, 'sign_in_identifier_taken');
  assert.deepEqual(await process(next.actor, upload.id, command), result);
});

test('concurrent processing and repeated upload requests create only one User and preserve original outcomes', async () => {
  const f = await fixture(); const batch = await stage(f.actor, [f.row()]); const checked = await review(f.actor, batch.id); const input = processing(checked.preview);
  const [first, second] = await Promise.all([process(f.actor, batch.id, input), process(f.actor, batch.id, input)]); assert.deepEqual(first, second); assert.equal(first.committed, 1);
  const outcome = await work(f.actor, (client, identity) => stageMasterBulk(client, identity, batch.input, batch.prepared.decoded, { credentials: batch.prepared.credentials }));
  assert.deepEqual(outcome, { id: batch.id, rowCount: 1 });
  await assert.rejects(work(f.actor, (client, identity) => findMasterBulkUpload(client, identity, { ...batch.input, sourceHmacSha256: 'a'.repeat(64) }), true), { code: 'bulk_request_reused' });
  await assert.rejects(correct(f.actor, batch.id, { id: checked.preview.rows[0].id, revision: 1, requestId: randomUUID(), cells: [{ columnNumber: 1, value: 'Too late' }] }), { code: 'bulk_row_committed' });
  assert.equal((await owner.query('SELECT * FROM user_creation_commands WHERE user_id=$1', [first.rows[0].resultId])).rowCount, 1);
});
