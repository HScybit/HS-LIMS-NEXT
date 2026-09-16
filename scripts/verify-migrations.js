import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createAccount } from '../tests/helpers/database.js';
import { signIn, withSession } from '../src/auth/service.js';
import { startMfaSetup, verifyMfaSetup, disableMfa, loadMfaStatus } from '../src/auth/mfa.js';
import { totpAt } from '../src/auth/totp.js';
import { closePool, getPool } from '../src/db/pool.js';
import { createAnalyticalTemplate } from '../tests/helpers/templates.js';
import { addImageWidget, createImageTemplate } from '../tests/helpers/template-image-fixture.js';
import { animatedPng } from '../tests/helpers/template-images.js';
import { uploadTemplateImage } from '../src/template-assets/service.js';
import { freezeTemplate, editTemplate } from '../src/templates/authoring.js';
import { createCapture, saveCapture } from '../src/templates/capture.js';
import { parameterDetailPayload } from '../src/templates/parameter-detail.js';
import { loadCapture, loadDefinition } from '../src/templates/loader.js';
import { createLaboratoryFixture } from '../tests/helpers/laboratory.js';
import { createNablReferences, nablCommand } from '../tests/helpers/nabl.js';
import { saveNablCertification, loadNablCertification, retireNablCertification, nablCatalog } from '../src/compliance/nabl.js';
import { uploadNablFile, readNablFile } from '../src/compliance/nabl-files.js';
import { quickCreateCustomer } from '../src/samples/customer.js';
import { registerSample } from '../src/samples/register.js';
import { loadSample } from '../src/samples/load.js';
import { generateTestRequests } from '../src/test-requests/generate.js';
import { allocateTestRequest } from '../src/test-requests/allocate.js';
import { prepareReportFlow } from '../tests/helpers/report-flow.js';
import { prepareParameterTitleRegistration } from '../tests/helpers/parameter-title-fields.js';
import { addProductWidgets } from '../tests/helpers/product-context.js';
import { addSampleLineWidgets } from '../tests/helpers/sample-lines.js';
import { prepareSubjectJob } from '../tests/helpers/job-subjects.js';
import { createReportTemplate } from '../tests/helpers/reports.js';
import { createReportAssets } from '../tests/helpers/report-assets.js';
import { deleteReportDocument, saveReportDocument } from '../src/report-assets/documents.js';
import { uploadReportImage } from '../src/report-assets/images.js';
import { saveWatermark, loadWatermark, deleteWatermark } from '../src/report-assets/watermarks.js';
import { loadCustomCss, saveCustomCss, loadCurrentCustomCss } from '../src/report-assets/custom-css.js';
import { reportSvg } from '../tests/helpers/report-svg.js';
import { emptyUncertaintyGrid, updateUncertaintyGrid } from '../src/masters/parameter-grid.js';
import { loadTestParameter, saveTestParameter, retireTestParameter, listTestParameters } from '../src/masters/test-parameters.js';
import { generateParameterCustomFields } from '../src/masters/parameter-custom-field-generation.js';
import { loadMethod, saveMethod, retireMethod, listMethods } from '../src/masters/methods.js';
import { saveBusinessUnit, loadBusinessUnit, listBusinessUnits } from '../src/masters/business-units.js';
import { saveLaboratory, loadLaboratory, retireLaboratory, listLaboratories } from '../src/masters/laboratories.js';
import { loadMaterialCategory, saveMaterialCategory, retireMaterialCategory, listMaterialCategories } from '../src/masters/material-categories.js';
import { createMaterialTransaction, loadMaterial, retireMaterial, saveMaterial } from '../src/materials/service.js';
import { listMaterials, listMaterialTransactions } from '../src/materials/listing.js';
import { loadProduct, saveProduct, retireProduct, listProducts } from '../src/masters/products.js';
import { loadCustomField, saveCustomField, retireCustomField, listCustomFields } from '../src/masters/custom-fields.js';
import { uploadCustomFieldAttachment, readCustomFieldAttachment } from '../src/custom-fields/attachments.js';
import { createProductFieldFixture } from '../tests/helpers/product-field-fixtures.js';
import { generateProductCustomFields } from '../src/masters/product-custom-field-generation.js';
import { createTestRequestJobs } from '../src/test-requests/jobs.js';
import { loadDatasheet } from '../src/datasheets/service.js';
import { loadWorkflowRun } from '../src/workflows/load.js';
import { createWorkflow, saveWorkflowState, saveWorkflowTransition, publishWorkflow, cloneWorkflowDraft } from '../src/workflows/authoring.js';
import { loadWorkflowDefinition } from '../src/workflows/definition.js';
import { loadWorkflowMaster, updateWorkflowMaster, retireWorkflowMaster } from '../src/workflows/metadata.js';
import { cloneWorkflowMaster } from '../src/workflows/master-clone.js';
import { submitDatasheetTransition } from '../src/workflows/requests.js';
import { generateReports, loadReport } from '../src/reports/service.js';
import { enqueueReportPdf, reportPdfFile } from '../src/reports/jobs.js';
import { loadReportRenderer } from '../src/reports/renderer.js';
import { createReportWorkerPool, verifyReportWorkerRole, processNextReportJob } from '../src/reports/worker.js';
import { createRole, updateRole, retireRole, loadRole, listRoles, loadRoleSettings } from '../src/roles/service.js';
import { loadLaboratorySettings, saveLaboratorySettings } from '../src/organization-settings/service.js';
import { emptyModuleAccess, moduleAccessValues } from '../tests/helpers/module-access.js';
import { loadModuleAccess } from '../src/organization-settings/module-access.js';
import { createChecklist, updateChecklist, retireChecklist, loadChecklist, listChecklists } from '../src/checklists/service.js';

process.loadEnvFile('.env.worker.local');

const ownerUrl = new URL(process.env.MIGRATION_DATABASE_URL);
const appUrl = new URL(process.env.DATABASE_URL);
const workerUrl = new URL(process.env.WORKER_DATABASE_URL);
for (const [url, username] of [[ownerUrl, 'sampleify_owner'], [appUrl, 'sampleify_app'], [workerUrl, 'sampleify_report_worker']]) {
  if (url.hostname !== '127.0.0.1' || url.port !== '55442' || url.pathname !== '/sampleify_local' || url.username !== username) {
    throw new Error('Migration verification requires the dedicated local synthetic database roles.');
  }
}

// A new database exercises every migration from an empty schema. Keep it for inspection;
// neither existing data nor previously applied migrations are reset or removed.
const databaseName = `sampleify_verify_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Client({ connectionString: ownerUrl.href });
let owner; let worker;
try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  console.log(`Verifying fresh isolated database: ${databaseName}`);
  ownerUrl.pathname = `/${databaseName}`;
  appUrl.pathname = `/${databaseName}`;
  workerUrl.pathname = `/${databaseName}`;
  process.env.DATABASE_URL = appUrl.href;
  owner = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
  const client = await owner.connect();
  try {
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: './drizzle' });
    await migrate(db, { migrationsFolder: './drizzle' }); // Reapplying must be a no-op.
  } finally { client.release(); }
  const expected = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8')).entries.length;
  const count = Number((await owner.query('SELECT count(*) FROM drizzle.__drizzle_migrations')).rows[0].count);
  assert.equal(count, expected);
  assert.equal((await owner.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND data_type IN ('json', 'jsonb')")).rowCount, 0);
  const role = (await getPool().query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  assert.equal((await getPool().query('SELECT * FROM templates')).rowCount, 0);
  const account = await createAccount(owner, { permissions: ['templates.read', 'templates.manage', 'datasheets.execute', 'samples.read', 'samples.create', 'samples.manage', 'test_requests.allocate', 'settings.manage', 'report_settings.manage', 'masters.manage', 'roles.manage', 'workflows.manage', 'checklists.manage'] });
  const session = await signIn({ identifier: account.username, password: account.password });
  await withSession(session.token, async (client, identity) => {
    const input = { id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Fresh checklist', isActive: false,
      items: [{ id: randomUUID(), prompt: '0' }, { id: randomUUID(), prompt: 'Verify results' }] };
    const created = await createChecklist(client, identity, input);
    const first = await loadChecklist(client, identity, input.id, { atRevision: 1 });
    assert.equal(first.savedBy, account.userId); assert.equal(first.isActive, false);
    assert.deepEqual(first.items, input.items.map((item, displayOrder) => ({ ...item, displayOrder })));
    await updateChecklist(client, identity, { id: input.id, requestId: randomUUID(), revision: 1, isActive: true });
    assert.deepEqual((await loadChecklist(client, identity, input.id)).items, first.items);
    assert.deepEqual(await loadChecklist(client, identity, input.id, { atRevision: 1 }), first);
    await retireChecklist(client, identity, { id: input.id, requestId: randomUUID(), revision: 2 });
    assert.deepEqual(await createChecklist(client, identity, input), created);
    assert.equal((await listChecklists(client, identity, { search: 'Fresh checklist' })).totalCount, 0);
    await assert.rejects(loadChecklist(client, identity, input.id), { code: 'checklist_not_found' });
  }, { csrfToken: session.csrfToken });
  await withSession(session.token, async (client, identity) => {
    const checklist = { id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Fresh workflow checklist binding', isActive: true,
      items: [{ id: randomUUID(), prompt: 'Verify frozen checklist' }, { id: randomUUID(), prompt: '0' }] };
    await createChecklist(client, identity, checklist);
    const workflow = await createWorkflow(client, identity, { code: randomUUID(), name: 'Fresh workflow layout', appliesTo: 'sample' });
    const initialInput = { code: 'initial', name: 'Initial', stateType: 'initial', canvasX: 0, canvasY: 0, inputCount: 0, outputCount: 8, badgeStyle: 'dark', legacyTrState: 'allocated' };
    const initial = await saveWorkflowState(client, identity, workflow.versionId, 1, initialInput);
    const final = await saveWorkflowState(client, identity, workflow.versionId, initial.revision,
      { code: 'final', name: 'Final', stateType: 'final', inputCount: 8, outputCount: 0, canvasX: 100000, canvasY: 100000, legacyTrState: 'approved' });
    const edge = await saveWorkflowTransition(client, identity, workflow.versionId, final.revision,
      { code: 'finish', name: 'Finish', sourceStateId: initial.id, targetStateId: final.id, sourcePort: 8, targetPort: 8, checklistMasterId: checklist.id,
        autoMoveMode: 'all_trs_approved', autoExecute: true });
    await publishWorkflow(client, identity, workflow.versionId, edge.revision, 'Fresh layout publication');
    const original = await loadWorkflowDefinition(client, identity, workflow.versionId);
    assert.deepEqual(original.states.map((state) => state.legacyTrState), ['allocated', 'approved']);
    assert.equal(original.transitions[0].checklistMasterId, checklist.id); assert.equal(original.transitions[0].checklistMasterRevision, 1);
    assert.equal(original.transitions[0].autoMoveMode, 'all_trs_approved'); assert.equal(original.transitions[0].autoExecute, false);
    await updateChecklist(client, identity, { id: checklist.id, requestId: randomUUID(), revision: 1, isActive: false });
    const copy = await cloneWorkflowDraft(client, identity, workflow.versionId);
    const cloned = await loadWorkflowDefinition(client, identity, copy.versionId);
    const first = cloned.states.find((state) => state.code === 'initial');
    assert.equal(first.canvasX, 0); assert.equal(first.inputCount, 0); assert.equal(first.badgeStyle, 'dark');
    assert.equal(cloned.transitions[0].sourcePort, 8); assert.equal(cloned.transitions[0].targetPort, 8);
    assert.equal(cloned.transitions[0].checklistMasterRevision, 1); assert.equal(cloned.transitions[0].checklist[0].prompt, checklist.items[0].prompt);
    assert.equal(cloned.transitions[0].autoMoveMode, 'all_trs_approved'); assert.equal(cloned.transitions[0].autoExecute, false);
    await saveWorkflowState(client, identity, copy.versionId, 1, { ...initialInput, outputCount: 1 }, first.id);
    assert.equal((await loadWorkflowDefinition(client, identity, copy.versionId)).transitions.length, 0);
    assert.deepEqual(await loadWorkflowDefinition(client, identity, workflow.versionId), original);
    const cloneInput = { id: randomUUID(), requestId: randomUUID(), sourceVersionId: workflow.versionId };
    const masterCopy = await cloneWorkflowMaster(client, identity, workflow.workflowId, cloneInput);
    assert.equal(masterCopy.metadataRevision, 1); assert.equal(masterCopy.revision, 2);
    const masterGraph = await loadWorkflowDefinition(client, identity, masterCopy.versionId);
    assert.deepEqual(masterGraph.states.map((state) => state.legacyTrState), ['allocated', 'approved']);
    assert.equal(masterGraph.states.length, original.states.length); assert.equal(masterGraph.transitions[0].sourcePort, 8);
    assert.equal(masterGraph.transitions[0].checklistMasterId, checklist.id); assert.equal(masterGraph.transitions[0].checklistMasterRevision, 1);
    assert.equal(masterGraph.transitions[0].autoMoveMode, 'all_trs_approved'); assert.equal(masterGraph.transitions[0].autoExecute, false);
    assert.notEqual(masterGraph.states[0].id, original.states[0].id);
    assert.equal((await client.query('SELECT source_version_id FROM workflow_clone_origins WHERE organization_id=$1 AND workflow_id=$2',
      [identity.organization_id, masterCopy.workflowId])).rows[0].source_version_id, workflow.versionId);
    const metadata = await loadWorkflowMaster(client, identity, workflow.workflowId);
    assert.equal(metadata.metadataRevision, 1); assert.equal(metadata.createdBy, identity.user_id);
    const input = { id: workflow.workflowId, requestId: randomUUID(), metadataRevision: 1, name: 'Fresh workflow metadata edit' };
    const changed = await updateWorkflowMaster(client, identity, input);
    assert.deepEqual(await updateWorkflowMaster(client, identity, input), changed);
    assert.equal((await loadWorkflowMaster(client, identity, workflow.workflowId, { atRevision: 1 })).name, 'Fresh workflow layout');
    await retireWorkflowMaster(client, identity, { id: workflow.workflowId, requestId: randomUUID(), metadataRevision: changed.metadataRevision });
    await assert.rejects(loadWorkflowMaster(client, identity, workflow.workflowId), { code: 'workflow_not_found' });
    assert.deepEqual(await cloneWorkflowMaster(client, identity, workflow.workflowId, cloneInput), masterCopy);
  }, { csrfToken: session.csrfToken });
  await withSession(session.token, async (client, identity) => {
    const command = { id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Fresh role history', description: '0',
      defaultPath: '/samples', permissionCodes: ['templates.read'], capabilityKeys: ['can_self_allocate', 'can_create_sample'] };
    assert.equal((await createRole(client, identity, command)).revision, 1);
    assert.equal((await createRole(client, identity, command)).revision, 1);
    const original = await loadRole(client, identity, command.id, { atRevision: 1 });
    assert.equal(original.savedBy, account.userId);
    await updateRole(client, identity, { id: command.id, requestId: randomUUID(), revision: 1, name: 'Fresh edited role' });
    assert.deepEqual((await loadRole(client, identity, command.id)).permissionCodes, command.permissionCodes);
    const removal = { id: command.id, requestId: randomUUID(), revision: 2 };
    assert.equal((await retireRole(client, identity, removal)).revision, 3);
    assert.equal((await retireRole(client, identity, removal)).revision, 3);
    assert.deepEqual(await loadRole(client, identity, command.id, { atRevision: 1 }), original);
    assert.equal((await listRoles(client, identity, { search: 'Fresh edited role' })).totalCount, 0);
    assert.equal((await loadRoleSettings(client, identity)).selfAllocationEnabled, false);
    const instrumentServiceTypes = [{ id: randomUUID(), serviceCode: 'CAL-1', displayLabel: 'Calibration', isActive: true },
      { id: randomUUID(), serviceCode: 'PM_1', displayLabel: 'Maintenance', isActive: false }];
    assert.equal((await client.query("SELECT organization_has_module_access('customer') AS allowed")).rows[0].allowed, false);
    const customerWriteId = randomUUID();
    const customerWriteSql = "INSERT INTO customers(organization_id,id,code,name,legal_name) VALUES($1,$2::uuid,$2::text,'Fresh Customer write','Synthetic legal name') RETURNING id";
    await client.query('SAVEPOINT customer_write_denied');
    await assert.rejects(client.query(customerWriteSql, [identity.organization_id, customerWriteId]), { code: '42501', constraint: 'organization_module_access_required' });
    await client.query('ROLLBACK TO SAVEPOINT customer_write_denied'); await client.query('RELEASE SAVEPOINT customer_write_denied');
    const moduleAccess = emptyModuleAccess(); moduleAccess[0] = { moduleKey: 'customer', enabled: true, roleIds: [account.roleId], userIds: [account.userId] };
    await saveLaboratorySettings(client, identity, { revision: 0, autoCreateJobs: false, resultSummaryTemplateId: null, jobWorkflowId: null, selfAllocationEnabled: true,
      dateFormat: 'Do MMMM YYYY', datetimeFormat: 'MMMM Do YYYY | hh:mm A', instrumentServiceTypes, moduleAccess });
    const settings = (await loadLaboratorySettings(client, identity)).settings;
    assert.equal(settings.dateFormat, 'Do MMMM YYYY'); assert.equal(settings.datetimeFormat, 'MMMM Do YYYY | hh:mm A');
    assert.equal(settings.updatedBy, account.userId);
    assert.deepEqual(settings.instrumentServiceTypes, instrumentServiceTypes);
    assert.deepEqual(moduleAccessValues(settings.moduleAccess), moduleAccess);
    assert.equal((await client.query("SELECT organization_has_module_access('customer') AS customer,organization_has_module_access('vendor') AS vendor")).rows[0].customer, true);
    await client.query('SAVEPOINT customer_write_allowed');
    assert.equal((await client.query(customerWriteSql, [identity.organization_id, customerWriteId])).rows[0].id, customerWriteId);
    assert.equal((await client.query('UPDATE customers SET revision=revision+1 WHERE organization_id=$1 AND id=$2 RETURNING id', [identity.organization_id, customerWriteId])).rowCount, 1);
    assert.equal((await client.query('DELETE FROM customers WHERE organization_id=$1 AND id=$2 RETURNING id', [identity.organization_id, customerWriteId])).rowCount, 1);
    await client.query('ROLLBACK TO SAVEPOINT customer_write_allowed'); await client.query('RELEASE SAVEPOINT customer_write_allowed');
    await client.query('SAVEPOINT customer_scope_denied');
    await assert.rejects(client.query(`INSERT INTO customers(organization_id,id,code,name,legal_name)
      SELECT CASE WHEN position=1 THEN $1::uuid ELSE set_config('app.organization_id',$2,true)::uuid END,
        gen_random_uuid(),$3||'-'||position,'Fresh mixed-scope Customer','Synthetic legal name'
      FROM generate_series(1,2) selected(position)`, [identity.organization_id, randomUUID(), randomUUID()]), { code: '42501' });
    await client.query('ROLLBACK TO SAVEPOINT customer_scope_denied'); await client.query('RELEASE SAVEPOINT customer_scope_denied');
    const moduleHistory = await loadModuleAccess(client, identity, { atRevision: 1 });
    assert.equal(moduleHistory.savedBy, account.userId); assert.deepEqual(moduleAccessValues(moduleHistory.modules), moduleAccess);
    const serviceVersion = (await client.query('SELECT row_count,saved_by FROM organization_instrument_service_versions WHERE organization_id=$1 AND revision=1', [identity.organization_id])).rows[0];
    assert.deepEqual(serviceVersion, { row_count: 2, saved_by: account.userId });
    assert.equal((await loadRoleSettings(client, identity)).selfAllocationEnabled, true);
  }, { csrfToken: session.csrfToken });
  // Enrollment must work from an empty schema using only the restricted app role.
  const unitAccount = await createAccount(owner, { permissions: ['users.manage'] });
  const unitSession = await signIn({ identifier: unitAccount.username, password: unitAccount.password });
  await withSession(unitSession.token, async (client, identity) => {
    const input = { id: randomUUID(), requestId: randomUUID(), revision: 0, code: 'FRESH-UNIT', name: 'Fresh unit', description: null, active: true };
    const created = await saveBusinessUnit(client, identity, input);
    assert.equal(created.savedBy, unitAccount.userId);
    await saveBusinessUnit(client, identity, { ...input, requestId: randomUUID(), revision: 1, active: false });
    assert.deepEqual(await saveBusinessUnit(client, identity, input), created);
    assert.equal((await loadBusinessUnit(client, identity, input.id)).active, false);
    assert.equal((await listBusinessUnits(client, identity, {})).totalCount, 1);
    const labInput = { id: randomUUID(), requestId: randomUUID(), revision: 0, code: 'FRESH-LAB', name: 'Fresh authored Lab',
      headUserId: unitAccount.userId, delegateUserId: unitAccount.userId, minimumTemperature: '0', maximumTemperature: '30C', minimumHumidity: ' ', maximumHumidity: 'Infinity' };
    const lab = await saveLaboratory(client, identity, labInput);
    assert.equal(lab.savedBy, unitAccount.userId); assert.equal(lab.minimumHumidity, ' ');
    await saveLaboratory(client, identity, { ...labInput, revision: 1, requestId: randomUUID(), name: 'Renamed fresh Lab' });
    const removal = { id: lab.id, revision: 2, requestId: randomUUID() }; const removed = await retireLaboratory(client, identity, removal);
    assert.equal(removed.active, false); assert.equal(removed.operation, 'retire'); assert.deepEqual(await retireLaboratory(client, identity, removal), removed);
    assert.deepEqual(await saveLaboratory(client, identity, labInput), lab); assert.deepEqual(await loadLaboratory(client, identity, lab.id, { atRevision: 1 }), lab);
    assert.equal((await listLaboratories(client, identity, {})).totalCount, 1);
  }, { csrfToken: unitSession.csrfToken });
  const nablAccount = await createAccount(owner, { permissions: ['compliance.manage'] });
  const nablSession = await signIn({ identifier: nablAccount.username, password: nablAccount.password });
  const nablReferences = await createNablReferences(owner, nablAccount);
  await withSession(nablSession.token, async (client, identity) => {
    const fileInput = { requestId: randomUUID(), originalName: 'Fresh NABL scope.txt', mediaType: 'text/plain', content: Buffer.from('Fresh immutable scope') };
    const file = await uploadNablFile(client, identity, fileInput); assert.equal((await uploadNablFile(client, identity, fileInput)).replayed, true);
    const input = nablCommand({ scopeFileId: file.id, scopes: [{ parameterId: nablReferences.parameters[0].id, productIds: [nablReferences.products[0].id], methodIds: [nablReferences.methods[1].id] }] });
    const saved = await saveNablCertification(client, identity, input); assert.equal(saved.scopes[0].accredited, true);
    assert.equal((await nablCatalog(client, identity, { kind: 'parameter' })).totalCount, 3);
    await saveNablCertification(client, identity, { ...input, revision: 1, requestId: randomUUID(), scopeFileId: null, scopes: [] });
    const removal = { id: input.id, revision: 2, requestId: randomUUID() }; const retired = await retireNablCertification(client, identity, removal);
    assert.deepEqual(await retireNablCertification(client, identity, removal), retired); assert.deepEqual(await saveNablCertification(client, identity, input), saved);
    assert.deepEqual(await loadNablCertification(client, identity, input.id, { atRevision: 1 }), saved);
    assert.deepEqual((await readNablFile(client, identity, file.id)).content, fileInput.content);
  }, { csrfToken: nablSession.csrfToken });
  const mfaSetup = await withSession(session.token, startMfaSetup, { csrfToken: session.csrfToken, accountAction: true });
  const mfaInput = { setupId: mfaSetup.setupId, code: totpAt(mfaSetup.secret, Date.now()) };
  const mfaResult = await withSession(session.token, (client, identity) => verifyMfaSetup(client, identity, mfaInput), { csrfToken: session.csrfToken, accountAction: true });
  if (mfaResult.error) throw mfaResult.error;
  assert.deepEqual(mfaResult, { enabled: true, revision: 1 });
  assert.deepEqual(await withSession(session.token, (client, identity) => verifyMfaSetup(client, identity, mfaInput), { csrfToken: session.csrfToken, accountAction: true }), mfaResult);
  const mfaRemoval = { revision: 1, requestId: randomUUID() };
  await withSession(session.token, (client) => disableMfa(client, mfaRemoval), { csrfToken: session.csrfToken, accountAction: true });
  assert.deepEqual(await withSession(session.token, loadMfaStatus, { readOnly: true, accountAction: true }), { enabled: false, revision: 2 });
  await withSession(session.token, async (client, identity) => {
    const template = await createAnalyticalTemplate(client, identity);
    const added = await editTemplate(client, identity, template.versionId, 1, { type: 'addColumn', rowId: template.records.rows[0].id });
    const configured = await editTemplate(client, identity, template.versionId, added.model.version.revision, { type: 'configureField',
      columnId: added.model.rowsById[template.records.rows[0].id].columnIds.at(-1), widget: 'tr_data_widget', alias: 'tr_context',
      sourceField: 'requestNumber', label: 'Request context', required: true, defaultValue: 'Do not capture configuration' });
    const field = Object.values(configured.model.fieldsById).find((field) => field.alias === 'tr_context');
    await freezeTemplate(client, identity, template.versionId, configured.model.version.revision);
    const capture = await createCapture(client, identity, template.versionId);
    const definition = await loadDefinition(client, identity.organization_id, template.versionId);
    const loaded = await loadCapture(client, identity.organization_id, capture.instanceId);
    assert.equal(definition.model.version.status, 'frozen');
    assert.equal(loaded.instance.version_id, template.versionId);
    assert.equal(loaded.occurrences.length, 3);
    assert(!loaded.values.some((value) => value.fieldId === field.id));
  }, { csrfToken: session.csrfToken });
  await withSession(session.token, async (client, identity) => {
    const input = { id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Fresh material category', description: 'Reference materials', reusable: true, expirable: false };
    const created = await saveMaterialCategory(client, identity, input);
    assert.equal(created.createdBy, account.userId); assert.equal(created.revision, 1);
    assert.equal((await saveMaterialCategory(client, identity, input)).revision, 1);
    await saveMaterialCategory(client, identity, { ...input, requestId: randomUUID(), revision: 1, reusable: false, expirable: true });
    const historical = await loadMaterialCategory(client, identity, input.id, { atRevision: 1 });
    assert.equal(historical.reusable, true); assert.equal(historical.expirable, false); assert.equal(historical.savedBy, account.userId);
    const removal = { id: input.id, requestId: randomUUID(), revision: 2 };
    assert.equal((await retireMaterialCategory(client, identity, removal)).revision, 3);
    assert.equal((await retireMaterialCategory(client, identity, removal)).revision, 3);
    assert.equal((await listMaterialCategories(client, identity)).totalCount, 0);
    assert.deepEqual(await loadMaterialCategory(client, identity, input.id, { atRevision: 1 }), historical);
  }, { csrfToken: session.csrfToken });
  const laboratory = await createLaboratoryFixture(owner, account);
  await withSession(session.token, async (client, identity) => {
    const category = await saveMaterialCategory(client, identity, { id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Fresh manual stock category' });
    const input = { id: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Fresh stock material', code: 'FRESH_STOCK', categoryId: category.id,
      measurementUnitId: laboratory.unit.id, initialQuantity: '1.0000000001', minimumQuantity: '0' };
    const material = await saveMaterial(client, identity, input); assert.equal(material.initialQuantity, '1.0000000001'); assert.equal(material.initialStockCreatedBy, account.userId);
    const receipt = { id: randomUUID(), requestId: randomUUID(), materialId: material.id, type: 'in', quantity: '2', cost: '0', batchSerialNumber: 'Fresh batch', supplier: 'Fresh supplier' };
    const created = await createMaterialTransaction(client, identity, receipt); assert.equal(created.createdBy, account.userId); assert.equal(created.cost, '0');
    assert.deepEqual(await createMaterialTransaction(client, identity, receipt), created);
    await createMaterialTransaction(client, identity, { ...receipt, id: randomUUID(), requestId: randomUUID(), type: 'out', quantity: '0.0000000001' });
    assert.equal((await loadMaterial(client, identity, material.id)).currentQuantity, '3.0000000000');
    const entries = await listMaterialTransactions(client, identity, material.id); assert.equal(entries.totalCount, 3); assert.equal(entries.items.filter(item => item.initial).length, 1);
    const updated = await saveMaterial(client, identity, { ...input, requestId: randomUUID(), revision: 1, initialQuantity: '2.0000000001' });
    assert.equal(updated.initialStockId, material.initialStockId); assert.equal((await loadMaterial(client, identity, material.id, { atRevision: 1 })).initialQuantity, '1.0000000001');
    const removal = { id: material.id, revision: 2, requestId: randomUUID() }; assert.equal((await retireMaterial(client, identity, removal)).revision, 3);
    assert.equal((await retireMaterial(client, identity, removal)).revision, 3); assert.equal((await listMaterials(client, identity)).totalCount, 0);
    assert.deepEqual(await createMaterialTransaction(client, identity, receipt), created);
    await retireMaterialCategory(client, identity, { id: category.id, revision: 1, requestId: randomUUID() });
  }, { csrfToken: session.csrfToken });
  const masterGrid = updateUncertaintyGrid(emptyUncertaintyGrid(), { headers: ['Sr. no.', 'Text', 'Notes'], data: [['1', '000.00', '=A1*2'], ['2', '  exact text  ', '']] });
  const masterKey = `FRESH_${randomUUID().slice(0, 8)}`;
  const masterInput = { id: randomUUID(), revision: 0, requestId: randomUUID(), name: 'Fresh uncertainty parameter', description: '',
    key: masterKey, schemeAbbreviation: masterKey, order: 0, laboratoryId: laboratory.laboratory.id, measurementUncertainty: masterGrid };
  await withSession(session.token, (client, identity) => saveTestParameter(client, identity, masterInput), { csrfToken: session.csrfToken });
  await withSession(session.token, async (client, identity) => {
    assert.equal((await saveTestParameter(client, identity, masterInput)).revision, 1);
    const historical = await loadTestParameter(client, identity, masterInput.id, { atRevision: 1 });
    assert.deepEqual(historical.measurementUncertainty, masterGrid); assert.equal(historical.savedBy, account.userId);
    await saveTestParameter(client, identity, { ...masterInput, revision: 1, requestId: randomUUID(), name: 'Later fresh master', measurementUncertainty: null });
    const removal = { id: masterInput.id, revision: 2, requestId: randomUUID() };
    assert.equal((await retireTestParameter(client, identity, removal)).revision, 3);
    assert.equal((await retireTestParameter(client, identity, removal)).revision, 3);
    assert.deepEqual(await loadTestParameter(client, identity, masterInput.id, { atRevision: 1 }), historical);
    await assert.rejects(loadTestParameter(client, identity, masterInput.id), { code: 'parameter_not_found' });
  }, { csrfToken: session.csrfToken });
  await withSession(session.token, async (client, identity) => {
    const fields = [];
    for (const [fieldType, key] of [['text', 'fresh_method_note'], ['number', 'fresh_method_number']]) fields.push(await saveCustomField(client, identity,
      { id: randomUUID(), requestId: randomUUID(), revision: 0, label: key, key, fieldType, associatedWith: 'method_of_analysis' }));
    const command = { id: randomUUID(), revision: 0, requestId: randomUUID(), name: 'Fresh method history', uuid: `ISO ${randomUUID()}`,
      description: '  Exact notes  ', decimalScale: 0, parseNumber: false, accessUserIds: [account.userId],
      customFields: fields.map((field, index) => ({ fieldId: field.id, fieldRevision: field.revision, value: index ? 0 : 'Fresh Method value' })) };
    const saved = await saveMethod(client, identity, command);
    assert.equal((await saveMethod(client, identity, command)).revision, 1);
    assert.equal(saved.decimalScale, 0); assert.equal(saved.parseNumber, false); assert.deepEqual(saved.accessUserIds, [account.userId]);
    assert.deepEqual(saved.customFields.map(field => field.value), ['Fresh Method value', 0]);
    const historical = await loadMethod(client, identity, command.id, { atRevision: 1 });
    assert.equal(historical.savedBy, account.userId);
    assert.equal((await listMethods(client, identity, { search: command.uuid })).totalCount, 1);
    await saveMethod(client, identity, { ...command, revision: 1, requestId: randomUUID(), parseNumber: true, accessUserIds: [] });
    const removal = { id: command.id, revision: 2, requestId: randomUUID() };
    assert.equal((await retireMethod(client, identity, removal)).revision, 3);
    assert.equal((await retireMethod(client, identity, removal)).revision, 3);
    assert.deepEqual(await loadMethod(client, identity, command.id, { atRevision: 1 }), historical);
    await assert.rejects(loadMethod(client, identity, command.id), { code: 'method_not_found' });
    for (const field of fields) await retireCustomField(client, identity, { id: field.id, revision: field.revision, requestId: randomUUID() });
  }, { csrfToken: session.csrfToken });
  const productTags = (await owner.query(`INSERT INTO tags(organization_id,code,name) VALUES($1,$2,'Fresh Alpha'),($1,$3,'Fresh Beta') RETURNING id`,
    [account.organizationId, randomUUID(), randomUUID()])).rows.map((row) => row.id);
  await withSession(session.token, async (client, identity) => {
    const command = { id: laboratory.product.id, revision: 1, requestId: randomUUID(), name: laboratory.product.name, key: laboratory.product.code,
      description: '  Exact Product notes  ', abbreviation: '0', jobTemplateId: laboratory.template.templateId, tagIds: productTags.toReversed() };
    const saved = await saveProduct(client, identity, command);
    assert.deepEqual(saved.sampleCategoryIds, [laboratory.category.id]); assert.deepEqual(saved.tagIds, productTags.toReversed());
    assert.equal(saved.abbreviation, '0'); assert.equal((await saveProduct(client, identity, command)).revision, 2);
    const historical = await loadProduct(client, identity, command.id, { atRevision: 2 });
    await saveProduct(client, identity, { ...command, revision: 2, requestId: randomUUID(), description: '', tagIds: [productTags[0]] });
    assert.deepEqual(await loadProduct(client, identity, command.id, { atRevision: 2 }), historical);
    assert.equal((await listProducts(client, identity, { filters: { tags: { type: 'relation', value: [productTags[0]] } } })).totalCount, 1);
    const standalone = await saveProduct(client, identity, { ...command, id: randomUUID(), revision: 0, requestId: randomUUID(), key: `FRESH-${randomUUID()}` });
    const removal = { id: standalone.id, revision: 1, requestId: randomUUID() };
    assert.equal((await retireProduct(client, identity, removal)).revision, 2); assert.equal((await retireProduct(client, identity, removal)).revision, 2);
    assert.deepEqual((await loadProduct(client, identity, standalone.id, { atRevision: 2 })).tagIds, standalone.tagIds);
    await assert.rejects(loadProduct(client, identity, standalone.id), { code: 'product_not_found' });
  }, { csrfToken: session.csrfToken });
  await withSession(session.token, async (client, identity) => {
    const command = { id: randomUUID(), revision: 0, requestId: randomUUID(), label: 'Fresh custom field', key: 'MiXeD_Field', associatedWith: 'product',
      fieldType: 'select', displayOrder: 0, roleIdsCanEdit: [account.roleId], associatedWithRoleId: account.roleId,
      options: [{ id: randomUUID(), key: 'A', label: 'Upper' }, { id: randomUUID(), key: 'a', label: 'Lower' }] };
    const first = await saveCustomField(client, identity, command); assert.equal(first.key, 'mixed_field'); assert.equal(first.displayOrder, 0);
    assert.deepEqual(first.options, command.options); assert.deepEqual(first.roleIdsCanEdit, [account.roleId]);
    await saveCustomField(client, identity, { ...command, revision: 1, requestId: randomUUID(), fieldType: 'date_time', datetimeFormat: 'MMMM Do YYYY | hh:mm A', options: command.options.toReversed() });
    assert.deepEqual(await loadCustomField(client, identity, command.id, { atRevision: 1 }), first);
    assert.deepEqual(await saveCustomField(client, identity, command), first);
    const removal = { id: command.id, revision: 2, requestId: randomUUID() };
    assert.equal((await retireCustomField(client, identity, removal)).revision, 3); assert.equal((await retireCustomField(client, identity, removal)).revision, 3);
    assert.deepEqual((await loadCustomField(client, identity, command.id, { atRevision: 3 })).options, command.options.toReversed());
    assert.equal((await listCustomFields(client, identity)).totalCount, 0);
  }, { csrfToken: session.csrfToken });
  const attachment = await withSession(session.token, async (client, identity) => {
    const field = await saveCustomField(client, identity, { id: randomUUID(), revision: 0, requestId: randomUUID(), label: 'Fresh attachment',
      key: 'fresh_attachment', associatedWith: 'product', fieldType: 'attachment' });
    const command = { requestId: randomUUID(), fieldId: field.id, fieldRevision: 1, originalName: 'Fresh विश्लेषण.bin',
      mediaType: 'application/octet-stream', content: Buffer.from([0, 255, 1, 10]) };
    const saved = await uploadCustomFieldAttachment(client, identity, command);
    assert.equal((await uploadCustomFieldAttachment(client, identity, { ...command, requestId: randomUUID(), content: Buffer.alloc(0) })).byteLength, 0);
    return { field, command, saved };
  }, { csrfToken: session.csrfToken });
  await withSession(session.token, (client, identity) => retireCustomField(client, identity,
    { id: attachment.field.id, revision: 1, requestId: randomUUID() }), { csrfToken: session.csrfToken });
  await withSession(session.token, async (client, identity) => {
    assert.deepEqual(await uploadCustomFieldAttachment(client, identity, attachment.command), { ...attachment.saved, replayed: true });
    assert.deepEqual((await readCustomFieldAttachment(client, identity, attachment.saved.id)).content, attachment.command.content);
  }, { csrfToken: session.csrfToken });
  const captureAccount = await createAccount(owner, { permissions: ['masters.manage'] });
  const captureSession = await signIn({ identifier: captureAccount.username, password: captureAccount.password });
  const captureWork = (action, readOnly = false) => withSession(captureSession.token, action, { csrfToken: captureSession.csrfToken, readOnly });
  const capturedProducts = await createProductFieldFixture(captureWork, { fieldCount: 16, productCount: 1, userId: captureAccount.userId });
  await captureWork(async (client, identity) => {
    const loaded = await loadProduct(client, identity, capturedProducts.products[0].id);
    assert.equal(loaded.customFields.length, 16);
    assert.equal(loaded.customFields.find((field) => field.fieldType === 'date').timeZone, 'UTC');
    const generated = await generateProductCustomFields(client, identity, { product: capturedProducts.product, customFieldTimeZone: 'UTC',
      customFields: capturedProducts.values.map((field, index) => ({ ...field, value: index >= 13 ? '' : field.value })) });
    assert.deepEqual(generated.values.map((field) => field.value), ['P/002', 'P/002/copy', 'P/002/copy/copy']);
    const listed = await listProducts(client, identity, { search: 'Synthetic value' });
    assert.equal(listed.rows.length, 1);
    assert.equal(Object.keys(listed.rows[0].customFields).length, 16);
  }, true);
  await captureWork(async (client, identity) => {
    const field = await saveCustomField(client, identity, { id: randomUUID(), requestId: randomUUID(), revision: 0,
      key: 'parameter_serial', label: 'Parameter Serial', associatedWith: 'parameter', fieldType: 'text',
      scheme: '{{entity.scheme_abbr}}/{{total_counter}}', generatedAt: 'on_init', showInList: true, showInFilter: true });
    const parameter = { name: 'Fresh typed Parameter', key: randomUUID(), schemeAbbreviation: 'Ni', order: 0 };
    const generated = await generateParameterCustomFields(client, identity,
      { parameter, customFields: [{ fieldId: field.id, fieldRevision: 1, value: '' }] });
    assert.deepEqual(generated.values, [{ fieldId: field.id, value: 'Ni/1' }]);
    const command = { ...parameter, id: randomUUID(), revision: 0, requestId: randomUUID(),
      customFields: [{ fieldId: field.id, fieldRevision: 1, value: generated.values[0].value }] };
    const saved = await saveTestParameter(client, identity, command);
    assert.equal(saved.laboratoryName, null);
    assert.equal((await listTestParameters(client, identity, { search: 'Ni/1' })).rows[0].customFields[field.id].displayValue, 'Ni/1');
    await retireTestParameter(client, identity, { id: saved.id, revision: 1, requestId: randomUUID() });
    assert.deepEqual((await loadTestParameter(client, identity, saved.id, { atRevision: 2 })).customFields, saved.customFields);
    assert.deepEqual((await saveTestParameter(client, identity, command)).customFields, saved.customFields);
  });
  const historyAccount = await createAccount(owner, { permissions: ['masters.manage'] });
  const historySession = await signIn({ identifier: historyAccount.username, password: historyAccount.password });
  const historyWork = action => withSession(historySession.token, action, { csrfToken: historySession.csrfToken });
  const historyLab = randomUUID();
  await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2::uuid,$2::text,'Fresh observed Lab')", [historyAccount.organizationId, historyLab]);
  const historyParameter = { id: randomUUID(), revision: 0, requestId: randomUUID(), key: randomUUID(), name: 'Fresh Lab label history',
    schemeAbbreviation: 'LAB-HISTORY', order: 0, laboratoryId: historyLab };
  await historyWork((client, identity) => saveTestParameter(client, identity, historyParameter));
  const observedParameter = await historyWork((client, identity) => loadTestParameter(client, identity, historyParameter.id, { atRevision: 1 }));
  assert.equal(observedParameter.laboratoryName, 'Fresh observed Lab');
  await owner.query("UPDATE laboratories SET name='Fresh renamed Lab',revision=revision+1 WHERE organization_id=$1 AND id=$2", [historyAccount.organizationId, historyLab]);
  await historyWork(async (client, identity) => {
    assert.equal((await loadTestParameter(client, identity, historyParameter.id)).laboratoryName, 'Fresh renamed Lab');
    assert.deepEqual(await loadTestParameter(client, identity, historyParameter.id, { atRevision: 1 }), observedParameter);
    assert.deepEqual(await saveTestParameter(client, identity, historyParameter), observedParameter);
  });
  const productJobSample = await withSession(session.token, (client, identity) => registerSample(client, identity, laboratory.registration), { csrfToken: session.csrfToken });
  assert.equal((await owner.query('SELECT product_revision FROM sample_products WHERE organization_id=$1 AND sample_id=$2',
    [account.organizationId, productJobSample.id])).rows[0].product_revision, 3);
  await withSession(session.token, async (client, identity) => {
    const generated = await generateTestRequests(client, identity, productJobSample.id);
    const created = await createTestRequestJobs(client, identity, { requestIds: generated.items.map((row) => row.id), analystUserId: account.userId });
    assert.equal(created.items.length, 1); assert.ok(created.items[0].datasheetId);
    const job = (await client.query('SELECT datasheet_template_id FROM test_requests WHERE organization_id=$1 AND id=$2', [identity.organization_id, created.items[0].id])).rows[0];
    assert.equal(job.datasheet_template_id, laboratory.template.templateId);
  }, { csrfToken: session.csrfToken });
  for (const [table, extraColumns, retire, load] of [
    ['methods_of_analysis', 'method_uuid', retireMethod, loadMethod],
    ['test_parameters', 'master_key,scheme_abbreviation', retireTestParameter, loadTestParameter],
  ]) {
    const id = randomUUID(); const name = 'L'.repeat(250); const description = 'd'.repeat(16001);
    await owner.query(`INSERT INTO ${table}(organization_id,id,code,name,description,${extraColumns})
      VALUES($1,$2::uuid,$2::text,$3,$4,${table === 'test_parameters' ? '$2::text,$2::text' : '$2::text'})`, [account.organizationId, id, name, description]);
    await withSession(session.token, async (client, identity) => {
      assert.equal((await retire(client, identity, { id, revision: 1, requestId: randomUUID() })).revision, 2);
      const history = await load(client, identity, id, { atRevision: 2 });
      assert.equal(history.name, name); assert.equal(history.description, description); assert.equal(history.savedBy, account.userId);
      await assert.rejects(load(client, identity, id, { atRevision: 1 }), (error) => error.status === 404);
    }, { csrfToken: session.csrfToken });
  }
  await withSession(session.token, async (client, identity) => {
    const customer = await quickCreateCustomer(client, identity, { name: 'Synthetic fresh customer', legalName: 'Synthetic legal name', contactPersonName: 'Synthetic contact',
      contactPersonEmail: 'fresh@example.invalid', contactPersonPhone: '00000000', billToAddress: 'Synthetic billing\nSecond line', shipToAddress: 'Synthetic receiving' });
    const sample = await registerSample(client, identity, { ...laboratory.registration, sampleType: 'customer', customerId: customer.id, customerAddress: customer.addresses[0].text });
    const generated = await generateTestRequests(client, identity, sample.id);
    assert.equal(generated.items.length, 1);
    const allocated = await allocateTestRequest(client, identity, generated.items[0].id, { revision: 1, assignmentType: 'analyst', assignedUserId: account.userId });
    assert.ok(allocated.datasheetId); assert.equal(allocated.status, 'allocated');
    const loaded = await loadSample(client, identity, sample.id);
    assert.equal(loaded.customerName, customer.name); assert.equal(loaded.products[0].tests[0].requestStatus, 'allocated');
  }, { csrfToken: session.csrfToken });
  const templateImage = { requestId: randomUUID(), originalName: 'Fresh animated template.png', mediaType: 'image/png', content: await animatedPng({ separateDefault: true }) };
  const registrationImageFixture = await createLaboratoryFixture(owner, account);
  const registrationImage = { ...templateImage, requestId: randomUUID(), originalName: 'Fresh registration image.png' };
  const registrationTemplate = await withSession(session.token, async (client, identity) => {
    const created = await createImageTemplate(client, identity, { kind: 'sample', repeated: true });
    await uploadTemplateImage(client, identity, created.versionId, created.fieldId, 1, registrationImage);
    await freezeTemplate(client, identity, created.versionId, 2);
    await client.query("INSERT INTO sample_category_templates(organization_id,sample_category_id,template_id,purpose,is_default) VALUES($1,$2,$3,'sample',true)",
      [identity.organization_id, registrationImageFixture.category.id, created.templateId]);
    return created;
  }, { csrfToken: session.csrfToken });
  const registrar = await createAccount(owner, { organizationId: account.organizationId, permissions: ['samples.create'] });
  const registrarSession = await signIn({ identifier: registrar.username, password: registrar.password });
  const imageSample = await withSession(registrarSession.token, (client, identity) => registerSample(client, identity, registrationImageFixture.registration), { csrfToken: registrarSession.csrfToken });
  const initializedImages = (await owner.query('SELECT version_id,image_id,origin,saved_by FROM template_values WHERE instance_id=$1', [imageSample.templateInstanceId])).rows;
  assert.deepEqual(initializedImages, Array.from({ length: 2 }, () => ({ version_id: registrationTemplate.versionId, image_id: registrationImage.requestId, origin: 'default', saved_by: registrar.userId })));
  await assert.rejects(withSession(registrarSession.token, (client, identity) => loadCapture(client, identity.organization_id, imageSample.templateInstanceId), { readOnly: true }), { code: 'capture_not_found' });
  const productContextField = await withSession(session.token, (client, identity) => saveCustomField(client, identity,
    { id: randomUUID(), revision: 0, requestId: randomUUID(), label: 'Fresh Product flag', key: 'fresh_product_flag', associatedWith: 'product', fieldType: 'checkbox' }), { csrfToken: session.csrfToken });
  const productContextSelector = 'project_field__splitter__fresh_product_flag';
  const parameterContextField = await withSession(session.token, (client, identity) => saveCustomField(client, identity,
    { id: randomUUID(), revision: 0, requestId: randomUUID(), label: 'Fresh Parameter flag', key: 'fresh_parameter_flag', associatedWith: 'parameter', fieldType: 'checkbox' }), { csrfToken: session.csrfToken });
  let verticalTextFieldId; let parameterDetailFieldId;
  const reportFlow = await prepareReportFlow(owner, { ...account, ...session }, { finalSection: true,
    prepareProduct: async (client, identity, fixture) => {
      fixture.registration.products[0].description = 'Fresh captured line-item description';
      await saveProduct(client, identity, { id: fixture.product.id, revision: 1, requestId: randomUUID(), key: fixture.product.code,
        name: 'Fresh captured Product', description: 'Fresh immutable Product context',
        customFields: [{ fieldId: productContextField.id, fieldRevision: 1, value: false }] });
      await saveTestParameter(client, identity, { id: fixture.parameter.id, revision: 1, requestId: randomUUID(), name: 'Fresh captured parameter',
        key: fixture.parameter.masterKey, schemeAbbreviation: fixture.parameter.schemeAbbreviation, order: 0, laboratoryId: fixture.laboratory.id,
        description: '<b>Fresh parameter H<sub>2</sub>O</b>', measurementUncertainty: null,
        customFields: [{ fieldId: parameterContextField.id, fieldRevision: 1, value: false }] });
      assert.deepEqual((await client.query(`SELECT method_id,method_revision,method_name FROM test_parameter_version_methods
        WHERE organization_id=$1 AND parameter_id=$2 AND revision=2`, [identity.organization_id, fixture.parameter.id])).rows,
      [{ method_id: fixture.method.id, method_revision: fixture.method.revision, method_name: fixture.method.name }]);
    }, prepareDatasheet: async (client, identity, template) => {
      const result = await addImageWidget(client, identity, template, templateImage, { rowId: template.records.rows[0].id });
      assert.equal(result.metrics.assets.queryCount, 1);
      assert.equal((await uploadTemplateImage(client, identity, template.versionId, result.fieldId, result.model.version.revision - 1, templateImage)).replayed, true);
      const products = await addProductWidgets(client, identity, { ...template, revision: result.model.version.revision }, template.records.sections[0].id, ['description', productContextSelector]);
      const rowId = template.records.rows[0].id;
      const added = await editTemplate(client, identity, template.versionId, products.revision, { type: 'addColumn', rowId });
      const columnId = added.model.rowsById[rowId].columnIds.at(-1);
      const vertical = await editTemplate(client, identity, template.versionId, added.model.version.revision,
        { type: 'configureField', columnId, widget: 'vertical_text_widget', alias: 'fresh_vertical_title', label: 'Fresh vertical <b>title</b>', defaultValue: 'Unused vertical default' });
      verticalTextFieldId = vertical.model.columnsById[columnId].fieldId;
      const titleColumn = await editTemplate(client, identity, template.versionId, vertical.model.version.revision, { type: 'addColumn', rowId });
      const title = await editTemplate(client, identity, template.versionId, titleColumn.model.version.revision,
        { type: 'configureField', columnId: titleColumn.model.rowsById[rowId].columnIds.at(-1), widget: 'text_widget', alias: 'fresh_parameter_title', label: 'description' });
      const customColumn = await editTemplate(client, identity, template.versionId, title.model.version.revision, { type: 'addColumn', rowId });
      const customTitle = await editTemplate(client, identity, template.versionId, customColumn.model.version.revision,
        { type: 'configureField', columnId: customColumn.model.rowsById[rowId].columnIds.at(-1), widget: 'text_widget', alias: 'fresh_custom_title', label: 'prefix.fresh_parameter_flag' });
      const detailColumn = await editTemplate(client, identity, template.versionId, customTitle.model.version.revision, { type: 'addColumn', rowId });
      const detail = await editTemplate(client, identity, template.versionId, detailColumn.model.version.revision,
        { type: 'configureField', columnId: detailColumn.model.rowsById[rowId].columnIds.at(-1), widget: 'parameter_detail_widget', alias: 'fresh_parameter_methods', label: 'moa_applicable' });
      parameterDetailFieldId = detail.model.columnsById[detailColumn.model.rowsById[rowId].columnIds.at(-1)].fieldId;
      const loop = await editTemplate(client, identity, template.versionId, detail.model.version.revision,
        { type: 'configureSection', id: template.records.sections[0].id, name: 'Final parameter results', isFinalResult: true, isParameterLoop: true });
      await addSampleLineWidgets(client, identity, { ...template, revision: loop.model.version.revision }, template.records.sections[0].id, ['custom_description']);
    } });
  const verticalCapture = await withSession(session.token, (client, identity) => loadCapture(client, identity.organization_id, reportFlow.sheet.template_instance_id), { readOnly: true });
  assert.equal(verticalCapture.values.some((value) => value.fieldId === verticalTextFieldId), false);
  assert.ok(verticalCapture.values.filter((value) => value.fieldId === parameterDetailFieldId)
    .every((value) => parameterDetailPayload(value)[0] === reportFlow.fixture.method.name));
  assert.equal(verticalCapture.metrics.queryCount, 5);
  const assets = await withSession(session.token, async (client, identity) => {
    const created = await createReportAssets(client, identity);
    const vector = await uploadReportImage(client, identity, { requestId: randomUUID(), originalName: 'Fresh vector.svg', mediaType: 'image/svg+xml', content: reportSvg });
    const watermarkInput = { watermarkId: randomUUID(), requestId: randomUUID(), revision: 0, name: 'Fresh watermark', imageId: vector.id, opacity: 0, width: 240, height: 320, rotation: 0 };
    const watermark = await saveWatermark(client, identity, watermarkInput);
    assert.equal((await saveWatermark(client, identity, watermarkInput)).replayed, true);
    await deleteWatermark(client, identity, watermark.watermark.id, { requestId: randomUUID(), revision: 1 });
    const oldWatermark = await loadWatermark(client, identity, watermark.watermark.id, { versionId: watermark.watermark.versionId });
    assert.equal(oldWatermark.imageId, vector.id); assert.equal(oldWatermark.opacity, 0); assert.equal(oldWatermark.rotation, 0);
    await assert.rejects(loadWatermark(client, identity, watermark.watermark.id), { code: 'watermark_not_found' });
    const footer = await saveReportDocument(client, identity, { ...created.footerInput, requestId: randomUUID(), revision: 1,
      templateHtml: `${created.footerInput.templateHtml}<img src="${vector.url}" width="80" height="24">` });
    const cssInput = { requestId: randomUUID(), revision: 0, cssContent: `.coa-report-header p::after{content:" FRESH FROZEN STYLESHEET"}.coa-report-footer{background-image:url('${vector.url}');background-repeat:no-repeat}` };
    const stylesheet = await saveCustomCss(client, identity, cssInput);
    assert.equal((await saveCustomCss(client, identity, cssInput)).replayed, true);
    assert.equal((await loadCurrentCustomCss(client)).versionId, stylesheet.versionId);
    await editTemplate(client, identity, reportFlow.template.versionId, 1, created.command);
    await addProductWidgets(client, identity, { ...reportFlow.template, revision: 2 },
      reportFlow.template.records.sections.find((section) => section.name === 'Certificate Details').id, ['name', productContextSelector]);
    return { ...created, footer: footer.document, stylesheet };
  }, { csrfToken: session.csrfToken });
  const generationInput = { ...reportFlow.input, finalizeSample: true };
  await owner.query('UPDATE sample_products SET description=$3 WHERE organization_id=$1 AND sample_id=$2',
    [account.organizationId, reportFlow.sample.id, 'Later line observed by the report']);
  const generated = await withSession(session.token, (client, identity) => generateReports(client, identity, reportFlow.sample.id, generationInput), { csrfToken: session.csrfToken });
  assert.equal(generated.items[0].isFinalized, true);
  assert.equal(generated.sample.status, 'completed'); assert.equal(generated.sample.revision, 2);
  const retried = await withSession(session.token, (client, identity) => generateReports(client, identity, reportFlow.sample.id, generationInput), { csrfToken: session.csrfToken });
  assert.equal(retried.replayed, true); assert.equal(retried.sample.revision, 2);
  const reportId = generated.items[0].id;
  await withSession(session.token, (client, identity) => deleteReportDocument(client, identity, assets.header.id, { requestId: randomUUID(), revision: 1 }), { csrfToken: session.csrfToken });
  await withSession(session.token, async (client, identity) => {
    const cleared = await saveCustomCss(client, identity, { requestId: randomUUID(), revision: 1, cssContent: '' });
    assert.equal(cleared.revision, 2); assert.equal((await loadCurrentCustomCss(client)).cssContent, '');
    assert.equal((await loadCustomCss(client, identity, { versionId: assets.stylesheet.versionId })).cssContent, assets.stylesheet.cssContent);
  }, { csrfToken: session.csrfToken });
  const captured = await withSession(session.token, (client, identity) => loadReport(client, identity, reportId), { readOnly: true });
  assert.equal(captured.results[0].parameterTitleValues.order, 0);
  assert.equal(captured.results[0].parameterTitleValues.description, '<b>Fresh parameter H<sub>2</sub>O</b>');
  assert.equal(captured.results[0].parameterTitleValues.project_field_data.fresh_parameter_flag.display_value, false);
  assert.equal(captured.metrics.parameters.queryCount, 3);
  assert.equal(captured.assets.header.versionId, assets.header.versionId);
  assert.ok(captured.assets.header.html.includes(`data:image/png;base64,${assets.content.toString('base64')}`));
  assert.equal(captured.assets.footer.versionId, assets.footer.versionId);
  assert.ok(captured.assets.footer.html.includes(`data:image/svg+xml;base64,${reportSvg.toString('base64')}`));
  assert.equal(captured.assets.customCss.versionId, assets.stylesheet.versionId);
  assert.ok(captured.assets.customCss.css.includes(`data:image/svg+xml;base64,${reportSvg.toString('base64')}`));
  assert.equal(captured.metrics.assets.queryCount, 1); assert.equal(captured.metrics.assets.images, 3);
  assert.equal(captured.metrics.imageCounts[templateImage.requestId], 2);
  assert.equal(captured.assets.templateImages[templateImage.requestId].src, `data:image/png;base64,${templateImage.content.toString('base64')}`);
  const queued = await withSession(session.token, (client, identity) => enqueueReportPdf(client, identity, reportId), { csrfToken: session.csrfToken });
  worker = createReportWorkerPool(workerUrl.href); await verifyReportWorkerRole(worker);
  assert.equal((await worker.query('SELECT id FROM sample_reports')).rowCount, 0);
  assert.equal((await worker.query('SELECT * FROM laboratory_parameter_context')).rowCount, 0);
  const renderer = await loadReportRenderer(); let checkedProductContext = false;
  const printed = await processNextReportJob({ pool: worker, renderer: { ...renderer,
    renderReportDocument(report, stylesheet) {
      assert.deepEqual(report.productDetailsByLineId, captured.productDetailsByLineId);
      assert.deepEqual(report.results.map((result) => result.parameterTitleValues), captured.results.map((result) => result.parameterTitleValues));
      assert.deepEqual(report.finalCaptures, captured.finalCaptures);
      assert.equal(report.lineItem.description, 'Later line observed by the report');
      assert.deepEqual(report.lineItem, captured.lineItem);
      assert.ok(Object.values(report.finalCaptures).every((capture) => capture.lineItem.description === 'Fresh captured line-item description'));
      const html = renderer.renderReportDocument(report, stylesheet);
      assert.ok(html.includes('Fresh captured line-item description'));
      assert.ok(html.includes('Fresh captured Product')); assert.ok(html.includes('Fresh immutable Product context'));
      assert.ok(html.includes('>false</div>')); assert.ok(!html.includes('Configured default is not a captured Product value'));
      assert.ok(html.includes('Fresh vertical &lt;b&gt;title&lt;/b&gt;'));
      assert.ok(html.includes('<b>Fresh parameter H<sub>2</sub>O</b>'));
      assert.ok(html.includes('transform:rotate(180deg);writing-mode:vertical-rl')); assert.ok(!html.includes('Unused vertical default'));
      checkedProductContext = true; return html;
    },
  }, workerId: randomUUID() });
  assert.deepEqual(printed, { jobId: queued.job.id, status: 'succeeded' });
  assert.equal(checkedProductContext, true);
  const pdf = await withSession(session.token, (client, identity) => reportPdfFile(client, identity, reportId), { readOnly: true });
  assert.equal(pdf.content.subarray(0, 5).toString(), '%PDF-'); assert.ok(pdf.byteLength > 5000);
  const creationOwner = await createAccount(owner, { permissions: ['samples.create', 'samples.manage', 'templates.manage', 'masters.manage', 'settings.manage'] });
  const creationSession = await signIn({ identifier: creationOwner.username, password: creationOwner.password });
  const creationFixture = await prepareParameterTitleRegistration(owner, { ...creationOwner, ...creationSession });
  const creationActor = await createAccount(owner, { organizationId: creationOwner.organizationId, permissions: ['samples.create'] });
  const creationLogin = await signIn({ identifier: creationActor.username, password: creationActor.password });
  const titleSample = await withSession(creationLogin.token, (client, identity) => registerSample(client, identity, creationFixture.registration), { csrfToken: creationLogin.csrfToken });
  const titleChild = titleSample.testRequests.find((row) => row.datasheetId);
  const titleSheet = await withSession(creationSession.token, (client, identity) => loadDatasheet(client, identity, titleChild.datasheetId), { readOnly: true });
  assert.equal(titleSheet.dataContext.results[0].parameterTitleValues.project_field_data.creation.display_value, 'Captured creation title');
  await withSession(creationLogin.token, async (client) => {
    await client.query("SELECT set_config('app.auto_job_request_id',$1,true)", [titleChild.id]);
    assert.equal((await client.query('SELECT * FROM laboratory_parameter_field_context')).rowCount, 0);
  }, { readOnly: true });
  const signedAccount = { ...account, ...session };
  const jobFlow = await prepareSubjectJob(owner, signedAccount, signedAccount, { resultWidget: true, resultValueType: 'result', resultDefaultValue: '000.00' });
  const work = (action, options = {}) => withSession(session.token, action, { csrfToken: session.csrfToken, ...options });
  let jobSheet = await work((client, identity) => loadDatasheet(client, identity, jobFlow.job.datasheetId), { readOnly: true });
  const fields = Object.values(jobSheet.model.fieldsById); const raw = fields.find((field) => field.alias === 'raw_0');
  const result = fields.find((field) => field.widget === 'result_widget');
  assert.equal(result.defaultLexical, '000.00');
  const defaults = jobSheet.capture.values.filter((value) => value.fieldId === result.id);
  assert.equal(defaults.length, 2);
  assert.ok(defaults.every((value) => value.origin === 'default' && value.numberValue === '0.00' && value.lexical === '000.00'));
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM job_result_entries WHERE datasheet_id=$1', [jobFlow.job.datasheetId])).rows[0].count, 0);
  await work((client, identity) => saveCapture(client, identity, jobSheet.capture.instance.id, jobSheet.capture.revision,
    jobSheet.capture.occurrences.filter((row) => row.subject).flatMap((row, index) => [
      { fieldId: raw.id, occurrenceId: row.id, state: 'present', value: '0' },
      { fieldId: result.id, occurrenceId: row.id, ...(index === 0 ? { state: 'empty' } : { state: 'present', value: 'Not detected' }) },
    ])));
  jobSheet = await work((client, identity) => loadDatasheet(client, identity, jobFlow.job.datasheetId), { readOnly: true });
  const run = await work((client, identity) => loadWorkflowRun(client, identity, jobFlow.job.workflowRunId), { readOnly: true });
  await work((client, identity) => submitDatasheetTransition(client, identity, run.id, { datasheetId: jobSheet.datasheet.id,
    datasheet: { revision: jobSheet.datasheet.revision, captureRevision: jobSheet.capture.revision },
    transition: { revision: run.revision, transitionId: run.transitions[0].id, comment: 'Synthetic fresh job completion', checklistItemIds: [] } }));
  assert.equal((await owner.query('SELECT count(*)::integer AS count FROM laboratory_job_workflow_effects WHERE parent_request_id=$1 AND is_current', [jobFlow.job.id])).rows[0].count, 2);
  const template = await work(createReportTemplate);
  const selected = (await owner.query('SELECT sample_test_id FROM test_requests WHERE organization_id=$1 AND parent_test_request_id=$2', [account.organizationId, jobFlow.job.id])).rows;
  const jobReports = await work((client, identity) => generateReports(client, identity, jobFlow.sample.id, { revision: jobFlow.sample.revision, requestId: randomUUID(),
    reportType: 'consolidated', selectedSampleTestIds: selected.map((row) => row.sample_test_id), templateSelections: [{ key: 'consolidated', templateId: template.templateId }] }));
  const jobReportId = jobReports.items[0].id;
  const qualitativeReport = await work((client, identity) => loadReport(client, identity, jobReportId), { readOnly: true });
  assert.deepEqual(qualitativeReport.results.map((row) => [row.resultType, row.finalResult]), [['numeric', '0.00'], ['text', 'Not detected']]);
  const jobPrint = await work((client, identity) => enqueueReportPdf(client, identity, jobReportId));
  assert.deepEqual(await processNextReportJob({ pool: worker, renderer: await loadReportRenderer(), workerId: randomUUID() }), { jobId: jobPrint.job.id, status: 'succeeded' });
  const jobPdf = await work((client, identity) => reportPdfFile(client, identity, jobReportId), { readOnly: true });
  assert.equal(jobPdf.content.subarray(0, 5).toString(), '%PDF-'); assert.ok(jobPdf.byteLength > 5000);
  await mkdir('.local', { recursive: true, mode: 0o700 });
  await writeFile('.local/migration-verification.json', JSON.stringify({ databaseName, migrations: count, status: 'passed', verifiedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  console.log(`Fresh install and repeat application passed for ${count} migrations; authentication, role history/settings, workflow layout/ports/metadata and master/draft cloning, template capture, typed parameter uncertainty, method/user and Product/tag history/retry/retirement, Product job fallback, unchanged long legacy master text, registration, allocation, frozen lexical defaults and explicit entry, typed numeric/qualitative grouped results/workflow, report finalisation/retry, watermark and stylesheet history, captured CSS images and two frozen PDF jobs passed with restricted application/worker roles. Synthetic database retained: ${databaseName}`);
} finally {
  await worker?.end();
  await closePool();
  await owner?.end();
  await admin.end();
}
