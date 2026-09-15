import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';
import { saveProduct, loadProduct, retireProduct } from '../../src/masters/products.js';
import { saveTestParameter, loadTestParameter, retireTestParameter } from '../../src/masters/test-parameters.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });
const apis = { product: { save: saveProduct, load: loadProduct, retire: retireProduct, versions: 'product_versions', idColumn: 'product_id' },
  parameter: { save: saveTestParameter, load: loadTestParameter, retire: retireTestParameter, versions: 'test_parameter_versions', idColumn: 'parameter_id' } };
const work = (actor, action, readOnly = false) => withSession(actor.token, action, { csrfToken: actor.csrfToken, readOnly });
const choice = (key, label = key) => ({ id: randomUUID(), key, label });
async function fixture(kind, changes = {}) {
  const user = await createAccount(owner, { permissions: ['masters.manage'] });
  const actor = { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  let definition = { id: randomUUID(), requestId: randomUUID(), revision: 0, key: 'saved_key', label: 'Saved field',
    fieldType: 'select', associatedWith: kind, options: [choice('A', 'Original A')], ...changes };
  let field = await work(actor, (c, i) => saveCustomField(c, i, definition));
  const id = randomUUID(); const key = randomUUID(); const api = apis[kind];
  const input = (value, revision, requestId = randomUUID(), target = { id, key }) => ({ ...target, requestId, revision, name: 'Retained selection master',
    ...(kind === 'parameter' ? { schemeAbbreviation: 'Retained' } : {}), customFields: [{ fieldId: field.id, fieldRevision: field.revision, value }] });
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
        definition = { ...definition, id: randomUUID(), revision: 0, requestId: randomUUID(), key, options: [choice('B', 'Current B')], ...changes };
        field = await saveCustomField(c, i, definition);
      }); return field;
    },
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
// Keep the real save transaction/field set and change only the inserted interpretation,
// so a service rejection cannot conceal a missing database guard.
async function direct(f, { value, revision, state = 'invalid', optionId = null, optionRevision = null }) {
  let inserted = false; let databaseError;
  try {
    return await work(f.actor, (client, identity) => f.api.save({ query: async (statement, parameters) => {
      const sql = typeof statement === 'string' ? statement : statement.text;
      const match = sql.match(new RegExp(`^INSERT INTO ${f.kind}_version_custom_field(s|_values)\\(([^)]+)\\)`));
      if (!match) return client.query(statement, parameters);
      const columns = match[2].split(','); const args = [...parameters];
      if (match[1] === 's') args[columns.indexOf('display_text')] = [value];
      else {
        inserted = true;
        for (const [column, replacement] of Object.entries({ raw_text: value, interpretation_state: state, option_id: optionId, option_revision: optionRevision })) {
          assert(columns.includes(column)); args[columns.indexOf(column)] = [replacement];
        }
      }
      try { return await client.query(statement, args); }
      catch (error) { if (match[1] === '_values') databaseError = error; throw error; }
    } }, identity, f.input('B', revision)));
  } catch (error) { throw databaseError ?? error; }
  finally { assert.equal(inserted, true, 'The actual value INSERT must reach its database guard.'); }
}

for (const kind of ['product', 'parameter']) {
  test(`${kind} replacement dropdowns retain unresolved values, exact concurrent retries and frozen history`, async () => {
    const f = await fixture(kind); const original = await f.save('A', 0); await f.replace(); const requestId = randomUUID();
    const outcomes = await Promise.allSettled([f.save('A', 1, requestId), f.save('A', 1, requestId)]);
    for (const outcome of outcomes) assert.equal(outcome.status, 'fulfilled', outcome.reason?.message);
    const saved = await f.read(2); const current = await f.read();
    const results = outcomes.map(outcome => outcome.value);
    assert.equal(results.filter(result => Object.hasOwn(result, 'savedAt')).length, 1);
    for (const result of results) assert.deepEqual(result, Object.hasOwn(result, 'savedAt') ? saved : current);
    assert.equal(saved.revision, 2);
    const captured = saved.customFields[0]; assert.equal(captured.value, 'A'); assert.equal(captured.displayValue, 'A');
    assert.equal(captured.items[0].interpretationState, 'invalid'); assert.equal(captured.items[0].optionId, null);
    await f.save('A', 2); const later = await f.read(); assert.deepEqual(await f.save('A', 1, requestId), saved); assert.deepEqual(await f.read(), later);
    assert.deepEqual((await f.read(1)).customFields, original.customFields);
    const option = choice('A', 'Resolved A'); await f.define({ options: [option] });
    const resolved = await f.save('A', 3); assert.equal(resolved.customFields[0].items[0].optionId, option.id);
    assert.equal(resolved.customFields[0].displayValue, 'Resolved A'); assert.equal((await f.read(2)).customFields[0].items[0].optionId, null);
  });
  test(`${kind} older option references require saved-key continuity after a rename`, async () => {
    const f = await fixture(kind); const first = await f.save('A', 0); await f.define({ options: [choice('B')] });
    const retained = await f.save('A', 1); assert.equal(retained.customFields[0].items[0].optionId, first.customFields[0].items[0].optionId);
    assert.equal(retained.customFields[0].items[0].optionRevision, 1);
    await f.define({ key: 'renamed' }); await unchanged(f, () => f.save('A', 2), { code: `invalid_${kind}_custom_field_option` });
    assert.equal((await f.save('B', 2)).customFields[0].key, 'renamed');
  });
  test(`${kind} text-to-dropdown capture retains raw zero, false and ordered duplicates`, async () => {
    const f = await fixture(kind, { fieldType: 'text', allowsMultiple: true, options: [] }); await f.save([0, false, 'A'], 0);
    await f.define({ fieldType: 'select', options: [choice('B')] }); const saved = await f.save([false, 0, 'A', 'A'], 1);
    assert.deepEqual(saved.customFields[0].value, [false, 0, 'A', 'A']); assert.equal(saved.customFields[0].displayValue, 'A, A');
    assert(saved.customFields[0].items.every(item => item.interpretationState === 'invalid' && item.optionId === null));
    for (const value of ['0', 'false', 'unknown']) await unchanged(f, () => f.save([value], 2), { code: `invalid_${kind}_custom_field_option` });
  });
  test(`${kind} cleared captures and other records cannot borrow older dropdown values`, async () => {
    const f = await fixture(kind); await f.save('A', 0); await f.replace(); await f.save('', 1);
    await unchanged(f, () => f.save('A', 2), { code: `invalid_${kind}_custom_field_option` });
    const target = { id: randomUUID(), key: randomUUID() };
    await assert.rejects(f.save('A', 0, undefined, target), { code: `invalid_${kind}_custom_field_option` });
    assert.equal((await owner.query(`SELECT 1 FROM ${f.api.versions} WHERE organization_id=$1 AND ${f.api.idColumn}=$2`, [f.actor.organizationId, target.id])).rowCount, 0);
  });
  test(`${kind} omitted fields and retirement preserve an unresolved interpretation exactly`, async () => {
    const f = await fixture(kind); await f.save('A', 0); await f.replace(); const saved = await f.save('A', 1);
    await work(f.actor, (c, i) => retireCustomField(c, i, { id: f.field().id, revision: 1, requestId: randomUUID() }));
    const { customFields: _fields, ...input } = f.input('unused', 2);
    const omitted = await work(f.actor, (c, i) => f.api.save(c, i, input));
    assert.equal(omitted.customFieldsProvided, false); assert.deepEqual(omitted.customFields, saved.customFields);
    await work(f.actor, (c, i) => f.api.retire(c, i, { id: f.id, revision: 3, requestId: randomUUID() }));
    assert.deepEqual((await f.read(4)).customFields, saved.customFields);
  });
  test(`${kind} SQL rejects fabricated dropdown states and foreign option references`, async () => {
    const f = await fixture(kind); const old = (await f.save('A', 0)).customFields[0].items[0]; await f.replace();
    for (const input of [{ value: 'unknown' }, { value: 'B' }, { value: 'A', state: 'valid', optionId: old.optionId, optionRevision: old.optionRevision }]) {
      await unchanged(f, () => direct(f, { ...input, revision: 1 }), { code: '23514', constraint: `${kind}_custom_value_option` });
    }
    await unchanged(f, () => direct(f, { value: 'A', revision: 1, state: 'out_of_range' }), { code: '23514' });
    const saved = await direct(f, { value: 'A', revision: 1 }); assert.equal(saved.customFields[0].items[0].interpretationState, 'invalid');
    assert.equal(saved.customFields[0].value, 'A');
  });
  test(`${kind} SQL requires the original same-key option reference when it still exists in history`, async () => {
    const f = await fixture(kind); const old = (await f.save('A', 0)).customFields[0].items[0]; await f.define({ options: [choice('B')] });
    await unchanged(f, () => direct(f, { value: 'A', revision: 1 }), { code: '23514', constraint: `${kind}_custom_value_option` });
    const retained = await direct(f, { value: 'A', revision: 1, state: 'valid', optionId: old.optionId, optionRevision: old.optionRevision });
    assert.equal(retained.customFields[0].items[0].optionId, old.optionId);
  });
  test(`${kind} SQL refuses an older option after the saved key changes`, async () => {
    const f = await fixture(kind); const old = (await f.save('A', 0)).customFields[0].items[0]; await f.define({ options: [choice('B')] });
    await f.define({ key: 'renamed' });
    await unchanged(f, () => direct(f, { value: 'A', revision: 1, state: 'valid', optionId: old.optionId, optionRevision: old.optionRevision }),
      { code: '23514', constraint: `${kind}_custom_value_option` });
  });
}
