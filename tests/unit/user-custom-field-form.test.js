import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { userCustomFieldName, userCustomFieldDraft, userCustomFieldPayload, userCustomFieldErrors,
  userCustomFieldSelectedIds, userCustomFieldSelectedOptions } from '../../src/users/custom-field-form.js';
import { uploadCustomFieldFile } from '../../src/custom-fields/attachment-client.js';

const field = (key, extra = {}) => ({ id: randomUUID(), revision: 1, key, fieldType: 'text', ...extra });

test('user drafts follow saved keys across replacements and renames while preserving defined false, zero, null and arrays', () => {
  const original = field('saved'); const replacement = field('saved');
  const stored = [{ fieldId: original.id, key: 'saved', value: 'Stored under the old identity' }];
  assert.deepEqual(userCustomFieldDraft([replacement], stored), { pf_saved: 'Stored under the old identity' });
  for (const value of ['', false, 0, null, [], ['draft']]) assert.deepEqual(userCustomFieldDraft([replacement], stored, { pf_saved: value }), { pf_saved: value });
  assert.deepEqual(userCustomFieldDraft([{ ...original, key: 'renamed' }], stored, { pf_saved: 'Unsaved' }), { pf_renamed: '' });
  assert.deepEqual(userCustomFieldDraft([replacement], stored, { pf_saved: undefined }), { pf_saved: 'Stored under the old identity' });
  assert.deepEqual(userCustomFieldDraft([], stored, { pf_saved: 'Unsaved' }), {});
  const special = field('__proto__'); assert.equal(userCustomFieldName(special), 'pf___proto__');
  const inherited = Object.create({ pf_saved: 'Inherited' });
  assert.equal(userCustomFieldDraft([replacement], stored, inherited).pf_saved, 'Stored under the old identity');
  assert.equal(userCustomFieldDraft([special], [{ key: '__proto__', value: 'Own value' }]).pf___proto__, 'Own value');
});

test('user drafts normalize only new entries using source multiple/date display fallback rules', () => {
  const fields = [field('people', { fieldType: 'multi_user_select' }), field('repeated', { allowsMultiple: true }), field('date', { fieldType: 'date' }), field('zero'), field('false')];
  const stored = [{ key: 'people', value: 'selected' }, { key: 'repeated', value: 0 }, { key: 'date', value: '', displayValue: '31/01/2026' }, { key: 'zero', value: 0 }, { key: 'false', value: false }];
  assert.deepEqual(userCustomFieldDraft(fields, stored), { pf_people: ['selected'], pf_repeated: [0], pf_date: '31/01/2026', pf_zero: 0, pf_false: false });
  assert.deepEqual(userCustomFieldDraft(fields.slice(0, 1), stored, { pf_people: 'Already defined' }), { pf_people: 'Already defined' });
});

test('user payloads preserve omission, exact field order/revisions, raw types and actual date-zone metadata', () => {
  assert.deepEqual(userCustomFieldPayload([], { pf_retired: 'Keep history' }, { revision: 5, timeZone: 'Asia/Kolkata' }), {});
  const fields = [field('repeated', { revision: 4, allowsMultiple: true }), field('date', { fieldType: 'date' }), field('false')];
  const values = { pf_repeated: [0, false, '', '  ', 'kept'], pf_date: '2026-01-31', pf_false: false };
  assert.deepEqual(userCustomFieldPayload(fields, values, { revision: 7, timeZone: 'Asia/Kolkata' }), {
    customFields: fields.map((f, i) => ({ fieldId: f.id, fieldRevision: f.revision, value: [[0, false, 'kept'], '2026-01-31', false][i] })), customFieldRevision: 7, customFieldTimeZone: 'Asia/Kolkata',
  });
  const creation = userCustomFieldPayload([fields[2]], values, { timeZone: 'Asia/Kolkata' });
  assert.equal(Object.hasOwn(creation, 'customFieldRevision'), false); assert.equal(Object.hasOwn(creation, 'customFieldTimeZone'), false);
});

test('manual validation covers required/repeated/numeric entries and does not bypass unavailable automatic generation', () => {
  const fields = [field('required', { isRequired: true }), field('number', { fieldType: 'number' }), field('repeat', { allowsMultiple: true, isRequired: true }),
    field('auto', { scheme: '{{total_counter}}', generatedAt: 'on_init' }), field('demand', { scheme: '{{total_counter}}', generatedAt: 'on_demand' })];
  const values = { pf_required: '', pf_number: 'bad', pf_repeat: [false, ''], pf_auto: '', pf_demand: '' };
  assert.deepEqual(Object.keys(userCustomFieldErrors(fields, values, 'create')), ['pf_required', 'pf_number', 'pf_repeat', 'pf_auto']);
  assert.equal(Object.hasOwn(userCustomFieldErrors(fields, values, 'edit'), 'pf_auto'), false);
  assert.deepEqual(userCustomFieldErrors(fields, { pf_required: 'yes', pf_number: 0, pf_repeat: [0], pf_auto: 'Manual value', pf_demand: '' }, 'create'), {});
});

test('current label lookups deduplicate normalized IDs without changing raw selection case or inventing missing names', () => {
  const first = 'a' + randomUUID().slice(1); const second = randomUUID(); const fields = [field('people', { fieldType: 'multi_user_select' }), field('ordinary')];
  const values = { pf_people: [first.toUpperCase(), first, 'legacy unknown', null, second], pf_ordinary: [randomUUID()] };
  assert.deepEqual(userCustomFieldSelectedIds(fields, values), [first, second]);
  assert.deepEqual(userCustomFieldSelectedOptions(fields, values, [{ id: first, name: 'Current_user/name' }]), [
    { value: first.toUpperCase(), label: 'Current user name' }, { value: first, label: 'Current user name' },
  ]);
  assert.deepEqual(userCustomFieldSelectedOptions(fields, values, [{ id: first, name: '' }]).map(option => option.label), ['', '']);
});

test('user file uploads retain exact binary headers and use the scoped endpoint while master calls retain their default', async () => {
  const originalFetch = globalThis.fetch; const originalDocument = globalThis.document;
  const calls = []; const selected = new File([], 'Original ü.bin', { type: 'application/octet-stream' }); const definition = field('file', { revision: 3 });
  globalThis.document = { cookie: 'other=value; sampleify_csrf=synthetic-csrf' };
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ id: 'uploaded' }) }; };
  try {
    const abort = new AbortController();
    assert.deepEqual(await uploadCustomFieldFile(definition, selected, 'request', abort.signal, { userFields: true }), { id: 'uploaded' });
    await uploadCustomFieldFile(definition, selected, 'request', abort.signal);
    assert.deepEqual(calls.map(call => call.url), ['/api/users/custom-fields/attachments', '/api/custom-fields/attachments']);
    for (const { options } of calls) {
      assert.equal(options.body, selected); assert.equal(options.signal, abort.signal); assert.equal(options.credentials, 'same-origin');
      assert.deepEqual(options.headers, { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': 'synthetic-csrf', 'X-File-Name': encodeURIComponent(selected.name), 'X-Upload-Request-Id': 'request', 'X-Custom-Field-Id': definition.id, 'X-Custom-Field-Revision': '3' });
    }
  } finally { globalThis.fetch = originalFetch; if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument; }
});

test('user file upload limits and unreadable or rejected responses retain explicit retry errors', async () => {
  const originalFetch = globalThis.fetch; const originalDocument = globalThis.document;
  globalThis.document = { cookie: '' };
  try {
    globalThis.fetch = () => { throw new Error('Should not upload an oversized file.'); };
    await assert.rejects(uploadCustomFieldFile(field('file'), { size: 20 * 1024 * 1024 + 1 }, 'request', undefined, { userFields: true }), /at most 20 MiB/);
    globalThis.fetch = async () => ({ ok: true, json() { throw new Error('Incomplete response'); } });
    await assert.rejects(uploadCustomFieldFile(field('file'), new File([], 'zero'), 'request', undefined, { userFields: true }), /Retry the upload/);
    globalThis.fetch = async () => ({ ok: false, json: async () => ({ error: { message: 'Field changed.' } }) });
    await assert.rejects(uploadCustomFieldFile(field('file'), new File([], 'zero'), 'request', undefined, { userFields: true }), /Field changed/);
  } finally { globalThis.fetch = originalFetch; if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument; }
});
