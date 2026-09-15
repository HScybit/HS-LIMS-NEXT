import test from 'node:test';
import assert from 'node:assert/strict';
import { createFilter } from 'react-select';
import { cacheSelectFilter, prepareSelectOptions } from '../../src/components/ui/selectUtils.js';

test('cached default filtering agrees with the installed filter for Unicode, IDs, primitives and whitespace', () => {
  const exact = createFilter(); const cached = cacheSelectFilter(exact);
  const options = ['Élodie', 'Straße', 'Ægir', 'Łódź', 'İstanbul', 'Åsa', 'e\u0301', '\u2003Trim\u00a0', 'a.b[0] %_', '子', '😀', 0, false, '', null, undefined]
    .map((label, index) => ({ label, value: index % 2 ? `Original-${index}` : index, data: {} }));
  const queries = ['', ' ', '\t\n', 'elodie', 'STRASSE', 'aegir', 'lodz', 'istanbul', 'asa', 'é', 'trim', 'original-', 'a.b[0]', '%_', '子', '😀', 'false', '0', 'no match'];
  for (const query of queries) for (const option of options) {
    const expected = exact(option, query); assert.equal(cached(option, query), expected); assert.equal(cached({ ...option }, query), expected);
  }
});

test('repeated library passes reuse each answer and a new query or explicit clear recomputes it', () => {
  let calls = 0; const exact = createFilter(); const cached = cacheSelectFilter((...args) => { calls++; return exact(...args); });
  const options = Array.from({ length: 1000 }, (_, index) => ({ label: `Élodie ${index}`, value: String(index), data: {} }));
  for (let pass = 0; pass < 4; pass++) for (const option of options) assert.equal(cached({ ...option }, 'elodie'), true);
  assert.equal(calls, 1000); for (const option of options) cached(option, 'missing'); assert.equal(calls, 2000);
  cached.clear(); assert.equal(cached(options[0], 'missing'), false); assert.equal(calls, 2001);
});

test('changed labels, values and new-option markers never reuse stale answers', () => {
  const cached = cacheSelectFilter(createFilter()); const data = {}; const option = { data, label: 'Before', value: 'old' };
  assert.equal(cached(option, 'new'), false); option.label = 'New label'; assert.equal(cached(option, 'new'), true);
  option.label = 'Before'; option.value = 'New ID'; assert.equal(cached(option, 'new'), true);
  option.value = 'old'; assert.equal(cached(option, 'new'), false); data.__isNew__ = true; assert.equal(cached(option, 'new'), true);
  data.__isNew__ = false; assert.equal(cached(option, 'new'), false);
});

test('object stringification and unusual data delegate directly instead of caching mutable behavior', () => {
  const exact = createFilter(); let calls = 0; const cached = cacheSelectFilter((...args) => { calls++; return exact(...args); });
  let label = 'before'; const option = { data: {}, value: 'id', label: { toString: () => label } };
  assert.equal(cached(option, 'after'), false); label = 'after'; assert.equal(cached(option, 'after'), true); assert.equal(calls, 2);
  const scalarData = { data: 'data', label: 'after', value: 'id' }; cached(scalarData, 'after'); cached(scalarData, 'after'); assert.equal(calls, 4);
  assert.throws(() => cached({ data: null, label: '', value: '' }, ''), TypeError);
});

test('blank-input filtering avoids accent work while retaining exact installed default results', () => {
  const exact = createFilter(); const blank = createFilter({ ignoreAccents: false }); let ordinaryCalls = 0; let blankCalls = 0;
  const cached = cacheSelectFilter((...args) => { ordinaryCalls++; return exact(...args); }, (...args) => { blankCalls++; return blank(...args); });
  const values = ['Élodie', 'Straße', 'Ægir', 'Łódź', 'İstanbul', 'e\u0301', '子', '😀', '', null, undefined, 0, false];
  for (const input of ['', ' \t\n', '\u2003\u00a0', 'elodie', 'strasse', '\u0301', 'missing']) {
    for (const label of values) {
      const option = { label, value: label, data: {} }; const expected = exact(option, input);
      assert.equal(cached(option, input), expected); assert.equal(cached(option, input), expected);
    }
  }
  assert.equal(blankCalls, values.length * 3); assert.equal(ordinaryCalls, values.length * 4);
  const mutable = { label: { toString: () => 'Élodie' }, value: 'id', data: {} };
  assert.equal(cached(mutable, ''), exact(mutable, '')); assert.equal(ordinaryCalls, values.length * 4 + 1);
});

test('prepared choices preserve normalization, grouping, exact source identity and last-value lookup semantics', () => {
  const options = [{ key: 'legacy', value: 'Original' }, { label: 'Group', options: [0, false, { value: 0, label: 'Last zero' }] }];
  const original = structuredClone(options); const prepared = prepareSelectOptions(options);
  assert.equal(prepared.sourceOptions, options); assert.deepEqual(options, original);
  assert.equal(prepared.options[0].value, 'legacy'); assert.equal(prepared.byValue.get('legacy').label, 'Original');
  assert.equal(prepared.byValue.get('0'), prepared.options[1].options[2]); assert.equal(prepared.byValue.get('false').label, false);
  assert.equal(prepareSelectOptions().byValue.size, 0);
});
