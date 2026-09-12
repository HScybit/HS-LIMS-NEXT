import { database } from '../db/pool.js';
import { HttpError } from '../auth/errors.js';
import { datasheetSubmissions, sampleEvents } from '../db/sample-schema.js';
import { requirePermission, uuid, revision, fieldsOnly, text } from '../templates/input.js';
import { requireCaptureWrite } from '../templates/access.js';
import { loadCapture, loadDefinition } from '../templates/loader.js';
import { calculateCapture } from '../templates/calculations.js';
import { datasheetRecord } from './service.js';
import { resolveFinalResult, validateSubmissionValues } from './final-result.js';

async function submissionUnit(client, identity, sheet, selectedId) {
  const specification = (await client.query(`SELECT specification.measurement_unit_id AS "measurementUnitId", specification.unit_revision AS "unitRevision",
    specification.unit_code AS "unitCode", specification.unit_name AS "unitName", specification.unit_symbol AS "unitSymbol", specification.unit_dimension AS "unitDimension"
    FROM datasheets sheet JOIN analytical_specifications specification ON specification.organization_id=sheet.organization_id AND specification.id=sheet.specification_id
    WHERE sheet.organization_id=$1 AND sheet.id=$2`, [identity.organization_id, sheet.id])).rows[0];
  if (selectedId === undefined || selectedId === specification.measurementUnitId) return specification;
  if (selectedId === null) return { measurementUnitId: null };
  // Same lock discipline as scientific master snapshot creation. The selected
  // alternate unit is copied once; later edits cannot reinterpret this result.
  await client.query('SELECT laboratory_lock_references($1,$2::uuid[])', ['measurement_units', [selectedId]]);
  const selected = (await client.query(`SELECT id AS "measurementUnitId", revision AS "unitRevision", code AS "unitCode", name AS "unitName", symbol AS "unitSymbol", dimension AS "unitDimension"
    FROM measurement_units WHERE organization_id=$1 AND id=$2 AND active`, [identity.organization_id, selectedId])).rows[0];
  if (!selected) throw new HttpError(422, 'invalid_measurement_unit', 'Measurement unit is unavailable.');
  return selected;
}

export async function submitDatasheet(client, identity, datasheetId, input) {
  requirePermission(identity, 'datasheets.execute'); uuid(datasheetId, 'Datasheet');
  fieldsOnly(input, ['revision', 'captureRevision', 'measurementUnitId', 'narration']);
  revision(input.revision); revision(input.captureRevision);
  if (input.measurementUnitId != null) uuid(input.measurementUnitId, 'Measurement unit');
  const narration = input.narration == null ? null : text(input.narration, 'Narration', 5000, { optional: true });
  if (!(await client.query('SELECT laboratory_lock_datasheet($1) AS found', [datasheetId])).rows[0].found) throw new HttpError(404, 'datasheet_not_found', 'Datasheet was not found.');
  const sheet = await datasheetRecord(client, identity, datasheetId);
  if (!sheet.assignedAnalyst) throw new HttpError(403, 'datasheet_not_assigned', 'Only the assigned analyst can submit this datasheet.');
  if (!['in_progress', 'rejected'].includes(sheet.status) || !['allocated', 'in_progress', 'rejected'].includes(sheet.requestStatus)) {
    throw new HttpError(409, 'datasheet_closed', 'Only an open datasheet can be submitted.');
  }
  if (sheet.revision !== input.revision) throw new HttpError(409, 'stale_datasheet', 'This datasheet changed. Reload before submitting.');
  const capture = await loadCapture(client, identity.organization_id, sheet.templateInstanceId);
  if (capture.revision !== input.captureRevision || capture.instance.status !== 'editing') throw new HttpError(409, 'stale_capture', 'This datasheet changed or was frozen. Reload before submitting.');
  await requireCaptureWrite(client, sheet.templateInstanceId);
  if ((await client.query(`SELECT approval.id FROM approval_cases approval JOIN workflow_runs run ON run.organization_id=approval.organization_id AND run.id=approval.workflow_run_id
    WHERE run.organization_id=$1 AND run.test_request_id=$2 AND approval.status='pending'`, [identity.organization_id, sheet.testRequestId])).rowCount) {
    throw new HttpError(409, 'approval_already_pending', 'A workflow approval is already pending for this test request.');
  }
  const { model, metrics } = await loadDefinition(client, identity.organization_id, capture.instance.version_id);
  const calculation = calculateCapture(model, capture.occurrences, capture.values);
  validateSubmissionValues(model, capture, calculation);
  const result = resolveFinalResult(model, capture.occurrences, capture.values);
  const unit = await submissionUnit(client, identity, sheet, input.measurementUnitId);
  const organizationId = identity.organization_id; const db = database(client);
  const captureRevision = capture.revision + 1;
  await client.query("UPDATE template_instances SET status='frozen', revision=revision+1 WHERE organization_id=$1 AND id=$2", [organizationId, sheet.templateInstanceId]);
  const number = (await client.query('SELECT coalesce(max(number),0)+1 AS number FROM datasheet_submissions WHERE organization_id=$1 AND datasheet_id=$2', [organizationId, datasheetId])).rows[0].number;
  const [submission] = await db.insert(datasheetSubmissions).values({ ...result, ...unit, organizationId, datasheetId, number,
    instanceId: sheet.templateInstanceId, versionId: model.version.id, captureRevision, narration, submittedBy: identity.user_id }).returning();
  const updated = (await client.query(`UPDATE datasheets SET status='under_review', revision=revision+1, latest_submission_id=$3, completed_by=$4, completed_at=now()
    WHERE organization_id=$1 AND id=$2 RETURNING revision`, [organizationId, datasheetId, submission.id, identity.user_id])).rows[0];
  await client.query(`UPDATE test_requests SET final_datasheet_id=$3, status='under_review', started_at=coalesce(started_at,now()), revision=revision+1
    WHERE organization_id=$1 AND id=$2`, [organizationId, sheet.testRequestId, datasheetId]);
  await db.insert(sampleEvents).values({ organizationId, sampleId: sheet.sampleId, testRequestId: sheet.testRequestId,
    eventType: 'datasheet_submitted', actorUserId: identity.user_id, description: `Submitted datasheet attempt ${sheet.attemptNumber} for review.` });
  return { id: datasheetId, status: 'under_review', revision: updated.revision, captureRevision, submission,
    metrics: { definition: metrics, capture: capture.metrics, calculationMs: calculation.durationMs } };
}
