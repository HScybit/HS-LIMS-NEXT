import { crc32 } from 'node:zlib';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const invalid = () => { throw new Error('Invalid PNG structure.'); };

function chunk(type, data) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); result.write(type, 4, 4, 'ascii'); data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}

// Sharp currently decodes APNG's static fallback only. Read the animation's
// actual frames, including files whose fallback is outside the animation.
// PNG Third Edition sections 4.9 and 11.3.6 define the ordering and inheritance.
export function pngFrames(content, { frameLimit, pixelLimit }) {
  if (!content.subarray(0, 8).equals(signature)) invalid();
  let header; let width; let height; let animation; let frame; let sequence = 0;
  let offset = 8; let count = 0; let seenData = false; let endedData = false; let ended = false;
  const inherited = []; const frames = [];
  function finishFrame() {
    if (frame && (!frame.parts.length || !frame.parts.some((part) => part.length))) invalid();
  }
  while (offset < content.length) {
    if (++count > 10000 || offset + 12 > content.length || ended) invalid();
    const length = content.readUInt32BE(offset);
    if (length > 0x7fffffff || offset + length + 12 > content.length) invalid();
    const type = content.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) invalid();
    const data = content.subarray(offset + 8, offset + 8 + length);
    const whole = content.subarray(offset, offset + length + 12);
    if (crc32(whole.subarray(4, -4)) !== whole.readUInt32BE(whole.length - 4)) invalid();
    if (count === 1 && type !== 'IHDR') invalid();
    if (seenData && type !== 'IDAT') endedData = true;
    if (type === 'IHDR') {
      if (header || length !== 13) invalid();
      header = data; width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (!width || !height || width > 10000 || height > 10000 || width * height > pixelLimit) invalid();
    } else if (type === 'acTL') {
      if (animation || seenData || length !== 8) invalid();
      animation = data.readUInt32BE(0);
      if (!animation || animation > frameLimit || width * height * animation > pixelLimit) invalid();
    } else if (type === 'fcTL') {
      if (!animation || length !== 26 || data.readUInt32BE(0) !== sequence++) invalid();
      finishFrame();
      const w = data.readUInt32BE(4); const h = data.readUInt32BE(8);
      const x = data.readUInt32BE(12); const y = data.readUInt32BE(16);
      if (!w || !h || w + x > width || h + y > height || data[24] > 2 || data[25] > 1) invalid();
      if (!seenData && (frames.length || x || y || w !== width || h !== height)) invalid();
      frame = { width: w, height: h, x, y, defaultImage: !seenData, parts: [] };
      frames.push(frame);
      if (frames.length > animation) invalid();
    } else if (type === 'IDAT') {
      if (endedData || frame && !frame.defaultImage) invalid();
      seenData = true;
      if (frame) frame.parts.push(data);
    } else if (type === 'fdAT') {
      if (!seenData || !frame || frame.defaultImage || length < 4 || data.readUInt32BE(0) !== sequence++) invalid();
      frame.parts.push(data.subarray(4));
    } else if (type === 'IEND') {
      if (!seenData || length) invalid();
      finishFrame(); ended = true;
    } else {
      if (type[0] === type[0].toUpperCase() && type !== 'PLTE') invalid();
      if (!seenData) inherited.push(whole);
    }
    offset += length + 12;
  }
  if (!ended || animation && frames.length !== animation) invalid();
  if (!animation) return null;
  // Also decode the separate fallback; it must not hide a compressed-data bomb.
  if (!frames[0].defaultImage && width * height * (animation + 1) > pixelLimit) invalid();
  return { width, height, frames: frames.map((value) => {
    const frameHeader = Buffer.from(header);
    frameHeader.writeUInt32BE(value.width, 0); frameHeader.writeUInt32BE(value.height, 4);
    return { width: value.width, height: value.height, x: value.x, y: value.y,
      content: Buffer.concat([signature, chunk('IHDR', frameHeader), ...inherited,
        ...value.parts.map((part) => chunk('IDAT', part)), chunk('IEND', Buffer.alloc(0))]) };
  }) };
}
