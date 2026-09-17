import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyPassword } from '../../src/auth/passwords.js';
import { parseMasterBulkCsv } from '../../src/masters/bulk-csv.js';
import { bindUserBulkHeaders, userBulkHeaders } from '../../src/users/bulk-input.js';
import { prepareUserBulkCredential, prepareUserBulkDecoded, userBulkSourceFingerprint } from '../../src/users/bulk-credentials.js';

const key = '03'.repeat(32);
const password = 'Synthetic bulk password!';
const sheet = (rows = 1) => parseMasterBulkCsv([userBulkHeaders.join(','), ...Array.from({ length: rows }, (_, i) =>
  `Person ${i},person${i}@example.invalid,00123,person${i},Analyst,,Reader,  ${password}  ,Laboratory`)].join('\n'));

test('User headers bind the source columns and explicit native Lab without accepting unknown or credential-like headers', () => {
  const columns = bindUserBulkHeaders([...userBulkHeaders.map(header => ` ${header} `), '', ' ']);
  assert.equal(columns.length, 9); assert.deepEqual(columns.at(-1), { header: 'lab_name', columnNumber: 9, fieldName: 'laboratoryId', kind: 'master' });
  assert.equal(columns.find(column => column.kind === 'password').columnNumber, 8);
  for (const missing of ['username', 'lab_name', 'role_name', 'password', 'email', 'name']) {
    assert.throws(() => bindUserBulkHeaders(userBulkHeaders.filter(header => header !== missing)), { status: 422, code: 'missing_user_bulk_columns' });
  }
  for (const headers of [null, [], new Array(10), [...userBulkHeaders, password], [...userBulkHeaders, 'PASSWORD'], [...userBulkHeaders, 'constructor'],
    [...userBulkHeaders, 'project_field.anything'], [...userBulkHeaders, 'name'], [...userBulkHeaders, ...Array(242).fill('')]]) {
    assert.throws(() => bindUserBulkHeaders(headers), error => error.status === 400 && !error.message.includes(password));
  }
  assert.equal(bindUserBulkHeaders(userBulkHeaders.filter(header => !['phone', 'designation', 'unit_name'].includes(header))).length, 6);
});

test('User file fingerprints are keyed and separate from password fingerprints and public file digests', async () => {
  const source = Buffer.from(password); const first = userBulkSourceFingerprint(source, key);
  assert.match(first, /^[a-f0-9]{64}$/); assert.equal(userBulkSourceFingerprint(new Uint8Array(source), key), first);
  assert.notEqual(first, createHash('sha256').update(source).digest('hex'));
  assert.notEqual(first, userBulkSourceFingerprint(source, '04'.repeat(32)));
  assert.notEqual(first, userBulkSourceFingerprint(Buffer.from(password + ' '), key));
  assert.notEqual(first, (await prepareUserBulkCredential(password, undefined, key)).fingerprint);
  for (const invalid of [null, '', 'f'.repeat(63), 'F'.repeat(64)]) {
    assert.throws(() => userBulkSourceFingerprint(source, invalid), { status: 503 });
    await assert.rejects(prepareUserBulkCredential(password, undefined, invalid), { status: 503 });
  }
  for (const invalid of [password, null, Buffer.alloc(0), Buffer.alloc(16 * 1_048_576 + 1)]) assert.throws(() => userBulkSourceFingerprint(invalid, key), { status: 400 });
});

test('prepared credentials use the actual native slow password format and source trimming without persisting plaintext', async () => {
  const first = await prepareUserBulkCredential(`  ${password}  `, undefined, key);
  const second = await prepareUserBulkCredential(password, { type: 'formula', hasResult: true, formula: password }, key);
  assert.equal(first.state, 'valid'); assert.equal(first.fingerprint, second.fingerprint); assert.notEqual(first.passwordHash, second.passwordHash);
  assert.match(first.passwordHash, /^scrypt\$1\$32768\$8\$1\$/);
  assert(await verifyPassword(password, first.passwordHash)); assert.equal(await verifyPassword(`  ${password}  `, first.passwordHash), false);
  assert.equal(JSON.stringify(first).includes(password), false); assert.deepEqual(Object.keys(first).sort(), ['fingerprint', 'passwordHash', 'state']);
  const numeric = await prepareUserBulkCredential(12345678, undefined, key); assert.equal(numeric.state, 'valid'); assert(await verifyPassword('12345678', numeric.passwordHash));
  const boundary = await prepareUserBulkCredential('é'.repeat(200), undefined, key); assert.equal(boundary.state, 'valid');
  assert(await verifyPassword('é'.repeat(200), boundary.passwordHash));
});

test('missing, invalid, spreadsheet-error and uncomputed password cells remain correctable without password hashes or echoed values', async () => {
  for (const value of [undefined, null, '', '  ']) {
    const result = await prepareUserBulkCredential(value, undefined, key); assert.equal(result.state, 'missing'); assert.equal(result.passwordHash, null);
  }
  for (const [value, metadata] of [[false], [0], ['1234567'], ['x'.repeat(201)], ['\ud800abcdefg'], [NaN], [Infinity], [new Date()], [{}],
    [password, { type: 'error', errorCode: '#VALUE!' }], [password, { type: 'formula', hasResult: false }], [password, { type: 'formula' }]]) {
    const result = await prepareUserBulkCredential(value, metadata, key); assert.equal(result.state, 'invalid'); assert.equal(result.passwordHash, null);
    assert.match(result.fingerprint, /^[a-f0-9]{64}$/); assert.equal(JSON.stringify(result).includes(password), false);
  }
  assert.notEqual((await prepareUserBulkCredential('123', undefined, key)).fingerprint, (await prepareUserBulkCredential('456', undefined, key)).fingerprint);
});

test('preparation redacts password values and all their workbook provenance while preserving other literal values and caller input', async () => {
  const decoded = sheet(2); decoded.rows[0].values[2] = 0; decoded.rows[1].values[2] = false;
  decoded.rows[0].cellMetadata = [{ columnNumber: 8, type: 'formula', formula: password, hyperlink: password, numberFormat: password, hasResult: true },
    { columnNumber: 3, type: 'formatted', numberFormat: '00000' }];
  decoded.headerCellMetadata = [{ columnNumber: 8, type: 'hyperlink', hyperlink: password }, { columnNumber: 1, type: 'formatted', numberFormat: '@' }];
  const before = structuredClone(decoded); const result = await prepareUserBulkDecoded(decoded, { key });
  assert.deepEqual(decoded, before); assert.equal(JSON.stringify(result.decoded).includes(password), false);
  assert.deepEqual(result.decoded.rows.map(row => row.values[7]), ['', '']); assert.deepEqual(result.decoded.rows.map(row => row.values[2]), [0, false]);
  assert.deepEqual(result.decoded.rows.map(row => row.rowNumber), [2, 3]);
  assert.deepEqual(result.decoded.rows[0].cellMetadata, [{ columnNumber: 3, type: 'formatted', numberFormat: '00000' }]);
  assert.deepEqual(result.decoded.headerCellMetadata, [{ columnNumber: 1, type: 'formatted', numberFormat: '@' }]);
  assert(result.credentials.every(credential => credential.state === 'valid')); assert(await verifyPassword(password, result.credentials[1].passwordHash));
  const short = sheet(); short.rows[0].values.length = 4;
  const missing = await prepareUserBulkDecoded(short, { key }); assert.equal(missing.credentials[0].state, 'missing'); assert.equal(missing.decoded.rows[0].values[7], '');
});

test('preparation rejects malformed or oversized decoded shapes and unheaded values before staging', async () => {
  for (const rows of [[], new Array(1), Array(2501).fill({ values: [] }), [{ values: null }], [{ values: Array(251).fill('') }],
    [{ values: [], cellMetadata: {} }], [{ values: [], cellMetadata: [null] }], [{ values: [], cellMetadata: [{ columnNumber: 251 }] }]]) {
    await assert.rejects(prepareUserBulkDecoded({ ...sheet(), rows }, { key }), { status: 400 });
  }
  for (const value of [0, false, password]) {
    const invalid = sheet(); invalid.rows[0].values.push(value);
    await assert.rejects(prepareUserBulkDecoded(invalid, { key }), { status: 400 });
  }
  await assert.rejects(prepareUserBulkDecoded({ ...sheet(), headerCellMetadata: [null] }, { key }), { status: 400 });
});

test('concurrent User preparations stay bounded and cancellation or key failure releases the slot after the active hash finishes', async () => {
  const controller = new AbortController();
  const first = prepareUserBulkDecoded(sheet(3), { key, signal: controller.signal }); const second = prepareUserBulkDecoded(sheet(3), { key });
  const firstResult = first.then(value => ({ value }), error => ({ error }));
  await assert.rejects(prepareUserBulkDecoded(sheet(), { key }), { status: 429 }); controller.abort();
  assert.equal((await firstResult).error.code, 'incomplete_bulk_file'); assert.equal((await second).credentials.length, 3);
  await assert.rejects(prepareUserBulkDecoded(sheet(), { key: null }), { status: 503 });
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(prepareUserBulkDecoded(sheet(), { key, signal: aborted.signal }), { status: 400 });
  assert.equal((await prepareUserBulkDecoded(sheet(), { key })).credentials.length, 1);
});

test('an expired preparation deadline cannot return prepared rows or leave the preparation slot occupied', async () => {
  await assert.rejects(prepareUserBulkDecoded(sheet(2), { key, timeoutMs: 1 }), { status: 408, code: 'user_bulk_timeout' });
  for (const timeoutMs of [0, -1, 300001, Infinity, '1000']) await assert.rejects(prepareUserBulkDecoded(sheet(), { key, timeoutMs }), { status: 400 });
  assert.equal((await prepareUserBulkDecoded(sheet(), { key })).credentials.length, 1);
});
