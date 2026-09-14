import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool, getPool } from '../../src/db/pool.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';
import { loadUserCustomFields, loadUserCustomFieldHistory, saveUserCustomFields } from '../../src/users/custom-fields.js';
import { uploadUserFieldAttachment } from '../../src/users/custom-field-attachments.js';
import { updateUserAccount } from '../../src/users/accounts.js';

const owner = ownerPool(); after(async () => { await closePool(); await owner.end(); });
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
async function account(options) {
  const actor = await createAccount(owner, options);
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
const definition = (fieldType = 'text', changes = {}) => ({ id: randomUUID(), requestId: randomUUID(), revision: 0,
  key: `field_${randomUUID().replaceAll('-', '')}`, label: 'Synthetic user field', associatedWith: 'users', fieldType, ...changes });
const entry = (field, value) => ({ fieldId: field.id, fieldRevision: field.revision, value });
const command = (customFields = [], changes = {}) => ({ requestId: randomUUID(), revision: 0, customFields, ...changes });
async function fixture() {
  const author = await account({ permissions: ['masters.manage'] });
  const manager = await account({ organizationId: author.organizationId, permissions: ['users.manage'] });
  const reader = await account({ organizationId: author.organizationId, permissions: ['users.read'] });
  const person = await createAccount(owner, { organizationId: author.organizationId, permissions: [] });
  const define = value => work(author, (client, identity) => saveCustomField(client, identity, value));
  return { author, manager, reader, person, define, field: (type, changes) => define(definition(type, changes)),
    save: (value, id = person.userId, actor = manager) => work(actor, (client, identity) => saveUserCustomFields(client, identity, id, value)),
    load: (options, id = person.userId, actor = reader) => work(actor, (client, identity) => loadUserCustomFields(client, identity, id, options), true),
    history: (options, id = person.userId, actor = reader) => work(actor, (client, identity) => loadUserCustomFieldHistory(client, identity, id, options), true) };
}
const head = async (f, id = f.person.userId) => (await owner.query('SELECT custom_field_revision FROM memberships WHERE organization_id=$1 AND user_id=$2', [f.author.organizationId, id])).rows[0].custom_field_revision;

test('unrecorded user fields differ from explicit empty captures and bounded immutable history', async () => {
  const f = await fixture(); const initial = await f.load(); assert.equal(initial.revision, 0); assert.equal(initial.recorded, false); assert.deepEqual(initial.customFields, []);
  assert.equal(initial.savedAt, null); assert.deepEqual(await f.history(), { rows: [], nextBeforeRevision: null });
  const first = command(); const saved = await f.save(first); assert.equal(saved.revision, 1); assert.deepEqual(await f.save(first), saved);
  await f.save(command([], { revision: 1 })); const record = await f.load(); assert.equal(record.revision, 2); assert.equal(record.recorded, true); assert.equal(record.savedBy, f.manager.userId);
  const page = await f.history({ limit: 1 }); assert.equal(page.rows[0].revision, 2); assert.equal(page.nextBeforeRevision, 2);
  assert.equal((await f.history({ beforeRevision: 2, limit: 1 })).rows[0].revision, 1);
  assert.equal((await f.load({ atRevision: 1 })).revision, 1); await assert.rejects(f.load({ atRevision: 3 }), { code: 'user_field_capture_not_found' });
  await assert.rejects(f.history({ limit: 101 }), { code: 'invalid_input' });
});

test('user captures preserve zero, false, cleaned arrays, invalid dates and explicit local date interpretation', async () => {
  const f = await fixture(); const fields = [];
  for (const [type, changes] of [['text'], ['number'], ['checkbox'], ['longtext', { allowsMultiple: true }], ['date'], ['date_time'], ['date', { allowsMultiple: true }]]) fields.push(await f.field(type, changes));
  const values = ['', 0, false, [0, false, '', '  ', 'kept'], '2026-01-31', '2026-01-31T13:45', ['not a date', -8640000000000000]];
  await f.save(command(fields.map((field, index) => entry(field, values[index])), { customFieldTimeZone: 'Asia/Kolkata' }));
  const loaded = await f.load(); assert.deepEqual(loaded.customFields.slice(0, 3).map(field => field.value), ['', 0, false]);
  assert.deepEqual(loaded.customFields[3].value, [0, false, 'kept']); assert.equal(loaded.customFields[3].displayValue, 'kept');
  assert.equal(loaded.customFields[4].displayValue, '31/01/2026'); assert.equal(loaded.customFields[4].timeZone, 'Asia/Kolkata');
  assert.deepEqual(loaded.customFields[6].items.map(item => item.interpretationState), ['invalid', 'out_of_range']);
  const parsed = (await owner.query('SELECT field_id,parsed_date,parsed_timestamp FROM user_version_custom_field_values WHERE organization_id=$1 AND subject_user_id=$2 AND field_id=ANY($3::uuid[])',
    [f.author.organizationId, f.person.userId, [fields[4].id, fields[5].id]])).rows;
  assert.equal(parsed.find(row => row.field_id === fields[4].id).parsed_timestamp.toISOString(), '2026-01-30T18:30:00.000Z');
  assert.equal(parsed.find(row => row.field_id === fields[5].id).parsed_timestamp.toISOString(), '2026-01-31T08:15:00.000Z');
  const missingZone = command(fields.map((field, index) => entry(field, values[index])), { revision: 1 });
  await assert.rejects(f.save(missingZone), { code: 'invalid_custom_field_timezone' }); assert.equal(await head(f), 1);
});

test('user captures freeze options, selected user observations and attachment revisions across later edits', async () => {
  const f = await fixture(); const selectInput = definition('select', { options: [{ id: randomUUID(), key: 'A', label: 'Original choice' }] });
  const select = await f.define(selectInput); const users = await f.field('multi_user_select'); const file = await f.field('attachment');
  const upload = await work(f.manager, (client, identity) => uploadUserFieldAttachment(client, identity, { requestId: randomUUID(), fieldId: file.id,
    fieldRevision: 1, originalName: 'Original.txt', mediaType: 'text/plain', content: Buffer.from('Immutable file') }));
  const fields = [entry(select, 'A'), entry(users, [f.reader.userId]), entry(file, upload.id)]; const first = command(fields); await f.save(first);
  await work(f.manager, (client, identity) => updateUserAccount(client, identity, f.reader.userId, { requestId: randomUUID(), revision: 1,
    username: f.reader.username, email: f.reader.email, displayName: 'Changed selected user', password: '' }));
  const nextSelect = await f.define({ ...selectInput, requestId: randomUUID(), revision: 1, label: 'Changed field', options: [{ id: randomUUID(), key: 'B', label: 'Later choice' }] });
  await f.save(command([entry(nextSelect, 'A'), fields[1], fields[2]], { revision: 1 }));
  const original = await f.load({ atRevision: 1 }); const current = await f.load();
  assert.equal(original.customFields[0].items[0].optionLabel, 'Original choice'); assert.equal(original.customFields[0].displayValue, 'Original choice');
  assert.equal(current.customFields[0].items[0].optionRevision, 1); assert.equal(current.customFields[0].displayValue, 'A');
  assert.equal(original.customFields[1].items[0].userName, 'Synthetic Analyst'); assert.equal(current.customFields[1].items[0].userName, 'Changed selected user');
  assert.equal(original.customFields[1].items[0].userUsername, f.reader.username); assert.equal(original.customFields[2].items[0].attachment.originalName, 'Original.txt');
  assert.match(original.customFields[2].items[0].attachment.url, /^\/api\/users\/custom-fields\/attachments\//);
  await work(f.author, (client, identity) => retireCustomField(client, identity, { id: file.id, revision: 1, requestId: randomUUID() }));
  assert.equal((await f.load({ atRevision: 1 })).customFields[2].items[0].attachmentId, upload.id);
  assert.equal((await f.save(first)).revision, 1); assert.equal(await head(f), 2);
});

test('capture retries compare every raw value and preserve order before stale/current definition checks', async () => {
  const f = await fixture(); const field = await f.field('text', { allowsMultiple: true }); const first = command([entry(field, ['first', 'second'])]);
  const results = await Promise.all([f.save(first), f.save(first)]); assert.deepEqual(results[0], results[1]);
  await assert.rejects(f.save({ ...first, customFields: [entry(field, ['second', 'first'])] }), { code: 'save_request_reused' });
  await assert.rejects(f.save({ ...first, customFields: [entry(field, ['changed', 'second'])] }), { code: 'save_request_reused' });
  await assert.rejects(f.save(first, f.person.userId, f.reader), { code: 'forbidden' });
  const otherManager = await account({ organizationId: f.author.organizationId, permissions: ['users.manage'] });
  await assert.rejects(f.save(first, f.person.userId, otherManager), { code: 'save_request_reused' });
  await assert.rejects(f.save(command(first.customFields)), { code: 'stale_user_custom_fields' });
  await f.save(command([entry(field, ['later'])], { revision: 1 }));
  await work(f.author, (client, identity) => retireCustomField(client, identity, { id: field.id, revision: 1, requestId: randomUUID() }));
  assert.deepEqual(await f.save(first), results[0]); assert.equal(await head(f), 2); assert.equal((await f.history()).rows.length, 2);
});

test('source user uniqueness includes inactive members and retains exact raw-string, scalar and repeated distinctions', async () => {
  const f = await fixture(); const field = await f.field('text', { validateUniqueness: true });
  const other = await createAccount(owner, { organizationId: f.author.organizationId });
  const race = await Promise.allSettled([f.person.userId, other.userId].map(id => f.save(command([entry(field, 'SAME')]), id)));
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1); assert.equal(race.find(result => result.status === 'rejected').reason.code, 'duplicate_user_custom_field');
  const winner = race[0].status === 'fulfilled' ? f.person.userId : other.userId;
  const loser = winner === f.person.userId ? other.userId : f.person.userId;
  await owner.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [f.author.organizationId, winner]);
  await assert.rejects(f.save(command([entry(field, 'SAME')]), loser), { code: 'duplicate_user_custom_field' });
  await f.save(command([entry(field, 'same')]), loser);
  for (const value of [false, false, -1, -1, 0, '0']) {
    const person = await createAccount(owner, { organizationId: f.author.organizationId }); await f.save(command([entry(field, value)]), person.userId);
  }
  const repeated = await createAccount(owner, { organizationId: f.author.organizationId });
  await assert.rejects(f.save(command([entry(field, 0)]), repeated.userId), { code: 'duplicate_user_custom_field' });
  await assert.rejects(f.save(command([entry(field, ['same', 'same'])]), repeated.userId), { code: 'duplicate_user_custom_field' });
  await assert.rejects(f.save(command([entry(field, [false, false])]), repeated.userId), { code: 'duplicate_user_custom_field' });
  assert.equal(await head(f, repeated.userId), 0);
});

test('requiredness, full current definition sets and unconfigured references reject atomically', async () => {
  const f = await fixture(); const required = await f.field('text', { isRequired: true });
  await assert.rejects(f.save(command()), { code: 'user_custom_fields_changed' });
  await assert.rejects(f.save(command([entry(required, '')])), { code: 'invalid_custom_field_value' });
  await assert.rejects(f.save(command([entry({ ...required, revision: 2 }, 'value')])), { code: 'user_custom_fields_changed' });
  const lookup = await f.field('lookup'); const users = await f.field('multi_user_select'); const file = await f.field('attachment');
  const valid = [entry(required, 'present'), entry(lookup, ''), entry(users, []), entry(file, '')];
  for (const [index, value, code] of [[1, 'unconfigured', 'invalid_user_custom_field_lookup'], [2, [randomUUID()], 'invalid_user_custom_field_user'], [3, randomUUID(), 'invalid_user_custom_field_attachment']]) {
    await assert.rejects(f.save(command(valid.map((item, position) => position === index ? { ...item, value } : item))), { code }); assert.equal(await head(f), 0);
  }
  await f.save(command(valid)); assert.equal(await head(f), 1);
});

test('user capture tables and views enforce actual tenant/session permissions without exposing master data', async () => {
  const f = await fixture(); const field = await f.field(); const first = command([entry(field, 'scoped')]); await f.save(first);
  const foreign = await fixture(); await assert.rejects(f.load({}, f.person.userId, foreign.manager), { code: 'user_not_found' });
  await assert.rejects(f.save(first, f.person.userId, foreign.manager), { code: 'user_not_found' });
  await assert.rejects(f.load({}, f.person.userId, f.author), { code: 'forbidden' });
  await assert.rejects(work(f.author, (client, identity) => saveUserCustomFields(client, { ...identity, permission_codes: ['users.manage'] }, f.person.userId, first)), { code: 'forbidden' });
  await work(f.reader, async (client, identity) => {
    assert.equal((await client.query('SELECT 1 FROM custom_field_definitions')).rowCount, 0);
    await assert.rejects(loadUserCustomFields(client, { ...identity, organization_id: foreign.author.organizationId }, f.person.userId), { code: 'user_not_found' });
    await client.query("SELECT set_config('app.organization_id',$1,true)", [foreign.author.organizationId]);
    for (const table of ['user_version_custom_fields', 'user_version_custom_field_values', 'user_field_capture_heads', 'user_field_capture_history']) assert.equal((await client.query(`SELECT 1 FROM ${table}`)).rowCount, 0);
  }, true);
  for (const table of ['user_version_custom_fields', 'user_version_custom_field_values', 'user_field_capture_heads', 'user_field_capture_history']) {
    assert.equal((await getPool().query(`SELECT 1 FROM ${table}`)).rowCount, 0);
    assert.equal((await owner.query('SELECT has_table_privilege($1,$2,$3) AS allowed', ['sampleify_report_worker', table, 'SELECT'])).rows[0].allowed, false);
  }
  await assert.rejects(work(f.manager, client => client.query('SELECT * FROM user_field_value_versions')), { code: '42501' });
});

test('direct SQL cannot commit incomplete captures or append/tamper with earlier immutable history', async () => {
  const f = await fixture(); const field = await f.field();
  await assert.rejects(work(f.manager, client => client.query('SELECT * FROM users_begin_field_capture($1,0,$2,1,NULL)', [f.person.userId, randomUUID()])), { constraint: 'user_custom_field_complete' });
  assert.equal(await head(f), 0);
  await f.save(command([entry(field, 'stored')]));
  for (const table of ['user_field_value_versions', 'user_version_custom_fields', 'user_version_custom_field_values']) {
    await assert.rejects(owner.query(`DELETE FROM ${table} WHERE organization_id=$1 AND subject_user_id=$2`, [f.author.organizationId, f.person.userId]), { code: '55000' });
  }
  await assert.rejects(work(f.manager, client => client.query("UPDATE user_version_custom_field_values SET raw_text='forged' WHERE subject_user_id=$1", [f.person.userId])), { code: '42501' });
  await assert.rejects(work(f.manager, (client, identity) => client.query(`INSERT INTO user_version_custom_fields
    (organization_id,subject_user_id,revision,field_id,field_revision,field_type,position,is_array,value_count,display_kind,display_text)
    VALUES($1,$2,1,$3,1,'text',1,false,1,'text','forged')`, [identity.organization_id, f.person.userId, field.id])), { constraint: 'user_custom_field_transaction' });
  assert.equal((await f.load()).customFields[0].value, 'stored');
});

test('direct SQL rejects missing or extra items and freezes selected-user labels from the actual member', async () => {
  const f = await fixture(); const field = await f.field('multi_user_select');
  const begin = async (client, identity) => {
    await client.query('SELECT * FROM users_begin_field_capture($1,0,$2,1,NULL)', [f.person.userId, randomUUID()]);
    await client.query(`INSERT INTO user_version_custom_fields
      (organization_id,subject_user_id,revision,field_id,field_revision,field_type,position,is_array,value_count,display_kind,display_text)
      VALUES($1,$2,1,$3,1,'multi_user_select',0,true,1,'text',$4)`, [identity.organization_id, f.person.userId, field.id, f.reader.userId]);
  };
  const item = (client, identity, position) => client.query(`INSERT INTO user_version_custom_field_values
    (organization_id,subject_user_id,revision,field_id,position,raw_kind,raw_text,interpretation_state,user_id,user_username,user_name)
    VALUES($1,$2,1,$3,$4,'text',$5::text,'valid',$5::uuid,'forged_username','Forged Name')`,
  [identity.organization_id, f.person.userId, field.id, position, f.reader.userId]);
  await assert.rejects(work(f.manager, begin), { constraint: 'user_custom_value_complete' });
  await assert.rejects(work(f.manager, async (client, identity) => { await begin(client, identity); await item(client, identity, 1); }), { constraint: 'user_custom_value_complete' });
  assert.equal(await head(f), 0);
  await work(f.manager, async (client, identity) => { await begin(client, identity); await item(client, identity, 0); });
  const captured = (await f.load()).customFields[0].items[0];
  assert.equal(captured.userUsername, f.reader.username); assert.equal(captured.userName, 'Synthetic Analyst');
});

test('capture transport and database boundaries reject oversized field and item sets without advancing history', async () => {
  const f = await fixture(); const ids = Array.from({ length: 11 }, () => randomUUID());
  await work(f.author, (client, identity) => client.query(`INSERT INTO custom_field_definitions
    (organization_id,id,key,label,associated_with,field_type,allows_multiple,save_request_id,display_order)
    SELECT $1,id,'field_'||replace(id::text,'-',''),'Field '||position,'users','text',true,gen_random_uuid(),position
    FROM unnest($2::uuid[]) WITH ORDINALITY AS fixture(id,position)`, [identity.organization_id, ids]));
  await assert.rejects(f.save(command(Array.from({ length: 501 }, () => entry({ id: randomUUID(), revision: 1 }, 'value')))), { code: 'invalid_custom_field_values' });
  await assert.rejects(f.save(command([entry({ id: ids[0], revision: 1 }, Array(501).fill('value'))])), { code: 'custom_field_value_limit' });
  await assert.rejects(f.save(command(ids.map(id => entry({ id, revision: 1 }, Array(500).fill('value'))))), { code: 'custom_field_value_limit' });
  await assert.rejects(work(f.manager, async (client, identity) => {
    await client.query('SELECT * FROM users_begin_field_capture($1,0,$2,11,NULL)', [f.person.userId, randomUUID()]);
    await client.query(`INSERT INTO user_version_custom_fields
      (organization_id,subject_user_id,revision,field_id,field_revision,field_type,position,is_array,value_count,display_kind,display_text)
      SELECT $1,$2,1,id,1,'text',position-1,true,500,'text','declared oversized capture'
      FROM unnest($3::uuid[]) WITH ORDINALITY AS fixture(id,position)`, [identity.organization_id, f.person.userId, ids]);
  }), { constraint: 'user_custom_field_complete' });
  assert.equal(await head(f), 0); assert.deepEqual((await f.history()).rows, []);
});

async function waitBlocked(pid) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await owner.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid])).rows[0].blocked) return;
    await delay(10);
  }
  assert.fail('Capture did not reach its expected database lock');
}
test('capture commands revalidate permissions, revocation and real expiry after an actor lock wait', async () => {
  for (const change of ['permission', 'revocation', 'expiry']) {
    const f = await fixture(); const field = await f.field(); const blocker = await owner.connect();
    await blocker.query('BEGIN'); await blocker.query('SELECT 1 FROM users WHERE id=$1 FOR UPDATE', [f.manager.userId]);
    let reached; const ready = new Promise(resolve => { reached = resolve; }); let setupError;
    const pending = work(f.manager, async (client, identity) => {
      reached((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      return saveUserCustomFields(client, identity, f.person.userId, command([entry(field, 'blocked')]));
    }).then(value => ({ value }), error => ({ error }));
    try {
      await waitBlocked(await ready);
      if (change === 'permission') await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2', [f.manager.organizationId, f.manager.roleId]);
      if (change === 'revocation') await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [f.manager.userId]);
      if (change === 'expiry') { await owner.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE user_id=$1", [f.manager.userId]); await delay(550); }
    } catch (error) { setupError = error;
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    const result = await pending; if (setupError) throw setupError;
    assert.equal(result.error?.code, 'forbidden'); assert.equal(await head(f), 0);
  }
});
