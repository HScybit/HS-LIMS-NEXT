import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateReportSvg } from '../../src/report-assets/svg.js';
import { validateReportImage } from '../../src/report-assets/images.js';
import { reportSvg } from '../helpers/report-svg.js';

const document = (body, attributes = '') => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="24" ${attributes}>${body}</svg>`);

test('static SVG preserves original bytes, dimensions, gradients, CSS, namespaces and local reuse', async () => {
  const original = Buffer.from(reportSvg);
  assert.deepEqual(await validateReportImage(reportSvg, 'image/svg+xml'), { width: 80, height: 24, mediaType: 'image/svg+xml',
    byteLength: reportSvg.length, sha256: createHash('sha256').update(reportSvg).digest('hex') });
  assert.deepEqual(reportSvg, original);
  validateReportSvg(document('<text x="2" y="14" style="fill:rgb(0, 20, 40);font-size:12px">Lab &amp; नमूना</text>'));
  validateReportSvg(document('<rect width="80" height="24"/>', 'role="img" aria-label="Lab@example.invalid"'));
  validateReportSvg(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), reportSvg]));
});

test('SVG rejects executable, external, encoded and animated content before image decoding', async () => {
  const bodies = [
    '<script>alert(1)</script>', '<rect onclick="alert(1)"/>', '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">HTML</div></foreignObject>',
    '<image href="https://example.invalid/a.png"/>', '<use href="https://example.invalid/a.svg#shape"/>', '<use href="&#x6a;avascript:alert(1)"/>',
    '<use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="file:///etc/passwd"/>', '<rect fill="url(https://example.invalid/a)"/>',
    '<rect style="fill:u\\72l(https://example.invalid/a)"/>', '<style>@import "https://example.invalid/a.css";</style>',
    '<style>rect { fill: url(//example.invalid/a); }</style>', '<style>rect{animation: move 1s infinite}</style>',
    '<style>rect{fill:var(--external)}</style>', '<style>rect{fill:u/**/rl(https://example.invalid/a)}</style>',
    '<rect fill="&#x75;rl(https://example.invalid/a)"/>', '<animate attributeName="x" from="0" to="100"/>',
    '<set attributeName="href" to="https://example.invalid/a"/>', '<?xml-stylesheet href="https://example.invalid/a.css"?>',
    '<x:script xmlns:x="http://www.w3.org/2000/svg">alert(1)</x:script>',
  ];
  for (const body of bodies) await assert.rejects(validateReportImage(document(body), 'image/svg+xml'), { code: 'unsafe_report_svg' }, body);
  assert.throws(() => validateReportSvg(document('<rect/>', 'xml:base="https://example.invalid/"')), { code: 'unsafe_report_svg' });
  assert.throws(() => validateReportSvg(Buffer.from('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>')), { code: 'unsafe_report_svg' });
});

test('SVG rejects malformed XML, duplicate or missing identities, foreign namespaces and invalid styles', () => {
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from('<svg>'), Buffer.from('<html/>'),
    document('<rect><circle/></path>'), document('<rect width="2" width="3"/>'), document('<g xmlns=""><rect/></g>'),
    document('<rect id="a"/><circle id="a"/>'), document('<use href="#missing"/>'), document('<rect fill="url(#missing)"/>'),
    document('<style>rect { fill: red</style>'), document('<rect style="fill:red}circle{fill:blue"/>'),
  ]) assert.throws(() => validateReportSvg(bytes), { code: 'unsafe_report_svg' });
});

test('SVG bounds nesting, node counts, cycles and exponential local reference expansion', () => {
  for (const body of ['<g>'.repeat(101) + '</g>'.repeat(101), '<rect/>'.repeat(20_001), '<use id="a" href="#a"/>',
    '<g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g>',
    '<defs><rect id="n0"/>' + Array.from({ length: 16 }, (_, index) => `<g id="n${index + 1}"><use href="#n${index}"/><use href="#n${index}"/></g>`).join('') + '</defs><use href="#n16"/>',
  ]) assert.throws(() => validateReportSvg(document(body)), { code: 'report_svg_limit' });
});
