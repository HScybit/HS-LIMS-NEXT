import { crc32 } from 'node:zlib';
import sharp from 'sharp';

export function pngChunks(content) {
  const chunks = [];
  for (let offset = 8; offset < content.length;) {
    const length = content.readUInt32BE(offset);
    chunks.push({ type: content.toString('latin1', offset + 4, offset + 8), data: Buffer.from(content.subarray(offset + 8, offset + 8 + length)) });
    offset += length + 12;
  }
  return chunks;
}

export function encodePng(chunks) {
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks.map(({ type, data }) => {
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length); result.write(type, 4, 4, 'latin1'); data.copy(result, 8);
    result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
    return result;
  })]);
}

export async function animatedPng({ separateDefault = false, width = 16, height = 16,
  frames = [{ color: 'red' }, { color: 'blue' }], palette = false, interlace = false, orientation } = {}) {
  const raster = async (frame) => pngChunks(await sharp({ create: { width: frame.width ?? width, height: frame.height ?? height,
    channels: 4, background: frame.color } }).png({ palette, progressive: interlace }).toBuffer());
  const fallback = await raster({ color: separateDefault ? 'green' : frames[0].color });
  const header = fallback.find((chunk) => chunk.type === 'IHDR');
  const inherited = fallback.filter((chunk) => !['IHDR', 'IDAT', 'IEND'].includes(chunk.type));
  if (orientation) {
    const tagged = await sharp({ create: { width, height, channels: 3, background: 'red' } }).withMetadata({ orientation }).png().toBuffer();
    inherited.push(pngChunks(tagged).find((chunk) => chunk.type === 'eXIf'));
  }
  const animation = Buffer.alloc(8); animation.writeUInt32BE(frames.length); animation.writeUInt32BE(1, 4);
  const chunks = [header, ...inherited, { type: 'acTL', data: animation }];
  if (separateDefault) chunks.push(...fallback.filter((chunk) => chunk.type === 'IDAT'));
  let sequence = 0;
  for (const [index, frame] of frames.entries()) {
    const control = Buffer.alloc(26); control.writeUInt32BE(sequence++);
    control.writeUInt32BE(frame.width ?? width, 4); control.writeUInt32BE(frame.height ?? height, 8);
    control.writeUInt32BE(frame.x ?? 0, 12); control.writeUInt32BE(frame.y ?? 0, 16);
    control.writeUInt16BE(index ? 2000 : 100, 20); control.writeUInt16BE(1000, 22);
    chunks.push({ type: 'fcTL', data: control });
    const pixels = index === 0 && !separateDefault ? fallback : await raster(frame);
    for (const part of pixels.filter((chunk) => chunk.type === 'IDAT')) {
      if (index === 0 && !separateDefault) chunks.push(part);
      else { const data = Buffer.alloc(part.data.length + 4); data.writeUInt32BE(sequence++); part.data.copy(data, 4); chunks.push({ type: 'fdAT', data }); }
    }
  }
  chunks.push({ type: 'IEND', data: Buffer.alloc(0) });
  return encodePng(chunks);
}

export async function animatedRaster(format, { width = 16, height = 16, frames = 2 } = {}) {
  const raw = Buffer.alloc(width * height * frames * 3);
  for (let pixel = 0; pixel < width * height * frames; pixel++) raw[pixel * 3 + (Math.floor(pixel / (width * height)) % 2 ? 2 : 0)] = 255;
  return sharp(raw, { raw: { width, height: height * frames, channels: 3, pageHeight: height } })
    .toFormat(format, { loop: 1, delay: Array.from({ length: frames }, (_, index) => index ? 2000 : 100), lossless: true }).toBuffer();
}
