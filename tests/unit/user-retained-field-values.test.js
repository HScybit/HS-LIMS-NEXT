import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareMasterCustomFieldValues } from '../../src/masters/master-custom-field-values.js';

const identity = { organization_id: randomUUID() };
const noQueries = { query() { throw new Error('This capture must not query references.'); } };
const definition = changes => ({ id: randomUUID(), revision: 1, key: 'saved_key', label: 'Saved field', fieldType: 'select',
  options: [{ id: randomUUID(), key: 'B', label: 'Current B' }], ...changes });
const previous = (field, value = 'A', changes = {}) => ({ fieldId: field.id, fieldRevision: field.revision, key: field.key,
  items: [{ value, optionId: randomUUID(), optionRevision: field.revision }], ...changes });
const prepare = (field, value, saved, client = noQueries, kind = 'user') => prepareMasterCustomFieldValues(kind, client, identity,
  { definitions: [field], entries: [{ fieldId: field.id, fieldRevision: field.revision, value }], previousFields: saved ? [saved] : [], timeZone: null });

test('a replacement user definition retains the previous saved-key primitive without inventing an option reference', async () => {
  const old = definition(); const field = definition(); const saved = previous(old); const before = structuredClone(saved);
  const result = await prepare(field, 'A', saved); const item = result.items[0];
  assert.equal(item.rawText, 'A'); assert.equal(item.interpretationState, 'invalid'); assert.equal(item.optionId, null); assert.equal(item.optionRevision, null);
  assert.equal(result.fields[0].displayText, 'A'); assert.deepEqual(saved, before);
});

test('an unresolved selection survives another capture and resolves to an actual newly available option', async () => {
  const field = definition(); const saved = previous(field, 'A', { items: [{ value: 'A', interpretationState: 'invalid', optionId: null, optionRevision: null }] });
  assert.equal((await prepare(field, 'A', saved)).items[0].interpretationState, 'invalid');
  const option = { id: randomUUID(), key: 'A', label: 'Current A' }; const current = { ...field, revision: 2, options: [option] };
  const result = await prepare(current, 'A', saved); assert.equal(result.items[0].interpretationState, 'valid');
  assert.equal(result.items[0].optionId, option.id); assert.equal(result.items[0].optionRevision, 2); assert.equal(result.fields[0].displayText, 'Current A');
});

test('the same definition and saved key retain an actual older option, while a renamed key cannot borrow that selection', async () => {
  const field = definition(); const saved = previous(field); const result = await prepare({ ...field, revision: 2 }, 'A', saved);
  assert.equal(result.items[0].interpretationState, 'valid'); assert.equal(result.items[0].optionId, saved.items[0].optionId); assert.equal(result.items[0].optionRevision, 1);
  await assert.rejects(prepare({ ...field, revision: 2, key: 'new_key' }, 'A', saved), { code: 'invalid_user_custom_field_option' });
});

test('unavailable user choices require an exact immediately supplied previous raw item and saved key', async () => {
  const field = definition(); const old = definition(); const saved = previous(old);
  for (const [value, prior] of [['A', null], ['A', { ...saved, key: 'another_key' }], ['changed', saved], ['A', { ...saved, items: [] }],
    [0, previous(old, '0')], [false, previous(old, 'false')]]) {
    await assert.rejects(prepare(field, value, prior), { code: 'invalid_user_custom_field_option' });
  }
});

test('retained multiple choices preserve zero, false and order, including a previous text field', async () => {
  const field = definition({ allowsMultiple: true }); const old = definition({ fieldType: 'text' });
  const saved = previous(old, '', { items: [{ value: 0 }, { value: false }, { value: 'A' }] });
  const result = await prepare(field, [0, false, 'A'], saved);
  assert.deepEqual(result.items.map(item => [item.rawKind, item.rawNumber, item.rawBoolean, item.rawText, item.interpretationState]),
    [['number', 0, null, null, 'invalid'], ['boolean', null, false, null, 'invalid'], ['text', null, null, 'A', 'invalid']]);
  assert.equal(result.fields[0].displayText, 'A'); assert.equal(result.items[0].rawNumberText, '0');
});

test('a user attachment from the previous saved key retains the exact original reference across definition replacement', async () => {
  const field = definition({ fieldType: 'attachment' }); const old = definition({ fieldType: 'attachment' }); const id = randomUUID();
  const saved = previous(old, id, { items: [{ value: id, attachmentId: id }] }); let queries = 0;
  const client = { async query(sql, parameters) { queries++; assert.match(sql, /FROM user_custom_field_attachments/); assert.deepEqual(parameters, [identity.organization_id, [id]]); return { rows: [{ id, field_id: old.id }] }; } };
  const result = await prepare(field, id, saved, client); assert.equal(queries, 1); assert.equal(result.items[0].attachmentId, id); assert.equal(result.items[0].interpretationState, 'valid');
});

test('foreign, unavailable and other-upload-key attachments cannot use absent retained-value evidence', async () => {
  const field = definition({ fieldType: 'attachment' }); const old = definition({ fieldType: 'attachment' }); const id = randomUUID();
  const saved = previous(old, id, { items: [{ value: id, attachmentId: id }] });
  for (const [prior, rows] of [[null, [{ id, field_id: old.id, upload_key: 'other' }]], [{ ...saved, key: 'other_key' }, [{ id, field_id: old.id, upload_key: 'other' }]],
    [{ ...saved, items: [] }, [{ id, field_id: old.id, upload_key: 'other' }]], [saved, []]]) {
    await assert.rejects(prepare(field, id, prior, { async query() { return { rows }; } }), { code: 'invalid_user_custom_field_attachment' });
  }
  const result = await prepare(field, id, null, { async query() { return { rows: [{ id, field_id: field.id }] }; } }); assert.equal(result.items[0].attachmentId, id);
});

test('a fresh user file keeps its immutable upload-key provenance without fabricating previous capture evidence', async () => {
  const field = definition({ fieldType: 'attachment' }); const original = definition({ fieldType: 'attachment' }); const id = randomUUID();
  const rows = [{ id, field_id: original.id, upload_key: field.key }]; const before = structuredClone(rows); let queries = 0;
  const client = { async query(sql, parameters) {
    queries++; assert.match(sql, /uploaded\.revision=file\.field_revision/); assert.deepEqual(parameters, [identity.organization_id, [id]]); return { rows };
  } };
  const result = await prepare(field, id.toUpperCase(), null, client);
  assert.equal(queries, 1); assert.equal(result.items[0].attachmentId, id); assert.equal(result.items[0].rawText, id.toUpperCase()); assert.deepEqual(rows, before);
  assert.equal((await prepare(field, '', null)).items[0].interpretationState, 'empty');
  await assert.rejects(prepare({ ...field, key: 'different' }, id, null, client), { code: 'invalid_user_custom_field_attachment' });
});

test('master selections require the saved key and attachments keep their definition boundary', async () => {
  for (const kind of ['product', 'parameter']) {
    const field = definition(); const old = definition({ key: 'other_key' });
    await assert.rejects(prepare(field, 'A', previous(old), noQueries, kind), { code: `invalid_${kind}_custom_field_option` });
    const saved = previous(field); const retained = await prepare({ ...field, revision: 2 }, 'A', saved, noQueries, kind); assert.equal(retained.items[0].optionId, saved.items[0].optionId);
    const id = randomUUID(); const file = definition({ fieldType: 'attachment' });
    await assert.rejects(prepare(file, id, previous(old, id, { items: [{ value: id, attachmentId: id }] }),
      { async query() { return { rows: [{ id, field_id: old.id, upload_key: file.key }] }; } }, kind), { code: `invalid_${kind}_custom_field_attachment` });
  }
});
