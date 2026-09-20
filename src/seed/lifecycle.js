import { loadDatasheet } from '../datasheets/service.js';
import { saveCapture } from '../templates/capture.js';
import { submitDatasheet } from '../datasheets/submit.js';
import { requestWorkflowTransition, approveWorkflowAssignment } from '../workflows/requests.js';
import { FLOW_ORDER } from './provision.js';

const flowRank = Object.freeze(Object.fromEntries(FLOW_ORDER.map((flow, index) => [flow, index])));

/**
 * Walks each seeded sample to the stage its scenario names.
 *
 * Everything past allocation belongs to somebody other than the administrator.
 * The analyst records and submits the datasheet and asks for review; the
 * reviewer grants that review and asks for quality approval; the QA approver
 * grants it. Releasing the sample itself is a second workflow with the same
 * shape. Each step therefore runs in a session belonging to the user who would
 * really perform it, which `sessionFor` supplies.
 */
export async function provisionSampleLifecycle({ sessionFor, catalog, samples, userIds }) {
  const expectedByParameter = new Map(catalog.testParameters.map((parameter) => [parameter.key, catalog.limits[parameter.ref]]));
  const counts = { recorded: 0, submitted: 0, reviewed: 0, approved: 0, released: 0, unrecordable: 0, failed: 0 };
  const failures = [];
  const note = (scenario, error) => {
    counts.failed += 1;
    if (failures.length < 20) failures.push({ scenario, reason: error.message });
  };

  for (const sample of samples) {
    const rank = flowRank[sample.flow];
    if (rank < flowRank.results || !sample.assignedUserId || !sample.testRequests.length) continue;
    const analyst = await sessionFor(sample.assignedUserId);
    const reviewer = await sessionFor(userIds.u_reviewer1);
    const approver = await sessionFor(userIds.u_approver);
    if (!analyst) continue;

    let allApproved = Boolean(sample.testRequests.length);
    for (const request of sample.testRequests) {
      try {
        const recorded = await analyst((client, identity) => recordResults(client, identity, request.id, expectedByParameter));
        if (recorded?.unrecordable) { counts.unrecordable += 1; allApproved = false; continue; }
        if (!recorded?.datasheetId) { allApproved = false; continue; }
        counts.recorded += 1;
        if (rank < flowRank.submitted) { allApproved = false; continue; }

        // Submitting the datasheet and asking for review are one step, so the
        // frozen submission is the evidence the review request carries.
        const submitted = await analyst((client, identity) => submitForReview(client, identity, recorded));
        counts.submitted += 1;
        if (rank < flowRank.pending_approval || !submitted?.approvalCaseId || !reviewer) { allApproved = false; continue; }

        await reviewer((client, identity) => respond(client, identity, submitted.approvalCaseId));
        counts.reviewed += 1;
        const pending = await reviewer((client, identity) => advance(client, identity, submitted.runId, 'Sent for quality approval by the seed module.'));
        if (rank < flowRank.approved || !pending?.approvalCaseId || !approver) { allApproved = false; continue; }

        await approver((client, identity) => respond(client, identity, pending.approvalCaseId));
        counts.approved += 1;
      } catch (error) { allApproved = false; note(sample.scenario, new Error(`${error.message.split('\n')[0]} | cause: ${error.cause?.message ?? error.detail ?? error.constraint ?? error.code ?? 'n/a'}`)); }
    }

    // A certificate is only meaningful once every test on the sample is
    // approved, so the sample's own release runs after its requests. Its
    // workflow starts at receipt, so it is walked the whole way: each
    // transition is asked for by somebody whose role may ask for it, and
    // granted by whoever it is actually assigned to.
    if (rank >= flowRank.coa && allApproved) {
      try {
        if (await walkSampleToRelease({ sessionFor, sampleId: sample.id, anySession: analyst })) counts.released += 1;
      } catch (error) { note(sample.scenario, error); }
    }
  }
  return { ...counts, failures };
}

// A recorded numeric result may carry at most two decimal places: the app
// refuses more while its numeric policy is undecided, so a catalog value quoted
// to three or four decimals is rounded rather than dropped. Qualitative results
// ("Complies", "Sterile") pass through as written — unless they begin like a
// number, which the app also refuses rather than guess at a numeric prefix.
// Two catalog results are of that shape, the ASTM copper strip rating "1a" and
// a textile blend composition, and they are left unrecorded.
function recordableResult(result) {
  if (result === undefined || result === null || result === '') return null;
  const text = String(result);
  if (!Number.isNaN(Number(text))) return Number(text).toFixed(Math.min(2, text.split('.')[1]?.length ?? 0));
  return /^[+-]?([0-9]|[.][0-9])/.test(text) ? null : text;
}

/**
 * Records results on a datasheet.
 *
 * The seeded Analytical Datasheet follows V4's layout: one Observed Result
 * field inside a parameter loop, repeated once per test request on the sheet.
 * Each repetition is bound to its request through datasheet_subjects, and the
 * value written is the realistic result the industry catalog publishes for that
 * request's parameter.
 */
async function recordResults(client, identity, requestId, expectedByParameter) {
  const sheet = (await client.query(`SELECT d.id, d.template_instance_id AS "instanceId"
    FROM datasheets d WHERE d.organization_id=$1 AND d.test_request_id=$2 ORDER BY d.created_at LIMIT 1`,
  [identity.organization_id, requestId])).rows[0];
  if (!sheet) return null;
  const loaded = await loadDatasheet(client, identity, sheet.id);
  if (!loaded.canExecute) throw new Error(`Datasheet ${sheet.id} is not executable by the assigned analyst (status ${loaded.datasheet.status}/${loaded.datasheet.requestStatus}).`);

  const all = Object.values(loaded.model.fieldsById ?? {});
  const resultField = all.find((field) => field.widget === 'result_widget');
  const statusField = all.find((field) => field.alias === 'ds_result_status');
  if (!resultField) throw new Error(`Datasheet ${sheet.id} has no result field.`);

  // Which repetition stands for which test request, and which parameter that
  // request was raised for.
  const subjects = (await client.query(`SELECT subject.occurrence_id AS "occurrenceId",
      specification.parameter_master_key AS "parameterKey"
    FROM datasheet_subjects subject
    JOIN analytical_specifications specification ON specification.organization_id=subject.organization_id AND specification.id=subject.specification_id
    WHERE subject.organization_id=$1 AND subject.datasheet_id=$2`, [identity.organization_id, sheet.id])).rows;
  const occurrences = subjects.length
    ? subjects
    : loaded.capture.occurrences.slice(0, 1).map((occurrence) => ({ occurrenceId: occurrence.id, parameterKey: null }));

  const values = [];
  for (const subject of occurrences) {
    const expected = expectedByParameter.get(subject.parameterKey);
    const result = recordableResult(expected?.result);
    if (result === null) continue;
    values.push({ fieldId: resultField.id, occurrenceId: subject.occurrenceId, state: 'present', value: result });
    if (statusField) values.push({ fieldId: statusField.id, occurrenceId: subject.occurrenceId, state: 'present', value: 'Pass' });
  }
  // Every parameter on this sheet is one the app will not accept a result for.
  if (!values.length) return { unrecordable: true };
  const saved = await saveCapture(client, identity, sheet.instanceId, loaded.capture.instance.revision, values);
  return { datasheetId: sheet.id, captureRevision: saved.revision, requestId };
}

async function submitForReview(client, identity, recorded) {
  const current = (await client.query('SELECT revision FROM datasheets WHERE organization_id=$1 AND id=$2',
    [identity.organization_id, recorded.datasheetId])).rows[0];
  await submitDatasheet(client, identity, recorded.datasheetId, {
    revision: current.revision, captureRevision: recorded.captureRevision, narration: 'Results recorded by the seed module.',
  });
  const run = (await client.query('SELECT id FROM workflow_runs WHERE organization_id=$1 AND test_request_id=$2 AND status=\'active\'',
    [identity.organization_id, recorded.requestId])).rows[0];
  if (!run) return null;
  const moved = await advance(client, identity, run.id, 'Submitted for review by the seed module.');
  return { ...recorded, ...moved, runId: run.id };
}

const MAX_SAMPLE_TRANSITIONS = 6;

async function walkSampleToRelease({ sessionFor, sampleId, anySession }) {
  const run = await anySession((client, identity) => client.query(
    "SELECT id FROM workflow_runs WHERE organization_id=$1 AND sample_id=$2 AND status='active'",
    [identity.organization_id, sampleId]).then((result) => result.rows[0]));
  if (!run) return false;

  for (let step = 0; step < MAX_SAMPLE_TRANSITIONS; step += 1) {
    const next = await anySession((client, identity) => nextSampleTransition(client, identity, run.id));
    if (!next) return true; // The run reached a final state.

    const requester = await sessionForAny(sessionFor, next.creatorUserIds);
    if (!requester) return false;
    const moved = await requester((client, identity) => requestWorkflowTransition(client, identity, run.id, {
      revision: next.revision, transitionId: next.transitionId, comment: 'Advanced by the seed module.',
    }));
    if (!moved?.approvalCaseId) continue;

    const assignee = await anySession((client, identity) => pendingAssignee(client, identity, moved.approvalCaseId));
    if (!assignee) return false;
    const grantor = await sessionFor(assignee.assignedUserId);
    if (!grantor) return false;
    await grantor((client, identity) => respond(client, identity, moved.approvalCaseId));
  }
  return true;
}

async function sessionForAny(sessionFor, userIds) {
  for (const userId of userIds) {
    const session = await sessionFor(userId);
    if (session) return session;
  }
  return null;
}

// The transition leaving the run's current state, together with the users whose
// roles are allowed to ask for it.
async function nextSampleTransition(client, identity, runId) {
  const found = (await client.query(`SELECT r.revision, t.id AS "transitionId"
    FROM workflow_runs r
    JOIN workflow_transitions t ON t.organization_id=r.organization_id AND t.workflow_version_id=r.workflow_version_id
      AND t.source_state_id=r.current_state_id
    WHERE r.organization_id=$1 AND r.id=$2 AND r.status='active'
    ORDER BY t.display_order LIMIT 1`, [identity.organization_id, runId])).rows[0];
  if (!found) return null;
  const creators = (await client.query(`SELECT DISTINCT mr.user_id AS "userId"
    FROM workflow_transition_creator_roles cr
    JOIN membership_roles mr ON mr.organization_id=cr.organization_id AND mr.role_id=cr.role_id
    WHERE cr.organization_id=$1 AND cr.transition_id=$2`, [identity.organization_id, found.transitionId])).rows;
  return { ...found, creatorUserIds: creators.map((row) => row.userId) };
}

async function pendingAssignee(client, identity, approvalCaseId) {
  return (await client.query(`SELECT a.assigned_user_id AS "assignedUserId"
    FROM approval_assignments a
    JOIN approval_stages s ON s.organization_id=a.organization_id AND s.id=a.approval_stage_id
    WHERE a.organization_id=$1 AND s.approval_case_id=$2 AND s.status='pending' AND a.status='pending' LIMIT 1`,
  [identity.organization_id, approvalCaseId])).rows[0] ?? null;
}

// Asks for whichever transition leaves the run's current state.
async function advance(client, identity, runId, comment) {
  const run = (await client.query(`SELECT r.id, r.revision, t.id AS "transitionId"
    FROM workflow_runs r
    JOIN workflow_transitions t ON t.organization_id=r.organization_id AND t.workflow_version_id=r.workflow_version_id
      AND t.source_state_id=r.current_state_id
    WHERE r.organization_id=$1 AND r.id=$2 AND r.status='active'
    ORDER BY t.display_order LIMIT 1`, [identity.organization_id, runId])).rows[0];
  if (!run) return null;
  const moved = await requestWorkflowTransition(client, identity, run.id, {
    revision: run.revision, transitionId: run.transitionId, comment,
  });
  return { approvalCaseId: moved.approvalCaseId ?? null, runId: run.id };
}

async function respond(client, identity, approvalCaseId) {
  const assignment = (await client.query(`SELECT a.id
    FROM approval_assignments a
    JOIN approval_stages s ON s.organization_id=a.organization_id AND s.id=a.approval_stage_id
    WHERE a.organization_id=$1 AND s.approval_case_id=$2 AND s.status='pending' AND a.status='pending'
      AND a.assigned_user_id=$3 LIMIT 1`, [identity.organization_id, approvalCaseId, identity.user_id])).rows[0];
  if (!assignment) return null;
  return approveWorkflowAssignment(client, identity, assignment.id, { comment: 'Approved by the seed module.' });
}
