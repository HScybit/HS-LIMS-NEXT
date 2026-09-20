import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { nablCertificationInput, saveNablCertification, nablCatalog, listNablCertifications } from '../../src/compliance/nabl.js';
import { uploadNablFile, readNablFile, readNablUpload, nablFileByteLimit } from '../../src/compliance/nabl-files.js';
import { parseCalendarDate } from '../../src/components/ui/date-input.js';

const command = (changes = {}) => ({ id: randomUUID(), revision: 0, requestId: randomUUID(), validFrom: '2024-02-29', validTo: '2026-09-16', scopes: [], ...changes });
const scope = (changes = {}) => ({ parameterId: randomUUID(), productIds: [], methodIds: [], ...changes });
const noQuery = { query() { assert.fail('Invalid input must not query the database'); } };
const manager = { permission_codes: ['compliance.manage'] };
test('NABL calendar editing preserves literal days in every zone, including early years, without rollover', () => {
  const previousZone = process.env.TZ;
  try {
    for (const zone of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles']) {
      process.env.TZ = zone;
      for (const [iso, display] of [['0001-01-01', '01/01/0001'], ['0099-12-31', '31/12/0099'], ['2000-02-29', '29/02/2000'], ['9999-12-31', '31/12/9999']]) {
        assert.deepEqual(parseCalendarDate(iso), { iso, display }); assert.deepEqual(parseCalendarDate(display), { iso, display });
      }
      for (const value of ['1900-02-29', '2026-02-31', '31/04/2026', '0000-01-01', '10000-01-01', '29/02/', '2024-02-29T00:00:00Z', null]) assert.equal(parseCalendarDate(value), null);
    }
  } finally { if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone; }
});
test('NABL preserves finite calendar dates, ordered partial scopes and canonical identities', () => {
  const row = scope({ productIds: [randomUUID(), randomUUID()] });
  const input = command({ id: randomUUID().toUpperCase(), validFrom: '0001-01-01', validTo: '9999-12-31', scopes: [scope(), row] });
  const parsed = nablCertificationInput(input); assert.equal(parsed.id, input.id.toLowerCase()); assert.deepEqual(parsed.scopes, input.scopes);
  assert.equal(parsed.scopeFileId, null); assert.equal(parsed.validFrom, '0001-01-01');
  assert.equal(nablCertificationInput(command({ validTo: '2024-02-29' })).validTo, '2024-02-29');
  for (const invalid of ['0000-01-01', '2026-02-29', '2024-04-31', '2024-2-29', '2024-02-29T00:00:00Z', new Date(), '', null]) {
    assert.throws(() => nablCertificationInput(command({ validFrom: invalid })), { code: 'invalid_date' });
  }
  assert.throws(() => nablCertificationInput(command({ validTo: '2024-02-28' })), { code: 'invalid_date_range' });
});
test('NABL rejects unknown, duplicate and malformed scope data before any write', async () => {
  const row = scope(); const product = randomUUID();
  for (const change of [{ organizationId: randomUUID() }, { revision: -1 }, { revision: 2_147_483_647 }, { requestId: '' }, { scopes: null },
    { scopes: [row, row] }, { scopes: [scope({ productIds: [product, product.toUpperCase()] })] }, { scopes: [scope({ methodIds: null })] },
    { scopes: [scope({ accredited: true })] }, { scopes: [scope({ productIds: Array.from({ length: 501 }, randomUUID) })] },
    { scopes: Array.from({ length: 2001 }, () => scope()) }, { certificateFileId: 'foreign-purpose' }]) {
    await assert.rejects(saveNablCertification(noQuery, manager, command(change)), { status: 400 });
  }
  for (const codes of [[], ['compliance.read'], ['masters.manage']]) await assert.rejects(saveNablCertification(noQuery, { permission_codes: codes }, command()), { status: 403 });
  assert.equal(nablCertificationInput(command({ scopes: Array.from({ length: 2000 }, () => scope()) })).scopes.length, 2000);
  assert.equal(nablCertificationInput(command({ scopes: [scope({ methodIds: Array.from({ length: 500 }, randomUUID) })] })).scopes[0].methodIds.length, 500);
});
test('NABL catalog and lists bound inputs and reject SQL-shaped field names', async () => {
  for (const input of [{ kind: 'users' }, { kind: 'product' }, { kind: 'parameter', pageSize: 101 }, { kind: 'parameter', selectedIds: [null] }, { kind: 'parameter', search: '\0' }]) {
    await assert.rejects(nablCatalog(noQuery, manager, input), { status: 400 });
  }
  for (const input of [{ sort: { key: 'saved_by', dir: 'desc' } }, { sort: { key: 'validFrom', dir: 'desc; SELECT' } }, { page: 0 }, { pageSize: 101 }, { search: 'x'.repeat(501) }]) {
    await assert.rejects(listNablCertifications(noQuery, manager, input), { status: 400 });
  }
});
test('NABL files require their own authority, valid metadata and actual bounded bytes', async () => {
  const input = { requestId: randomUUID(), originalName: 'scope.txt', mediaType: 'text/plain', content: Buffer.alloc(0) };
  for (const permission_codes of [[], ['compliance.read'], ['users.manage'], ['masters.manage']]) await assert.rejects(uploadNablFile(noQuery, { permission_codes }, input), { status: 403 });
  for (const [change, code] of [[{ content: null }, 'invalid_attachment'], [{ content: Buffer.alloc(nablFileByteLimit + 1) }, 'attachment_size_limit'],
    [{ originalName: 'bad\nname' }, 'invalid_attachment_name'], [{ mediaType: 'text/bad type' }, 'invalid_attachment_type'], [{ fieldId: randomUUID() }, 'invalid_input']]) {
    await assert.rejects(uploadNablFile(noQuery, manager, { ...input, ...change }), { code });
  }
  await assert.rejects(readNablFile({ async query() { return { rows: [] }; } }, manager, randomUUID()), { status: 404 });
  await assert.rejects(readNablFile({ async query() { return { rows: [{ encodedContent: 'YQ==', byteLength: 1, sha256: '0'.repeat(64) }] }; } }, manager, randomUUID()), { code: 'attachment_unavailable' });
});
test('NABL upload streams preserve empty/full-limit content and reject truncation, overflow and read failures', async () => {
  const request = (body, headers = {}) => new Request('http://localhost/upload', { method: 'POST', body, duplex: 'half', headers: { 'x-file-name': encodeURIComponent('scope λ.txt'), 'x-upload-request-id': randomUUID(), ...headers } });
  assert.equal((await readNablUpload(request(null, { 'content-length': '0' }))).content.length, 0);
  const full = Buffer.alloc(nablFileByteLimit, 37); const result = await readNablUpload(request(full));
  assert.equal(result.originalName, 'scope λ.txt'); assert.deepEqual(result.content, full);
  await assert.rejects(readNablUpload(request('abc', { 'content-length': '4' })), { code: 'incomplete_attachment' });
  await assert.rejects(readNablUpload(request(null, { 'content-length': '-1' })), { code: 'invalid_attachment_length' });
  await assert.rejects(readNablUpload(request(null, { 'content-length': String(nablFileByteLimit + 1) })), { status: 413 });
  await assert.rejects(readNablUpload(request('a', { 'x-file-name': '%' })), { code: 'invalid_attachment_name' });
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(full); controller.enqueue(new Uint8Array([1])); }, cancel() { cancelled = true; } });
  await assert.rejects(readNablUpload(request(stream)), { status: 413 }); assert(cancelled);
  await assert.rejects(readNablUpload(request(new ReadableStream({ start(controller) { controller.error(new Error('Interrupted')); } }))), { code: 'incomplete_attachment' });
});
