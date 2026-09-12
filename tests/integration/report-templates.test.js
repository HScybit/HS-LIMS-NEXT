import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { ownerPool, createAccount } from '../helpers/database.js';
import { createReportTemplate } from '../helpers/reports.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { loadDefinition } from '../../src/templates/loader.js';
import { resolveCaptureVersion } from '../../src/templates/snapshots.js';
import { editTemplate, freezeTemplate, createDraft } from '../../src/templates/authoring.js';

const owner = ownerPool();
after(async () => { await closePool(); await owner.end(); });

test('report field bindings and loop flags survive runtime snapshots, draft clones and later edits in eight queries', async () => {
  const account = await createAccount(owner, { permissions: ['templates.manage', 'templates.read', 'samples.manage'] });
  const session = await signIn({ identifier: account.username, password: account.password });
  const work = (callback, options) => withSession(session.token, callback, { csrfToken: session.csrfToken, ...options });
  const template = await work(createReportTemplate);
  const versionId = await work((client, identity) => resolveCaptureVersion(client, identity, template.templateId, { kind: 'report' }));
  const original = await work((client, identity) => loadDefinition(client, identity.organization_id, versionId), { readOnly: true });
  assert.equal(original.metrics.queryCount, 8);
  assert.equal(original.model.version.status, 'frozen');
  assert.equal(Object.values(original.model.sectionsById).filter((section) => section.isParameterLoop).length, 1);
  const field = original.model.fieldsById[template.records.fields.find((field) => field.alias === 'param').id];
  await work((client, identity) => editTemplate(client, identity, template.versionId, 1, { type: 'configureField', columnId: field.columnId, widget: field.widget, alias: field.alias, sourceField: 'methodName' }));
  const historical = await work((client, identity) => loadDefinition(client, identity.organization_id, versionId), { readOnly: true });
  assert.equal(historical.model.fieldsById[field.id].sourceField, 'parameterName');
  await assert.rejects(work((client) => client.query('UPDATE template_fields SET source_field = $3 WHERE organization_id = $1 AND version_id = $2', [account.organizationId, versionId, 'methodName'])), { code: '55000' });
  await work((client, identity) => freezeTemplate(client, identity, template.versionId, 2));
  const draft = await work((client, identity) => createDraft(client, identity, versionId));
  const cloned = await work((client, identity) => loadDefinition(client, identity.organization_id, draft.versionId), { readOnly: true });
  assert.equal(cloned.model.fieldsById[field.id].sourceField, 'parameterName');
  assert.equal(cloned.records.fields.find((field) => field.widget === 'sno_widget').serialPadding, 2);
  assert.deepEqual(cloned.records.sections.map((section) => [section.id, section.isParameterLoop, section.isParameterLoopHeader]), original.records.sections.map((section) => [section.id, section.isParameterLoop, section.isParameterLoopHeader]));
});

test('invalid or foreign report bindings cannot bypass authoring or typed SQL constraints', async () => {
  const account = await createAccount(owner, { permissions: ['templates.manage', 'templates.read'] });
  const session = await signIn({ identifier: account.username, password: account.password });
  const work = (callback) => withSession(session.token, callback, { csrfToken: session.csrfToken });
  const template = await work(createReportTemplate);
  const field = template.records.fields.find((field) => field.widget === 'tr_data_widget');
  for (const sourceField of ['constructor', 'parameter.secret', false, 0, {}]) {
    await assert.rejects(work((client, identity) => editTemplate(client, identity, template.versionId, 1, { type: 'configureField', columnId: field.columnId, widget: field.widget, alias: field.alias, sourceField })), { code: 'invalid_context_field' });
  }
  await assert.rejects(work((client, identity) => editTemplate(client, identity, template.versionId, 1, { type: 'configureField', columnId: field.columnId, widget: field.widget, alias: field.alias, sourceField: 'parameterName', editable: true })), { code: 'readonly_context_widget' });
  await assert.rejects(work((client) => client.query('UPDATE template_fields SET source_field = $4 WHERE organization_id = $1 AND version_id = $2 AND id = $3', [account.organizationId, template.versionId, field.id, 'customerName'])), { code: '23514' });
  const foreign = await createAccount(owner, { permissions: ['templates.read'] });
  const foreignSession = await signIn({ identifier: foreign.username, password: foreign.password });
  await assert.rejects(withSession(foreignSession.token, (client, identity) => loadDefinition(client, identity.organization_id, template.versionId), { readOnly: true }), { status: 404 });
  assert.equal((await work((client, identity) => loadDefinition(client, identity.organization_id, template.versionId))).model.version.revision, 1);
});
