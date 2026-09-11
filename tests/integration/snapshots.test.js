import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createAnalyticalTemplate } from '../helpers/templates.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { createTemplate, createDraft, editTemplate, freezeTemplate } from '../../src/templates/authoring.js';
import { resolveCaptureVersion } from '../../src/templates/snapshots.js';
import { loadDefinition, loadCapture } from '../../src/templates/loader.js';
import { listTemplateRows } from '../../src/templates/listing.js';
import { createCapture } from '../../src/templates/capture.js';
import { setCaptureContext } from '../../src/templates/access.js';

const owner = ownerPool();
let author; let allocator; let reader; let foreign;
before(async () => {
  const account = await createAccount(owner, { permissions: ['templates.read', 'templates.manage', 'datasheets.execute'] });
  author = await signIn({ identifier: account.username, password: account.password });
  for (const [key, permissions] of [['allocator', ['test_requests.allocate']], ['reader', ['templates.read']]]) {
    const user = await createAccount(owner, { organizationId: account.organizationId, permissions });
    const session = await signIn({ identifier: user.username, password: user.password });
    if (key === 'allocator') allocator = session; else reader = session;
  }
  const other = await createAccount(owner, { permissions: ['test_requests.allocate'] });
  foreign = await signIn({ identifier: other.username, password: other.password });
});
after(async () => { await closePool(); await owner.end(); });
const work = (session, action) => withSession(session.token, action, { csrfToken: session.csrfToken });
const fixture = () => work(author, (client, identity) => createAnalyticalTemplate(client, identity, { repeated: false }));
const load = (versionId) => work(author, (client, identity) => loadDefinition(client, identity.organization_id, versionId));

test('allocation without master editing reuses a frozen snapshot and keeps its source draft visible', async () => {
  const template = await fixture();
  const results = await Promise.all([1, 2].map(() => work(allocator, (client, identity) => resolveCaptureVersion(client, identity, template.templateId))));
  assert.equal(results[0], results[1]);
  assert.notEqual(results[0], template.versionId);
  const frozen = (await load(results[0])).model;
  assert.equal(frozen.version.status, 'frozen');
  assert.equal(frozen.version.snapshotSourceId, template.versionId);
  assert.equal(frozen.version.snapshotSourceRevision, 1);
  assert.deepEqual(Object.keys(frozen.fieldsById).sort(), template.records.fields.map((field) => field.id).sort());
  const current = await work(author, (client, identity) => loadDefinition(client, identity.organization_id, null, { templateId: template.templateId }));
  assert.equal(current.model.version.id, template.versionId);
  assert.equal(current.model.version.status, 'draft');
  assert.equal(current.model.version.revision, 1);
  await assert.rejects(work(author, (client, identity) => createDraft(client, identity, results[0])), { code: 'draft_exists' });
  await assert.rejects(work(allocator, (client, identity) => editTemplate(client, identity, template.versionId, 1, { type: 'editDetails', name: 'Denied' })), { status: 403 });
  const direct = await work(allocator, (client, identity) => client.query('UPDATE template_fields SET label = $3 WHERE organization_id = $1 AND version_id = $2', [identity.organization_id, template.versionId, 'Denied']));
  assert.equal(direct.rowCount, 0);
  await assert.rejects(work(author, (client, identity) => client.query('UPDATE template_fields SET label = $3 WHERE organization_id = $1 AND version_id = $2', [identity.organization_id, results[0], 'Denied'])), { code: '55000' });
});

test('a later source revision creates a new snapshot without changing earlier captured interpretation', async () => {
  const template = await fixture();
  const first = await work(allocator, (client, identity) => resolveCaptureVersion(client, identity, template.templateId));
  const capture = await work(author, (client, identity) => createCapture(client, identity, first));
  await work(author, (client, identity) => editTemplate(client, identity, template.versionId, 1, { type: 'editDetails', name: 'Revised source name', description: '' }));
  const second = await work(allocator, (client, identity) => resolveCaptureVersion(client, identity, template.templateId));
  assert.notEqual(first, second);
  assert.equal((await load(first)).model.version.name, 'Synthetic analytical template');
  assert.equal((await load(second)).model.version.name, 'Revised source name');
  const loaded = await work(author, (client, identity) => loadCapture(client, identity.organization_id, capture.instanceId));
  assert.equal(loaded.instance.version_id, first);
  const list = await work(author, (client, identity) => listTemplateRows(client, identity, { search: 'Revised source name' }));
  assert.equal(list.rows.find((row) => row._id === template.templateId).versionId, template.versionId);
  await assert.rejects(work(allocator, (client) => client.query('SELECT template_snapshot_from_draft($1, $2)', [template.versionId, 1])), { code: '40001' });
});

test('snapshot permissions, tenant boundaries and rollback reject unauthorized or invalid work', async () => {
  const template = await fixture();
  await assert.rejects(work(reader, (client, identity) => resolveCaptureVersion(client, identity, template.templateId)), { status: 403 });
  await assert.rejects(work(reader, (client) => client.query('SELECT template_snapshot_from_draft($1, $2)', [template.versionId, 1])), { code: '42501' });
  await assert.rejects(work(foreign, (client, identity) => resolveCaptureVersion(client, identity, template.templateId)), { status: 404 });
  await assert.rejects(work(foreign, (client) => client.query('SELECT template_snapshot_from_draft($1, $2)', [template.versionId, 1])), { code: 'P0002' });
  await assert.rejects(work(allocator, async (client, identity) => {
    await resolveCaptureVersion(client, identity, template.templateId);
    throw new Error('Abort allocation');
  }), /Abort allocation/);
  assert.equal((await owner.query('SELECT 1 FROM template_versions WHERE snapshot_source_id = $1', [template.versionId])).rowCount, 0);
  const empty = await work(author, (client, identity) => createTemplate(client, identity, { name: 'Empty', kind: 'datasheet' }));
  await assert.rejects(work(allocator, (client, identity) => resolveCaptureVersion(client, identity, empty.templateId)), { code: 'invalid_template' });
  assert.equal((await owner.query("SELECT 1 FROM template_versions WHERE status = 'building'")).rowCount, 0);
});

test('unfinished snapshots cannot commit even when inserted by the schema owner', async () => {
  const template = await fixture();
  const source = (await load(template.versionId)).model.version;
  await assert.rejects(owner.query(`INSERT INTO template_versions (organization_id, id, template_id, number, status, name, kind,
    created_by, snapshot_source_id, snapshot_source_revision) VALUES ($1,$2,$3,2,'building','Unfinished','datasheet',$4,$5,1)`,
  [source.organizationId, randomUUID(), template.templateId, source.createdBy, template.versionId]), { code: '23514' });
  assert.equal((await owner.query('SELECT 1 FROM template_versions WHERE snapshot_source_id = $1', [template.versionId])).rowCount, 0);
});

test('final-result column settings are typed, copied into snapshots and isolated from later edits', async () => {
  const template = await fixture();
  const column = template.records.columns[1];
  const command = { type: 'configureColumn', id: column.id, span: column.span, cssClass: '', isFinalResult: true };
  await assert.rejects(work(author, (client, identity) => editTemplate(client, identity, template.versionId, 1,
    { ...command, isFinalResult: 'true' })), { code: 'invalid_input' });
  await work(author, (client, identity) => editTemplate(client, identity, template.versionId, 1, command));
  const frozenId = await work(allocator, (client, identity) => resolveCaptureVersion(client, identity, template.templateId));
  assert.equal((await load(frozenId)).model.columnsById[column.id].isFinalResult, true);
  const { isFinalResult: _flag, ...layoutOnly } = command;
  await work(author, (client, identity) => editTemplate(client, identity, template.versionId, 2, layoutOnly));
  assert.equal((await load(template.versionId)).model.columnsById[column.id].isFinalResult, true);
  await work(author, (client, identity) => editTemplate(client, identity, template.versionId, 3, { ...command, isFinalResult: false }));
  assert.equal((await load(template.versionId)).model.columnsById[column.id].isFinalResult, false);
  assert.equal((await load(frozenId)).model.columnsById[column.id].isFinalResult, true);
});

test('removal cannot rewrite the historical position of a captured repeat', async () => {
  const template = await work(author, (client, identity) => createAnalyticalTemplate(client, identity));
  await work(author, (client, identity) => freezeTemplate(client, identity, template.versionId, 1));
  const capture = await work(author, (client, identity) => createCapture(client, identity, template.versionId));
  const loaded = await work(author, (client, identity) => loadCapture(client, identity.organization_id, capture.instanceId));
  const occurrence = loaded.occurrences.find((row) => row.groupId);
  await assert.rejects(work(author, async (client, identity) => {
    await setCaptureContext(client, capture.instanceId);
    await client.query('UPDATE template_instances SET revision = 2 WHERE organization_id=$1 AND id=$2', [identity.organization_id, capture.instanceId]);
    await client.query('UPDATE template_occurrences SET position = position + 10, removed_revision = 2 WHERE organization_id=$1 AND instance_id=$2 AND id=$3', [identity.organization_id, capture.instanceId, occurrence.id]);
  }), { code: '55000' });
  const prior = await work(author, (client, identity) => loadCapture(client, identity.organization_id, capture.instanceId));
  assert.equal(prior.revision, 1);
  assert.equal(prior.occurrences.find((row) => row.id === occurrence.id).position, occurrence.position);
});
