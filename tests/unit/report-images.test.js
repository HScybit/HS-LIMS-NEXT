import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { validateReportImage, reportImageByteLimit } from '../../src/report-assets/images.js';
import { readReportImageUpload } from '../../src/report-assets/upload.js';

const pixels = () => sharp({ create: { width: 24, height: 12, channels: 3, background: '#005577' } });

test('report images preserve verified raster bytes, dimensions and checksums', async () => {
  for (const format of ['png', 'jpeg', 'webp']) {
    const content = await pixels().toFormat(format).toBuffer();
    const value = await validateReportImage(content, `image/${format}`);
    assert.deepEqual(value, { width: 24, height: 12, mediaType: `image/${format}`, byteLength: content.length,
      sha256: createHash('sha256').update(content).digest('hex') });
  }
});

test('image validation rejects empty, disguised, truncated, oversized and excessive-dimension inputs', async () => {
  const content = await pixels().png().toBuffer();
  for (const empty of [null, '', Buffer.alloc(0)]) await assert.rejects(validateReportImage(empty, 'image/png'), { code: 'empty_report_image' });
  await assert.rejects(validateReportImage(content, 'image/jpeg'), { code: 'report_image_type' });
  await assert.rejects(validateReportImage(Buffer.from('<svg onload="alert(1)"/>'), 'image/svg+xml'), { code: 'report_image_type' });
  await assert.rejects(validateReportImage(Buffer.from('<html>Not an image</html>'), 'image/png'), { code: 'invalid_report_image' });
  await assert.rejects(validateReportImage(content.subarray(0, Math.floor(content.length / 2)), 'image/png'), { code: 'invalid_report_image' });
  await assert.rejects(validateReportImage(Buffer.alloc(reportImageByteLimit + 1), 'image/png'), { code: 'report_image_size_limit' });
  const wide = await sharp({ create: { width: 10001, height: 1, channels: 3, background: 'white' } }).png().toBuffer();
  await assert.rejects(validateReportImage(wide, 'image/png'), { code: 'report_image_dimensions' });
});

test('bounded uploads handle chunked content, unicode names and stream errors without trusting Content-Length', async () => {
  const content = await pixels().png().toBuffer(); const requestId = randomUUID();
  const request = new Request('https://example.invalid/upload', { method: 'POST', headers: {
    'content-type': 'image/png', 'x-file-name': encodeURIComponent('Lab नमूना.png'), 'x-upload-request-id': requestId,
  }, body: content });
  const value = await readReportImageUpload(request);
  assert.deepEqual(value, { requestId, originalName: 'Lab नमूना.png', mediaType: 'image/png', content });
  let cancelled = false;
  const large = new Request('https://example.invalid/upload', { method: 'POST', duplex: 'half', headers: { 'content-length': '1' },
    body: new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(reportImageByteLimit + 1)); }, cancel() { cancelled = true; } }) });
  await assert.rejects(readReportImageUpload(large), { code: 'report_image_size_limit' });
  assert.equal(cancelled, true);
  const invalidName = new Request('https://example.invalid/upload', { method: 'POST', body: content, headers: { 'x-file-name': '%' } });
  await assert.rejects(readReportImageUpload(invalidName), { code: 'invalid_image_name' });
  const broken = new Request('https://example.invalid/upload', { method: 'POST', duplex: 'half',
    body: new ReadableStream({ start(controller) { controller.error(new Error('Synthetic upload interrupted')); } }) });
  await assert.rejects(readReportImageUpload(broken), /Synthetic upload interrupted/);
});
