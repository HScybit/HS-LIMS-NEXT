import test from 'node:test';
import assert from 'node:assert/strict';
import { customCssImageIds, capturedCustomCss, currentCustomCss } from '../../src/report-assets/css-resources.js';

const id = 'b20299d6-f9fc-4a80-9aa0-87ff26c5c4b2'; const path = `/api/report-assets/images/${id}`;
const source = 'data:image/png;base64,c3ludGhldGlj'; const sources = new Map([[id, source]]);

test('CSS image references include escaped URLs, custom properties, fallbacks and image-set strings', () => {
  for (const css of [`.report{background:url('${path}')}`, String.raw`.report{background:u\72l("${path}")}`,
    `.report{--image:url('${path}');background:var(--image)}`, `.report{background:var(--image,url('${path}'))}`,
    `.report{background:image-set('${path}' 1x,url('${path}') 2x)}`, `@media print{.report{background:URL('${path.toUpperCase().replace('/API/REPORT-ASSETS/IMAGES/', '/api/report-assets/images/')}')}}`]) {
    assert.deepEqual(customCssImageIds(css), [id]);
    const captured = capturedCustomCss(css, sources);
    assert.deepEqual(captured.imageIds, [id]); assert.ok(captured.css.includes(source)); assert.ok(!captured.css.includes('/api/report-assets/images/'));
  }
  assert.deepEqual(customCssImageIds('.report{content:"url(https://example.invalid/is-text)";color:red}'), []);
  assert.ok(capturedCustomCss('.report{filter:url(#local);color:var(--color,#005577)}', sources).css.includes('url(#local)'));
});

test('uncaptured and disguised CSS resource requests cannot become frozen report styling', () => {
  for (const css of [String.raw`.report{background:url(\68ttps://example.invalid/logo.png)}`, String.raw`@\69mport "https://example.invalid/style.css";`,
    '.report{background:image-set("https://example.invalid/logo.png" 1x)}', '.report{--image:url(https://example.invalid/image);background:var(--image)}',
    '.report{background:src(var(--url));--url:"https://example.invalid/image"}', '.report{background:paint(unstored)}', '.report{width:expression(alert(1))}',
    '.report{--image:"https://example.invalid/image";background:image-set(var(--image) 1x)}',
    '@font-face{font-family:External;src:local("Uncaptured font")}', '.report{background:url(data:image/svg+xml,unstored)}', '.report{bad; color:red}']) {
    assert.throws(() => capturedCustomCss(css, sources), { code: 'report_css_not_captured' });
  }
  assert.throws(() => capturedCustomCss(`.report{background:url('${path}')}`, new Map()), { code: 'report_asset_history_unavailable' });
  // Source brace warnings remain authorable; the CSS parser recovers omitted closing braces.
  assert.equal(capturedCustomCss('.report{color:red;', sources).css, '.report{color:red}');
});

test('live CSS preserves raw warnings and remote authoring while binding known images', () => {
  const css = `/* retained */ .x{bad;--image:url('${path}');color:red;background:u\\72l("${path}")} @import 'https://example.invalid/theme.css';`;
  const current = currentCustomCss(css, sources);
  assert.equal(current.css, `/* retained */ .x{bad;--image:url(${source});color:red;background:url(${source})} @import 'https://example.invalid/theme.css';`);
  assert.deepEqual(current.imageIds, [id]);
  assert.equal(currentCustomCss('.x{bad;color:red', sources).css, '.x{bad;color:red');
  assert.throws(() => capturedCustomCss(css, sources), { code: 'report_css_not_captured' });
});

test('CSS token/depth, unique image and expanded content limits bound capture work', () => {
  assert.throws(() => customCssImageIds('@media print{'.repeat(101) + '}'.repeat(101)), { code: 'custom_css_complexity_limit' });
  assert.throws(() => customCssImageIds('.x{color:red;}'.repeat(20_000)), { code: 'custom_css_complexity_limit' });
  const many = Array.from({ length: 101 }, (_, index) => `.x${index}{background:url('/api/report-assets/images/00000000-0000-4000-8000-${String(index).padStart(12, '0')}')}`).join('');
  assert.throws(() => customCssImageIds(many), { code: 'custom_css_image_limit' });
  assert.throws(() => capturedCustomCss(`.x{background:url('${path}')}`, new Map([[id, 'x'.repeat(32 * 1024 * 1024)]])), { code: 'report_asset_size_limit' });
});
