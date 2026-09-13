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
import { addImageWidget } from '../tests/helpers/template-image-fixture.js';
import { animatedPng } from '../tests/helpers/template-images.js';
import { uploadTemplateImage } from '../src/template-assets/service.js';
import { freezeTemplate, editTemplate } from '../src/templates/authoring.js';
import { createCapture, saveCapture } from '../src/templates/capture.js';
import { loadCapture, loadDefinition } from '../src/templates/loader.js';
import { createLaboratoryFixture } from '../tests/helpers/laboratory.js';
import { quickCreateCustomer } from '../src/samples/customer.js';
import { registerSample } from '../src/samples/register.js';
import { loadSample } from '../src/samples/load.js';
import { generateTestRequests } from '../src/test-requests/generate.js';
import { allocateTestRequest } from '../src/test-requests/allocate.js';
import { prepareReportFlow } from '../tests/helpers/report-flow.js';
import { addProductWidgets } from '../tests/helpers/product-context.js';
import { prepareSubjectJob } from '../tests/helpers/job-subjects.js';
import { createReportTemplate } from '../tests/helpers/reports.js';
import { createReportAssets } from '../tests/helpers/report-assets.js';
import { deleteReportDocument, saveReportDocument } from '../src/report-assets/documents.js';
import { uploadReportImage } from '../src/report-assets/images.js';
import { saveWatermark, loadWatermark, deleteWatermark } from '../src/report-assets/watermarks.js';
import { loadCustomCss, saveCustomCss, loadCurrentCustomCss } from '../src/report-assets/custom-css.js';
import { reportSvg } from '../tests/helpers/report-svg.js';
import { emptyUncertaintyGrid, updateUncertaintyGrid } from '../src/masters/parameter-grid.js';
import { loadTestParameter, saveTestParameter, retireTestParameter } from '../src/masters/test-parameters.js';
import { loadMethod, saveMethod, retireMethod, listMethods } from '../src/masters/methods.js';
import { loadProduct, saveProduct, retireProduct, listProducts } from '../src/masters/products.js';
import { loadCustomField, saveCustomField, retireCustomField, listCustomFields } from '../src/masters/custom-fields.js';
import { uploadCustomFieldAttachment, readCustomFieldAttachment } from '../src/custom-fields/attachments.js';
import { createProductFieldFixture } from '../tests/helpers/product-field-fixtures.js';
import { generateProductCustomFields } from '../src/masters/product-custom-field-generation.js';
import { createTestRequestJobs } from '../src/test-requests/jobs.js';
import { loadDatasheet } from '../src/datasheets/service.js';
import { loadWorkflowRun } from '../src/workflows/load.js';
import { submitDatasheetTransition } from '../src/workflows/requests.js';
import { generateReports, loadReport } from '../src/reports/service.js';
import { enqueueReportPdf, reportPdfFile } from '../src/reports/jobs.js';
import { loadReportRenderer } from '../src/reports/renderer.js';
import { createReportWorkerPool, verifyReportWorkerRole, processNextReportJob } from '../src/reports/worker.js';

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
  const account = await createAccount(owner, { permissions: ['templates.read', 'templates.manage', 'datasheets.execute', 'samples.read', 'samples.create', 'samples.manage', 'test_requests.allocate', 'settings.manage', 'report_settings.manage', 'masters.manage'] });
  const session = await signIn({ identifier: account.username, password: account.password });
  // Enrollment must work from an empty schema using only the restricted app role.
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
    await freezeTemplate(client, identity, template.versionId, 1);
    const capture = await createCapture(client, identity, template.versionId);
    const definition = await loadDefinition(client, identity.organization_id, template.versionId);
    const loaded = await loadCapture(client, identity.organization_id, capture.instanceId);
    assert.equal(definition.model.version.status, 'frozen');
    assert.equal(loaded.instance.version_id, template.versionId);
    assert.equal(loaded.occurrences.length, 3);
  }, { csrfToken: session.csrfToken });
  const laboratory = await createLaboratoryFixture(owner, account);
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
    const command = { id: randomUUID(), revision: 0, requestId: randomUUID(), name: 'Fresh method history', uuid: `ISO ${randomUUID()}`,
      description: '  Exact notes  ', decimalScale: 0, parseNumber: false, accessUserIds: [account.userId] };
    const saved = await saveMethod(client, identity, command);
    assert.equal((await saveMethod(client, identity, command)).revision, 1);
    assert.equal(saved.decimalScale, 0); assert.equal(saved.parseNumber, false); assert.deepEqual(saved.accessUserIds, [account.userId]);
    const historical = await loadMethod(client, identity, command.id, { atRevision: 1 });
    assert.equal(historical.savedBy, account.userId);
    assert.equal((await listMethods(client, identity, { search: command.uuid })).totalCount, 1);
    await saveMethod(client, identity, { ...command, revision: 1, requestId: randomUUID(), parseNumber: true, accessUserIds: [] });
    const removal = { id: command.id, revision: 2, requestId: randomUUID() };
    assert.equal((await retireMethod(client, identity, removal)).revision, 3);
    assert.equal((await retireMethod(client, identity, removal)).revision, 3);
    assert.deepEqual(await loadMethod(client, identity, command.id, { atRevision: 1 }), historical);
    await assert.rejects(loadMethod(client, identity, command.id), { code: 'method_not_found' });
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
  const productContextField = await withSession(session.token, (client, identity) => saveCustomField(client, identity,
    { id: randomUUID(), revision: 0, requestId: randomUUID(), label: 'Fresh Product flag', key: 'fresh_product_flag', associatedWith: 'product', fieldType: 'checkbox' }), { csrfToken: session.csrfToken });
  const productContextSelector = 'project_field__splitter__fresh_product_flag';
  const reportFlow = await prepareReportFlow(owner, { ...account, ...session }, { finalSection: true,
    prepareProduct: async (client, identity, fixture) => {
      await saveProduct(client, identity, { id: fixture.product.id, revision: 1, requestId: randomUUID(), key: fixture.product.code,
        name: 'Fresh captured Product', description: 'Fresh immutable Product context',
        customFields: [{ fieldId: productContextField.id, fieldRevision: 1, value: false }] });
    }, prepareDatasheet: async (client, identity, template) => {
      const result = await addImageWidget(client, identity, template, templateImage, { rowId: template.records.rows[0].id });
      assert.equal(result.metrics.assets.queryCount, 1);
      assert.equal((await uploadTemplateImage(client, identity, template.versionId, result.fieldId, result.model.version.revision - 1, templateImage)).replayed, true);
      await addProductWidgets(client, identity, { ...template, revision: result.model.version.revision }, template.records.sections[0].id, ['description', productContextSelector]);
    } });
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
  const renderer = await loadReportRenderer(); let checkedProductContext = false;
  const printed = await processNextReportJob({ pool: worker, renderer: { ...renderer,
    renderReportDocument(report, stylesheet) {
      assert.deepEqual(report.productDetailsByLineId, captured.productDetailsByLineId);
      const html = renderer.renderReportDocument(report, stylesheet);
      assert.ok(html.includes('Fresh captured Product')); assert.ok(html.includes('Fresh immutable Product context'));
      assert.ok(html.includes('>false</div>')); assert.ok(!html.includes('Configured default is not a captured Product value'));
      checkedProductContext = true; return html;
    },
  }, workerId: randomUUID() });
  assert.deepEqual(printed, { jobId: queued.job.id, status: 'succeeded' });
  assert.equal(checkedProductContext, true);
  const pdf = await withSession(session.token, (client, identity) => reportPdfFile(client, identity, reportId), { readOnly: true });
  assert.equal(pdf.content.subarray(0, 5).toString(), '%PDF-'); assert.ok(pdf.byteLength > 5000);
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
  console.log(`Fresh install and repeat application passed for ${count} migrations; authentication, template capture, typed parameter uncertainty, method/user and Product/tag history/retry/retirement, Product job fallback, unchanged long legacy master text, registration, allocation, frozen lexical defaults and explicit entry, typed numeric/qualitative grouped results/workflow, report finalisation/retry, watermark and stylesheet history, captured CSS images and two frozen PDF jobs passed with restricted application/worker roles. Synthetic database retained: ${databaseName}`);
} finally {
  await worker?.end();
  await closePool();
  await owner?.end();
  await admin.end();
}
