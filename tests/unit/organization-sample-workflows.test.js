import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sampleWorkflowSettingsInput } from '../../src/organization-settings/sample-workflows.js';

const empty = () => ({ base: null, iqc: null, ilc: null, pt: null, amendment: null, complaint: null });

test('omitted workflow settings preserve assignments while a complete empty group clears them', () => {
  assert.equal(sampleWorkflowSettingsInput({}), null);
  assert.deepEqual(sampleWorkflowSettingsInput({ sampleWorkflows: empty() }), empty());
});

test('workflow settings preserve independent selections and normalize UUID spelling', () => {
  const values = Object.fromEntries(Object.keys(empty()).map(key => [key, randomUUID().toUpperCase()]));
  const input = { sampleWorkflows: values }; const original = structuredClone(input);
  assert.deepEqual(sampleWorkflowSettingsInput(input), Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.toLowerCase()])));
  assert.deepEqual(input, original);
});

test('workflow settings reject partial groups, unknown keys and invalid identifiers', () => {
  for (const sampleWorkflows of [undefined, null, [], false, '', {}, { base: null }, { ...empty(), extra: null },
    ...[undefined, '', false, 0, 'bad', randomUUID() + ' ', ['id']].map(base => ({ ...empty(), base }))]) {
    assert.throws(() => sampleWorkflowSettingsInput({ sampleWorkflows }), error => error.status === 400);
  }
  const inherited = Object.create({ base: null }); Object.assign(inherited, empty()); delete inherited.base;
  assert.throws(() => sampleWorkflowSettingsInput({ sampleWorkflows: inherited }), { code: 'invalid_sample_workflows' });
});
