import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { HttpError } from '../auth/errors.js';
import { database } from '../db/pool.js';
import { sampleReports, sampleReportTests, sampleReportPrintSettings } from '../db/report-schema.js';
import { sampleEvents } from '../db/sample-schema.js';
import { requirePermission, uuid } from '../templates/input.js';
import { insertBatch } from '../templates/authoring.js';
import { loadDefinitions, loadCaptures } from '../templates/loader.js';
import { resolveCaptureVersions } from '../templates/snapshots.js';
import { templateView } from '../templates/transport.js';
import { requireWorkflowAction } from '../workflows/access.js';
import { reportGenerationInput, reportGroups } from './input.js';
import { datasheetTemplateView, datasheetCaptureView } from '../datasheets/transport.js';
import { finalResultSectionRoots } from '../datasheets/final-result.js';
import { assertReportSize } from './render-model.js';
import { loadReportAssets, loadReportAssetBatch } from './assets.js';
import { loadSampleProductContext } from '../samples/product-context.js';

const scope = (table, organizationId) => eq(table.organizationId, organizationId);
const reportSummary = (report) => ({ id: report.id, reportNumber: report.reportNumber, revision: report.revision, reportType: report.reportType, groupKey: report.groupKey, status: report.status, isFinalized: report.isFinalized, generatedAt: report.generatedAt });
function requireRead(identity) {
  if (!identity.permission_codes.some((permission) => ['samples.read', 'samples.manage'].includes(permission))) throw new HttpError(403, 'forbidden', 'You cannot view sample reports.');
}

async function reportSample(client, identity, sampleId, { lock = false } = {}) {
  uuid(sampleId, 'Sample');
  if (lock) await client.query('SELECT report_lock_sample($1)', [sampleId]);
  const sample = (await client.query('SELECT * FROM samples WHERE organization_id=$1 AND id=$2', [identity.organization_id, sampleId])).rows[0];
  if (!sample) throw new HttpError(404, 'sample_not_found', 'Sample was not found.');
  const access = await requireWorkflowAction(client, identity, { type: 'sample', id: sampleId }, 'printCoa');
  return { sample, access };
}

// Selected result/specification references are authoritative; editable masters
// never supply the interpretation for a completed analytical result.
export async function reportCandidates(client, identity, sampleId) {
  const result = await client.query(`SELECT test.id AS "sampleTestId", product.id AS "sampleProductId", product.product_code AS "productCode", product.product_name AS "productName",
      test.status AS "testStatus", test.is_accredited AS "isAccredited", request.id AS "testRequestId", request.request_number AS "requestNumber", request.status AS "requestStatus", request.completed_at AS "completedAt",
      sheet.status AS "datasheetStatus", submission.specification_id AS "specificationId", submission.id AS "submissionId", submission.submitted_by AS "submittedBy",
      submission.source, submission.instance_id AS "instanceId", submission.version_id AS "versionId", submission.capture_revision AS "captureRevision",
      specification.parameter_name AS "parameterName", specification.method_name AS "methodName", specification.rule_name AS specification, submission.unit_symbol AS "measurementUnit",
      submission.result_type AS "resultType", submission.number_value AS "numberValue", submission.text_value AS "textValue", submission.boolean_value AS "booleanValue",
      boundary.id AS "decisionLimitId", boundary.outcome AS "decisionOutcome"
    FROM sample_products product JOIN sample_tests test ON test.organization_id=product.organization_id AND test.sample_product_id=product.id
    LEFT JOIN LATERAL (SELECT * FROM test_requests request WHERE request.organization_id=test.organization_id AND request.sample_test_id=test.id ORDER BY request.attempt_number DESC LIMIT 1) request ON true
    LEFT JOIN datasheets sheet ON sheet.organization_id=request.organization_id AND sheet.id=request.final_datasheet_id AND sheet.test_request_id=request.id
    LEFT JOIN datasheet_submissions submission ON submission.organization_id=sheet.organization_id AND submission.id=sheet.latest_submission_id
    LEFT JOIN analytical_specifications specification ON specification.organization_id=sheet.organization_id AND specification.id=coalesce(submission.specification_id,sheet.specification_id)
    LEFT JOIN LATERAL (SELECT boundary.id, boundary.outcome FROM analytical_specification_limits boundary
      WHERE boundary.organization_id=specification.organization_id AND boundary.specification_id=specification.id AND submission.result_type='numeric'
        AND (boundary.lower_limit IS NULL OR CASE WHEN boundary.lower_inclusive THEN submission.number_value>=boundary.lower_limit ELSE submission.number_value>boundary.lower_limit END)
        AND (boundary.upper_limit IS NULL OR CASE WHEN boundary.upper_inclusive THEN submission.number_value<=boundary.upper_limit ELSE submission.number_value<boundary.upper_limit END)
      ORDER BY boundary.display_order, boundary.id LIMIT 1) boundary ON true
    WHERE product.organization_id=$1 AND product.sample_id=$2 AND test.status<>'cancelled'
    ORDER BY product.display_order, product.id, test.display_order, test.id`, [identity.organization_id, sampleId]);
  return result.rows;
}

export async function reportOptions(client, identity, sampleId) {
  requireRead(identity);
  const { sample, access } = await reportSample(client, identity, sampleId);
  const templates = await client.query(`SELECT template.id, template.code, version.name, version.id AS "versionId", version.status
    FROM templates template JOIN LATERAL (SELECT * FROM template_versions version WHERE version.organization_id=template.organization_id AND version.template_id=template.id
      AND version.status IN ('draft','frozen') ORDER BY (version.status='draft') DESC, version.number DESC LIMIT 1) version ON true
    WHERE template.organization_id=$1 AND template.active AND version.kind='report' ORDER BY lower(version.name), template.id`, [identity.organization_id]);
  const defaults = await client.query("SELECT template_id AS \"templateId\" FROM sample_category_templates WHERE organization_id=$1 AND sample_category_id=$2 AND purpose='report' AND is_default ORDER BY template_id", [identity.organization_id, sample.sample_category_id]);
  const results = await reportCandidates(client, identity, sampleId);
  const products = new Map();
  for (const result of results) {
    if (!products.has(result.sampleProductId)) products.set(result.sampleProductId, { id: result.sampleProductId, name: result.productName, tests: [] });
    products.get(result.sampleProductId).tests.push({ id: result.sampleTestId, parameterName: result.parameterName, methodName: result.methodName,
      hasSubmission: result.submissionId !== null, isApproved: result.testStatus === 'completed' && result.datasheetStatus === 'approved' });
  }
  return { sample: { id: sample.id, sampleNumber: sample.sample_number, revision: sample.revision, status: sample.status }, templates: templates.rows, defaultTemplateId: defaults.rows[0]?.templateId ?? null,
    products: [...products.values()], requireApprovedTestRequests: access.state?.require_all_test_requests_approved || access.permissionFallbackActions.printCoa,
    canGenerate: identity.permission_codes.includes('samples.manage') && sample.status !== 'cancelled' };
}

export async function listReports(client, identity, sampleId) {
  requireRead(identity);
  await reportSample(client, identity, sampleId);
  const items = await database(client).select().from(sampleReports).where(and(scope(sampleReports, identity.organization_id), eq(sampleReports.sampleId, sampleId)));
  items.sort((left, right) => right.generatedAt - left.generatedAt || left.groupKey.localeCompare(right.groupKey) || right.revision - left.revision);
  return { items };
}

async function checkReplay(client, identity, sampleId, input) {
  const db = database(client);
  const reports = await db.select().from(sampleReports).where(and(scope(sampleReports, identity.organization_id), eq(sampleReports.generatedEventId, input.requestId)));
  if (!reports.length) return null;
  const reportIds = reports.map((report) => report.id);
  const rows = (await client.query(`SELECT chosen.report_id AS "reportId", chosen.sample_test_id AS "sampleTestId", chosen.sample_product_id AS "sampleProductId", version.template_id AS "templateId"
    FROM sample_report_tests chosen JOIN sample_reports report ON report.organization_id=chosen.organization_id AND report.id=chosen.report_id
    JOIN template_versions version ON version.organization_id=report.organization_id AND version.id=report.template_version_id
    WHERE chosen.organization_id=$1 AND chosen.report_id=ANY($2::uuid[]) ORDER BY chosen.display_order`, [identity.organization_id, reportIds])).rows;
  const expected = new Set(input.selectedSampleTestIds);
  const found = new Set(rows.map((row) => row.sampleTestId));
  const templates = new Map(input.templateSelections.map((selection) => [selection.key, selection.templateId]));
  const settings = (await client.query('SELECT * FROM sample_report_print_settings WHERE organization_id=$1 AND report_id=ANY($2::uuid[])', [identity.organization_id, reportIds])).rows;
  const snake = (key) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  if (reports.some((report) => report.sampleId !== sampleId || report.generatedBy !== identity.user_id || report.sampleRevision !== input.revision || report.reportType !== input.reportType || report.isFinalized !== input.finalizeSample)
    || expected.size !== found.size || [...expected].some((id) => !found.has(id))
    || rows.some((row) => templates.get(input.reportType === 'consolidated' ? 'consolidated' : row.sampleProductId) !== row.templateId)
    || settings.some((setting) => Object.entries(input.printConfig).some(([key, value]) => typeof value === 'string' && ['scale', 'xMargin', 'topMargin', 'bottomMargin'].includes(key)
      ? Number(setting[snake(key)]) !== Number(value) : setting[snake(key)] !== value))) throw new HttpError(409, 'report_request_reused', 'This generation request was already used with different details.');
  reportGroups(rows, input);
  return { items: reports.map(reportSummary), replayed: true };
}

export async function generateReports(client, identity, sampleId, rawInput) {
  try { return await generateReportRevisions(client, identity, sampleId, rawInput); }
  catch (error) {
    if (error.constraint === 'report_asset_unavailable') throw new HttpError(409, 'report_asset_unavailable', 'A selected report header or footer was deleted. Choose an available template asset before generating.');
    throw error;
  }
}

async function generateReportRevisions(client, identity, sampleId, rawInput) {
  requirePermission(identity, 'samples.manage');
  const input = reportGenerationInput(rawInput);
  const { sample, access } = await reportSample(client, identity, sampleId, { lock: true });
  const replay = await checkReplay(client, identity, sampleId, input);
  if (replay) return { ...replay, sample: { id: sample.id, revision: sample.revision, status: sample.status } };
  if (sample.revision !== input.revision) throw new HttpError(409, 'stale_sample', 'The sample changed. Reload before generating reports.');
  if (sample.status === 'cancelled') throw new HttpError(409, 'sample_cancelled', 'Cancelled samples cannot generate reports.');
  const candidates = await reportCandidates(client, identity, sampleId);
  if (!candidates.length) throw new HttpError(409, 'sample_has_no_results', 'The sample has no tests to report.');
  const requireApproved = access.state?.require_all_test_requests_approved || access.permissionFallbackActions.printCoa;
  if (requireApproved && candidates.some((result) => result.testStatus !== 'completed' || result.datasheetStatus !== 'approved')) throw new HttpError(409, 'report_tests_unapproved', 'Approve all test requests before generating reports.');
  const groups = reportGroups(candidates, input);
  if (groups.some((group) => group.results.some((result) => !result.submissionId || !['under_review', 'approved'].includes(result.requestStatus) || !['under_review', 'approved'].includes(result.datasheetStatus)))) throw new HttpError(409, 'report_result_missing', 'Every selected test needs a submitted result.');
  const actors = new Map((await client.query('SELECT * FROM laboratory_actor_labels($1::uuid[])', [[...new Set(groups.flatMap((group) => group.results.map((result) => result.submittedBy)))]] )).rows.map((actor) => [actor.user_id, actor.display_name]));
  const selectedResults = groups.flatMap((group) => group.results);
  const { versions, models, definitions } = await resolveCaptureVersions(client, identity, groups.map((group) => group.templateId),
    { kind: 'report', additionalVersionIds: selectedResults.filter((result) => result.source === 'section').map((result) => result.versionId) });
  const history = await reportFinalSections(client, identity, selectedResults, definitions);
  const imageCounts = new Map(groups.map((group) => [group.key, assertReportSize(models.get(group.templateId), group.results, history.finalCaptures, history.datasheetModels).imageCounts ?? {}]));
  const db = database(client);
  await db.insert(sampleEvents).values({ organizationId: identity.organization_id, id: input.requestId, sampleId,
    eventType: input.finalizeSample ? 'reports_finalized' : 'reports_generated', actorUserId: identity.user_id,
    description: `${input.finalizeSample ? 'Finalised and generated' : 'Generated'} ${groups.length} ${input.reportType.replaceAll('_', ' ')} report${groups.length === 1 ? '' : 's'}.` });
  const previous = (await client.query('SELECT DISTINCT ON(group_key) group_key, report_number, revision FROM sample_reports WHERE organization_id=$1 AND sample_id=$2 ORDER BY group_key, revision DESC', [identity.organization_id, sampleId])).rows;
  const byGroup = new Map(previous.map((row) => [row.group_key, row]));
  const reports = [];
  for (const group of groups) {
    const prior = byGroup.get(group.key);
    const reportNumber = prior?.report_number ?? (await client.query('SELECT report_next_number() AS number')).rows[0].number;
    const id = randomUUID();
    // Copy timestamps inside PostgreSQL: a JavaScript Date would discard the
    // original microseconds and change the historical record.
    const report = (await client.query(`INSERT INTO sample_reports(organization_id, id, sample_id, template_version_id, report_number, revision, report_type, group_key,
      sample_product_id, sample_test_id, generated_by, generated_event_id, sample_revision, sample_number, sample_type, sample_category_name, customer_name, customer_address,
      customer_reference, received_at, registered_at, due_at, description, is_finalized)
      SELECT $1,$2,sample.id,$4,$5,$6,$7,$8,$9,$10,$11,$12,sample.revision,sample.sample_number,sample.sample_type,sample.category_name,sample.customer_name,sample.customer_address,
        sample.customer_reference,sample.received_at,sample.registered_at,sample.due_at,sample.description,$13
      FROM samples sample WHERE sample.organization_id=$1 AND sample.id=$3
      RETURNING id, report_number AS "reportNumber", revision, report_type AS "reportType", group_key AS "groupKey", status, is_finalized AS "isFinalized", generated_at AS "generatedAt"`,
    [identity.organization_id, id, sampleId, versions.get(group.templateId), reportNumber, (prior?.revision ?? 0) + 1, input.reportType, group.key,
      group.sampleProductId, group.sampleTestId, identity.user_id, input.requestId, input.finalizeSample])).rows[0];
    await insertBatch(db, sampleReportTests, group.results.map((row, displayOrder) => ({ organizationId: identity.organization_id, reportId: id, displayOrder,
      sampleTestId: row.sampleTestId, sampleProductId: row.sampleProductId, testRequestId: row.testRequestId, submissionId: row.submissionId, specificationId: row.specificationId,
      decisionLimitId: row.decisionLimitId, productCode: row.productCode, productName: row.productName, requestNumber: row.requestNumber, analystName: actors.get(row.submittedBy),
      isAccredited: row.isAccredited, requestStatus: row.requestStatus, datasheetStatus: row.datasheetStatus,
      completedAt: sql`(SELECT completed_at FROM test_requests WHERE organization_id=${identity.organization_id} AND id=${row.testRequestId})` })));
    await db.insert(sampleReportPrintSettings).values({ organizationId: identity.organization_id, reportId: id, ...input.printConfig });
    reports.push(report);
  }
  // Validate the actual captured assets for all groups before this transaction
  // can complete. No per-report/field content query or partial finalisation.
  await loadReportAssetBatch(client, identity.organization_id, reports.map((report) => report.id), Object.fromEntries(reports.map((report) => [report.id, imageCounts.get(report.groupKey)])));
  const sampleRevision = input.finalizeSample
    ? (await client.query('SELECT report_finalize_sample($1) AS revision', [input.requestId])).rows[0].revision : sample.revision;
  return { items: reports, replayed: false, sample: { id: sample.id, revision: sampleRevision, status: input.finalizeSample ? 'completed' : sample.status } };
}

async function reportFinalSections(client, identity, results, definitions) {
  const sectionResults = results.filter((result) => result.source === 'section');
  const captured = sectionResults.length ? await loadCaptures(client, identity.organization_id, sectionResults.map((result) => ({ instanceId: result.instanceId, revision: result.captureRevision })))
    : { captures: new Map(), metrics: { queryCount: 0, databaseMs: 0 } };
  const finalCaptures = {}; const datasheetModels = {};
  for (const result of sectionResults) {
    const capture = captured.captures.get(result.instanceId);
    const definition = definitions.get(result.versionId);
    if (capture.instance.version_id !== result.versionId || capture.instance.status !== 'frozen' || definition.model.version.status !== 'frozen') throw new HttpError(409, 'report_history_unavailable', 'The submitted result history is unavailable.');
    const sectionRoots = finalResultSectionRoots(definition.model, capture.occurrences);
    if (!sectionRoots.length) throw new HttpError(409, 'report_history_unavailable', 'The submitted final-result sections are unavailable.');
    finalCaptures[result.instanceId] = { versionId: result.versionId, revision: capture.revision, sectionRoots,
      occurrences: capture.occurrences, values: datasheetCaptureView(capture).values };
    datasheetModels[result.versionId] ??= datasheetTemplateView(definition.model);
  }
  return { finalCaptures, datasheetModels, metrics: captured.metrics };
}

export async function loadReport(client, identity, reportId) {
  requireRead(identity); uuid(reportId, 'Report');
  const db = database(client);
  const [report] = await db.select().from(sampleReports).where(and(scope(sampleReports, identity.organization_id), eq(sampleReports.id, reportId)));
  if (!report) throw new HttpError(404, 'report_not_found', 'Report was not found.');
  await requireWorkflowAction(client, identity, { type: 'sample', id: report.sampleId }, 'printCoa');
  const [printConfig] = await db.select().from(sampleReportPrintSettings).where(and(scope(sampleReportPrintSettings, identity.organization_id), eq(sampleReportPrintSettings.reportId, reportId)));
  const results = (await client.query(`SELECT chosen.sample_test_id AS id, chosen.sample_product_id AS "sampleProductId", chosen.test_request_id AS "testRequestId", chosen.submission_id AS "submissionId",
    chosen.product_code AS "productCode", chosen.product_name AS "productName", chosen.request_number AS "requestNumber", chosen.analyst_name AS "analystName", chosen.is_accredited AS "isAccredited",
    chosen.request_status AS "requestStatus", chosen.datasheet_status AS "datasheetStatus", chosen.completed_at AS "completedAt",
    specification.parameter_name AS "parameterName", specification.method_name AS "methodName", specification.rule_name AS specification,
    submission.unit_symbol AS "measurementUnit", submission.submitted_at AS "submittedAt", submission.source, submission.instance_id AS "instanceId", submission.version_id AS "versionId", submission.capture_revision AS "captureRevision",
    submission.result_type AS "resultType", submission.number_value AS "numberValue", submission.text_value AS "textValue", submission.boolean_value AS "booleanValue", boundary.outcome AS "decisionOutcome"
    FROM sample_report_tests chosen JOIN analytical_specifications specification ON specification.organization_id=chosen.organization_id AND specification.id=chosen.specification_id
    JOIN datasheet_submissions submission ON submission.organization_id=chosen.organization_id AND submission.id=chosen.submission_id
    LEFT JOIN analytical_specification_limits boundary ON boundary.organization_id=chosen.organization_id AND boundary.specification_id=chosen.specification_id AND boundary.id=chosen.decision_limit_id
    WHERE chosen.organization_id=$1 AND chosen.report_id=$2 ORDER BY chosen.display_order`, [identity.organization_id, reportId])).rows;
  for (const result of results) result.finalResult = result.resultType === 'numeric' ? result.numberValue : result.resultType === 'boolean' ? result.booleanValue : result.textValue;
  const sectionResults = results.filter((result) => result.source === 'section');
  const loaded = await loadDefinitions(client, identity.organization_id, [...new Set([report.templateVersionId, ...sectionResults.map((result) => result.versionId)])]);
  const { finalCaptures, datasheetModels, metrics: captureMetrics } = await reportFinalSections(client, identity, results, loaded.definitions);
  const definition = loaded.definitions.get(report.templateVersionId);
  const size = assertReportSize(definition.model, results, finalCaptures, datasheetModels);
  const productSelectors = [...loaded.definitions.values()].flatMap(({ model }) => Object.values(model.fieldsById)
    .filter((field) => field.widget === 'product_detail_widget').map((field) => field.alias));
  const productLineId = report.productContextLineId ?? report.sampleProductId;
  if (productSelectors.length && !productLineId) throw new HttpError(409, 'incomplete_sample_product_history', 'This report has no recorded Product context.');
  const products = productSelectors.length ? await loadSampleProductContext(client, identity, report.sampleId, productSelectors,
    { sampleProductIds: [...new Set([productLineId, ...results.map((result) => result.sampleProductId)])] }) : null;
  const branding = await loadReportAssets(client, identity.organization_id, reportId, size.imageCounts);
  return { report, sample: { sampleNumber: report.sampleNumber, sampleCategoryName: report.sampleCategoryName, customerName: report.customerName, customerAddress: report.customerAddress,
    customerReference: report.customerReference, receivedAt: report.receivedAt, registeredAt: report.registeredAt, dueAt: report.dueAt, description: report.description },
    results, printConfig, model: templateView(definition.model), finalCaptures, datasheetModels, assets: branding.assets,
    ...(products ? { productDetailsByLineId: products.productDetailsByLineId, primaryProductLineId: productLineId, productLineId } : {}),
    metrics: { definition: loaded.metrics, capture: captureMetrics, assets: branding.metrics, ...(products ? { products: products.metrics } : {}), ...size } };
}
