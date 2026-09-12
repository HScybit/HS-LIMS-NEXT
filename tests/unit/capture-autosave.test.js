import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaptureAutosave } from '../../src/datasheets/autosave.js';

const input = (fieldId, value) => ({ fieldId, occurrenceId: 'root', state: value === '' ? 'empty' : 'present', ...(value === '' ? {} : { value }) });
const response = (revision, entry) => ({ revision, values: [{ ...entry, valueType: typeof entry.value === 'boolean' ? 'boolean' : 'text',
  ...(typeof entry.value === 'boolean' ? { booleanValue: entry.value } : { textValue: entry.value }) }] });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test('rapid edits serialize revisions and keep a newer draft over an earlier response', async () => {
  const first = deferred();
  const requests = [];
  const notifications = [];
  const autosave = createCaptureAutosave(async (instanceId, payload) => {
    requests.push({ instanceId, ...payload });
    if (requests.length === 1) await first.promise;
    return response(payload.revision + 1, payload.values[0]);
  }, (saved, pending) => notifications.push({ saved, pending }));
  autosave.reset('capture', 1, []);
  const a = autosave.commit(input('same', 'first'));
  const b = autosave.commit(input('same', 'second'));
  await Promise.resolve();
  assert.equal(requests.length, 1);
  assert.equal(autosave.snapshot().pending[0].value, 'second');
  first.resolve(); await Promise.all([a, b]); await autosave.flush();
  assert.deepEqual(requests.map((value) => value.revision), [1, 2]);
  assert.equal(notifications[0].pending[0].value, 'second');
  assert.deepEqual(autosave.snapshot().pending, []);
  assert.equal(autosave.snapshot().revision, 3);
  assert.equal(await autosave.commit(input('same', 'second')), false);
  assert.equal(requests.length, 2);
});

test('a later successful field cannot hide a failed write from flush; retry retains its value', async () => {
  let fail = true;
  const requests = [];
  const autosave = createCaptureAutosave(async (_instanceId, payload) => {
    requests.push(payload);
    if (payload.values[0].fieldId === 'first' && fail) throw new Error('Offline');
    return response(payload.revision + 1, payload.values[0]);
  });
  autosave.reset('capture', 4, []);
  const failed = autosave.commit(input('first', 'unsaved'));
  const passed = autosave.commit(input('second', false));
  await assert.rejects(failed, /Offline/); await passed;
  await assert.rejects(autosave.flush(), /Offline/);
  assert.deepEqual(autosave.snapshot().pending, [input('first', 'unsaved')]);
  fail = false; await autosave.retry();
  assert.equal(requests.at(-1).revision, 5);
  assert.equal(requests.at(-1).values[0].value, 'unsaved');
  assert.equal(autosave.snapshot().revision, 6);
  await autosave.flush();
});

test('false, empty and absent values stay distinct and stale writes remain pending', async () => {
  let fail = false;
  const autosave = createCaptureAutosave(async (_instanceId, payload) => {
    if (fail) throw Object.assign(new Error('Reload before saving'), { code: 'stale_capture' });
    return response(payload.revision + 1, payload.values[0]);
  });
  await assert.rejects(autosave.commit(input('first', false)), /not ready/);
  autosave.reset('capture', 1, [{ fieldId: 'first', occurrenceId: 'root', state: 'present', valueType: 'boolean', booleanValue: false }]);
  assert.equal(await autosave.commit(input('first', false)), false);
  assert.equal((await autosave.commit(input('first', ''))).revision, 2);
  assert.equal((await autosave.commit({ fieldId: 'first', occurrenceId: 'root', state: 'absent' })).revision, 3);
  fail = true;
  await assert.rejects(autosave.commit(input('first', 'edited')), { code: 'stale_capture' });
  await assert.rejects(autosave.flush(), { code: 'stale_capture' });
  assert.equal(autosave.snapshot().revision, 3);
  assert.equal(autosave.snapshot().pending[0].value, 'edited');
});

test('completion from a previous capture cannot notify or advance the new capture', async () => {
  const pending = deferred();
  const notifications = [];
  const autosave = createCaptureAutosave(async (_instanceId, payload) => {
    await pending.promise;
    return response(payload.revision + 1, payload.values[0]);
  }, (result) => notifications.push(result));
  autosave.reset('old', 2, []);
  const saving = autosave.commit(input('first', 'old value'));
  await Promise.resolve();
  autosave.reset('new', 9, []);
  pending.resolve(); await saving;
  assert.equal(autosave.snapshot().instanceId, 'new');
  assert.equal(autosave.snapshot().revision, 9);
  assert.deepEqual(notifications, []);
});

test('retry cannot transfer pending values into another capture while waiting for a save', async () => {
  const pending = deferred();
  const requests = [];
  const autosave = createCaptureAutosave(async (instanceId) => {
    requests.push(instanceId);
    await pending.promise;
    throw new Error('Offline');
  });
  autosave.reset('old', 1, []);
  const saving = autosave.commit(input('shared-field', 'old observation'));
  const failed = assert.rejects(saving, /Offline/);
  const retry = autosave.retry();
  autosave.reset('new', 1, []);
  pending.resolve();
  await failed; await retry;
  assert.deepEqual(requests, ['old']);
  assert.deepEqual(autosave.snapshot().pending, []);
});

test('an explicit unchanged result records one entry while its simultaneous flush shares the same write', async () => {
  const pending = deferred(); const requests = [];
  const autosave = createCaptureAutosave(async (_instanceId, payload) => {
    requests.push(payload); await pending.promise;
    return response(payload.revision + 1, payload.values[0]);
  });
  autosave.reset('capture', 1, response(1, input('result', 'Not detected')).values);
  const entry = autosave.commit(input('result', 'Not detected'), { force: true });
  const flushEntry = autosave.commit(input('result', 'Not detected'));
  assert.equal(entry, flushEntry);
  pending.resolve(); await entry; await autosave.flush();
  assert.equal(requests.length, 1); assert.equal(autosave.snapshot().revision, 2);
  assert.equal(await autosave.commit(input('result', 'Not detected')), false);
  await autosave.commit(input('result', 'Not detected'), { force: true });
  assert.equal(requests.length, 2);
});

test('retry preserves a failed explicit entry even when its value equals the stored default', async () => {
  let fail = true; let writes = 0;
  const autosave = createCaptureAutosave(async (_instanceId, payload) => {
    writes += 1; if (fail) throw new Error('Offline');
    return response(payload.revision + 1, payload.values[0]);
  });
  autosave.reset('capture', 1, response(1, input('result', '0')).values);
  const entry = autosave.commit(input('result', '0'), { force: true });
  const flushEntry = autosave.commit(input('result', '0'));
  assert.equal(entry, flushEntry);
  await assert.rejects(entry, /Offline/);
  await assert.rejects(autosave.flush(), /Offline/);
  await assert.rejects(autosave.commit(input('result', '0')), /Offline/);
  fail = false; await autosave.retry();
  assert.equal(writes, 3); assert.equal(autosave.snapshot().revision, 2);
  assert.deepEqual(autosave.snapshot().pending, []);
});

test('numeric result spelling remains stable through save and reset without another automatic entry', async () => {
  let writes = 0;
  const stored = { fieldId: 'result', occurrenceId: 'root', state: 'present', valueType: 'result', numberValue: '0.00', lexical: '000.00' };
  const autosave = createCaptureAutosave(async (_instanceId, payload) => {
    writes += 1;
    return { revision: payload.revision + 1, values: [stored] };
  });
  autosave.reset('capture', 1, [stored]);
  assert.equal(await autosave.commit(input('result', '000.00')), false);
  await autosave.commit(input('result', '000.00'), { force: true });
  assert.equal(await autosave.commit(input('result', '000.00')), false);
  autosave.reset('capture', 2, [stored]);
  assert.equal(await autosave.commit(input('result', '000.00')), false);
  assert.equal(writes, 1); assert.deepEqual(autosave.snapshot().pending, []);
});
