import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { uploadUserFieldAttachment, readUserFieldAttachment } from '../../src/users/custom-field-attachments.js';
import { customFieldAttachmentByteLimit } from '../../src/custom-fields/attachments.js';

test('user attachment inputs require user authority and bounded valid metadata before any query', async () => {
  const client = { query() { assert.fail('Unexpected database query'); } };
  const manager = { permission_codes: ['users.manage'] };
  const input = { requestId: randomUUID(), fieldId: randomUUID(), fieldRevision: 1, originalName: 'file', content: Buffer.alloc(0) };
  for (const permissions of [[], ['users.read'], ['masters.manage']]) {
    await assert.rejects(uploadUserFieldAttachment(client, { permission_codes: permissions }, input), { code: 'forbidden' });
  }
  for (const [changes, code] of [[{ content: '' }, 'invalid_attachment'], [{ content: Buffer.alloc(customFieldAttachmentByteLimit + 1) }, 'attachment_size_limit'],
    [{ fieldRevision: 0 }, 'invalid_input'], [{ originalName: 'bad\r\nfile' }, 'invalid_attachment_name'], [{ mediaType: 'text/bad type' }, 'invalid_attachment_type'],
    [{ fieldId: 'invalid' }, 'invalid_id'], [{ organizationId: randomUUID() }, 'invalid_input']]) {
    await assert.rejects(uploadUserFieldAttachment(client, manager, { ...input, ...changes }), { code });
  }
  await assert.rejects(readUserFieldAttachment(client, { permission_codes: ['masters.read'] }, randomUUID()), { code: 'forbidden' });
});

test('user attachment downloads fail closed on missing or corrupt binary data', async () => {
  const identity = { organization_id: randomUUID(), permission_codes: ['users.read'] };
  await assert.rejects(readUserFieldAttachment({ async query() { return { rows: [] }; } }, identity, randomUUID()), { code: 'attachment_not_found' });
  for (const record of [{}, { encodedContent: 'YQ==', byteLength: 0, sha256: 'a'.repeat(64) }, { encodedContent: 'YQ==', byteLength: 1, sha256: 'a'.repeat(64) }]) {
    await assert.rejects(readUserFieldAttachment({ async query() { return { rows: [record] }; } }, identity, randomUUID()), { code: 'attachment_unavailable' });
  }
});
