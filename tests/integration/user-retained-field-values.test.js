import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';
import { saveUserCustomFields, loadUserCustomFields } from '../../src/users/custom-fields.js';
import { uploadUserFieldAttachment, readUserFieldAttachment } from '../../src/users/custom-field-attachments.js';
import { uploadCustomFieldAttachment } from '../../src/custom-fields/attachments.js';
import { updateUserForm, loadUserForm } from '../../src/users/forms.js';
import { createUser } from '../../src/users/create.js';

const owner = ownerPool(); after(async () => { await closePool(); await owner.end(); });
const work = (actor, operation, readOnly = false) => withSession(actor.token, operation, { readOnly });
const account = async options => { const person = await createAccount(owner, options); return { ...person, ...await signIn({ identifier: person.username, password: person.password }) }; };
const choice = (key, label = key) => ({ id: randomUUID(), key, label });
async function fixture(changes = {}) {
  const author = await account({ permissions: ['masters.manage'] }); const manager = await account({ organizationId: author.organizationId, permissions: ['users.manage'] });
  const person = await account({ organizationId: author.organizationId, permissions: ['users.read'] });
  let definition = { id: randomUUID(), requestId: randomUUID(), revision: 0, key: 'saved_key', label: 'Saved field', fieldType: 'select',
    associatedWith: 'users', options: [choice('A', 'Original A')], ...changes };
  let field = await work(author, (client, identity) => saveCustomField(client, identity, definition));
  const define = async changes => { definition = { ...definition, revision: field.revision, requestId: randomUUID(), ...changes };
    field = await work(author, (client, identity) => saveCustomField(client, identity, definition)); return field; };
  const replace = async (changes = {}) => {
    const key = definition.key; await define({ key: key + '_old_' + randomUUID().replaceAll('-', '') });
    await work(author, (client, identity) => retireCustomField(client, identity, { id: field.id, revision: field.revision, requestId: randomUUID() }));
    definition = { ...definition, id: randomUUID(), requestId: randomUUID(), revision: 0, key, options: [choice('B', 'Current B')], ...changes };
    field = await work(author, (client, identity) => saveCustomField(client, identity, definition)); return field;
  };
  const input = (value, revision, requestId = randomUUID()) => ({ requestId, revision, customFields: [{ fieldId: field.id, fieldRevision: field.revision, value }] });
  return { author, manager, person, define, replace, field: () => field, input,
    save: (value, revision, requestId, target = person) => work(manager, (client, identity) => saveUserCustomFields(client, identity, target.userId, input(value, revision, requestId))),
    read: (options, target = person) => work(manager, (client, identity) => loadUserCustomFields(client, identity, target.userId, options), true),
    upload: (name = 'Original.txt', content = Buffer.from('Actual original ' + name)) => work(manager, (client, identity) => uploadUserFieldAttachment(client, identity, { requestId: randomUUID(), fieldId: field.id, fieldRevision: field.revision,
      originalName: name, mediaType: 'text/plain', content })) };
}
async function unchanged(f, operation, error) {
  const before = await f.read(); const count = (await owner.query('SELECT count(*)::integer AS count FROM user_field_value_versions WHERE organization_id=$1 AND subject_user_id=$2', [f.author.organizationId, f.person.userId])).rows[0].count;
  await assert.rejects(operation, error); assert.deepEqual(await f.read(), before);
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM user_field_value_versions WHERE organization_id=$1 AND subject_user_id=$2', [f.author.organizationId, f.person.userId])).rows[0].count, count);
}

test('a reused user key retains an unresolved selection through repeat saves and then resolves an actual current option', async () => {
  const f = await fixture(); const original = f.field(); await f.save('A', 0); await f.replace(); const requestId = randomUUID();
  const saved = await f.save('A', 1, requestId); assert.equal(saved.revision, 2);
  let field = (await f.read()).customFields[0]; assert.equal(field.key, 'saved_key'); assert.notEqual(field.fieldId, original.id);
  assert.equal(field.value, 'A'); assert.equal(field.displayValue, 'A'); assert.equal(field.items[0].interpretationState, 'invalid'); assert.equal(field.items[0].optionId, null); assert.equal(field.items[0].optionLabel, null);
  const historical = (await f.read({ atRevision: 1 })).customFields[0]; assert.equal(historical.fieldId, original.id); assert.equal(historical.items[0].optionLabel, 'Original A');
  await f.save('A', 2); const later = await f.read(); assert.deepEqual(await f.save('A', 1, requestId), saved); assert.deepEqual(await f.read(), later);
  const option = choice('A', 'New current A'); await f.define({ options: [option] }); await f.save('A', 3);
  field = (await f.read()).customFields[0]; assert.equal(field.items[0].interpretationState, 'valid'); assert.equal(field.items[0].optionId, option.id); assert.equal(field.items[0].optionRevision, 2); assert.equal(field.displayValue, 'New current A');
  assert.equal((await f.read({ atRevision: 2 })).customFields[0].items[0].optionId, null);
});

test('same-definition older options require saved-key continuity and a renamed key cannot inherit them', async () => {
  const f = await fixture(); await f.save('A', 0); await f.define({ options: [choice('B')] }); await f.save('A', 1);
  assert.equal((await f.read()).customFields[0].items[0].optionRevision, 1);
  await f.define({ key: 'renamed_key' }); await unchanged(f, () => f.save('A', 2), { code: 'invalid_user_custom_field_option' });
  await f.save('B', 2); assert.equal((await f.read()).customFields[0].key, 'renamed_key');
});

test('text-to-select transitions retain exact ordered raw primitives and distinguish number and boolean types', async () => {
  const f = await fixture({ fieldType: 'text', allowsMultiple: true, options: [] }); await f.save([0, false, 'A'], 0);
  await f.define({ fieldType: 'select', options: [choice('B')] }); await f.save([false, 0, 'A'], 1);
  const field = (await f.read()).customFields[0]; assert.deepEqual(field.value, [false, 0, 'A']); assert.equal(field.displayValue, 'A'); assert(field.items.every(item => item.interpretationState === 'invalid' && item.optionId === null));
  await unchanged(f, () => f.save(['false', 0, 'A'], 2), { code: 'invalid_user_custom_field_option' });
  await unchanged(f, () => f.save([false, '0', 'A'], 2), { code: 'invalid_user_custom_field_option' });
});

test('an intervening clear or a different subject cannot borrow older unresolved selections', async () => {
  const f = await fixture(); await f.save('A', 0); await f.replace(); await f.save('', 1);
  await unchanged(f, () => f.save('A', 2), { code: 'invalid_user_custom_field_option' });
  const other = await createAccount(owner, { organizationId: f.author.organizationId, permissions: [] });
  await assert.rejects(f.save('A', 0, undefined, other), { code: 'invalid_user_custom_field_option' });
  assert.equal((await f.read({ atRevision: 1 })).customFields[0].value, 'A');
});

test('a replacement attachment definition retains the actual same-key file and its immutable original metadata', async () => {
  const f = await fixture({ fieldType: 'attachment', options: [] }); const original = f.field(); const file = await f.upload();
  await f.define({ key: 'captured_key' }); await f.save(file.id, 0);
  await f.replace({ options: [] }); const requestId = randomUUID(); const saved = await f.save(file.id, 1, requestId); await f.save(file.id, 2);
  const current = await f.read(); assert.equal(current.customFields[0].items[0].attachmentId, file.id); assert.equal(current.customFields[0].items[0].attachment.originalName, 'Original.txt');
  assert.deepEqual(await f.save(file.id, 1, requestId), saved); assert.deepEqual(await f.read(), current);
  const attachment = (await owner.query('SELECT field_id,field_revision,original_name FROM custom_field_attachments WHERE organization_id=$1 AND id=$2', [f.author.organizationId, file.id])).rows[0];
  assert.deepEqual(attachment, { field_id: original.id, field_revision: 1, original_name: 'Original.txt' });
  assert.equal((await f.read({ atRevision: 1 })).customFields[0].fieldId, original.id);
});

test('files uploaded under another key require immediate same-subject capture evidence after definition replacement', async () => {
  for (const mode of ['first', 'key', 'clear', 'subject']) {
    const f = await fixture({ fieldType: 'attachment', options: [] }); const file = await f.upload();
    await f.define({ key: 'captured_key' });
    if (mode !== 'first') await f.save(file.id, 0);
    await f.replace({ options: [], ...(mode === 'key' ? { key: 'another_key' } : {}) });
    if (mode === 'clear') await f.save('', 1);
    if (mode === 'subject') {
      const other = await createAccount(owner, { organizationId: f.author.organizationId, permissions: [] });
      await assert.rejects(f.save(file.id, 0, undefined, other), { code: 'invalid_user_custom_field_attachment' });
    } else await unchanged(f, () => f.save(file.id, mode === 'first' ? 0 : mode === 'clear' ? 2 : 1), { code: 'invalid_user_custom_field_attachment' });
  }
});

test('fresh upload-key drafts survive definition replacement with no capture or a different previously captured file', async () => {
  for (const priorCapture of [false, true]) {
    const f = await fixture({ fieldType: 'attachment', options: [] }); const original = f.field();
    const old = priorCapture ? await f.upload('Previous.txt') : null; if (old) await f.save(old.id, 0);
    const bytes = priorCapture ? Buffer.from('New draft bytes') : Buffer.alloc(0); const file = await f.upload('Fresh draft.txt', bytes);
    const originalFile = await work(f.manager, (c, i) => readUserFieldAttachment(c, i, file.id), true);
    await f.replace({ options: [] }); const input = f.input(file.id.toUpperCase(), Number(priorCapture));
    const save = () => work(f.manager, (c, i) => saveUserCustomFields(c, i, f.person.userId, input));
    const result = await save(); const capture = await f.read(); assert.equal(capture.revision, Number(priorCapture) + 1);
    assert.equal(capture.customFields[0].value, file.id.toUpperCase()); assert.equal(capture.customFields[0].items[0].attachmentId, file.id);
    assert.equal(capture.customFields[0].fieldId, f.field().id);
    if (old) assert.equal((await f.read({ atRevision: 1 })).customFields[0].value, old.id);
    await f.save(file.id, capture.revision); const later = await f.read(); await f.define({ key: 'later_key' });
    assert.deepEqual(await save(), result); assert.deepEqual(await f.read(), later);
    const after = await work(f.manager, (c, i) => readUserFieldAttachment(c, i, file.id), true);
    assert.deepEqual(after, originalFile); assert(after.content.equals(bytes)); assert.equal(after.fieldId, original.id); assert.equal(after.fieldRevision, 1);
  }
});

test('an actual matching upload key permits explicit selection after a clear and for another scoped subject', async () => {
  const f = await fixture({ fieldType: 'attachment', options: [] }); const file = await f.upload(); await f.replace({ options: [] });
  await direct(f, { value: file.id, attachmentId: file.id, state: 'valid', revision: 0 });
  await f.save('', 1); await f.save(file.id, 2); assert.equal((await f.read()).customFields[0].value, file.id);
  const other = await createAccount(owner, { organizationId: f.author.organizationId, permissions: [] });
  await f.save(file.id, 0, undefined, other); assert.equal((await f.read({}, other)).customFields[0].value, file.id);
  assert.equal((await f.read({ atRevision: 2 })).customFields[0].value, '');
});

test('changing the upload definition current key cannot fabricate immutable same-key draft provenance', async () => {
  const f = await fixture({ fieldType: 'attachment', options: [], key: 'uploaded_key' }); const file = await f.upload();
  await f.define({ key: 'current_key' }); await f.replace({ options: [] });
  await unchanged(f, () => f.save(file.id, 0), { code: 'invalid_user_custom_field_attachment' });
  await unchanged(f, () => direct(f, { value: file.id, attachmentId: file.id, state: 'valid', revision: 0 }), { code: '23514', constraint: 'user_custom_value_attachment' });
});

test('matching upload keys never admit foreign-organization or master-only attachments through user captures', async () => {
  const f = await fixture({ fieldType: 'attachment', options: [] }); const foreign = await fixture({ fieldType: 'attachment', options: [] }); const foreignFile = await foreign.upload();
  const original = f.field(); await work(f.author, (c, i) => retireCustomField(c, i, { id: original.id, revision: 1, requestId: randomUUID() }));
  const master = await work(f.author, (c, i) => saveCustomField(c, i, { id: randomUUID(), requestId: randomUUID(), revision: 0, key: original.key,
    label: 'Master-only file', fieldType: 'attachment', associatedWith: 'product' }));
  const masterFile = await work(f.author, (c, i) => uploadCustomFieldAttachment(c, i, { requestId: randomUUID(), fieldId: master.id, fieldRevision: 1,
    originalName: 'Master.txt', mediaType: 'text/plain', content: Buffer.from('Only master authority') }));
  await work(f.author, (c, i) => retireCustomField(c, i, { id: master.id, revision: 1, requestId: randomUUID() }));
  await f.define({ id: randomUUID(), revision: 0 });
  for (const file of [foreignFile, masterFile]) {
    await unchanged(f, () => f.save(file.id, 0), { code: 'invalid_user_custom_field_attachment' });
    await unchanged(f, () => direct(f, { value: file.id, attachmentId: file.id, state: 'valid', revision: 0 }), { code: '23514', constraint: 'user_custom_value_attachment' });
  }
});

test('fresh file drafts participate in atomic account creation and full-form rollback without earlier capture evidence', async () => {
  const f = await fixture({ fieldType: 'attachment', options: [] }); const file = await f.upload(); await f.replace({ options: [] });
  const lab = randomUUID(); await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Fresh-file laboratory')", [f.author.organizationId, lab]);
  const fields = f.input(file.id, 0).customFields; const id = randomUUID();
  const create = { id, requestId: randomUUID(), revision: 0, username: 'new-file-' + id, email: id + '@example.invalid', displayName: 'New file user',
    password: 'Synthetic fresh-file password', defaultRoleId: f.person.roleId, laboratoryId: lab, customFields: fields };
  await assert.rejects(work(f.manager, (c, i) => createUser(c, i, { ...create, customFields: [{ ...fields[0], value: randomUUID() }] })), { code: 'invalid_user_custom_field_attachment' });
  assert.equal((await owner.query('SELECT 1 FROM users WHERE id=$1', [id])).rowCount, 0);
  const created = await work(f.manager, (c, i) => createUser(c, i, create)); assert.equal(created.customFieldRevision, 1);
  assert.deepEqual(await work(f.manager, (c, i) => createUser(c, i, create)), created);
  const form = { requestId: randomUUID(), revision: 1, profileRevision: 0, username: f.person.username, email: f.person.email, displayName: 'Fresh file edit',
    defaultRoleId: f.person.roleId, laboratoryId: lab, phone: 'Atomic draft contact', customFieldRevision: 0, customFields: fields };
  const read = () => work(f.manager, (c, i) => loadUserForm(c, i, f.person.userId), true); const before = await read();
  await assert.rejects(work(f.manager, (c, i) => updateUserForm(c, i, f.person.userId, { ...form, email: f.manager.email })), { code: 'sign_in_identifier_taken' });
  assert.deepEqual(await read(), before);
  const saved = await work(f.manager, (c, i) => updateUserForm(c, i, f.person.userId, form)); assert.equal(saved.customFieldRevision, 1);
  assert.deepEqual(await work(f.manager, (c, i) => updateUserForm(c, i, f.person.userId, form)), saved);
  assert.equal((await read()).fieldCapture.customFields[0].items[0].attachmentId, file.id); assert.equal((await read()).profile.phone, form.phone);
});

async function direct(f, { value, state = 'invalid', revision = 1, optionId = null, optionRevision = null, attachmentId = null }) {
  return work(f.manager, async (client, identity) => {
    const field = f.field(); await client.query('SELECT * FROM users_begin_field_capture($1,$2,$3,1,NULL)', [f.person.userId, revision, randomUUID()]);
    const type = attachmentId ? 'attachment' : 'select';
    await client.query(`INSERT INTO user_version_custom_fields(organization_id,subject_user_id,revision,field_id,field_revision,field_type,position,is_array,value_count,display_kind,display_text)
      VALUES($1,$2,$3,$4,$5,$6,0,false,1,'text',$7)`, [identity.organization_id, f.person.userId, revision + 1, field.id, field.revision, type, value]);
    await client.query(`INSERT INTO user_version_custom_field_values(organization_id,subject_user_id,revision,field_id,position,raw_kind,raw_text,interpretation_state,option_id,option_revision,attachment_id)
      VALUES($1,$2,$3,$4,0,'text',$5,$6,$7,$8,$9)`, [identity.organization_id, f.person.userId, revision + 1, field.id, value, state, optionId, optionRevision, attachmentId]);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  });
}

test('native dropdown guards reject fabricated invalid states, cross-definition option references and out-of-range claims', async () => {
  const f = await fixture(); await f.save('A', 0); const old = (await f.read()).customFields[0].items[0]; await f.replace();
  for (const input of [{ value: 'unknown' }, { value: 'B' }, { value: 'A', state: 'valid', optionId: old.optionId, optionRevision: old.optionRevision }]) {
    await unchanged(f, () => direct(f, input), { code: '23514', constraint: 'user_custom_value_option' });
  }
  await unchanged(f, () => direct(f, { value: 'A', state: 'out_of_range' }), { code: '23514' });
  await direct(f, { value: 'A' }); assert.equal((await f.read()).customFields[0].items[0].interpretationState, 'invalid');
});

test('native older-option guards enforce saved keys and preserve the real same-definition reference', async () => {
  const f = await fixture(); await f.save('A', 0); const old = (await f.read()).customFields[0].items[0]; await f.define({ options: [choice('B')] });
  await unchanged(f, () => direct(f, { value: 'A' }), { code: '23514', constraint: 'user_custom_value_option' });
  await f.define({ key: 'another_key' });
  await unchanged(f, () => direct(f, { value: 'A', state: 'valid', optionId: old.optionId, optionRevision: old.optionRevision }), { code: '23514', constraint: 'user_custom_value_option' });
});

test('native file guards reject an original absent from the previous capture and admit only the actual retained reference', async () => {
  const f = await fixture({ fieldType: 'attachment', options: [] }); const saved = await f.upload('Saved.txt'); const unrelated = await f.upload('Never selected.txt');
  await f.define({ key: 'captured_key' }); await f.save(saved.id, 0); await f.replace({ options: [] });
  await unchanged(f, () => direct(f, { value: unrelated.id, attachmentId: unrelated.id, state: 'valid' }), { code: '23514', constraint: 'user_custom_value_attachment' });
  await direct(f, { value: saved.id, attachmentId: saved.id, state: 'valid' }); assert.equal((await f.read()).customFields[0].items[0].attachmentId, saved.id);
});

test('complete forms retain saved-key values atomically while new accounts cannot borrow that history', async () => {
  const f = await fixture(); await f.save('A', 0); await f.replace(); const lab = randomUUID();
  await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Retained form lab')", [f.author.organizationId, lab]);
  const input = { requestId: randomUUID(), revision: 1, profileRevision: 0, username: f.person.username, email: f.person.email, displayName: 'Retained complete form',
    phone: 'Actual contact', defaultRoleId: f.person.roleId, laboratoryId: lab, customFieldRevision: 1, customFields: f.input('A', 1).customFields };
  const read = () => work(f.manager, (client, identity) => loadUserForm(client, identity, f.person.userId), true); const before = await read();
  await assert.rejects(work(f.manager, (client, identity) => updateUserForm(client, identity, f.person.userId, { ...input, email: f.manager.email })), { code: 'sign_in_identifier_taken' }); assert.deepEqual(await read(), before);
  const saved = await work(f.manager, (client, identity) => updateUserForm(client, identity, f.person.userId, input)); assert.equal(saved.customFieldRevision, 2);
  await f.save('A', 2); const later = await read(); assert.deepEqual(await work(f.manager, (client, identity) => updateUserForm(client, identity, f.person.userId, input)), saved); assert.deepEqual(await read(), later);
  const id = randomUUID(); await assert.rejects(work(f.manager, (client, identity) => createUser(client, identity, { id, requestId: randomUUID(), revision: 0,
    username: 'new-retained-' + id, email: id + '@example.invalid', displayName: 'Cannot borrow history', password: 'Synthetic new retained password',
    defaultRoleId: f.person.roleId, laboratoryId: lab, customFields: input.customFields })), { code: 'invalid_user_custom_field_option' });
  assert.equal((await owner.query('SELECT 1 FROM users WHERE id=$1', [id])).rowCount, 0);
});
