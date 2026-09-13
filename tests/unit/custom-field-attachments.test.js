import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { customFieldAttachmentByteLimit, customFieldAttachmentMetadata, customFieldAttachmentHeaders, uploadCustomFieldAttachment,
  readCustomFieldAttachment } from '../../src/custom-fields/attachments.js';
import { readCustomFieldAttachmentUpload } from '../../src/custom-fields/attachment-upload.js';

const request = (body, headers = {}) => new Request('http://localhost/upload', { method: 'POST', body, duplex: 'half',
  headers: { 'x-file-name': encodeURIComponent('Synthetic file.txt'), 'x-upload-request-id': randomUUID(),
    'x-custom-field-id': randomUUID(), 'x-custom-field-revision': '1', ...headers } });

test('attachment names retain the source basename and Unicode without truncation or unsafe header characters', () => {
  assert.deepEqual(customFieldAttachmentMetadata(' C:\\fakepath\\विश्लेषण 0.txt ', ' TEXT/PLAIN '), { originalName: 'विश्लेषण 0.txt', mediaType: 'text/plain' });
  assert.deepEqual(customFieldAttachmentMetadata('/folder/name.pdf', ''), { originalName: 'name.pdf', mediaType: 'application/octet-stream' });
  assert.equal(customFieldAttachmentMetadata(' ', null).originalName, 'upload');
  assert.equal(customFieldAttachmentMetadata('x'.repeat(500), 'application/x-custom+binary').originalName.length, 500);
  for (const name of [null, {}, 'x'.repeat(501), 'bad\r\nname', 'bad\0name', 'bad\u0085name', '\ud800']) {
    assert.throws(() => customFieldAttachmentMetadata(name, 'text/plain'), { code: 'invalid_attachment_name' });
  }
  for (const type of ['text/plain; charset=utf-8', 'text/pla in', '/plain', 'text/', 'text/\r\n', true, `text/${'x'.repeat(251)}`]) {
    assert.throws(() => customFieldAttachmentMetadata('file', type), { code: 'invalid_attachment_type' });
  }
});

test('attachment streaming accepts empty and exact maximum bytes and preserves binary content', async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from([0, 255, 10, 127]), Buffer.alloc(customFieldAttachmentByteLimit, 7)]) {
    const value = await readCustomFieldAttachmentUpload(request(bytes, { 'content-length': String(bytes.length), 'content-type': 'application/octet-stream' }));
    assert.equal(value.fieldRevision, 1); assert.equal(value.originalName, 'Synthetic file.txt'); assert.deepEqual(value.content, bytes);
  }
  assert.equal((await readCustomFieldAttachmentUpload(request(null, { 'content-length': '0' }))).content.length, 0);
});

test('attachment streaming rejects malformed names and lengths, truncated streams, aborts and overflow without trusting headers', async () => {
  await assert.rejects(readCustomFieldAttachmentUpload(request('x', { 'x-file-name': '%ED%A0%80' })), { code: 'invalid_attachment_name' });
  await assert.rejects(readCustomFieldAttachmentUpload(request('x', { 'content-length': '-1' })), { code: 'invalid_attachment_length' });
  await assert.rejects(readCustomFieldAttachmentUpload(request('x', { 'content-length': String(customFieldAttachmentByteLimit + 1) })), { code: 'attachment_size_limit' });
  await assert.rejects(readCustomFieldAttachmentUpload(request('x', { 'content-length': '2' })), { code: 'incomplete_attachment' });
  await assert.rejects(readCustomFieldAttachmentUpload(request(null, { 'content-length': '1' })), { code: 'incomplete_attachment' });
  const broken = new ReadableStream({ start(controller) { controller.error(new Error('Synthetic read failure')); } });
  await assert.rejects(readCustomFieldAttachmentUpload(request(broken)), { code: 'incomplete_attachment' });
  let canceled = false; let read = 0;
  const overflow = new ReadableStream({ pull(controller) {
    controller.enqueue(Buffer.alloc(read++ === 0 ? customFieldAttachmentByteLimit : 1));
  }, cancel() { canceled = true; } });
  await assert.rejects(readCustomFieldAttachmentUpload(request(overflow, { 'content-length': '1' })), { code: 'attachment_size_limit' });
  assert.equal(canceled, true);
});

test('attachment responses preserve Unicode download names and isolate active content even when View is requested', () => {
  const file = { originalName: 'विश्लेषण "sample" (1).html', mediaType: 'text/html', byteLength: 12, sha256: 'a'.repeat(64) };
  for (const mediaType of ['text/html', 'image/svg+xml', 'application/javascript', 'application/octet-stream']) {
    const headers = customFieldAttachmentHeaders({ ...file, mediaType }, { view: true });
    assert.match(headers['Content-Disposition'], /^attachment; /); assert.match(headers['Content-Disposition'], /filename\*=UTF-8''/);
    assert.equal(headers['Content-Type'], mediaType); assert.equal(headers['Content-Length'], '12');
    assert.equal(headers['Content-Security-Policy'], "default-src 'none'; sandbox");
    assert.equal(headers['X-Content-Type-Options'], 'nosniff'); assert.equal(headers['Cross-Origin-Resource-Policy'], 'same-origin');
    assert.equal(headers['Cache-Control'], 'private, no-store');
    assert.doesNotThrow(() => new Headers(headers));
  }
  for (const mediaType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']) {
    assert.match(customFieldAttachmentHeaders({ ...file, mediaType }, { view: true })['Content-Disposition'], /^inline; /);
    assert.match(customFieldAttachmentHeaders({ ...file, mediaType })['Content-Disposition'], /^attachment; /);
  }
});

test('attachment service rejects unauthorized and invalid content before issuing any data query', async () => {
  const client = { query() { assert.fail('Unexpected database query'); } };
  const identity = { permission_codes: ['masters.manage'] };
  const input = { requestId: randomUUID(), fieldId: randomUUID(), fieldRevision: 1, originalName: 'file', content: Buffer.alloc(0) };
  await assert.rejects(uploadCustomFieldAttachment(client, { permission_codes: ['masters.read'] }, input), { code: 'forbidden' });
  await assert.rejects(uploadCustomFieldAttachment(client, identity, { ...input, content: '' }), { code: 'invalid_attachment' });
  await assert.rejects(uploadCustomFieldAttachment(client, identity, { ...input, content: Buffer.alloc(customFieldAttachmentByteLimit + 1) }), { code: 'attachment_size_limit' });
  await assert.rejects(uploadCustomFieldAttachment(client, identity, { ...input, fieldRevision: 0 }), { code: 'invalid_input' });
  await assert.rejects(readCustomFieldAttachment(client, { permission_codes: [] }, randomUUID()), { code: 'forbidden' });
});

test('attachment reads report missing or corrupt historical bytes without returning content', async () => {
  const identity = { organization_id: randomUUID(), permission_codes: ['masters.read'] };
  await assert.rejects(readCustomFieldAttachment({ query: async () => ({ rows: [] }) }, identity, randomUUID()), { code: 'attachment_not_found' });
  for (const row of [{ encodedContent: Buffer.from('changed').toString('base64'), byteLength: 7, sha256: 'a'.repeat(64) }, { encodedContent: '', byteLength: 1 }, { encodedContent: null, byteLength: 0 }]) {
    await assert.rejects(readCustomFieldAttachment({ query: async () => ({ rows: [row] }) }, identity, randomUUID()), { code: 'attachment_unavailable' });
  }
});
