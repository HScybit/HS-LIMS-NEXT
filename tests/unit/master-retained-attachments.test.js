import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareMasterCustomFieldValues } from '../../src/masters/master-custom-field-values.js';
import { masterCustomFieldDraft } from '../../src/masters/custom-field-draft.js';

const identity = { organization_id: randomUUID() };
const field = { id: randomUUID(), revision: 1, key: 'saved_key', label: 'Saved file', fieldType: 'attachment', options: [] };
const old = { ...field, id: randomUUID() }; const id = randomUUID();
const previous = { fieldId: old.id, key: field.key, items: [{ value: id, attachmentId: id }] };
const prepare = (kind, rows, saved, changes = {}) => prepareMasterCustomFieldValues(kind, { async query(_sql, parameters) {
  assert.deepEqual(parameters, [identity.organization_id, [id]]); return { rows };
} }, identity, { definitions: [{ ...field, ...changes }], entries: [{ fieldId: field.id, fieldRevision: 1, value: id.toUpperCase() }], previousFields: saved ? [saved] : [] });

for (const kind of ['product', 'parameter']) {
  test(`${kind} files preserve immutable upload-key and immediate captured-key references`, async () => {
    for (const [rows, saved] of [[[{ id, field_id: old.id, upload_key: field.key }], null],
      [[{ id, field_id: old.id, upload_key: 'uploaded_elsewhere' }], previous], [[{ id, field_id: field.id }], null]]) {
      const result = await prepare(kind, rows, saved);
      assert.equal(result.items[0].attachmentId, id); assert.equal(result.items[0].rawText, id.toUpperCase());
      assert.equal(result.items[0].interpretationState, 'valid');
    }
  });
  test(`${kind} missing files and unsupported provenance cannot borrow captured-key continuity`, async () => {
    for (const [rows, saved] of [[[], previous], [[{ id, field_id: old.id, upload_key: 'other' }], null],
      [[{ id, field_id: old.id }], { ...previous, key: 'other' }], [[{ id, field_id: old.id }], { ...previous, items: [] }],
      [[{ id, field_id: old.id }], { ...previous, items: [{ attachmentId: randomUUID() }] }]]) {
      await assert.rejects(prepare(kind, rows, saved), { code: `invalid_${kind}_custom_field_attachment` });
    }
  });
}

test('attachment drafts retain saved and fresh values by key, initialize only undefined, and prune renamed or removed keys', () => {
  const stored = [{ fieldId: old.id, key: field.key, value: id }];
  assert.deepEqual(masterCustomFieldDraft([field], stored), { [field.id]: id });
  for (const value of [id, '', null]) assert.equal(masterCustomFieldDraft([field], stored, [old], { [old.id]: value })[field.id], value);
  assert.equal(masterCustomFieldDraft([field], stored, [old], { [old.id]: undefined })[field.id], id);
  assert.equal(masterCustomFieldDraft([{ ...old, key: 'renamed' }], stored, [old], { [old.id]: id })[old.id], '');
  assert.deepEqual(masterCustomFieldDraft([], stored, [old], { [old.id]: id }), {});
});
