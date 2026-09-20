import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { serviceAgreementInput, serviceAgreementRequestFingerprint } from '../../src/masters/service-agreement-input.js';
import { readServiceAgreementUpload } from '../../src/masters/service-agreement-files.js';
import { serviceAgreementFileByteLimit } from '../../src/masters/service-agreement-file-config.js';

const input = () => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, vendorId: randomUUID(), instrumentIds: [randomUUID()], startDate: '2026-01-01', endDate: '2026-12-31' });
const invalid = action => assert.throws(action, error => error.status === 400);

test('Service Agreements preserve zero, false, literal calendar bounds and validated defaults', () => {
  const raw = input(); const value = serviceAgreementInput(raw);
  assert.equal(value.noOfServices, 0); assert.equal(value.cost, '0'); assert.equal(value.inEffect, false);
  assert.equal(value.notes, null); assert.equal(value.attachmentFileId, null); assert.equal(value.includedServices, null);
  const full = serviceAgreementInput({ ...raw, startDate: '0001-01-01', endDate: '9999-12-31', noOfServices: 0, cost: '0.00', inEffect: false, notes: '  Test\nnotes  ', includedServices: [] });
  assert.equal(full.startDate, '0001-01-01'); assert.equal(full.endDate, '9999-12-31'); assert.equal(full.cost, '0.00'); assert.equal(full.notes, 'Test\nnotes');
  assert.deepEqual(full.includedServices, []); assert.equal(full.inEffect, false);
});

test('partial Agreement edits preserve omitted scalars and distinguish omitted selections from explicit clears', () => {
  const existing = { ...serviceAgreementInput(input()), revision: 1, noOfServices: 7, cost: '42.50', notes: 'Saved', inEffect: true, attachmentFileId: randomUUID(), includedServices: ['calibration'] };
  const command = { id: existing.id, revision: 1, requestId: randomUUID(), notes: '' };
  const changed = serviceAgreementInput(command, existing);
  assert.equal(changed.noOfServices, 7); assert.equal(changed.cost, '42.50'); assert.equal(changed.inEffect, true); assert.equal(changed.attachmentFileId, existing.attachmentFileId);
  assert.equal(changed.notes, ''); assert.equal(changed.instrumentIds, null); assert.equal(changed.includedServices, null);
  const clear = serviceAgreementInput({ ...command, includedServices: [], attachmentFileId: null, cost: '0', noOfServices: 0, inEffect: false }, existing);
  assert.deepEqual(clear.includedServices, []); assert.equal(clear.attachmentFileId, null); assert.equal(clear.inEffect, false);
  invalid(() => serviceAgreementInput({ ...command, instrumentIds: [] }, existing));
});

test('Agreement dates reject reversed ranges, malformed calendar values and unsupported years', () => {
  for (const day of ['', null, '0000-01-01', '10000-01-01', '2026-02-29', '2026-13-01', '2026-01-32', '2026-01-01T00:00:00Z']) invalid(() => serviceAgreementInput({ ...input(), startDate: day }));
  invalid(() => serviceAgreementInput({ ...input(), endDate: '2025-12-31' }));
  assert.equal(serviceAgreementInput({ ...input(), startDate: '2024-02-29', endDate: '2024-02-29' }).endDate, '2024-02-29');
});

test('Agreement numeric validation rejects negative fractions before rounding and noninteger counts', () => {
  for (const cost of [-1, '-0.00001', '-1e-400', NaN, Infinity, 'Infinity', '', null, true, '12suffix']) invalid(() => serviceAgreementInput({ ...input(), cost }));
  assert.equal(serviceAgreementInput({ ...input(), cost: '-0.0000' }).cost, '-0.0000');
  assert.equal(serviceAgreementInput({ ...input(), cost: '9999999999999999.99', noOfServices: 2_147_483_647 }).noOfServices, 2_147_483_647);
  for (const noOfServices of [-1, .5, 2_147_483_648, null, '1', NaN, false]) invalid(() => serviceAgreementInput({ ...input(), noOfServices }));
  for (const inEffect of [null, 0, 'false']) invalid(() => serviceAgreementInput({ ...input(), inEffect }));
});

test('Agreement selections are distinct, bounded, ordered and limited to the three actual service codes', () => {
  const ids = Array.from({ length: 501 }, () => randomUUID()); const raw = input();
  assert.deepEqual(serviceAgreementInput({ ...raw, instrumentIds: ids.slice(0, 500).map(id => id.toUpperCase()), includedServices: ['breakdown', 'calibration', 'preventivemaintenance'] }).instrumentIds, ids.slice(0, 500));
  for (const instrumentIds of [null, [], ids, [ids[0], ids[0].toUpperCase()], Array(1), [{}]]) invalid(() => serviceAgreementInput({ ...raw, instrumentIds }));
  for (const includedServices of [null, ['custom'], ['Calibration'], ['calibration', 'calibration'], Array(1), ['calibration', 'breakdown', 'preventivemaintenance', 'calibration']]) invalid(() => serviceAgreementInput({ ...raw, includedServices }));
});

test('Agreement inputs reject unsupported properties and invalid notes, identities or revision', () => {
  for (const raw of [null, [], { ...input(), customFields: [] }, { ...input(), revision: -1 }, { ...input(), attachmentFileId: '' },
    { ...input(), vendorId: null }, { ...input(), notes: 'x'.repeat(10001) }, { ...input(), notes: '\0' }, { ...input(), notes: '\ud800' }]) invalid(() => serviceAgreementInput(raw));
  assert.equal(serviceAgreementInput({ ...input(), notes: 'x'.repeat(10000) }).notes.length, 10000);
});

test('Agreement request fingerprints bind supplied intent and remain stable when omitted fields change', () => {
  const existing = { ...serviceAgreementInput(input()), revision: 1 };
  const raw = { id: existing.id, revision: 1, requestId: randomUUID(), notes: 'New notes' };
  const first = serviceAgreementRequestFingerprint(raw, serviceAgreementInput(raw, existing));
  const reordered = Object.fromEntries(Object.entries(raw).reverse());
  assert.equal(serviceAgreementRequestFingerprint(reordered, serviceAgreementInput(reordered, { ...existing, cost: '25', inEffect: true })), first);
  const clear = { ...raw, attachmentFileId: null };
  assert.notEqual(serviceAgreementRequestFingerprint(clear, serviceAgreementInput(clear, existing)), first);
});

function request(body = Buffer.from('Agreement'), changes = {}) {
  return new Request('http://localhost/api/masters/service-agreements/files', { method: 'POST', body, duplex: 'half', headers: {
    'content-type': 'text/plain; charset=utf-8', 'x-file-name': encodeURIComponent('Agreement résumé.txt'), 'x-upload-request-id': randomUUID(), ...changes,
  } });
}

test('Agreement uploads preserve encoded names and exact bytes and reject invalid metadata or empty data', async () => {
  const bytes = Buffer.from('Agreement\n\u0000literal bytes'); const result = await readServiceAgreementUpload(request(bytes));
  assert.deepEqual(result.content, bytes); assert.equal(result.originalName, 'Agreement résumé.txt'); assert.equal(result.mediaType, 'text/plain');
  for (const [body, headers, code] of [[Buffer.alloc(0), {}, 'empty_attachment'], [bytes, { 'x-file-name': '%' }, 'invalid_attachment_name'],
    [bytes, { 'content-type': 'text/html' }, 'attachment_type_not_allowed'], [bytes, { 'content-length': '-1' }, 'invalid_attachment_length'],
    [bytes, { 'content-length': String(bytes.length + 1) }, 'incomplete_attachment']]) {
    await assert.rejects(readServiceAgreementUpload(request(body, headers)), { code });
  }
});

test('Agreement uploads enforce both declared and streamed size limits and report failed streams', async () => {
  await assert.rejects(readServiceAgreementUpload(request(Buffer.from('x'), { 'content-length': String(serviceAgreementFileByteLimit + 1) })), { status: 413 });
  await assert.rejects(readServiceAgreementUpload(request(Buffer.alloc(serviceAgreementFileByteLimit + 1))), { status: 413 });
  const failed = new ReadableStream({ start(controller) { controller.error(new Error('Synthetic interrupted upload')); } });
  await assert.rejects(readServiceAgreementUpload(request(failed)), { code: 'incomplete_attachment' });
});
