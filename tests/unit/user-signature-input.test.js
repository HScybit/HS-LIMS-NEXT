import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { userSignatureByteLimit, userSignatureRemovalInput, userSignatureUploadInput } from '../../src/users/signature-input.js';
import { readUserSignatureUpload } from '../../src/users/signature-upload.js';

const requestId = 'abcdef00-0000-4000-8000-000000000001';
const value = (extra = {}) => ({ requestId, revision: 0, originalName: 'signature.bin', mediaType: 'application/octet-stream', content: Buffer.from('original file bytes'), ...extra });
const headers = (extra = {}) => new Headers({ 'x-upload-request-id': requestId, 'x-signature-revision': '0', 'x-file-name': encodeURIComponent('signature.bin'), ...extra });

test('signature uploads preserve original arbitrary bytes, empty files and the actual 20 MiB boundary', () => {
  for (const content of [Buffer.alloc(0), Buffer.from([0, 255, 13, 10]), Buffer.alloc(userSignatureByteLimit, 65)]) {
    const input = userSignatureUploadInput(value({ content })); assert.equal(input.content, content); assert.equal(input.byteLength, content.length);
    assert.equal(input.sha256, createHash('sha256').update(content).digest('hex'));
  }
  assert.throws(() => userSignatureUploadInput(value({ content: Buffer.alloc(userSignatureByteLimit + 1) })), { status: 413, code: 'signature_size_limit' });
  for (const content of [null, '', [], new Uint8Array([1])]) assert.throws(() => userSignatureUploadInput(value({ content })), { status: 400 });
});

test('signature metadata follows source basenames without deriving MIME from extensions or permitting header injection', () => {
  const input = userSignatureUploadInput(value({ requestId: requestId.toUpperCase(), originalName: 'C:\\folder\\本人署名.PDF', mediaType: '' }));
  assert.equal(input.requestId, requestId); assert.equal(input.originalName, '本人署名.PDF'); assert.equal(input.mediaType, 'application/octet-stream');
  assert.equal(userSignatureUploadInput(value({ originalName: '', mediaType: ' TEXT/PLAIN ' })).originalName, 'upload');
  assert.equal(userSignatureUploadInput(value({ mediaType: ' TEXT/PLAIN ' })).mediaType, 'text/plain');
  for (const originalName of [null, 'x\r\nContent-Type:text/html', 'bad\0name', '\ud800', 'x'.repeat(501)]) assert.throws(() => userSignatureUploadInput(value({ originalName })), { status: 400 });
  for (const mediaType of [42, 'image/png\r\nInjected:yes', 'image', 'text/html; charset=utf-8']) assert.throws(() => userSignatureUploadInput(value({ mediaType })), { status: 400 });
});

test('signature upload/removal identities require strict UUIDs, revisions and explicit operation fields', () => {
  assert.deepEqual(userSignatureRemovalInput({ requestId: requestId.toUpperCase(), revision: 0 }), { requestId, revision: 0 });
  for (const input of [null, [], {}, { requestId, revision: '0' }, { requestId, revision: -1 }, { requestId, revision: 1.1 },
    { requestId, revision: 2_147_483_647 }, { requestId: 'invalid', revision: 0 }, { requestId, revision: 0, content: null }]) {
    assert.throws(() => userSignatureRemovalInput(input), { status: 400 });
  }
  assert.throws(() => userSignatureUploadInput(value({ organizationId: requestId })), { status: 400 });
  assert.throws(() => userSignatureUploadInput(value({ sha256: 'forged' })), { status: 400 });
});

test('binary signature streams support empty and split uploads and reject mismatched lengths or async failures', async () => {
  const content = Buffer.from('exact bytes\0é');
  const body = new ReadableStream({ start(controller) { controller.enqueue(content.subarray(0, 4)); controller.enqueue(content.subarray(4)); controller.close(); } });
  const result = await readUserSignatureUpload({ headers: headers({ 'content-length': String(content.length), 'content-type': 'application/octet-stream' }), body });
  assert.deepEqual(result, value({ content }));
  assert.equal((await readUserSignatureUpload({ headers: headers({ 'content-length': '0' }), body: null })).content.length, 0);
  await assert.rejects(readUserSignatureUpload({ headers: headers({ 'content-length': '1' }), body: null }), { code: 'incomplete_signature_file' });
  const failed = new ReadableStream({ pull(controller) { controller.error(new Error('Synthetic transport failure')); } });
  await assert.rejects(readUserSignatureUpload({ headers: headers(), body: failed }), { status: 400, code: 'incomplete_signature_file' }); assert.equal(failed.locked, false);
});

test('signature streams reject malformed metadata before reading and stop oversized transfers', async () => {
  for (const changed of [{ 'x-signature-revision': '' }, { 'x-signature-revision': 'NaN' }, { 'x-signature-revision': '2147483647' },
    { 'x-upload-request-id': 'invalid' }, { 'x-file-name': '%invalid' }, { 'content-length': '-1' }, { 'content-length': '1.5' }]) {
    let opened = false;
    await assert.rejects(readUserSignatureUpload({ headers: headers(changed), body: { getReader() { opened = true; throw new Error('Must not read invalid request'); } } }), { status: 400 });
    assert.equal(opened, false);
  }
  let canceled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(userSignatureByteLimit)); controller.enqueue(new Uint8Array(1)); }, cancel() { canceled = true; } });
  await assert.rejects(readUserSignatureUpload({ headers: headers(), body }), { status: 413, code: 'signature_size_limit' });
  assert.equal(canceled, true); assert.equal(body.locked, false);
  await assert.rejects(readUserSignatureUpload({ headers: headers({ 'content-length': String(userSignatureByteLimit + 1) }), body: null }), { status: 413 });
});
