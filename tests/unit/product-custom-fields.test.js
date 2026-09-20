import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { productCustomFields } from '../../src/masters/custom-fields.js';

test('Product definition loading does not query for unauthorized identities or return a missing immutable version', async () => {
  let calls = 0;
  const client = { query: async () => { calls++; return { rows: [{ id: randomUUID(), revision: 1, versionId: null }] }; } };
  await assert.rejects(productCustomFields(client, { permission_codes: [] }), { code: 'forbidden' });
  assert.equal(calls, 0);
  await assert.rejects(productCustomFields(client, { organization_id: randomUUID(), permission_codes: ['masters.read'] }), { code: 'incomplete_custom_field' });
  assert.equal(calls, 1);
});
