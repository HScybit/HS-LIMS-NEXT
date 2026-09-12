import { HttpError } from '../auth/errors.js';
import { uuid, revision } from '../templates/input.js';
import { loadCapture, loadDefinition } from '../templates/loader.js';
import { datasheetTemplateView, datasheetCaptureView } from './transport.js';
import { calculateCapture } from '../templates/calculations.js';
import { isContextWidget } from '../templates/context-widgets.js';
import { loadDatasheetContext, assembleDatasheetContext } from './context.js';
import { withTemplateImages } from '../template-assets/service.js';

export async function datasheetRecord(client, identity, datasheetId, sampleId) {
  uuid(datasheetId, 'Datasheet');
  if (sampleId) uuid(sampleId, 'Sample');
  if (!['samples.read', 'samples.manage', 'test_requests.allocate', 'datasheets.execute', 'approvals.respond'].some((permission) => identity.permission_codes?.includes(permission))) {
    throw new HttpError(403, 'forbidden', 'You cannot view datasheets.');
  }
  const result = await client.query(`SELECT sheet.id, sheet.test_request_id AS "testRequestId", sheet.template_instance_id AS "templateInstanceId",
    capture.version_id AS "templateVersionId",capture.revision AS "captureRevision",
    sheet.status, sheet.revision, sheet.attempt_number AS "attemptNumber", request.request_number AS "requestNumber", request.status AS "requestStatus",
    sample.id AS "sampleId", sample.sample_number AS "sampleNumber", coalesce(specification.method_name,'Job') AS "methodName", sheet.specification_id AS "specificationId", request.is_job AS "isJob",
    laboratory_request_can_work(sheet.test_request_id) AS "canWork",
    EXISTS (SELECT 1 FROM test_request_assignments assignment WHERE assignment.organization_id = sheet.organization_id
      AND assignment.test_request_id = sheet.test_request_id AND assignment.assignment_type = 'analyst'
      AND assignment.assigned_user_id = $3 AND assignment.unassigned_at IS NULL) AS "assignedAnalyst"
    FROM datasheets sheet JOIN test_requests request ON request.organization_id = sheet.organization_id AND request.id = sheet.test_request_id
    JOIN template_instances capture ON capture.organization_id=sheet.organization_id AND capture.id=sheet.template_instance_id
    JOIN laboratory_test_request_context product ON product.organization_id=request.organization_id AND product.test_request_id=request.id
    JOIN samples sample ON sample.organization_id = product.organization_id AND sample.id = product.sample_id
    LEFT JOIN analytical_specifications specification ON specification.organization_id = sheet.organization_id AND specification.id = sheet.specification_id
    WHERE sheet.organization_id = $1 AND sheet.id = $2 AND ($4::uuid IS NULL OR sample.id = $4)`,
  [identity.organization_id, datasheetId, identity.user_id, sampleId ?? null]);
  if (!result.rowCount) throw new HttpError(404, 'datasheet_not_found', 'Datasheet was not found.');
  return result.rows[0];
}

export async function loadDatasheet(client, identity, datasheetId, { sampleId, atRevision } = {}) {
  if (atRevision !== undefined) revision(atRevision);
  const started = performance.now();
  const sheet = await datasheetRecord(client, identity, datasheetId, sampleId);
  const metadataMs = performance.now() - started;
  const captureRevision = atRevision ?? sheet.captureRevision;
  const definition = await loadDefinition(client, identity.organization_id, sheet.templateVersionId);
  const context = Object.values(definition.model.fieldsById).some((field) => isContextWidget(field.widget))
    ? await loadDatasheetContext(client, identity, sheet, captureRevision) : null;
  const capture = await loadCapture(client, identity.organization_id, sheet.templateInstanceId, captureRevision, { pinnedValues: context?.pinnedValues ?? [] });
  const calculation = calculateCapture(definition.model, capture.occurrences, capture.values);
  const withImages = await withTemplateImages(client, identity.organization_id, definition, capture);
  const projectionStart = performance.now();
  const modelView = datasheetTemplateView(withImages.model); const runtimeView = datasheetCaptureView(capture);
  const projectionMs = performance.now() - projectionStart;
  return { datasheet: sheet, model: modelView, capture: runtimeView, dataContext: context ? assembleDatasheetContext(context, capture) : undefined, validation: calculation.validation,
    canExecute: atRevision === undefined && sheet.canWork && identity.permission_codes.includes('datasheets.execute') && sheet.assignedAnalyst
      && ['allocated', 'in_progress', 'rejected'].includes(sheet.requestStatus) && ['in_progress', 'rejected'].includes(sheet.status) && capture.instance.status === 'editing',
    metrics: { metadataQueryCount: context ? 2 : 1, metadataMs: metadataMs + (context?.databaseMs ?? 0), definition: definition.metrics, capture: capture.metrics,
      ...(withImages.metrics.assets ? { assets: withImages.metrics.assets } : {}), calculationMs: calculation.durationMs, projectionMs } };
}
