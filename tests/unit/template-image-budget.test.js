import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTemplateImageBudget } from '../../src/template-assets/service.js';

const field = { id: 'image', widget: 'template_image_widget', repeatGroupId: 'rows', defaultImageId: 'asset' };
const model = { fieldsById: { image: field } };
const capture = { occurrences: [{ id: 'root', groupId: null }, { id: 'first', groupId: 'rows' }, { id: 'second', groupId: 'rows' }], values: [] };

test('image admission makes no request when no rendered field has an image', async () => {
  const client = { query: () => assert.fail('unexpected image query') };
  await assertTemplateImageBudget(client, 'org', { fieldsById: {} }, capture);
  await assertTemplateImageBudget(client, 'org', { fieldsById: { image: { ...field, defaultImageId: null } } }, capture);
  await assertTemplateImageBudget(client, 'org', model, { occurrences: [capture.occurrences[0]], values: [] });
});

test('image admission counts repetitions at the exact base64 boundary using one metadata batch', async () => {
  // Both individual images fit the SQL 10 MiB limit. Together their data URIs
  // occupy exactly 16 MiB, so two rendered appearances fill the 32 MiB budget.
  const row = { id: 'asset', media_type: 'image/png', byte_length: 6_291_438, print_byte_length: 6_291_441 };
  let calls = 0;
  const client = { query: async (sql, args) => {
    calls++; assert.doesNotMatch(sql, /\b(?:content|print_content)\b/);
    assert.deepEqual(args, ['org', ['asset']]); return { rows: [row] };
  } };
  await assertTemplateImageBudget(client, 'org', model, capture); assert.equal(calls, 1);
  row.byte_length++;
  await assert.rejects(assertTemplateImageBudget(client, 'org', model, capture), { code: 'template_image_batch_size_limit', message: 'The expanded template images exceed 32 MiB.' });
  assert.equal(calls, 2);
});

test('image admission binds active captured images, falls back to defaults, and rejects missing or excessive unique assets', async () => {
  const runtime = { ...capture, values: [
    { fieldId: 'image', occurrenceId: 'first', state: 'present', imageId: 'historical' },
    { fieldId: 'image', occurrenceId: 'second', state: 'empty', imageId: null },
    { fieldId: 'image', occurrenceId: 'removed', state: 'present', imageId: 'ignored' },
  ] };
  let rows = ['historical', 'asset'].map((id) => ({ id, media_type: 'image/png', byte_length: 3, print_byte_length: 3 }));
  const client = { query: async (_sql, args) => { assert.deepEqual(args, ['org', ['historical', 'asset']]); return { rows }; } };
  await assertTemplateImageBudget(client, 'org', model, runtime);
  rows = rows.slice(0, 1);
  await assert.rejects(assertTemplateImageBudget(client, 'org', model, runtime), { code: 'template_image_history_unavailable' });
  rows = ['historical', 'asset'].map((id) => ({ id, media_type: 'image/png', byte_length: 7 * 1024 * 1024, print_byte_length: 7 * 1024 * 1024 }));
  await assert.rejects(assertTemplateImageBudget(client, 'org', model, runtime), { code: 'template_image_batch_size_limit', message: 'The template images exceed 24 MiB.' });
});
