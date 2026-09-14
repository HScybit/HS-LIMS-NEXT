import test from 'node:test';
import assert from 'node:assert/strict';
import { userFormDraft, userFormPayload, userFormErrors, userReturnPath } from '../../src/users/form-model.js';
import { userSignatureFileHeaders } from '../../src/users/signatures.js';

const data = { account: { username: 'actual-login', email: 'person@example.invalid', displayName: 'Actual person', revision: 8 },
  profile: { revision: 3, phone: null, designation: 'Analyst', canManagePeople: false, businessUnitId: 'inactive-unit', defaultRoleId: 'inactive-role', laboratoryId: 'inactive-lab',
    reportingManagerId: 'inactive-manager', employeeCode: 'unrelated employee code', roles: [{ id: 'hidden-role' }] } };

test('form edits preserve hidden fields, nulls and inactive selections and keep exact optional password semantics', () => {
  const draft = userFormDraft(data); assert.equal(draft.username, 'actual-login'); assert.equal(draft.password, '');
  const value = userFormPayload({ ...draft, displayName: ' Renamed ', phone: ' +91 123 ', password: '        ' }, data, { requestId: 'request' });
  assert.deepEqual(value, { requestId: 'request', revision: 8, profileRevision: 3, username: 'actual-login', email: 'person@example.invalid', displayName: 'Renamed', password: '        ', phone: '+91 123' });
  assert.equal(Object.hasOwn(value, 'roleIds'), false); assert.equal(Object.hasOwn(value, 'employeeCode'), false);
  assert.deepEqual(userFormErrors(draft, true), {});
});

test('first profiles include required references and explicit false while creation omits the edit-only manager', () => {
  const draft = { ...userFormDraft(), username: 'new-login', email: 'new@example.invalid', displayName: 'New person', defaultRoleId: 'role', laboratoryId: 'lab', password: 'password' };
  const value = userFormPayload(draft, null, { id: 'person', requestId: 'request' });
  assert.equal(value.id, 'person'); assert.equal(value.revision, 0); assert.equal(value.defaultRoleId, 'role'); assert.equal(value.laboratoryId, 'lab');
  assert.equal(value.canManagePeople, false); assert.equal(value.phone, null); assert.equal(value.businessUnitId, null); assert.equal(Object.hasOwn(value, 'reportingManagerId'), false);
  const initial = userFormPayload(draft, { ...data, profile: { revision: 0, profile: null } }, { requestId: 'request' });
  assert.equal(initial.profileRevision, 0); assert.equal(initial.reportingManagerId, null); assert.equal(Object.hasOwn(initial, 'id'), false);
  assert.deepEqual(userFormErrors(draft, false), {});
});

test('form validation handles required fields, malformed email, short creation passwords and unchanged blank edit passwords', () => {
  const missing = userFormErrors(userFormDraft(), false);
  assert.deepEqual(Object.keys(missing).sort(), ['displayName', 'email', 'username', 'defaultRoleId', 'laboratoryId', 'password'].sort());
  for (const password of ['1234567', 'x'.repeat(201), '\ud800'.repeat(8)]) assert(userFormErrors({ ...userFormDraft(data), password }, true).password);
  assert(userFormErrors({ ...userFormDraft(data), email: 'not-an-email' }, true).email);
  assert.equal(userReturnPath('/user_management?search=abc'), '/user_management?search=abc');
  for (const path of ['//evil.invalid', '/user_management/../me', 'https://evil.invalid', '/user_management#fragment', null]) assert.equal(userReturnPath(path), '/user_management');
});

test('signature previews keep exact original file headers and sandbox images and PDFs; other types always download', () => {
  for (const mediaType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/tiff', 'application/pdf', 'text/html', 'application/octet-stream']) {
    const file = { originalName: 'Original ü " file.svg', mediaType, byteLength: 0, sha256: 'a'.repeat(64) };
    const download = userSignatureFileHeaders(file); const view = userSignatureFileHeaders(file, { view: true });
    assert.match(download['Content-Disposition'], /^attachment;/);
    assert.match(view['Content-Disposition'], mediaType.startsWith('image/') || mediaType === 'application/pdf' ? /^inline;/ : /^attachment;/);
    assert.match(view['Content-Security-Policy'], /(?:^|; )sandbox$/); assert.match(view['Content-Security-Policy'], /default-src 'none'/);
    for (const key of ['Content-Type', 'Content-Length', 'X-Attachment-SHA256', 'X-Content-Type-Options', 'Cache-Control', 'Cross-Origin-Resource-Policy']) assert.equal(view[key], download[key]);
    assert.equal(view['Content-Disposition'].replace(/^inline;/, 'attachment;'), download['Content-Disposition']);
  }
});
