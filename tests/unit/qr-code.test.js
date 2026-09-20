import test from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import { qrCodeSvg } from '../../src/templates/qr-code.js';

test('qrCodeSvg matches the qrcode package\'s own SVG renderer byte for byte', async () => {
  for (const text of ['SAMPLE-0001', 'https://example.invalid/s/abc-123', '1']) {
    const expected = await new Promise((resolve, reject) => QRCode.toString(text, { type: 'svg', margin: 1 }, (error, svg) => error ? reject(error) : resolve(svg)));
    assert.equal(qrCodeSvg(text), expected.trim());
  }
});

test('qrCodeSvg returns null for empty or missing text rather than throwing', () => {
  assert.equal(qrCodeSvg(''), null);
  assert.equal(qrCodeSvg(null), null);
  assert.equal(qrCodeSvg(undefined), null);
});

test('qrCodeSvg is a valid, well-formed SVG document with a square viewBox', () => {
  const svg = qrCodeSvg('SAMPLE-0001');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 (\d+) \1" shape-rendering="crispEdges">/);
  assert.match(svg, /<path fill="#ffffff"/); assert.match(svg, /<path stroke="#000000"/);
  assert.ok(svg.endsWith('</svg>'));
});
