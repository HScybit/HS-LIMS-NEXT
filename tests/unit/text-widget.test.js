import test from 'node:test';
import assert from 'node:assert/strict';
import { editedTextTitle, formattedTextTitle, textWidgetTitle } from '../../src/templates/text.js';

test('runtime Text edits keep source trim, blank, unchanged and zero behavior', () => {
  for (const value of ['', ' ', '\n\t', 'Title', ' Title ']) assert.equal(editedTextTitle('Title', value), null);
  assert.equal(editedTextTitle('Title', ' 0 '), '0');
  assert.equal(editedTextTitle('Title', ' New title\n'), 'New title');
  assert.equal(editedTextTitle(' Padded title ', ' Padded title '), 'Padded title');
  assert.equal(editedTextTitle('Title', 'false'), 'false');
});

test('Text widgets retain an actual captured title and otherwise use their frozen configured title', () => {
  const field = { label: 'Frozen title', editable: true };
  for (const value of [undefined, { state: 'absent' }, { state: 'empty' }]) assert.equal(textWidgetTitle(field, value), 'Frozen title');
  assert.equal(textWidgetTitle(field, { state: 'present', origin: 'entered', textValue: '0' }), '0');
  assert.equal(textWidgetTitle(field, { state: 'present', origin: 'entered', textValue: 'Edited title' }), 'Edited title');
});

test('Text initialized defaults do not replace configured source titles, including zero and blank titles', () => {
  for (const label of ['Conclusion', '0', 'false', '', ' ']) for (const editable of [true, false]) {
    assert.equal(textWidgetTitle({ label, editable }, { state: 'present', origin: 'default', textValue: 'A different default' }), label);
  }
});

test('noneditable Text displays its configured title even if an imported key has an entered value', () => {
  assert.equal(textWidgetTitle({ label: 'Configured title', editable: false }, { state: 'present', origin: 'entered', textValue: 'Unrelated stored key value' }), 'Configured title');
});

test('formatted Text preserves scientific notation, entities, supported styles and tables', () => {
  const title = '<strong>Water H<sub>2</sub>O</strong> &amp; x<sup>2</sup> = 0';
  assert.equal(formattedTextTitle(title), title);
  assert.equal(formattedTextTitle('0 &lt; 1 &amp; false'), '0 &lt; 1 &amp; false');
  assert.equal(formattedTextTitle('<table><tbody><tr><td colspan="2" style="text-align:center;font-size:12pt">0</td></tr></tbody></table>'),
    '<table><tbody><tr><td colspan="2" style="text-align:center;font-size:12pt">0</td></tr></tbody></table>');
  assert.equal(formattedTextTitle('<p><b>First</p>Second'), '<p><b>First</b></p>Second');
  assert.equal(formattedTextTitle('<a href="https://example.invalid/" target="_blank">Reference</a>'),
    '<a href="https://example.invalid/" target="_blank" rel="noopener noreferrer">Reference</a>');
});

test('plain, unsupported, executable and image-bearing Text remains literal', () => {
  const titles = [null, undefined, false, 0, '', '0', ' ', 'Normal heading',
    '<script>alert(1)</script>', '<div onclick="alert(1)">Unsafe</div>', '<a href="javas&#99;ript:alert(1)">Unsafe</a>',
    '<p style="background:url(https://example.invalid/x)">Unsafe</p>', '<svg onload="alert(1)"></svg>',
    '<img src="https://example.invalid/x" alt="Unbound">', '<img src="/api/report-assets/images/11111111-1111-4111-8111-111111111111">',
    '<div>'.repeat(101) + 'deep' + '</div>'.repeat(101), '<br>'.repeat(20_001)];
  for (const title of titles) assert.equal(formattedTextTitle(title), null, String(title).slice(0, 120));
});
