import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';
import { uploadCustomFieldAttachment, readCustomFieldAttachment } from '../../src/custom-fields/attachments.js';
import { uploadUserFieldAttachment } from '../../src/users/custom-field-attachments.js';
import { saveProduct, loadProduct, retireProduct } from '../../src/masters/products.js';
import { saveTestParameter, loadTestParameter, retireTestParameter } from '../../src/masters/test-parameters.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const apis = { product: { save: saveProduct, load: loadProduct, retire: retireProduct, versions: 'product_versions', idColumn: 'product_id' },
  parameter: { save: saveTestParameter, load: loadTestParameter, retire: retireTestParameter, versions: 'test_parameter_versions', idColumn: 'parameter_id' } };
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { csrfToken: actor.csrfToken, readOnly });
async function fixture(kind, changes = {}) {
  const user = await createAccount(owner, { permissions: ['masters.manage', 'users.manage'] });
  const actor = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  let definition = { id: randomUUID(), requestId: randomUUID(), revision: 0, key: 'saved_key', label: 'Saved field',
    fieldType: 'attachment', associatedWith: kind, options: [], ...changes };
  let field = await work(actor, (c, i) => saveCustomField(c, i, definition));
  const id = randomUUID(); const key = randomUUID(); const api = apis[kind];
  const input = (value, revision, requestId = randomUUID(), target = { id, key }) => ({ ...target, requestId, revision, name: 'Retained attachment master',
    ...(kind === 'parameter' ? { schemeAbbreviation: target.key } : {}), customFields: [{ fieldId: field.id, fieldRevision: field.revision, value }] });
  return { kind, actor, api, id, key, input, field: () => field,
    define: async changes => {
      definition = { ...definition, revision: field.revision, requestId: randomUUID(), ...changes };
      field = await work(actor, (c, i) => saveCustomField(c, i, definition)); return field;
    },
    replace: async (changes = {}) => {
      const key = definition.key;
      await work(actor, async (c, i) => {
        const renamed = await saveCustomField(c, i, { ...definition, revision: field.revision, requestId: randomUUID(), key: 'retired_' + randomUUID().replaceAll('-', '') });
        await retireCustomField(c, i, { id: field.id, revision: renamed.revision, requestId: randomUUID() });
        definition = { ...definition, id: randomUUID(), revision: 0, requestId: randomUUID(), key, options: [], ...changes };
        field = await saveCustomField(c, i, definition);
      }); return field;
    },
    upload: (name = 'Original.txt', content = Buffer.from('Original bytes'), users = false) => work(actor, (c, i) => (users ? uploadUserFieldAttachment : uploadCustomFieldAttachment)(c, i, { requestId: randomUUID(), fieldId: field.id, fieldRevision: field.revision, originalName: name, mediaType: 'text/plain', content })),
    bytes: file => work(actor, (c, i) => readCustomFieldAttachment(c, i, file.id), true),
    save: (value, revision, requestId, target) => work(actor, (c, i) => api.save(c, i, input(value, revision, requestId, target))),
    read: atRevision => work(actor, (c, i) => api.load(c, i, id, { atRevision }), true),
  };
}
async function unchanged(f, operation, error) {
  const before = await f.read();
  const count = async () => (await owner.query(`SELECT count(*)::integer AS count FROM ${f.api.versions} WHERE organization_id=$1 AND ${f.api.idColumn}=$2`, [f.actor.organizationId, f.id])).rows[0].count;
  const priorCount = await count(); await assert.rejects(operation, error);
  assert.deepEqual(await f.read(), before); assert.equal(await count(), priorCount);
}

// Substitute only the actual SQL capture reference after valid service preparation.
// This exercises the database guard even where service visibility rejects a file.
async function direct(f, file, revision, allowed, target) {
  let inserted = false; let databaseError;
  try {
    return await work(f.actor, (client, identity) => f.api.save({ query: async (statement, parameters) => {
      const sql = typeof statement === 'string' ? statement : statement.text;
      const match = sql.match(new RegExp(`^INSERT INTO ${f.kind}_version_custom_field(s|_values)\\(([^)]+)\\)`));
      if (!match) return client.query(statement, parameters);
      const columns = match[2].split(','); const args = [...parameters];
      if (match[1] === 's') args[columns.indexOf('display_text')] = [file.id];
      else {
        inserted = true;
        for (const [column, value] of Object.entries({ raw_text: file.id, attachment_id: file.id })) {
          assert(columns.includes(column)); args[columns.indexOf(column)] = [value];
        }
      }
      try { return await client.query(statement, args); }
      catch (error) { if (match[1] === '_values') databaseError = error; throw error; }
    } }, identity, f.input(allowed.id, revision, undefined, target)));
  } catch (error) { throw databaseError ?? error; }
  finally { assert.equal(inserted, true, 'The actual attachment INSERT must reach its database guard.'); }
}

for (const kind of ['product', 'parameter']) {
  test(`${kind} retained files preserve captured-key metadata, concurrent exact retries and immutable history`, async () => {
    const f = await fixture(kind); const original = f.field(); const file = await f.upload(); const bytes = await f.bytes(file);
    await f.define({ key: 'captured_key' }); const first = await f.save(file.id, 0); await f.replace();
    const requestId = randomUUID(); const outcomes = await Promise.allSettled([f.save(file.id, 1, requestId), f.save(file.id, 1, requestId)]);
    for (const result of outcomes) assert.equal(result.status, 'fulfilled', result.reason?.message);
    const historical = await f.read(2); const current = await f.read();
    assert.equal(outcomes.filter(result => Object.hasOwn(result.value, 'savedAt')).length, 1);
    for (const result of outcomes) assert.deepEqual(result.value, Object.hasOwn(result.value, 'savedAt') ? historical : current);
    assert.equal(current.customFields[0].fieldId, f.field().id);
    assert.equal(current.customFields[0].items[0].attachmentId, file.id);
    assert.equal(current.customFields[0].items[0].attachment.originalName, 'Original.txt');
    await f.save(file.id, 2); const later = await f.read();
    assert.deepEqual(await f.save(file.id, 1, requestId), historical); assert.deepEqual(await f.read(), later);
    assert.deepEqual((await f.read(1)).customFields, first.customFields); assert.deepEqual(await f.bytes(file), bytes);
    assert.equal(bytes.fieldId, original.id); assert.equal(bytes.fieldRevision, 1);
  });

  test(`${kind} fresh upload-key drafts survive replacement and keep exact bytes without prior capture evidence`, async () => {
    for (const prior of [false, true]) {
      const f = await fixture(kind); const old = prior ? await f.upload('Previous.txt') : null;
      if (old) await f.save(old.id, 0);
      const content = prior ? Buffer.from('Fresh draft bytes') : Buffer.alloc(0); const file = await f.upload('Draft.txt', content);
      const bytes = await f.bytes(file); await f.replace();
      const saved = await f.save(file.id.toUpperCase(), Number(prior));
      assert.equal(saved.customFields[0].value, file.id.toUpperCase()); assert.equal(saved.customFields[0].items[0].attachmentId, file.id);
      assert.deepEqual(await f.bytes(file), bytes); assert.deepEqual(bytes.content, content);
      if (old) assert.equal((await f.read(1)).customFields[0].value, old.id);
    }
  });

  test(`${kind} files uploaded under another key require immediate same-record captured evidence`, async () => {
    for (const mode of ['first', 'key', 'clear', 'record']) {
      const f = await fixture(kind); const file = await f.upload(); await f.define({ key: 'captured_key' });
      if (mode !== 'first') await f.save(file.id, 0);
      await f.replace(mode === 'key' ? { key: 'another_key' } : {}); const allowed = await f.upload('Allowed.txt');
      if (mode === 'clear') await f.save('', 1);
      const revision = mode === 'first' ? 0 : mode === 'clear' ? 2 : 1;
      if (mode === 'record') {
        const target = { id: randomUUID(), key: randomUUID() };
        await assert.rejects(f.save(file.id, 0, undefined, target), { code: `invalid_${kind}_custom_field_attachment` });
        await assert.rejects(direct(f, file, 0, allowed, target), { code: '23514', constraint: `${kind}_custom_value_attachment` });
        assert.equal((await owner.query(`SELECT 1 FROM ${f.api.versions} WHERE organization_id=$1 AND ${f.api.idColumn}=$2`, [f.actor.organizationId, target.id])).rowCount, 0);
      } else {
        const error = { code: `invalid_${kind}_custom_field_attachment` };
        if (revision) await unchanged(f, () => f.save(file.id, revision), error); else await assert.rejects(f.save(file.id, revision), error);
        await assert.rejects(direct(f, file, revision, allowed), { code: '23514', constraint: `${kind}_custom_value_attachment` });
      }
    }
  });

  test(`${kind} immutable upload keys permit explicit selection after a clear and for another scoped record`, async () => {
    const f = await fixture(kind); const file = await f.upload(); await f.replace(); const allowed = await f.upload('Allowed.txt');
    await direct(f, file, 0, allowed); await f.save('', 1); await f.save(file.id, 2);
    assert.equal((await f.read()).customFields[0].value, file.id); assert.equal((await f.read(2)).customFields[0].value, '');
    const other = await f.save(file.id, 0, undefined, { id: randomUUID(), key: randomUUID() }); assert.equal(other.customFields[0].value, file.id);
  });

  test(`${kind} changing an upload definition current key cannot fabricate draft provenance`, async () => {
    const f = await fixture(kind); const file = await f.upload(); await f.define({ key: 'changed_key' }); await f.replace(); const allowed = await f.upload('Allowed.txt');
    await assert.rejects(f.save(file.id, 0), { code: `invalid_${kind}_custom_field_attachment` });
    await assert.rejects(direct(f, file, 0, allowed), { code: '23514', constraint: `${kind}_custom_value_attachment` });
  });

  test(`${kind} same-definition reassociation cannot expose private user files through service or direct SQL`, async () => {
    const f = await fixture(kind, { associatedWith: 'users' }); const privateFile = await f.upload('Private.txt', Buffer.from('User only'), true);
    await f.define({ associatedWith: kind }); const allowed = await f.upload('Master.txt'); await f.save(allowed.id, 0);
    await unchanged(f, () => f.save(privateFile.id, 1), { code: `invalid_${kind}_custom_field_attachment` });
    await unchanged(f, () => direct(f, privateFile, 1, allowed), { code: '23514', constraint: `${kind}_custom_value_attachment` });
    await assert.rejects(f.bytes(privateFile), { code: 'attachment_not_found' });
  });

  test(`${kind} matching saved keys never expose foreign or user-only original uploads`, async () => {
    const f = await fixture(kind); const allowed = await f.upload(); await f.save(allowed.id, 0);
    const foreign = await fixture(kind); const foreignFile = await foreign.upload();
    const key = f.field().key; await f.define({ key: 'temporarily_renamed' });
    const privateField = await work(f.actor, (c, i) => saveCustomField(c, i, { id: randomUUID(), requestId: randomUUID(), revision: 0,
      key, label: 'Private', fieldType: 'attachment', associatedWith: 'users' }));
    const privateFile = await work(f.actor, (c, i) => uploadUserFieldAttachment(c, i, { requestId: randomUUID(), fieldId: privateField.id,
      fieldRevision: 1, originalName: 'Private.txt', mediaType: 'text/plain', content: Buffer.from('Private') }));
    await work(f.actor, (c, i) => retireCustomField(c, i, { id: privateField.id, revision: 1, requestId: randomUUID() }));
    await f.define({ key });
    for (const file of [foreignFile, privateFile, { id: randomUUID() }]) {
      await unchanged(f, () => f.save(file.id, 1), { code: `invalid_${kind}_custom_field_attachment` });
      await unchanged(f, () => direct(f, file, 1, allowed), { code: '23514', constraint: `${kind}_custom_value_attachment` });
      await assert.rejects(f.bytes(file), { code: 'attachment_not_found' });
    }
  });

  test(`${kind} omitted captures retain exact original files after definition retirement`, async () => {
    const f = await fixture(kind); const file = await f.upload(); const original = await f.save(file.id, 0); await f.replace(); await f.save(file.id, 1);
    await work(f.actor, (c, i) => retireCustomField(c, i, { id: f.field().id, revision: 1, requestId: randomUUID() }));
    const input = f.input(file.id, 2); delete input.customFields;
    const copied = await work(f.actor, (c, i) => f.api.save(c, i, input)); assert.equal(copied.customFields[0].value, file.id);
    assert.deepEqual((await f.read(1)).customFields, original.customFields);
    assert.deepEqual((await f.bytes(file)).content, Buffer.from('Original bytes'));
  });
}
