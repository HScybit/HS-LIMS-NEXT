import { database } from '../db/pool.js';
import { HttpError } from '../auth/errors.js';
import { datasheetSubmissions, sampleEvents, jobSubmissionMembers } from '../db/sample-schema.js';
import { requirePermission, uuid, revision, fieldsOnly, text } from '../templates/input.js';
import { requireCaptureWrite } from '../templates/access.js';
import { loadCaptures, loadDefinitions } from '../templates/loader.js';
import { calculateCapture } from '../templates/calculations.js';
import { datasheetRecord } from './service.js';
import { resolveFinalResult, validateSubmissionValues } from './final-result.js';
import { loadJobSubmissionMembers, prepareJobSubmissions } from './group-submission.js';
import { insertBatch } from '../templates/authoring.js';

async function submissionUnit(client, identity, sheet, selectedId) {
  const specification = (await client.query(`SELECT specification.measurement_unit_id AS "measurementUnitId", specification.unit_revision AS "unitRevision",
    specification.unit_code AS "unitCode", specification.unit_name AS "unitName", specification.unit_symbol AS "unitSymbol", specification.unit_dimension AS "unitDimension"
    FROM datasheets sheet JOIN analytical_specifications specification ON specification.organization_id=sheet.organization_id AND specification.id=sheet.specification_id
    WHERE sheet.organization_id=$1 AND sheet.id=$2`, [identity.organization_id, sheet.id])).rows[0] ?? { measurementUnitId: null };
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

async function insertSubmission(client, identity, details) {
  const number = (await client.query('SELECT coalesce(max(number),0)+1 AS number FROM datasheet_submissions WHERE organization_id=$1 AND datasheet_id=$2', [identity.organization_id, details.datasheetId])).rows[0].number;
  const [submission] = await database(client).insert(datasheetSubmissions).values({ ...details, organizationId: identity.organization_id, number, submittedBy: identity.user_id }).returning();
  return submission;
}

async function completeSubmittedSheet(client, identity, sheet, submission, sampleId, description) {
  const updated = (await client.query(`UPDATE datasheets SET status='under_review',revision=revision+1,latest_submission_id=$3,completed_by=$4,completed_at=now()
    WHERE organization_id=$1 AND id=$2 RETURNING revision`, [identity.organization_id, sheet.id, submission.id, identity.user_id])).rows[0];
  await client.query(`UPDATE test_requests SET final_datasheet_id=$3,status='under_review',started_at=coalesce(started_at,now()),revision=revision+1
    WHERE organization_id=$1 AND id=$2`, [identity.organization_id, sheet.testRequestId, sheet.id]);
  await database(client).insert(sampleEvents).values({ organizationId: identity.organization_id, sampleId, testRequestId: sheet.testRequestId,
    eventType: 'datasheet_submitted', actorUserId: identity.user_id, description });
  return updated.revision;
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
  await requireCaptureWrite(client, sheet.templateInstanceId);
  const members = sheet.isJob ? await loadJobSubmissionMembers(client, identity, sheet) : [];
  const captureIds = [...new Set([sheet.templateInstanceId, ...members.map((member) => member.instanceId)])];
  const batch = await loadCaptures(client, identity.organization_id, captureIds.map((instanceId) => ({ instanceId })), {
    pinnedValues: members.filter((member) => member.entryId).map((member) => ({ instanceId: sheet.templateInstanceId, fieldId: member.fieldId, occurrenceId: member.occurrenceId, revision: member.valueRevision })),
  });
  const capture = batch.captures.get(sheet.templateInstanceId);
  if (capture.revision !== input.captureRevision || capture.instance.status !== 'editing') throw new HttpError(409, 'stale_capture', 'This datasheet changed or was frozen. Reload before submitting.');
  if ((await client.query(`SELECT approval.id FROM approval_cases approval JOIN workflow_runs run ON run.organization_id=approval.organization_id AND run.id=approval.workflow_run_id
    WHERE run.organization_id=$1 AND run.test_request_id=$2 AND approval.status='pending'`, [identity.organization_id, sheet.testRequestId])).rowCount) {
    throw new HttpError(409, 'approval_already_pending', 'A workflow approval is already pending for this test request.');
  }
  const { definitions, metrics } = await loadDefinitions(client, identity.organization_id, [...new Set([...batch.captures.values()].map((item) => item.instance.version_id))]);
  const { model } = definitions.get(capture.instance.version_id);
  const calculation = calculateCapture(model, capture.occurrences, capture.values);
  validateSubmissionValues(model, capture, calculation);
  const result = resolveFinalResult(model, capture.occurrences, capture.values);
  const unit = await submissionUnit(client, identity, sheet, input.measurementUnitId);
  const memberPlans = prepareJobSubmissions(members, batch, definitions, sheet, capture);
  const organizationId = identity.organization_id; const db = database(client);
  const captureRevision = capture.revision + 1;
  await client.query("UPDATE template_instances SET status='frozen', revision=revision+1 WHERE organization_id=$1 AND id=$2", [organizationId, sheet.templateInstanceId]);
  const submission = await insertSubmission(client, identity, { ...result, ...unit, datasheetId, sourceDatasheetId: datasheetId, specificationId: sheet.specificationId,
    instanceId: sheet.templateInstanceId, versionId: model.version.id, captureRevision, narration });
  if (sheet.isJob) {
    await client.query("SELECT set_config('app.job_submission_id',$1,true)", [submission.id]);
    const links = [];
    for (const member of memberPlans) {
      let memberSubmissionId = member.reuseSubmissionId;
      if (!memberSubmissionId) {
        const revision = member.capture.revision + 1;
        if (!member.entryId) await client.query("UPDATE template_instances SET status='frozen',revision=revision+1 WHERE organization_id=$1 AND id=$2", [organizationId, member.instanceId]);
        const recorded = await insertSubmission(client, identity, { ...member.result, ...member.unit, datasheetId: member.datasheetId, sourceDatasheetId: member.sourceDatasheetId,
          specificationId: member.specificationId, jobResultEntryId: member.entryId, instanceId: member.capture.instance.id,
          versionId: member.capture.instance.version_id, captureRevision: revision, narration });
        memberSubmissionId = recorded.id;
        await completeSubmittedSheet(client, identity, { id: member.datasheetId, testRequestId: member.testRequestId }, recorded, sheet.sampleId,
          `Submitted datasheet attempt ${member.attemptNumber} for review as part of job ${sheet.requestNumber}.`);
      }
      links.push({ organizationId, parentSubmissionId: submission.id, testRequestId: member.testRequestId, submissionId: memberSubmissionId });
    }
    await insertBatch(db, jobSubmissionMembers, links);
    await client.query("SELECT set_config('app.job_submission_id','',true)");
  }
  const updatedRevision = await completeSubmittedSheet(client, identity, sheet, submission, sheet.sampleId, `Submitted datasheet attempt ${sheet.attemptNumber} for review.`);
  return { id: datasheetId, status: 'under_review', revision: updatedRevision, captureRevision, submission,
    metrics: { definition: metrics, capture: batch.metrics, calculationMs: calculation.durationMs } };
}
