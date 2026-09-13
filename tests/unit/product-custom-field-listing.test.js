import test from 'node:test';
import assert from 'node:assert/strict';
import { productCustomFieldListDisplay, productCustomFieldSearchValue } from '../../src/custom-fields/listing-values.js';

test('Product list displays retain zero/false and saved labels while date arrays use the source date formatter', () => {
  assert.equal(productCustomFieldListDisplay({ displayValue: 0 },{ fieldType:'text' }),'0');
  assert.equal(productCustomFieldListDisplay({ displayValue: false },{ fieldType:'checkbox' }),'false');
  assert.equal(productCustomFieldListDisplay({ value:['A'],displayValue:'Old label' },{ fieldType:'select' }),'Old label');
  assert.equal(productCustomFieldListDisplay({ value:[0,false],displayValue:'' },{ fieldType:'text' }),'');
  assert.equal(productCustomFieldListDisplay({ value:['2026-12-31',false,'bad'],displayValue:'old' },{ fieldType:'date',dateFormat:'YYYY/MM/DD' }),'2026/12/31, false, bad');
  assert.equal(productCustomFieldListDisplay(undefined,{fieldType:'date'}),'');
});

test('Product field filters preserve literal whitespace and wildcard characters plus source numeric and boolean alternatives', () => {
  assert.deepEqual(productCustomFieldSearchValue(' 0 '),{pattern:'%0%',number:0,boolean:false});
  assert.deepEqual(productCustomFieldSearchValue('YES'),{pattern:'%YES%',number:null,boolean:true});
  assert.deepEqual(productCustomFieldSearchValue('0x10'),{pattern:'%0x10%',number:16,boolean:null});
  assert.deepEqual(productCustomFieldSearchValue('Infinity'),{pattern:'%Infinity%',number:null,boolean:null});
  assert.equal(productCustomFieldSearchValue(' a  b%_\\.* ').pattern,'%a  b\\%\\_\\\\.*%');
});
