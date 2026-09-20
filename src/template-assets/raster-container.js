const invalid = () => { throw new Error('Incomplete image container.'); };

// Pixel decoders can silently recover partial animations. Require complete
// containers as well as decoding pixels before retaining an immutable original.
export function gifFrameCount(content) {
  if (content.length < 14 || !['GIF87a', 'GIF89a'].includes(content.toString('latin1', 0, 6))) invalid();
  const width = content.readUInt16LE(6); const height = content.readUInt16LE(8);
  let offset = 13 + (content[10] & 0x80 ? 3 * 2 ** ((content[10] & 7) + 1) : 0);
  let frames = 0; let blocks = 0;
  function advance(length) { offset += length; if (offset > content.length) invalid(); }
  function subBlocks() {
    let bytes = 0;
    while (true) {
      if (offset >= content.length || ++blocks > 100000) invalid();
      const length = content[offset++];
      if (!length) return bytes;
      bytes += length; advance(length);
    }
  }
  while (offset < content.length) {
    const type = content[offset++];
    if (type === 0x3b) {
      if (offset !== content.length || !frames) invalid();
      return frames;
    }
    if (type === 0x21) {
      const label = content[offset++];
      if (label === 0xf9) {
        if (content[offset] !== 4 || content[offset + 5] !== 0) invalid();
        const flags = content[offset + 1];
        if (flags & 0xe0 || ((flags >> 2) & 7) > 3) invalid();
        advance(6);
      } else {
        if (label === 0xff && content[offset] !== 11 || label === 0x01 && content[offset] !== 12) invalid();
        subBlocks();
      }
    } else if (type === 0x2c) {
      if (offset + 9 > content.length) invalid();
      const x = content.readUInt16LE(offset); const y = content.readUInt16LE(offset + 2);
      const w = content.readUInt16LE(offset + 4); const h = content.readUInt16LE(offset + 6);
      const flags = content[offset + 8]; advance(9);
      if (!w || !h || x + w > width || y + h > height || flags & 0x18) invalid();
      if (flags & 0x80) advance(3 * 2 ** ((flags & 7) + 1));
      const codeSize = content[offset++];
      if (codeSize < 2 || codeSize > 8 || !subBlocks()) invalid();
      frames++;
    } else invalid();
  }
  invalid();
}

export function webpFrameCount(content) {
  if (content.length < 20 || content.toString('latin1', 0, 4) !== 'RIFF' || content.toString('latin1', 8, 12) !== 'WEBP'
    || content.readUInt32LE(4) + 8 !== content.length) invalid();
  let offset = 12; let frames = 0; let chunks = 0;
  while (offset < content.length) {
    if (offset + 8 > content.length || ++chunks > 10000) invalid();
    const type = content.toString('latin1', offset, offset + 4);
    const length = content.readUInt32LE(offset + 4);
    offset += 8 + length;
    if (offset > content.length) invalid();
    if (length & 1) { if (content[offset++] !== 0) invalid(); }
    if (type === 'ANMF') frames++;
  }
  return frames || 1;
}
