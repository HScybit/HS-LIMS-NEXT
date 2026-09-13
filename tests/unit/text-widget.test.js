import test from 'node:test';
import assert from 'node:assert/strict';
import { editedTextTitle, textWidgetTitle } from '../../src/templates/text.js';

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
