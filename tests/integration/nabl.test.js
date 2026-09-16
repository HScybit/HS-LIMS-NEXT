import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createNablReferences, nablCommand, nablCompletenessCases, insertNablCompletenessFixture } from '../helpers/nabl.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { hashToken } from '../../src/auth/tokens.js';
import { closePool } from '../../src/db/pool.js';
import { saveMethod } from '../../src/masters/methods.js';
import { saveNablCertification, loadNablCertification, retireNablCertification, listNablCertifications, nablCatalog } from '../../src/compliance/nabl.js';
import { uploadNablFile, readNablFile, nablFileByteLimit } from '../../src/compliance/nabl-files.js';

const owner = ownerPool(); after(async () => { await closePool(); await owner.end(); });
async function account(options = {}) {
  const actor = await createAccount(owner, { permissions: ['compliance.manage'], ...options });
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}
const work = (actor, action) => withSession(actor.token, action, { csrfToken: actor.csrfToken });
const save = (actor, input) => work(actor, (client, identity) => saveNablCertification(client, identity, input));
const load = (actor, id, atRevision) => work(actor, (client, identity) => loadNablCertification(client, identity, id, atRevision === undefined ? {} : { atRevision }));
const retire = (actor, input) => work(actor, (client, identity) => retireNablCertification(client, identity, input));
const list = (actor, input = {}) => work(actor, (client, identity) => listNablCertifications(client, identity, input));
const catalog = (actor, input) => work(actor, (client, identity) => nablCatalog(client, identity, input));
const upload = (actor, input) => work(actor, (client, identity) => uploadNablFile(client, identity, input));
const read = (actor, id) => work(actor, (client, identity) => readNablFile(client, identity, id));
const fileInput = (changes = {}) => ({ requestId: randomUUID(), originalName: 'scope.txt', mediaType: 'text/plain', content: Buffer.from('Original scope bytes'), ...changes });
const scope = (refs, index = 0, changes = {}) => ({ parameterId: refs.parameters[index].id, productIds: [refs.products[0].id], methodIds: [refs.methods[1].id], ...changes });
async function privileged(actor, action) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN'); const identity = (await client.query('SELECT * FROM auth_session_context($1)', [hashToken(actor.token)])).rows[0];
    const result = await action(client, identity); await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function waitForLock(pid, failure) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (failure()) throw failure();
    if (pid() && (await owner.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid()])).rows[0]?.waiting) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Expected command to reach a database lock wait');
}

test('NABL stores ordered partial scopes and immutable observations through edits, file clearing and retirement', async () => {
  const actor = await account(); const refs = await createNablReferences(owner, actor); const originalFile = fileInput(); const file = await upload(actor, originalFile);
  const input = nablCommand({ scopeFileId: file.id, scopes: [scope(refs, 1, { productIds: [], methodIds: [] }), scope(refs, 0, { productIds: [refs.products[1].id, refs.products[0].id] })] });
  const original = await save(actor, input); assert.equal(original.revision, 1); assert.equal(original.savedBy, actor.userId); assert.equal(original.savedByName, 'Synthetic Analyst');
  assert.equal(original.validFrom, '2024-02-29'); assert.equal(original.scopes[0].accredited, false); assert.equal(original.scopes[1].accredited, true);
  assert.deepEqual(original.scopes[1].products.map(item => item.id), input.scopes[1].productIds);
  await owner.query("UPDATE products SET name='Current product',revision=revision+1 WHERE organization_id=$1 AND id=$2", [actor.organizationId, refs.products[0].id]);
  await owner.query("UPDATE test_parameters SET name='Current parameter',revision=revision+1 WHERE organization_id=$1 AND id=$2", [actor.organizationId, refs.parameters[0].id]);
  await owner.query("UPDATE users SET display_name='Current actor' WHERE id=$1", [actor.userId]);
  assert.deepEqual(await load(actor, input.id, 1), original); assert.deepEqual(await save(actor, input), original);
  const editing = await work(actor, (client, identity) => loadNablCertification(client, identity, input.id, { forEdit: true }));
  assert.equal(editing.scopes[1].parameterName, 'Current parameter'); assert.equal(editing.scopes[1].products[1].name, 'Current product');
  const updated = await save(actor, { ...input, revision: 1, requestId: randomUUID(), scopeFileId: null });
  assert.equal(updated.scopeFile, null); assert.equal(updated.scopes[1].parameterName, 'Current parameter'); assert.equal(updated.scopes[1].products[1].name, 'Current product'); assert.equal(updated.savedByName, 'Current actor');
  assert.deepEqual((await read(actor, original.scopeFile.id)).content, originalFile.content);
  const removal = { id: input.id, revision: 2, requestId: randomUUID() }; const removed = await retire(actor, removal); assert.equal(removed.operation, 'retire'); assert.equal(removed.active, false);
  await assert.rejects(load(actor, input.id), { status: 404 }); assert.equal((await list(actor)).totalCount, 0);
  assert.deepEqual(await retire(actor, removal), removed); assert.deepEqual(await save(actor, input), original);
  await assert.rejects(save(actor, { ...input, revision: 3, requestId: randomUUID() }), { status: 409 });
});

test('NABL validates product and method membership independently, permits partial/inactive references, and rejects foreign or inactive rules', async () => {
  const actor = await account(); const refs = await createNablReferences(owner, actor); const foreign = await account(); const foreignRefs = await createNablReferences(owner, foreign);
  await save(actor, nablCommand({ scopes: [scope(refs)] })); // Product A + Method B has no exact-pair rule.
  await save(actor, nablCommand({ scopes: [scope(refs, 0, { methodIds: [] }), scope(refs, 1, { productIds: [] })] }));
  await owner.query('UPDATE products SET active=false,revision=revision+1 WHERE organization_id=$1 AND id=$2', [actor.organizationId, refs.products[0].id]);
  await owner.query('UPDATE test_parameters SET active=false,revision=revision+1 WHERE organization_id=$1 AND id=$2', [actor.organizationId, refs.parameters[0].id]);
  const input = nablCommand({ scopes: [scope(refs)] }); const original = await save(actor, input);
  assert.equal((await catalog(actor, { kind: 'parameter' })).totalCount, 2);
  assert.equal((await catalog(actor, { kind: 'parameter', selectedIds: [refs.parameters[0].id] })).totalCount, 3);
  assert.equal((await catalog(actor, { kind: 'product', parameterId: refs.parameters[0].id })).totalCount, 1);
  assert.equal((await catalog(actor, { kind: 'product', parameterId: refs.parameters[0].id, selectedIds: [refs.products[0].id] })).totalCount, 2);
  await owner.query('UPDATE decision_rules SET active=false,revision=revision+1 WHERE organization_id=$1', [actor.organizationId]);
  assert.deepEqual(await save(actor, input), original);
  await assert.rejects(save(actor, nablCommand({ scopes: [scope(refs)] })), { status: 422, code: 'invalid_nabl_scope' });
  await retire(actor, { id: input.id, revision: 1, requestId: randomUUID() });
  for (const scopes of [[scope(foreignRefs)], [scope(refs, 1, { productIds: [randomUUID()] })], [scope(refs, 1, { methodIds: [foreignRefs.methods[0].id] })]]) {
    await assert.rejects(save(actor, nablCommand({ scopes })), { status: 422, code: 'invalid_reference' });
  }
  await assert.rejects(save(actor, nablCommand({ scopeFileId: randomUUID() })), { status: 422, code: 'invalid_reference' });
});

test('NABL exact requests serialize, distinguish actors and ordered content, and roll back late failures', async () => {
  const actor = await account(); const colleague = await account({ organizationId: actor.organizationId }); const refs = await createNablReferences(owner, actor);
  const input = nablCommand({ scopes: [scope(refs, 0, { productIds: refs.products.map(item => item.id) })] });
  const results = await Promise.all([save(actor, input), save(actor, input)]); assert.deepEqual(results[0], results[1]);
  await assert.rejects(save(colleague, input), { code: 'save_request_reused' });
  await assert.rejects(save(actor, { ...input, scopes: [scope(refs, 0, { productIds: [...input.scopes[0].productIds].reverse() })] }), { code: 'save_request_reused' });
  await assert.rejects(save(actor, { ...input, validTo: '2027-01-01' }), { code: 'save_request_reused' });
  const updates = await Promise.allSettled([0, 1].map(() => save(actor, { ...input, revision: 1, requestId: randomUUID() })));
  assert.equal(updates.filter(result => result.status === 'fulfilled').length, 1); assert.equal(updates.find(result => result.status === 'rejected').reason.code, 'stale_nabl_certification');
  await assert.rejects(work(actor, async (client, identity) => {
    await saveNablCertification(client, identity, { ...input, revision: 2, requestId: randomUUID() }); throw new Error('Late rollback');
  }), /Late rollback/);
  assert.equal((await load(actor, input.id)).revision, 2);
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM nabl_certificate_versions WHERE organization_id=$1', [actor.organizationId])).rows[0].count, 2);
});

test('NABL read permissions scope every view and catalog without granting unrelated master access', async () => {
  const actor = await account(); const refs = await createNablReferences(owner, actor); const input = nablCommand({ scopes: [scope(refs)] }); const saved = await save(actor, input);
  const reader = await account({ organizationId: actor.organizationId, permissions: ['compliance.read'] }); const foreign = await account(); const denied = await account({ organizationId: actor.organizationId, permissions: ['masters.manage'] });
  assert.deepEqual(await load(reader, input.id), saved); assert.equal((await catalog(reader, { kind: 'method', parameterId: refs.parameters[0].id })).totalCount, 2);
  await assert.rejects(save(reader, nablCommand()), { status: 403 }); await assert.rejects(load(denied, input.id), { status: 403 }); await assert.rejects(load(foreign, input.id), { status: 404 });
  assert.equal((await catalog(foreign, { kind: 'parameter', selectedIds: [refs.parameters[0].id] })).totalCount, 0);
  assert.equal((await list(reader, { search: '2024-02' })).totalCount, 1); assert.equal((await list(reader, { search: '%' })).totalCount, 0);
  assert.equal((await list(reader, { filters: { validFrom: { type: 'date', from: '2024-02-29', to: '2024-02-29' } } })).totalCount, 1);
  assert.equal((await list(reader, { filters: { validTo: { type: 'date', from: '2027-01-01' } } })).totalCount, 0);
  assert.equal((await list(reader, { filters: { _id: { type: 'text', value: input.id } } })).rows[0]._id, input.id);
  await assert.rejects(list(reader, { filters: { validTo: { type: 'date', from: '2026-02-29' } } }), { status: 400 });
  for (const view of ['nabl_certificate_directory', 'nabl_certificate_history', 'nabl_scope_history', 'nabl_product_history', 'nabl_method_history', 'nabl_parameter_catalog', 'nabl_product_catalog', 'nabl_method_catalog', 'nabl_rule_catalog']) {
    assert.equal((await work(denied, client => client.query(`SELECT * FROM ${view}`))).rowCount, 0);
    assert.equal((await work(foreign, client => client.query(`SELECT * FROM ${view} WHERE organization_id=$1`, [actor.organizationId]))).rowCount, 0);
  }
});

test('NABL immutable files preserve empty and 25 MiB content, exact retries and private cross-purpose boundaries', async () => {
  const actor = await account(); const reader = await account({ organizationId: actor.organizationId, permissions: ['compliance.read'] }); const colleague = await account({ organizationId: actor.organizationId }); const foreign = await account();
  for (const content of [Buffer.alloc(0), Buffer.alloc(nablFileByteLimit, 51)]) {
    const input = fileInput({ originalName: 'folder/original λ.svg', mediaType: 'IMAGE/SVG+XML', content }); const first = await upload(actor, input);
    assert.equal(first.replayed, false); assert.equal(first.originalName, 'original λ.svg'); assert.equal(first.mediaType, 'image/svg+xml'); assert.equal((await upload(actor, input)).replayed, true);
    assert.deepEqual((await read(reader, first.id)).content, content);
    await assert.rejects(upload(colleague, input), { status: 409 }); await assert.rejects(upload(actor, { ...input, originalName: 'Different' }), { status: 409 });
    await assert.rejects(read(foreign, first.id), { status: 404 }); await assert.rejects(upload(reader, input), { status: 403 });
    await assert.rejects(save(foreign, nablCommand({ scopeFileId: first.id })), { status: 422 });
    await assert.rejects(owner.query("UPDATE nabl_files SET original_name='changed' WHERE organization_id=$1 AND id=$2", [actor.organizationId, first.id]), { code: '55000' });
  }
  await assert.rejects(upload(actor, fileInput({ content: Buffer.alloc(nablFileByteLimit + 1) })), { status: 413 });
});

test('NABL SQL denies direct writes, fabricated provenance, incomplete histories and worker/public execution', async () => {
  const actor = await account(); const refs = await createNablReferences(owner, actor); const input = nablCommand({ scopes: [scope(refs)] }); await save(actor, input);
  for (const table of ['nabl_certifications', 'nabl_files', 'nabl_certificate_versions', 'nabl_scope_rows', 'nabl_scope_products', 'nabl_scope_methods']) {
    for (const query of [`INSERT INTO ${table} DEFAULT VALUES`, `DELETE FROM ${table}`, `UPDATE ${table} SET organization_id=organization_id`]) {
      await assert.rejects(work(actor, client => client.query(query)), { code: '42501' });
    }
  }
  for (const table of ['nabl_certificate_versions', 'nabl_scope_rows', 'nabl_scope_products', 'nabl_scope_methods']) {
    await assert.rejects(owner.query(`DELETE FROM ${table} WHERE organization_id=$1`, [actor.organizationId]), { code: '55000' });
  }
  await assert.rejects(privileged(actor, client => client.query('INSERT INTO nabl_certifications(organization_id,id,created_by) VALUES($1,$2,$3)', [actor.organizationId, randomUUID(), actor.userId])), { code: '23514' });
  await assert.rejects(privileged(actor, async (client, identity) => {
    const draft = nablCommand({ scopes: [scope(refs)] }); await saveNablCertification(client, identity, draft);
    await client.query("INSERT INTO nabl_scope_rows(organization_id,certification_id,revision,parameter_id,position,parameter_name,scheme_abbreviation,parameter_revision,product_count,method_count) VALUES($1,$2,1,$3,1,'Fake','Fake',1,0,0)", [actor.organizationId, draft.id, refs.parameters[1].id]);
  }), { code: '23514' });
  await assert.rejects(privileged(actor, async (client, identity) => {
    const draft = nablCommand(); await saveNablCertification(client, identity, draft);
    const parameter = refs.parameters[0];
    await client.query('INSERT INTO nabl_scope_rows(organization_id,certification_id,revision,parameter_id,position,parameter_name,scheme_abbreviation,parameter_revision,product_count,method_count) VALUES($1,$2,1,$3,0,$4,$5,1,0,0)', [actor.organizationId, draft.id, parameter.id, parameter.name, parameter.schemeAbbreviation]);
  }), { code: '23514' });
  const privileges = (await owner.query("SELECT proname,has_function_privilege('sampleify_report_worker',oid,'EXECUTE') AS worker,has_function_privilege('public',oid,'EXECUTE') AS public FROM pg_proc WHERE proname LIKE 'nabl_%' ORDER BY proname")).rows;
  assert.equal(privileges.length, 11); assert(privileges.every(row => !row.worker && !row.public));
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM nabl_certifications WHERE organization_id=$1', [actor.organizationId])).rows[0].count, 1);
});

test('NABL deferred completeness preserves per-parameter counts, zero-based order and full transaction rollback', async () => {
  const actor = await account(); const refs = await createNablReferences(owner, actor);
  for (const input of nablCompletenessCases) {
    const id = randomUUID(); const action = () => privileged(actor, client => insertNablCompletenessFixture(client, actor, refs, id, input));
    if (input.valid) await assert.doesNotReject(action, input.name);
    else await assert.rejects(action, { code: '23514', message: 'Certification history requires complete ordered scope rows' }, input.name);
    for (const table of ['nabl_certifications', 'nabl_certificate_versions']) {
      const column = table === 'nabl_certifications' ? 'id' : 'certification_id';
      const count = (await owner.query(`SELECT count(*)::integer AS count FROM ${table} WHERE organization_id=$1 AND ${column}=$2`, [actor.organizationId, id])).rows[0].count;
      assert.equal(count, input.valid ? 1 : 0, input.name);
    }
  }
});

test('NABL rechecks changed permission and session expiry after waiting on a selected method', { timeout: 15000 }, async () => {
  for (const revoke of ['permission', 'expiry']) {
    const actor = await account(); const refs = await createNablReferences(owner, actor); const blocker = await owner.connect(); let pid; let failure; let pending;
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM methods_of_analysis WHERE organization_id=$1 AND id=$2 FOR UPDATE', [actor.organizationId, refs.methods[1].id]);
      if (revoke === 'expiry') await owner.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '700 milliseconds' WHERE user_id=$1", [actor.userId]);
      pending = work(actor, async (client, identity) => { pid = (await client.query('SELECT pg_backend_pid() AS id')).rows[0].id; return saveNablCertification(client, identity, nablCommand({ scopes: [scope(refs)] })); });
      void pending.catch(error => { failure = error; }); await waitForLock(() => pid, () => failure);
      if (revoke === 'permission') await owner.query("DELETE FROM role_permissions WHERE organization_id=$1 AND role_id=$2 AND permission_code='compliance.manage'", [actor.organizationId, actor.roleId]);
      else await new Promise(resolve => setTimeout(resolve, 750));
      await blocker.query('COMMIT'); await assert.rejects(pending, { status: 403 });
      assert.equal((await owner.query('SELECT count(*)::integer AS count FROM nabl_certifications WHERE organization_id=$1', [actor.organizationId])).rows[0].count, 0);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending.catch(() => {}); }
  }
});

test('NABL shared actor observation permits actual Method access-history save and records its committed rename', { timeout: 15000 }, async () => {
  const actor = await account(); const editor = await account({ organizationId: actor.organizationId, permissions: ['masters.manage'] }); const refs = await createNablReferences(owner, actor);
  const methodInput = { id: refs.methods[1].id, revision: 1, requestId: randomUUID(), name: 'After wait', uuid: refs.methods[1].methodUuid, accessUserIds: [actor.userId] };
  let releaseEditor; const editorGate = new Promise(resolve => { releaseEditor = resolve; }); let updated; const updatedGate = new Promise(resolve => { updated = resolve; });
  let editorFailure; const editing = work(editor, async (client, identity) => {
    const query = client.query; client.query = async (...args) => {
      const result = await query.apply(client, args);
      if (typeof args[0] === 'string' && args[0].startsWith('UPDATE methods_of_analysis SET')) { updated(); await editorGate; }
      return result;
    };
    try { return await saveMethod(client, identity, methodInput); } finally { client.query = query; }
  });
  void editing.catch(error => { editorFailure = error; }); let pending; let failure; let pid;
  try {
    await Promise.race([updatedGate, editing.then(() => { throw new Error('Expected actual Method update gate'); })]);
    pending = work(actor, async (client, identity) => { pid = (await client.query('SELECT pg_backend_pid() AS id')).rows[0].id; return saveNablCertification(client, identity, nablCommand({ scopes: [scope(refs)] })); });
    void pending.catch(error => { failure = error; }); await waitForLock(() => pid, () => failure ?? editorFailure); releaseEditor();
    const [method, certification] = await Promise.all([editing, pending]); assert.equal(method.name, 'After wait'); assert.equal(certification.scopes[0].methods[0].name, 'After wait');
    assert.equal(certification.scopes[0].methods[0].revision, 2);
  } finally { releaseEditor(); await editing.catch(() => {}); if (pending) await pending.catch(() => {}); }
});
