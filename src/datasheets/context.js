// One metadata statement loads the source data widgets for the whole datasheet.
// Scientific labels come from frozen specifications; actor labels use a bounded
// tenant-scoped lookup. No per-widget request or serialized context is persisted.
import { valuePayload } from '../templates/calculations.js';

export async function loadDatasheetContext(client, identity, sheet, captureRevision) {
  const started = performance.now();
  const result = await client.query(`WITH selected_results AS MATERIALIZED (
    SELECT DISTINCT ON(subject.test_request_id) subject.test_request_id,entry.id,entry.child_datasheet_id,entry.instance_id,entry.field_id,entry.occurrence_id,entry.value_revision,entry.recorded_by,entry.recorded_at
    FROM job_result_entries entry JOIN datasheet_subjects subject ON subject.organization_id=entry.organization_id AND subject.id=entry.subject_id
    WHERE $3 AND entry.organization_id=$1 AND entry.datasheet_id=$4 AND entry.value_revision<=$6
    ORDER BY subject.test_request_id,entry.value_revision DESC,entry.position DESC
  ), members AS MATERIALIZED (
    SELECT request.id AS "testRequestId",request.request_number AS "requestNumber",product.product_name AS "productName",
      specification.parameter_name AS "parameterName",specification.method_name AS "methodName",specification.unit_symbol AS "measurementUnit",specification.rule_name AS specification,
      submission.submitted_at AS "submittedAt",source_sheet.completed_at AS "completedAt",
      CASE WHEN selected.id IS NOT NULL THEN selected.recorded_by ELSE coalesce(submission.submitted_by,assignment.assigned_user_id) END AS analyst_id,
      CASE WHEN selected.id IS NULL THEN submission.result_type END AS result_type,
      CASE WHEN selected.id IS NULL THEN submission.number_value END AS number_value,
      CASE WHEN selected.id IS NULL THEN submission.text_value END AS text_value,CASE WHEN selected.id IS NULL THEN submission.boolean_value END AS boolean_value,
      selected.id AS "resultEntryId",selected.child_datasheet_id AS "resultDatasheetId",selected.recorded_at AS "resultSavedAt",
      selected.instance_id AS "resultInstanceId",selected.field_id AS "resultFieldId",selected.occurrence_id AS "resultOccurrenceId",selected.value_revision AS "resultValueRevision",request.job_member_position
    FROM test_requests request JOIN laboratory_test_request_context product ON product.organization_id=request.organization_id AND product.test_request_id=request.id
    LEFT JOIN datasheets initial_sheet ON initial_sheet.organization_id=request.organization_id AND initial_sheet.test_request_id=request.id AND initial_sheet.attempt_number=1
    LEFT JOIN datasheets source_sheet ON source_sheet.organization_id=request.organization_id
      AND source_sheet.id=CASE WHEN $3 THEN coalesce(request.final_datasheet_id,initial_sheet.id) ELSE $4::uuid END
    JOIN analytical_specifications specification ON specification.organization_id=request.organization_id
      AND specification.id=CASE WHEN $3 THEN request.specification_id ELSE source_sheet.specification_id END
    LEFT JOIN datasheet_submissions submission ON submission.organization_id=source_sheet.organization_id AND submission.id=source_sheet.latest_submission_id
    LEFT JOIN selected_results selected ON selected.test_request_id=request.id AND (submission.id IS NULL OR selected.recorded_at>=submission.submitted_at)
    LEFT JOIN test_request_assignments assignment ON assignment.organization_id=request.organization_id AND assignment.test_request_id=request.id
      AND assignment.assignment_type='analyst' AND assignment.unassigned_at IS NULL
    WHERE request.organization_id=$1 AND (($3 AND request.parent_test_request_id=$2) OR (NOT $3 AND request.id=$2))
  ), actors AS MATERIALIZED (SELECT * FROM laboratory_actor_labels(ARRAY(SELECT DISTINCT analyst_id FROM members WHERE analyst_id IS NOT NULL)))
  SELECT members.*,actors.display_name AS "analystName",sample.sample_number AS "sampleNumber",sample.customer_name AS "customerName",
    sample.customer_address AS "customerAddress",sample.category_name AS "sampleCategoryName",sample.received_at AS "receivedAt",sample.registered_at AS "registeredAt",
    sample.due_at AS "dueAt",sample.description,sample.customer_reference AS "customerReference"
  FROM members LEFT JOIN actors ON actors.user_id=members.analyst_id JOIN samples sample ON sample.organization_id=$1 AND sample.id=$5
  ORDER BY members.job_member_position,members."testRequestId"`, [identity.organization_id, sheet.testRequestId, sheet.isJob, sheet.id, sheet.sampleId, captureRevision]);
  return { rows: result.rows, pinnedValues: result.rows.filter((row) => row.resultEntryId).map((row) => ({ instanceId: row.resultInstanceId, fieldId: row.resultFieldId,
    occurrenceId: row.resultOccurrenceId, revision: row.resultValueRevision })), databaseMs: performance.now() - started };
}

export function assembleDatasheetContext(context, capture) {
  const first = context.rows[0];
  const sample = first ? Object.fromEntries(['sampleNumber', 'customerName', 'customerAddress', 'sampleCategoryName', 'receivedAt', 'registeredAt', 'dueAt', 'description', 'customerReference'].map((key) => [key, first[key]])) : {};
  const results = context.rows.map((row, index) => ({ id: row.testRequestId, serialNumber: index + 1, ...Object.fromEntries(['testRequestId', 'requestNumber', 'productName', 'parameterName', 'methodName', 'measurementUnit', 'specification', 'analystName', 'submittedAt', 'completedAt', 'resultEntryId', 'resultDatasheetId', 'resultSavedAt'].map((key) => [key, row[key]])),
    finalResult: row.resultEntryId ? valuePayload(capture.pinnedValues.get(`${row.resultInstanceId}:${row.resultFieldId}:${row.resultOccurrenceId}:${row.resultValueRevision}`))
      : row.result_type === 'numeric' ? row.number_value : row.result_type === 'boolean' ? row.boolean_value : row.text_value }));
  return { sample, results, parametersByRequestId: Object.fromEntries(results.map((row) => [row.testRequestId, row])) };
}
