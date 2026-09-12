import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { validateTemplateImage, templateImageByteLimit } from '../../src/template-assets/images.js';
import { animatedPng, animatedRaster, pngChunks, encodePng } from '../helpers/template-images.js';
import { imageLayout } from '../../src/templates/image-config.js';
import { readTemplateImageUpload } from '../../src/template-assets/upload.js';

const pixel = async (content, x = 8, y = 8) => [...await sharp(content).ensureAlpha().extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer()];
const raster = () => sharp({ create: { width: 16, height: 12, channels: 4, background: '#005577' } });

test('template image formats retain original checksums and a complete static PNG for printing', async () => {
  for (const format of ['jpeg', 'png', 'gif', 'webp']) {
    const content = await raster().toFormat(format).toBuffer();
    const value = await validateTemplateImage(content, `image/${format}`);
    assert.equal(value.sha256, createHash('sha256').update(content).digest('hex'));
    assert.equal(value.printSha256, createHash('sha256').update(value.printContent).digest('hex'));
    assert.deepEqual([value.width, value.height, value.frameCount, value.byteLength, value.printByteLength], [16, 12, 1, content.length, value.printContent.length]);
    assert.equal((await sharp(value.printContent).metadata()).format, 'png');
    await sharp(value.printContent).stats();
  }
  const jpeg = await raster().jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const rotated = await validateTemplateImage(jpeg, 'image/jpg');
  assert.deepEqual([rotated.mediaType, rotated.width, rotated.height], ['image/jpeg', 12, 16]);
  assert.equal((await sharp(rotated.printContent).metadata()).width, 12);
});

test('GIF, WebP and both APNG layouts print the first animation frame, never the separate fallback', async () => {
  const fixtures = [
    [await animatedRaster('gif'), 'image/gif'], [await animatedRaster('webp'), 'image/webp'],
    [await animatedPng(), 'image/png'], [await animatedPng({ separateDefault: true }), 'image/png'],
    [await animatedPng({ interlace: true }), 'image/png'],
    [await animatedPng({ palette: true }), 'image/png'],
  ];
  for (const [content, type] of fixtures) {
    const value = await validateTemplateImage(content, type);
    assert.deepEqual([value.width, value.height, value.frameCount], [16, 16, 2]);
    assert.deepEqual(await pixel(value.printContent), [255, 0, 0, 255]);
  }
});

test('image configuration retains source numeric prefixes, zero, negative margins and alignment aliases', () => {
  assert.deepEqual(imageLayout(), { widthPercent: 100, marginTop: 0, marginBottom: 0, marginRight: 0, marginLeft: 0, alignment: 'start' });
  assert.deepEqual(imageLayout({ widthPercent: '0', marginTop: '-4.5px', marginBottom: '1e2', marginRight: 'NaN', marginLeft: 'Infinity', alignment: ' FLEX-END ' }),
    { widthPercent: 0, marginTop: -4.5, marginBottom: 100, marginRight: 0, marginLeft: 0, alignment: 'end' });
  assert.equal(imageLayout({ widthPercent: '-25%', alignment: 'middle' }).widthPercent, -25);
  assert.equal(imageLayout({ alignment: 'middle' }).alignment, 'center');
  assert.equal(imageLayout({ alignment: 'unknown' }).alignment, 'start');
  assert.throws(() => imageLayout({ src: 'https://example.invalid/image' }), { code: 'invalid_input' });
  for (const value of [{ toString: null }, [], { width: 10 }]) assert.throws(() => imageLayout({ widthPercent: value }), { code: 'invalid_input' });
});

test('template uploads bound actual streamed bytes and handle filenames and interrupted requests', async () => {
  const content = await raster().png().toBuffer();
  const input = await readTemplateImageUpload(new Request('http://localhost/upload', { method: 'POST', body: content,
    headers: { 'Content-Type': 'image/png', 'X-File-Name': encodeURIComponent('नमूना.png'), 'X-Upload-Request-Id': 'synthetic' } }));
  assert.deepEqual(input, { requestId: 'synthetic', originalName: 'नमूना.png', mediaType: 'image/png', content });
  let cancelled = false;
  const excessive = new Request('http://localhost/upload', { method: 'POST', duplex: 'half', headers: { 'Content-Length': '1' }, body: new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(templateImageByteLimit + 1)); }, cancel() { cancelled = true; },
  }) });
  await assert.rejects(readTemplateImageUpload(excessive), { code: 'template_image_size_limit' }); assert.equal(cancelled, true);
  await assert.rejects(readTemplateImageUpload(new Request('http://localhost/upload', { method: 'POST', headers: { 'X-File-Name': '%' } })), { code: 'invalid_image_name' });
  await assert.rejects(readTemplateImageUpload(new Request('http://localhost/upload', { method: 'POST', duplex: 'half', body: new ReadableStream({
    start(controller) { controller.error(new Error('Synthetic interrupted stream')); },
  }) })), /Synthetic interrupted stream/);
});

test('a partial first APNG frame starts on a transparent canvas', async () => {
  const content = await animatedPng({ separateDefault: true, frames: [
    { color: { r: 255, g: 0, b: 0, alpha: 0.5 }, width: 8, height: 8, x: 4, y: 3 }, { color: 'blue' },
  ] });
  const value = await validateTemplateImage(content, 'image/png');
  assert.deepEqual(await pixel(value.printContent, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(await pixel(value.printContent, 4, 3), [255, 0, 0, 128]);
  assert.deepEqual(await pixel(value.printContent, 12, 11), [0, 0, 0, 0]);
});

test('APNG print frames apply all EXIF orientations to the complete transparent canvas', async () => {
  const points = [[5, 3], [18, 3], [18, 8], [5, 8], [3, 5], [8, 5], [8, 18], [3, 18]];
  for (let orientation = 1; orientation <= 8; orientation++) {
    const content = await animatedPng({ width: 24, height: 12, separateDefault: true, orientation, frames: [
      { width: 8, height: 4, x: 4, y: 2, color: { r: 255, g: 0, b: 0, alpha: 0.5 } }, { color: 'blue' },
    ] });
    const value = await validateTemplateImage(content, 'image/png');
    assert.deepEqual([value.width, value.height], orientation >= 5 ? [12, 24] : [24, 12]);
    const metadata = await sharp(value.printContent).metadata();
    assert.deepEqual([metadata.width, metadata.height], [value.width, value.height]); assert.equal(metadata.orientation, undefined);
    assert.deepEqual(await pixel(value.printContent, ...points[orientation - 1]), [255, 0, 0, 128]);
    assert.deepEqual(await pixel(value.printContent, 0, 0), [0, 0, 0, 0]);
  }
});

test('image uploads reject empty, excessive, disguised and incomplete files', async () => {
  for (const content of [null, '', Buffer.alloc(0)]) await assert.rejects(validateTemplateImage(content, 'image/png'), { code: 'empty_template_image' });
  await assert.rejects(validateTemplateImage(Buffer.alloc(templateImageByteLimit + 1), 'image/png'), { code: 'template_image_size_limit' });
  const content = await raster().png().toBuffer();
  await assert.rejects(validateTemplateImage(content, 'image/svg+xml'), { code: 'template_image_type' });
  await assert.rejects(validateTemplateImage(content, 'image/jpeg'), { code: 'template_image_type' });
  await assert.rejects(validateTemplateImage(content.subarray(0, -12), 'image/png'), { code: 'invalid_template_image' });
  await assert.rejects(validateTemplateImage(Buffer.from('<html>image</html>'), 'image/png'), { code: 'invalid_template_image' });
  for (const format of ['gif', 'webp']) {
    const animation = await animatedRaster(format);
    await assert.rejects(validateTemplateImage(animation.subarray(0, -10), `image/${format}`), { code: 'invalid_template_image' });
    await assert.rejects(validateTemplateImage(await animatedRaster(format, { frames: 201 }), `image/${format}`), { code: 'template_image_dimensions' });
  }
});

test('APNG validates every frame CRC, sequence, bound, count and compressed stream', async () => {
  const original = await animatedPng({ separateDefault: true });
  const mutations = [
    (chunks) => chunks.find((chunk) => chunk.type === 'acTL').data.writeUInt32BE(0),
    (chunks) => chunks.find((chunk) => chunk.type === 'acTL').data.writeUInt32BE(3),
    (chunks) => chunks.find((chunk) => chunk.type === 'acTL').data.writeUInt32BE(201),
    (chunks) => chunks.find((chunk) => chunk.type === 'fcTL').data.writeUInt32BE(1),
    (chunks) => chunks.find((chunk) => chunk.type === 'fcTL').data.writeUInt32BE(17, 4),
    (chunks) => chunks.find((chunk) => chunk.type === 'fcTL').data.writeUInt32BE(1, 12),
    (chunks) => { chunks.find((chunk) => chunk.type === 'fcTL').data[24] = 3; },
    (chunks) => { chunks.find((chunk) => chunk.type === 'fcTL').data[25] = 2; },
    (chunks) => chunks.findLast((chunk) => chunk.type === 'fdAT').data.fill(0, 4),
    (chunks) => { chunks.findLast((chunk) => chunk.type === 'fdAT').data = Buffer.alloc(4); },
    (chunks) => chunks.splice(chunks.findIndex((chunk) => chunk.type === 'acTL'), 1),
    (chunks) => chunks.push({ type: 'tEXt', data: Buffer.from('key\0value') }),
  ];
  for (const mutate of mutations) {
    const chunks = pngChunks(original); mutate(chunks);
    await assert.rejects(validateTemplateImage(encodePng(chunks), 'image/png'), { code: 'invalid_template_image' });
  }
  const corrupted = Buffer.from(original); corrupted[corrupted.length - 1] ^= 1;
  await assert.rejects(validateTemplateImage(corrupted, 'image/png'), { code: 'invalid_template_image' });
});
