import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import sharp from 'sharp';
import { sampleProductInput } from '../../src/samples/input.js';
import { validateSampleImage, sampleImageByteLimit } from '../../src/samples/images.js';
import { readSampleImageUpload } from '../../src/samples/image-upload.js';

const fails = code => error => error.code === code;
const image = format => sharp({ create: { width: 3, height: 2, channels: 3, background: 'red' } }).toFormat(format).toBuffer();

test('sample lines accept a canonical image identity, explicit removal and no image', () => {
  const id = randomUUID(); const line = { productId: id, tests: [{ testParameterId: id, methodId: id }] };
  assert.equal(sampleProductInput({ ...line, imageFileId: id.toUpperCase() }, id).imageFileId, id);
  assert.equal(sampleProductInput({ ...line, imageFileId: null }, id).imageFileId, null);
  assert.equal(sampleProductInput(line, id).imageFileId, null);
  for (const value of ['', false, 2, {}, 'https://example.invalid/image.png']) assert.throws(() => sampleProductInput({ ...line, imageFileId: value }, id));
});

test('image validation preserves original bytes, dimensions and checksums for every accepted media type', async () => {
  for (const [format, mediaType] of [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']]) {
    const content = await image(format); const original = Buffer.from(content);
    const result = await validateSampleImage(content, mediaType);
    assert.deepEqual(content, original);
    assert.deepEqual(result, { mediaType, width: 3, height: 2, frameCount: 1, byteLength: content.length,
      sha256: createHash('sha256').update(content).digest('hex') });
  }
});

test('empty, malformed, misleading, oversized and overdimensioned images fail before storage', async () => {
  const png = await image('png');
  await assert.rejects(validateSampleImage(Buffer.alloc(0), 'image/png'), fails('empty_sample_image'));
  await assert.rejects(validateSampleImage(Buffer.alloc(sampleImageByteLimit + 1), 'image/png'), fails('sample_image_size_limit'));
  await assert.rejects(validateSampleImage(png, 'image/jpeg'), fails('sample_image_type'));
  await assert.rejects(validateSampleImage(png.subarray(0, 40), 'image/png'), fails('invalid_sample_image'));
  for (const type of ['image/svg+xml', 'image/gif', 'image/jpg', 'text/html', undefined]) await assert.rejects(validateSampleImage(png, type), fails('sample_image_type'));
  const wide = await sharp({ create: { width: 10001, height: 1, channels: 3, background: 'red' } }).png().toBuffer();
  await assert.rejects(validateSampleImage(wide, 'image/png'), fails('invalid_sample_image'));
});

function uploadRequest(chunks, headers = {}, fail = false) {
  return { headers: new Headers({ 'x-file-name': encodeURIComponent('photo β.png'), 'content-type': 'image/png', 'x-upload-request-id': randomUUID(), ...headers }),
    body: new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); if (fail) controller.error(new Error('disconnected')); else controller.close(); } }) };
}

test('streaming upload handles chunk boundaries and preserves raw content and Unicode filenames', async () => {
  const bytes = await image('png');
  const result = await readSampleImageUpload(uploadRequest([bytes.subarray(0, 10), bytes.subarray(10)], { 'content-length': String(bytes.length) }));
  assert.deepEqual(result.content, bytes); assert.equal(result.originalName, 'photo β.png'); assert.equal(result.mediaType, 'image/png');
});

test('streaming upload rejects malformed lengths, underreported sizes and async failures', async () => {
  const bytes = await image('png');
  await assert.rejects(readSampleImageUpload(uploadRequest([bytes], { 'content-length': 'oops' })), fails('invalid_image_length'));
  await assert.rejects(readSampleImageUpload(uploadRequest([], { 'content-length': String(sampleImageByteLimit + 1) })), fails('sample_image_size_limit'));
  for (const length of [bytes.length - 1, bytes.length + 1]) await assert.rejects(readSampleImageUpload(uploadRequest([bytes], { 'content-length': String(length) })), fails('incomplete_image'));
  await assert.rejects(readSampleImageUpload(uploadRequest([], {}, true)), fails('incomplete_image'));
  await assert.rejects(readSampleImageUpload(uploadRequest([Buffer.alloc(sampleImageByteLimit), Buffer.from([1])])), fails('sample_image_size_limit'));
  await assert.rejects(readSampleImageUpload(uploadRequest([], { 'x-file-name': '%' })), fails('invalid_image_name'));
});
