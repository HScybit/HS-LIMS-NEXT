import test from 'node:test';
import assert from 'node:assert/strict';
import { customCssInput } from '../../src/report-assets/custom-css.js';

test('authored CSS preserves source text, empty content, newline normalization and nonblocking brace warnings', () => {
  assert.equal(customCssInput(''), '');
  assert.equal(customCssInput('  .sample {\r\n  color: red;\r\n}\n'), '  .sample {\n  color: red;\n}\n');
  assert.equal(customCssInput('.sample {'), '.sample {');
  assert.equal(customCssInput('/* <scripture> */'), '/* <scripture> */');
  assert.equal(customCssInput(' '.repeat(1_000_000)).length, 1_000_000);
  assert.throws(() => customCssInput(' '.repeat(1_000_001)), { code: 'custom_css_size_limit' });
});

test('raw style and script tags, null bytes and nontext CSS inputs are rejected', () => {
  for (const value of [null, undefined, 0, {}, [], '.sample\0{}', '<style>p{color:red}</style>', '</STYLE><SCRIPT>alert(1)</SCRIPT>', '< script >', '</ style>']) {
    assert.throws(() => customCssInput(value), { code: 'invalid_custom_css' });
  }
});
