import { HttpError } from '../auth/errors.js';
import { calculateCapture } from '../templates/calculations.js';
import { resolveFinalResult, resolveRecordedResult, validateSubmissionValues } from './final-result.js';

// One ownership/selection query for the whole group. Captured values and
// definitions are loaded separately in the shared three/eight statement batches.
export async function loadJobSubmissionMembers(client, identity, sheet) {
  await client.query('SELECT laboratory_lock_job_members($1)', [sheet.id]);
  const result = await client.query(`SELECT member.id AS "testRequestId",member.request_number AS "requestNumber",member.status AS "requestStatus",
      chosen.id AS "datasheetId",chosen.status,chosen.attempt_number AS "attemptNumber",chosen.template_instance_id AS "instanceId",capture.version_id AS "versionId",
      existing.id AS "existingSubmissionId",existing.job_result_entry_id AS "existingEntryId",
      entry.id AS "entryId",entry.field_id AS "fieldId",entry.occurrence_id AS "occurrenceId",entry.value_revision AS "valueRevision",
      specification.id AS "specificationId",specification.measurement_unit_id AS "measurementUnitId",specification.unit_revision AS "unitRevision",
      specification.unit_code AS "unitCode",specification.unit_name AS "unitName",specification.unit_symbol AS "unitSymbol",specification.unit_dimension AS "unitDimension",
      EXISTS (SELECT 1 FROM workflow_runs run JOIN approval_cases approval ON approval.organization_id=run.organization_id AND approval.workflow_run_id=run.id
        WHERE run.organization_id=member.organization_id AND run.test_request_id=member.id AND approval.status='pending') AS "approvalPending"
    FROM test_requests member
    LEFT JOIN LATERAL (SELECT candidate.* FROM datasheets candidate WHERE candidate.organization_id=member.organization_id AND candidate.test_request_id=member.id AND candidate.status<>'void'
      ORDER BY (candidate.id=member.final_datasheet_id) DESC NULLS LAST,candidate.attempt_number DESC,candidate.created_at DESC,candidate.id LIMIT 1) fallback ON true
    LEFT JOIN datasheet_submissions current_result ON current_result.organization_id=fallback.organization_id AND current_result.id=fallback.latest_submission_id
    LEFT JOIN LATERAL (SELECT candidate.*,subject.specification_id FROM job_result_entries candidate JOIN datasheet_subjects subject
      ON subject.organization_id=candidate.organization_id AND subject.id=candidate.subject_id
      WHERE candidate.organization_id=member.organization_id AND candidate.datasheet_id=$3 AND subject.test_request_id=member.id
      ORDER BY candidate.value_revision DESC,candidate.position DESC LIMIT 1) latest_entry ON true
    LEFT JOIN job_result_entries entry ON entry.organization_id=latest_entry.organization_id AND entry.id=latest_entry.id
      AND (current_result.id IS NULL OR entry.recorded_at>=current_result.submitted_at)
    LEFT JOIN datasheets chosen ON chosen.organization_id=member.organization_id AND chosen.id=coalesce(entry.child_datasheet_id,fallback.id)
    LEFT JOIN template_instances capture ON capture.organization_id=chosen.organization_id AND capture.id=chosen.template_instance_id
    LEFT JOIN datasheet_submissions existing ON existing.organization_id=chosen.organization_id AND existing.id=chosen.latest_submission_id
    LEFT JOIN analytical_specifications specification ON specification.organization_id=member.organization_id
      AND specification.id=CASE WHEN entry.id IS NOT NULL THEN latest_entry.specification_id ELSE chosen.specification_id END
    WHERE member.organization_id=$1 AND member.parent_test_request_id=$2 ORDER BY member.job_member_position,member.id`, [identity.organization_id, sheet.testRequestId, sheet.id]);
  if (!result.rowCount || result.rowCount > 500) throw new HttpError(409, 'invalid_job_members', 'The job needs between one and 500 linked test requests.');
  for (const member of result.rows) {
    if (!member.datasheetId || member.status === 'void') throw new HttpError(409, 'job_member_datasheet_unavailable', `${member.requestNumber} needs an active datasheet for its selected result.`);
    if (member.approvalPending) throw new HttpError(409, 'job_member_approval_pending', `${member.requestNumber} has an independent approval pending.`);
    if (member.requestStatus === 'cancelled') throw new HttpError(409, 'job_member_cancelled', `${member.requestNumber} was cancelled and cannot receive a new grouped submission.`);
  }
  return result.rows;
}

export function prepareJobSubmissions(members, batch, definitions, parentSheet, parentCapture) {
  return members.map((member) => {
    if (['under_review', 'approved'].includes(member.status) && member.existingSubmissionId && (!member.entryId || member.entryId === member.existingEntryId)) {
      return { ...member, reuseSubmissionId: member.existingSubmissionId };
    }
    if (!['in_progress', 'rejected'].includes(member.status) || !['allocated', 'in_progress', 'rejected'].includes(member.requestStatus)) {
      throw new HttpError(409, 'job_member_closed', `${member.requestNumber} cannot replace its submitted result.`);
    }
    const capture = member.entryId ? parentCapture : batch.captures.get(member.instanceId);
    const model = definitions.get(capture.instance.version_id).model;
    let result;
    if (member.entryId) {
      const value = batch.pinnedValues.get(`${parentSheet.templateInstanceId}:${member.fieldId}:${member.occurrenceId}:${member.valueRevision}`);
      if (!value || value.state !== 'present') throw new HttpError(422, 'job_member_result_required', `Enter a result for ${member.requestNumber}; its last summary result is empty.`);
      result = resolveRecordedResult(model.fieldsById[member.fieldId], value, member.occurrenceId, 'result_widget');
    } else {
      if (capture.instance.status !== 'editing') throw new HttpError(409, 'job_member_capture_closed', `${member.requestNumber} needs a submitted result from its frozen capture.`);
      validateSubmissionValues(model, capture, calculateCapture(model, capture.occurrences, capture.values));
      result = resolveFinalResult(model, capture.occurrences, capture.values);
    }
    const unit = Object.fromEntries(['measurementUnitId', 'unitRevision', 'unitCode', 'unitName', 'unitSymbol', 'unitDimension'].map((key) => [key, member[key]]));
    return { ...member, result, unit, capture, sourceDatasheetId: member.entryId ? parentSheet.id : member.datasheetId };
  });
}
