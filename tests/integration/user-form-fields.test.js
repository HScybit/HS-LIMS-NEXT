import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField, retireCustomField } from '../../src/masters/custom-fields.js';
import { saveUserCustomFields } from '../../src/users/custom-fields.js';
import { uploadUserFieldAttachment } from '../../src/users/custom-field-attachments.js';
import { updateUserProfile } from '../../src/users/profiles.js';
import { updateUserAccount, updateUserFormAccount } from '../../src/users/accounts.js';
import { updateUserForm, loadUserForm } from '../../src/users/forms.js';

const owner = ownerPool(); after(async () => { await closePool(); await owner.end(); });
const work = (actor, callback, readOnly = false) => withSession(actor.token, callback, { readOnly });
const account = async options => { const person = await createAccount(owner, options); return { ...person, ...await signIn({ identifier: person.username, password: person.password }) }; };
const definition = (key, changes = {}) => ({ id: randomUUID(), requestId: randomUUID(), revision: 0, key, label: key, associatedWith: 'users', fieldType: 'text', ...changes });
const entry = (field, value) => ({ fieldId: field.id, fieldRevision: field.revision, value });
async function fixture() {
  const author = await account({ permissions: ['masters.manage'] }); const manager = await account({ organizationId: author.organizationId, permissions: ['users.manage'] });
  const person = await account({ organizationId: author.organizationId, permissions: ['users.read'] });
  const lab = randomUUID(); await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Atomic form lab')", [author.organizationId, lab]);
  return { author, manager, person, lab,
    define: input => work(author, (client, identity) => saveCustomField(client, identity, input)),
    input: (changes = {}, target = person) => ({ requestId: randomUUID(), revision: 1, profileRevision: 0, username: target.username, email: target.email,
      displayName: 'Atomic form subject', defaultRoleId: target.roleId, laboratoryId: lab, phone: 'Form contact', ...changes }),
    save: (input, target = person, actor = manager) => work(actor, (client, identity) => updateUserForm(client, identity, target.userId, input)),
    read: (target = person) => work(manager, (client, identity) => loadUserForm(client, identity, target.userId), true),
    capture: (target, fields, revision = 0) => work(manager, (client, identity) => saveUserCustomFields(client, identity, target.userId, { requestId: randomUUID(), revision, customFields: fields })) };
}
const accountOnly = input => { const { profileRevision: _revision, defaultRoleId: _role, laboratoryId: _lab, phone: _phone, ...account } = input; return account; };
const noProfile = input => ({ ...accountOnly(input), profileRevision: input.profileRevision });
async function counts(f, person = f.person) {
  return (await owner.query(`SELECT (SELECT count(*)::integer FROM user_account_commands WHERE organization_id=$1 AND user_id=$2) AS accounts,
    (SELECT count(*)::integer FROM user_profile_versions WHERE organization_id=$1 AND user_id=$2) AS profiles,
    (SELECT count(*)::integer FROM user_field_value_versions WHERE organization_id=$1 AND subject_user_id=$2) AS captures`, [f.author.organizationId, person.userId])).rows[0];
}
async function unchanged(f, operation, error) {
  const before = await f.read(); const history = await counts(f);
  const credential = (await owner.query("SELECT revision,encode(sha256(password_hash::bytea),'hex') AS digest FROM credentials WHERE user_id=$1", [f.person.userId])).rows[0];
  await assert.rejects(operation, error); assert.deepEqual(await f.read(), before); assert.deepEqual(await counts(f), history);
  assert.deepEqual((await owner.query("SELECT revision,encode(sha256(password_hash::bytea),'hex') AS digest FROM credentials WHERE user_id=$1", [f.person.userId])).rows[0], credential);
}

test('complete forms distinguish omitted, empty and populated captures and link actual immutable versions to the account receipt', async () => {
  for (const mode of ['omitted', 'empty', 'populated']) {
    const f = await fixture(); const field = mode === 'populated' ? await f.define(definition('form_value')) : null;
    const input = f.input(mode === 'omitted' ? {} : { customFieldRevision: 0, customFields: field ? [entry(field, 'raw value')] : [] });
    const saved = await f.save(input); assert.equal(saved.revision, 2); assert.equal(saved.profileRevision, 1);
    const loaded = await f.read(); assert.equal(loaded.fieldCapture.recorded, mode !== 'omitted'); assert.equal(loaded.fieldCapture.revision, mode === 'omitted' ? 0 : 1);
    assert.equal(Object.hasOwn(saved, 'customFieldRevision'), mode !== 'omitted');
    if (field) { assert.equal(loaded.fieldCapture.customFields[0].value, 'raw value'); assert.equal(loaded.fieldCapture.displayName, 'Synthetic Analyst'); assert.equal(loaded.account.displayName, input.displayName); }
    const receipt = (await owner.query(`SELECT octet_length(account.form_fingerprint) AS fingerprint_bytes,account.form_profile_revision,account.form_custom_field_revision,
      account.created_transaction_id=profile.created_transaction_id AS profile_transaction,
      capture.created_transaction_id IS NULL OR account.created_transaction_id=capture.created_transaction_id AS field_transaction
      FROM user_account_commands account JOIN user_profile_versions profile ON profile.organization_id=account.organization_id AND profile.user_id=account.user_id AND profile.revision=account.form_profile_revision
      LEFT JOIN user_field_value_versions capture ON capture.organization_id=account.organization_id AND capture.subject_user_id=account.user_id AND capture.revision=account.form_custom_field_revision
      WHERE account.organization_id=$1 AND account.request_id=$2`, [f.author.organizationId, input.requestId])).rows[0];
    assert.deepEqual(receipt, { fingerprint_bytes: 32, form_profile_revision: 1, form_custom_field_revision: mode === 'omitted' ? null : 1, profile_transaction: true, field_transaction: true });
  }
});

test('late field and identity failures roll back the full profile, capture, account, credentials and histories', async () => {
  const f = await fixture(); const field = await f.define(definition('required_unique', { isRequired: true, validateUniqueness: true }));
  const other = await createAccount(owner, { organizationId: f.author.organizationId, permissions: [] }); await f.capture(other, [entry(field, 'TAKEN')]);
  const base = f.input({ password: 'Must not be committed', customFieldRevision: 0, customFields: [entry(field, 'VALID')] });
  for (const [changes, code] of [[{ customFields: [] }, 'user_custom_fields_changed'], [{ customFields: [entry(field, '')] }, 'invalid_custom_field_value'],
    [{ customFields: [{ ...entry(field, 'VALID'), fieldRevision: 2 }] }, 'user_custom_fields_changed'],
    [{ customFields: [entry(field, 'TAKEN')] }, 'duplicate_user_custom_field'], [{ email: f.manager.email }, 'sign_in_identifier_taken']]) {
    await unchanged(f, () => f.save({ ...base, ...changes }), { code });
  }
  await withSession(f.person.token, () => {});
});

test('new full-form retries bind profile and field presence, raw contents and order while preserving later standalone changes', async () => {
  const f = await fixture(); const first = await f.define(definition('first')); const second = await f.define(definition('second'));
  const input = f.input({ customFieldRevision: 0, customFields: [entry(first, 'FIRST'), entry(second, [0, false])] });
  const saved = await f.save(input); const { customFieldRevision: _revision, customFields: _fields, ...omitted } = input;
  for (const changed of [noProfile(input), omitted, { ...input, customFields: [...input.customFields].reverse() },
    { ...input, customFields: [entry(first, 'CHANGED'), entry(second, [0, false])] }, { ...input, phone: 'Changed retry' }]) {
    await unchanged(f, () => f.save(changed), { code: 'save_request_reused' });
  }
  await work(f.manager, (client, identity) => updateUserProfile(client, identity, f.person.userId, { requestId: randomUUID(), revision: 1, phone: 'Later profile' }));
  await f.capture(f.person, [entry(first, 'LATER'), entry(second, [false])], 1);
  await work(f.manager, (client, identity) => updateUserAccount(client, identity, f.person.userId, { requestId: randomUUID(), revision: 2,
    username: f.person.username, email: f.person.email, displayName: 'Later identity' }));
  const before = await f.read(); assert.deepEqual(await f.save(input), saved); assert.deepEqual(await f.read(), before);
});

test('an omitted capture is revalidated against current uniqueness without creating a version, including inactive users and renamed or reused keys', async () => {
  const f = await fixture(); const original = definition('saved_key'); const first = await f.define(original);
  const other = await createAccount(owner, { organizationId: f.author.organizationId, permissions: [] });
  await f.capture(f.person, [entry(first, 'SAME')]); await f.capture(other, [entry(first, 'SAME')]);
  await owner.query('UPDATE memberships SET active=false WHERE organization_id=$1 AND user_id=$2', [f.author.organizationId, other.userId]);
  await f.define({ ...original, requestId: randomUUID(), revision: 1, validateUniqueness: true });
  await unchanged(f, () => f.save(f.input()), { code: 'duplicate_user_custom_field' });
  await f.define({ ...original, requestId: randomUUID(), revision: 2, key: 'renamed_key', validateUniqueness: true });
  await f.save(f.input()); assert.equal((await f.read()).fieldCapture.revision, 1);
  const replacement = await f.define(definition('saved_key', { validateUniqueness: true }));
  await unchanged(f, () => f.save(f.input({ revision: 2, profileRevision: 1 })), { code: 'duplicate_user_custom_field' });
  await work(f.author, (client, identity) => retireCustomField(client, identity, { id: replacement.id, revision: 1, requestId: randomUUID() }));
  await f.save(f.input({ revision: 2, profileRevision: 1 })); assert.equal((await f.read()).fieldCapture.revision, 1); assert.equal((await counts(f)).captures, 1);
});

test('omitted uniqueness retains scalar false and array false distinctions and detects duplicates within preserved arrays', async () => {
  for (const [raw, existing, duplicate] of [[false, 'false', false], [[false], 'false', true], [[false, false], 'different', true], [0, '0', true], [' Raw ', ' Raw ', false]]) {
    const f = await fixture(); const original = definition('raw'); const field = await f.define(original);
    const other = await createAccount(owner, { organizationId: f.author.organizationId, permissions: [] });
    await f.capture(f.person, [entry(field, raw)]); await f.capture(other, [entry(field, existing)]);
    await f.define({ ...original, requestId: randomUUID(), revision: 1, validateUniqueness: true });
    if (duplicate) await unchanged(f, () => f.save(f.input()), { code: 'duplicate_user_custom_field' }); else await f.save(f.input());
    assert.equal((await f.read()).fieldCapture.revision, 1);
  }
});

test('legacy account and profile receipts retain exact retries without fabricated form metadata or added and omitted profile parts', async () => {
  for (const withProfile of [false, true]) {
    const f = await fixture(); const input = withProfile ? f.input() : noProfile(f.input());
    await work(f.manager, async (client, identity) => {
      if (withProfile) await updateUserProfile(client, identity, f.person.userId, { requestId: input.requestId, revision: 0, phone: input.phone, defaultRoleId: input.defaultRoleId, laboratoryId: input.laboratoryId });
      await updateUserAccount(client, identity, f.person.userId, accountOnly(input));
    });
    const saved = await f.save(input); assert.equal(saved.profileRevision, withProfile ? 1 : null);
    const changed = withProfile ? noProfile(input) : { ...input, defaultRoleId: f.person.roleId, laboratoryId: f.lab, phone: 'Added on retry' };
    await unchanged(f, () => f.save(changed), { code: 'save_request_reused' });
    await unchanged(f, () => f.save({ ...input, customFieldRevision: 0, customFields: [] }), { code: 'save_request_reused' });
    const receipt = (await owner.query('SELECT form_fingerprint,form_profile_revision,form_custom_field_revision FROM user_account_commands WHERE organization_id=$1 AND request_id=$2', [f.author.organizationId, input.requestId])).rows[0];
    assert.deepEqual(receipt, { form_fingerprint: null, form_profile_revision: null, form_custom_field_revision: null });
  }
});

test('standalone account requests cannot replay a new form receipt and an older standalone profile cannot be stitched into a new form', async () => {
  const f = await fixture(); const input = f.input(); await f.save(input);
  await unchanged(f, () => work(f.manager, (client, identity) => updateUserAccount(client, identity, f.person.userId, accountOnly(input))), { code: 'save_request_reused' });
  const requestId = randomUUID(); await work(f.manager, (client, identity) => updateUserProfile(client, identity, f.person.userId, { requestId, revision: 1, phone: 'Standalone profile' }));
  await unchanged(f, () => work(f.manager, (client, identity) => updateUserFormAccount(client, identity, f.person.userId,
    { ...accountOnly(input), requestId, revision: 2 }, { fingerprint: Buffer.alloc(32, 4), profileRevision: 2, customFieldRevision: null })), { code: 'save_request_reused' });
});

test('form helpers and private receipts retain actual role and tenant boundaries', async () => {
  const f = await fixture(); const outsider = await account({ permissions: ['users.manage'] });
  await assert.rejects(f.save(f.input(), f.person, outsider), { status: 404 }); await assert.rejects(f.save(f.input(), f.person, f.person), { status: 403 });
  await work(f.person, async (client, identity) => {
    await client.query('SAVEPOINT denied'); await assert.rejects(updateUserForm(client, { ...identity, permission_codes: ['users.manage'] }, f.person.userId, f.input()), { code: 'forbidden' }); await client.query('ROLLBACK TO SAVEPOINT denied');
  });
  await work(f.manager, async (client, identity) => {
    for (const sql of ['SELECT * FROM user_account_commands', 'SELECT users_assert_saved_field_uniqueness($1,$2)']) {
      await client.query('SAVEPOINT private'); await assert.rejects(client.query(sql, sql.includes('$1') ? [identity.organization_id, f.person.userId] : []), { code: '42501' }); await client.query('ROLLBACK TO SAVEPOINT private');
    }
  });
  const grants = (await owner.query(`SELECT proname,has_function_privilege('sampleify_app',oid,'EXECUTE') AS app,
    has_function_privilege('sampleify_report_worker',oid,'EXECUTE') AS worker FROM pg_proc WHERE pronamespace='public'::regnamespace
    AND proname IN ('users_prepare_field_form','users_write_form_account','users_write_account_command','users_assert_saved_field_uniqueness')`)).rows;
  assert.equal(grants.length, 4); for (const grant of grants) { assert.equal(grant.worker, false); assert.equal(grant.app, ['users_prepare_field_form', 'users_write_form_account'].includes(grant.proname)); }
});

test('concurrent exact forms commit one set of versions and competing complete forms have one coherent winner', async () => {
  const f = await fixture(); const field = await f.define(definition('concurrent')); const input = f.input({ customFieldRevision: 0, customFields: [entry(field, 'FIRST')] });
  const exact = await Promise.all([f.save(input), f.save(input)]); assert.deepEqual(exact[0], exact[1]); assert.deepEqual(await counts(f), { accounts: 1, profiles: 1, captures: 1 });
  const result = await Promise.allSettled(['A', 'B'].map(value => f.save(f.input({ revision: 2, profileRevision: 1, customFieldRevision: 1,
    displayName: value, phone: value, customFields: [entry(field, value)] }))));
  assert.equal(result.filter(item => item.status === 'fulfilled').length, 1); assert.equal(result.find(item => item.status === 'rejected').reason.status, 409);
  const loaded = await f.read(); assert.equal(loaded.account.displayName, loaded.profile.phone); assert.equal(loaded.profile.phone, loaded.fieldCapture.customFields[0].value);
});

test('self password changes commit the complete form before revocation and exact retries preserve a fresh session', async () => {
  const f = await fixture(); const field = await f.define(definition('self')); const input = f.input({ password: 'Synthetic complete self password', customFieldRevision: 0, customFields: [entry(field, 'SELF')] }, f.manager);
  const saved = await f.save(input, f.manager); assert.equal(saved.passwordChanged, true); assert.equal(saved.customFieldRevision, 1);
  await assert.rejects(withSession(f.manager.token, () => {}), { status: 401 });
  const fresh = { ...f.manager, ...await signIn({ identifier: f.manager.username, password: input.password }) };
  assert.deepEqual(await f.save(input, fresh, fresh), saved); await withSession(fresh.token, () => {});
  const loaded = await work(fresh, (client, identity) => loadUserForm(client, identity, fresh.userId), true);
  assert.equal(loaded.account.revision, 2); assert.equal(loaded.profile.revision, 1); assert.equal(loaded.fieldCapture.revision, 1);
});

test('complete forms preserve typed selections, attachment revisions and date zones and roll back unavailable references', async () => {
  const f = await fixture(); const select = await f.define(definition('choice', { fieldType: 'select', options: [{ id: randomUUID(), key: 'A', label: 'Observed choice' }] }));
  const users = await f.define(definition('people', { fieldType: 'multi_user_select' })); const file = await f.define(definition('file', { fieldType: 'attachment' }));
  const date = await f.define(definition('day', { fieldType: 'date' }));
  const upload = await work(f.manager, (client, identity) => uploadUserFieldAttachment(client, identity, { requestId: randomUUID(), fieldId: file.id, fieldRevision: 1,
    originalName: 'Form.txt', mediaType: 'text/plain', content: Buffer.from('Actual form attachment') }));
  const input = f.input({ customFieldRevision: 0, customFieldTimeZone: 'Asia/Kolkata',
    customFields: [entry(select, 'A'), entry(users, [f.person.userId]), entry(file, upload.id), entry(date, '2026-01-31')] });
  for (const [index, value, code] of [[0, 'missing', 'invalid_user_custom_field_option'], [1, [randomUUID()], 'invalid_user_custom_field_user'], [2, randomUUID(), 'invalid_user_custom_field_attachment']]) {
    await unchanged(f, () => f.save({ ...input, customFields: input.customFields.map((field, position) => position === index ? { ...field, value } : field) }), { code });
  }
  const noZone = { ...input }; delete noZone.customFieldTimeZone;
  await unchanged(f, () => f.save(noZone), { code: 'invalid_custom_field_timezone' });
  const saved = await f.save(input); const loaded = await f.read();
  assert.equal(loaded.fieldCapture.customFields[0].items[0].optionLabel, 'Observed choice');
  assert.equal(loaded.fieldCapture.customFields[1].items[0].userName, 'Synthetic Analyst');
  assert.equal(loaded.fieldCapture.customFields[2].items[0].attachment.originalName, 'Form.txt');
  assert.equal(loaded.fieldCapture.customFields[3].timeZone, 'Asia/Kolkata'); assert.equal(loaded.fieldCapture.customFields[3].displayValue, '31/01/2026');
  await unchanged(f, () => f.save({ ...input, customFieldTimeZone: 'UTC' }), { code: 'save_request_reused' }); assert.deepEqual(await f.save(input), saved);
});

test('protected identities and stale account or profile revisions leave no partial field capture', async () => {
  const f = await fixture(); const field = await f.define(definition('rollback'));
  const input = f.input({ customFieldRevision: 0, customFields: [entry(field, 'Must roll back')] });
  const foreign = await account({ permissions: [] }); await owner.query('INSERT INTO memberships(organization_id,user_id) VALUES($1,$2)', [foreign.organizationId, f.person.userId]);
  await unchanged(f, () => f.save(input), { code: 'protected_user_identity' });
  const ownIdentity = { ...input, displayName: 'Synthetic Analyst' };
  await work(f.manager, (client, identity) => updateUserAccount(client, identity, f.person.userId,
    { requestId: randomUUID(), revision: 1, username: f.person.username, email: f.person.email, displayName: 'Synthetic Analyst' }));
  await unchanged(f, () => f.save(ownIdentity), { code: 'stale_user_account' });
  await f.save({ ...ownIdentity, revision: 2 });
  await unchanged(f, () => f.save({ ...ownIdentity, requestId: randomUUID(), revision: 3, customFieldRevision: 1 }), { code: 'stale_user_profile' });
});

test('direct form commands cannot link captures from another request, subject or earlier transaction', async () => {
  for (const kind of ['request', 'subject', 'transaction']) {
    const f = await fixture(); const input = accountOnly(f.input());
    if (kind === 'transaction') await work(f.manager, (client, identity) => saveUserCustomFields(client, identity, f.person.userId, { requestId: input.requestId, revision: 0, customFields: [] }));
    await unchanged(f, () => work(f.manager, async (client, identity) => {
      if (kind !== 'transaction') await saveUserCustomFields(client, identity, kind === 'subject' ? f.manager.userId : f.person.userId,
        { requestId: kind === 'request' ? randomUUID() : input.requestId, revision: 0, customFields: [] });
      return updateUserFormAccount(client, identity, f.person.userId, input, { fingerprint: Buffer.alloc(32, 5), profileRevision: null, customFieldRevision: 1 });
    }), { code: 'save_request_reused' });
    assert.equal((await counts(f, f.manager)).captures, 0);
  }
});

test('deferred form receipts require their linked profile and capture to remain the actual final heads', async () => {
  for (const part of ['profile', 'capture']) {
    const f = await fixture(); const input = f.input({ customFieldRevision: 0, customFields: [] });
    await unchanged(f, () => work(f.manager, async (client, identity) => {
      await updateUserForm(client, identity, f.person.userId, input);
      if (part === 'profile') await updateUserProfile(client, identity, f.person.userId, { requestId: randomUUID(), revision: 1, phone: 'Unlinked later profile' });
      else await saveUserCustomFields(client, identity, f.person.userId, { requestId: randomUUID(), revision: 1, customFields: [] });
      await client.query('SET CONSTRAINTS user_account_result_required IMMEDIATE');
    }), { code: '23514', constraint: 'user_account_request_reused' });
  }
});

function signal() { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; }
const settle = promise => promise.then(value => ({ value }), error => ({ error }));
const ready = (notice, pending) => Promise.race([notice.promise, pending.then(result => { throw result.error ?? new Error('Operation ended before reaching its synchronization point.'); })]);
async function advisoryWait(pid) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const row = (await owner.query('SELECT wait_event_type,wait_event,cardinality(pg_blocking_pids(pid)) AS blockers FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
    if (row?.wait_event_type === 'Lock' && row.wait_event === 'advisory' && row.blockers > 0) return;
    await delay(10);
  }
  throw new Error('Expected the form to wait on the real definition advisory lock.');
}
async function unlocked(f) {
  const probe = await owner.connect();
  try { await probe.query('BEGIN'); await probe.query('SELECT 1 FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT', [[f.manager.userId, f.person.userId]]);
    await probe.query('SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE NOWAIT', [f.author.organizationId]);
  } finally { await probe.query('ROLLBACK'); probe.release(); }
}

test('definition insertion completes before waiting forms take account or organization locks and stale fields leave no partial form', async () => {
  const f = await fixture(); const field = await f.define(definition('existing')); const input = f.input({ customFieldRevision: 0, customFields: [entry(field, 'VALUE')] });
  const held = signal(); const insert = signal(); const started = signal(); let writer; let form; let written; let saved;
  try {
    writer = settle(work(f.author, async (client, identity) => { await client.query("SELECT pg_advisory_xact_lock(hashtextextended('custom-field-definitions:'||$1::text,0))", [identity.organization_id]); held.resolve(); await insert.promise;
      return saveCustomField(client, identity, definition('added')); }));
    await ready(held, writer);
    form = settle(work(f.manager, async (client, identity) => { started.resolve((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid); return updateUserForm(client, identity, f.person.userId, input); }));
    await advisoryWait(await ready(started, form)); await unlocked(f); insert.resolve();
  } finally { insert.resolve(); if (writer) written = await writer; if (form) saved = await form; }
  assert.equal(written.error, undefined); assert.equal(saved.error?.code, 'user_custom_fields_changed'); assert.deepEqual(await counts(f), { accounts: 0, profiles: 0, captures: 0 });
});

test('actual permission and session loss during the early form wait reject all writes', async () => {
  for (const loss of ['permission', 'session']) {
    const f = await fixture(); const held = signal(); const release = signal(); const started = signal(); let holder; let form; let heldResult; let saved;
    try {
      holder = settle(work(f.author, async (client, identity) => { await client.query("SELECT pg_advisory_xact_lock(hashtextextended('custom-field-definitions:'||$1::text,0))", [identity.organization_id]); held.resolve(); await release.promise; }));
      await ready(held, holder);
      form = settle(work(f.manager, async (client, identity) => { started.resolve((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid); return updateUserForm(client, identity, f.person.userId, f.input()); }));
      await advisoryWait(await ready(started, form)); await unlocked(f);
      if (loss === 'permission') await owner.query('DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2', [f.author.organizationId, f.manager.roleId]);
      else await owner.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [f.manager.userId]);
    } finally { release.resolve(); if (holder) heldResult = await holder; if (form) saved = await form; }
    assert.equal(heldResult.error, undefined); assert.equal(saved.error?.code, 'forbidden'); assert.deepEqual(await counts(f), { accounts: 0, profiles: 0, captures: 0 });
  }
});
