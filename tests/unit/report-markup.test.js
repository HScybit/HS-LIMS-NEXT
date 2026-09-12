import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { reportContentHtml } from '../../src/report-assets/markup.js';

test('source rich content preserves formatting, tables, exact text and stable image references', () => {
  const id = randomUUID();
  const input = `<figure class="table" style="width:75%;margin-left:auto;margin-right:auto"><table style="border-collapse:collapse;border:1px solid #000"><tbody><tr>
    <td colspan="2" style="padding:0 4px;text-align:center"><strong>Laboratory &amp; quality</strong><br><span style="font-family:'Times New Roman';font-size:12pt;color:rgb(0, 0, 0)">0 &lt; 1</span></td>
    </tr><tr><td><img src="/api/report-assets/images/${id.toUpperCase()}" width="80" alt="Logo"></td><td><a href="https://example.invalid/" target="_blank">Reference</a></td></tr></tbody></table></figure>`;
  const result = reportContentHtml(input);
  assert.deepEqual(result.imageIds, [id]);
  for (const value of ['class="table"', 'width:75%', 'border:1px solid #000', 'padding:0 4px', 'colspan="2"', '0 &lt; 1', 'Laboratory &amp; quality', 'font-size:12pt', 'font-family:', 'rel="noopener noreferrer"']) assert.ok(result.html.includes(value), value);
  assert.ok(result.html.includes(`/api/report-assets/images/${id}`));
  assert.deepEqual(reportContentHtml(''), { html: '', imageIds: [] });
  assert.deepEqual(reportContentHtml(result.html), result);
});

test('executable tags, encoded URLs, namespaces, event handlers and resource-bearing CSS are rejected', () => {
  const attacks = ['<script>alert(1)</script>', '<iframe src="https://example.invalid"></iframe>', '<svg><a xlink:href="javascript:alert(1)">X</a></svg>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">', '<img src=x onerror=alert(1)>',
    '<p ONCLICK="alert(1)">X</p>', '<a href="javas&#99;ript:alert(1)">X</a>', '<a href="data:text/html,hi">X</a>',
    '<p style="background:url(https://example.invalid)">X</p>', '<p style="color: e\\78pression(alert(1))">X</p>',
    '<p style="background:u/**/rl(x)">X</p>', '<style>@import "https://example.invalid"</style>', '<form action="/api/action">X</form>',
    '<img srcset="https://example.invalid/a 2x">', '<div is="custom-element">X</div>'];
  for (const html of attacks) assert.throws(() => reportContentHtml(html), { code: 'unsafe_report_html' }, html);
  const stripped = reportContentHtml('<p style="position:fixed;z-index:100;animation-name:external;display:block;color:red">Text</p>').html;
  assert.equal(stripped, '<p style="display:block;color:red">Text</p>');
});

test('only captured images can be referenced and the renderer requires every exact image source', () => {
  const id = randomUUID();
  for (const src of ['https://example.invalid/image.png', '//example.invalid/a', '/other/path', 'data:image/png;base64,AAAA']) {
    assert.throws(() => reportContentHtml(`<img src="${src}">`), { code: 'report_image_not_captured' });
  }
  const input = `<img src="/api/report-assets/images/${id}"><img src="/api/report-assets/images/${id}">`;
  assert.deepEqual(reportContentHtml(input).imageIds, [id]);
  assert.throws(() => reportContentHtml(input, { imageSources: new Map() }), { code: 'report_image_unavailable' });
  assert.throws(() => reportContentHtml(input, { imageSources: new Map([[id, 'data:text/html;base64,PHN2Zz4=']]) }), { code: 'report_image_unavailable' });
  const result = reportContentHtml(input, { imageSources: new Map([[id, 'data:image/png;base64,AAAA']]) });
  assert.equal((result.html.match(/src="data:image\/png;base64,AAAA"/g) ?? []).length, 2);
});

test('empty content is allowed while malformed values, excessive content and deeply nested layouts are bounded', () => {
  for (const input of [null, false, {}, 'x'.repeat(1_000_001)]) assert.throws(() => reportContentHtml(input), { code: 'invalid_report_html' });
  assert.throws(() => reportContentHtml('<div>'.repeat(101) + 'X' + '</div>'.repeat(101)), { code: 'report_content_limit' });
  assert.throws(() => reportContentHtml('<br>'.repeat(20_001)), { code: 'report_content_limit' });
  assert.throws(() => reportContentHtml('<table><tr><td colspan="1000000">X</td></tr></table>'), { code: 'unsafe_report_html' });
  assert.equal(reportContentHtml('<p>First<p>Second').html, '<p>First</p><p>Second</p>');
});

test('repeated image expansion is bounded before constructing an oversized HTML string', () => {
  const id = randomUUID(); const source = `data:image/png;base64,${'A'.repeat(1024 * 1024)}`;
  assert.throws(() => reportContentHtml(`<img src="/api/report-assets/images/${id}">`.repeat(33), { imageSources: new Map([[id, source]]) }), { code: 'report_asset_size_limit' });
});
