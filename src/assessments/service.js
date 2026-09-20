import { HttpError } from '../auth/errors.js';
import { requirePermission, uuid } from '../templates/input.js';
import { assessmentInput, assessmentSubmissionInput } from './input.js';

function requireRead(identity) {
  if (!identity.permission_codes?.some((code) => ['assessments.read', 'assessments.manage', 'assessments.take'].includes(code))) {
    throw new HttpError(403, 'forbidden', 'You cannot view assessments.');
  }
}
function requireManage(identity) { requirePermission(identity, 'assessments.manage'); }
function requireTake(identity) { requirePermission(identity, 'assessments.take'); }

async function assertMembers(client, organizationId, userIds) {
  const found = await client.query('SELECT user_id FROM memberships WHERE organization_id=$1 AND user_id=ANY($2::uuid[])', [organizationId, userIds]);
  if (found.rowCount !== new Set(userIds).size) throw new HttpError(422, 'invalid_assignee', 'Assign only members of this organization.');
}

const assessmentColumns = `id, name, description, from_date AS "fromDate", to_date AS "toDate", time_limit_minutes AS "timeLimitMinutes", is_released AS "isReleased",
  revision, created_by AS "createdBy", created_at AS "createdAt", updated_by AS "updatedBy", updated_at AS "updatedAt"`;

async function questionsWithOptions(client, organizationId, assessmentId, { includeAnswers }) {
  const questions = (await client.query(`SELECT id, display_order AS "displayOrder", question_text AS "questionText", points
    FROM assessment_questions WHERE organization_id=$1 AND assessment_id=$2 ORDER BY display_order`, [organizationId, assessmentId])).rows;
  const options = (await client.query(`SELECT question_id AS "questionId", id, display_order AS "displayOrder", option_text AS "optionText"${includeAnswers ? ', is_correct AS "isCorrect"' : ''}
    FROM assessment_question_options WHERE organization_id=$1 AND question_id=ANY($2::uuid[]) ORDER BY question_id, display_order`,
  [organizationId, questions.map((question) => question.id)])).rows;
  const byQuestion = new Map(questions.map((question) => [question.id, { ...question, options: [] }]));
  for (const option of options) byQuestion.get(option.questionId).options.push(option);
  return [...byQuestion.values()];
}

async function assigneesOf(client, organizationId, assessmentId) {
  const result = await client.query('SELECT user_id AS "userId" FROM assessment_assignments WHERE organization_id=$1 AND assessment_id=$2 ORDER BY user_id', [organizationId, assessmentId]);
  return result.rows.map((row) => row.userId);
}

export async function listAssessments(client, identity) {
  requireRead(identity);
  const result = await client.query(`SELECT ${assessmentColumns} FROM assessments WHERE organization_id=$1 ORDER BY from_date DESC, id`, [identity.organization_id]);
  return { items: result.rows };
}

// Authoring view: includes which option is correct. Only for assessments.manage/.read.
export async function getAssessment(client, identity, assessmentId) {
  if (!identity.permission_codes?.some((code) => ['assessments.read', 'assessments.manage'].includes(code))) throw new HttpError(403, 'forbidden', 'You cannot view assessment authoring detail.');
  const id = uuid(assessmentId, 'Assessment').toLowerCase();
  const result = await client.query(`SELECT ${assessmentColumns} FROM assessments WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id]);
  if (!result.rowCount) throw new HttpError(404, 'assessment_not_found', 'Assessment was not found.');
  return { ...result.rows[0], questions: await questionsWithOptions(client, identity.organization_id, id, { includeAnswers: true }),
    assigneeIds: await assigneesOf(client, identity.organization_id, id) };
}

// Attempt view: never exposes which option is correct.
export async function getAssessmentForAttempt(client, identity, assessmentId) {
  requireTake(identity); const id = uuid(assessmentId, 'Assessment').toLowerCase();
  const assigned = await client.query('SELECT 1 FROM assessment_assignments WHERE organization_id=$1 AND assessment_id=$2 AND user_id=$3', [identity.organization_id, id, identity.user_id]);
  if (!assigned.rowCount) throw new HttpError(404, 'assessment_not_found', 'Assessment was not found.');
  const result = await client.query(`SELECT ${assessmentColumns} FROM assessments WHERE organization_id=$1 AND id=$2`, [identity.organization_id, id]);
  if (!result.rowCount) throw new HttpError(404, 'assessment_not_found', 'Assessment was not found.');
  return { ...result.rows[0], questions: await questionsWithOptions(client, identity.organization_id, id, { includeAnswers: false }) };
}

async function replaceQuestions(client, organizationId, assessmentId, questions) {
  await client.query(`DELETE FROM assessment_question_options WHERE organization_id=$1 AND question_id IN
    (SELECT id FROM assessment_questions WHERE organization_id=$1 AND assessment_id=$2)`, [organizationId, assessmentId]);
  await client.query('DELETE FROM assessment_questions WHERE organization_id=$1 AND assessment_id=$2', [organizationId, assessmentId]);
  let order = 0;
  for (const question of questions) {
    const inserted = (await client.query(`INSERT INTO assessment_questions(organization_id, assessment_id, display_order, question_text, points)
      VALUES($1,$2,$3,$4,$5) RETURNING id`, [organizationId, assessmentId, order, question.questionText, question.points])).rows[0];
    let optionOrder = 0;
    for (const option of question.options) {
      await client.query('INSERT INTO assessment_question_options(organization_id, question_id, display_order, option_text, is_correct) VALUES($1,$2,$3,$4,$5)',
        [organizationId, inserted.id, optionOrder, option.optionText, option.isCorrect]);
      optionOrder += 1;
    }
    order += 1;
  }
}

async function replaceAssignees(client, organizationId, assessmentId, assigneeIds) {
  await client.query('DELETE FROM assessment_assignments WHERE organization_id=$1 AND assessment_id=$2', [organizationId, assessmentId]);
  for (const userId of assigneeIds) await client.query('INSERT INTO assessment_assignments(organization_id, assessment_id, user_id) VALUES($1,$2,$3)', [organizationId, assessmentId, userId]);
}

export async function createAssessment(client, identity, rawInput) {
  requireManage(identity);
  const input = assessmentInput(rawInput);
  await assertMembers(client, identity.organization_id, input.assigneeIds);
  const result = await client.query(`INSERT INTO assessments(organization_id, name, description, from_date, to_date, time_limit_minutes, created_by, updated_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING ${assessmentColumns}`,
  [identity.organization_id, input.name, input.description, input.fromDate, input.toDate, input.timeLimitMinutes, identity.user_id]);
  const assessment = result.rows[0];
  await replaceQuestions(client, identity.organization_id, assessment.id, input.questions);
  await replaceAssignees(client, identity.organization_id, assessment.id, input.assigneeIds);
  return getAssessment(client, identity, assessment.id);
}

// Editing the question set or assignees is only allowed before release —
// once released, an assigned user may already be relying on the assessment
// they were shown, so it becomes a one-way gate matching Meteor's own
// is_released concept.
export async function updateAssessment(client, identity, assessmentId, rawInput) {
  requireManage(identity); const id = uuid(assessmentId, 'Assessment').toLowerCase();
  const input = assessmentInput(rawInput, { partial: true });
  await assertMembers(client, identity.organization_id, input.assigneeIds);
  const existing = await client.query('SELECT is_released FROM assessments WHERE organization_id=$1 AND id=$2', [identity.organization_id, id]);
  if (!existing.rowCount) throw new HttpError(404, 'assessment_not_found', 'Assessment was not found.');
  if (existing.rows[0].is_released) throw new HttpError(409, 'assessment_already_released', 'A released assessment cannot be edited.');
  const result = await client.query(`UPDATE assessments SET name=$3, description=$4, from_date=$5, to_date=$6, time_limit_minutes=$7, revision=revision+1, updated_by=$8, updated_at=now()
    WHERE organization_id=$1 AND id=$2 AND revision=$9 AND NOT is_released RETURNING ${assessmentColumns}`,
  [identity.organization_id, id, input.name, input.description, input.fromDate, input.toDate, input.timeLimitMinutes, identity.user_id, input.revision]);
  if (!result.rowCount) throw new HttpError(409, 'assessment_changed', 'This assessment changed. Reload before saving.');
  await replaceQuestions(client, identity.organization_id, id, input.questions);
  await replaceAssignees(client, identity.organization_id, id, input.assigneeIds);
  return getAssessment(client, identity, id);
}

export async function releaseAssessment(client, identity, assessmentId, expectedRevision) {
  requireManage(identity); const id = uuid(assessmentId, 'Assessment').toLowerCase();
  const result = await client.query(`UPDATE assessments SET is_released=true, revision=revision+1, updated_by=$3, updated_at=now()
    WHERE organization_id=$1 AND id=$2 AND revision=$4 AND NOT is_released RETURNING ${assessmentColumns}`,
  [identity.organization_id, id, identity.user_id, expectedRevision]);
  if (!result.rowCount) {
    const exists = await client.query('SELECT is_released FROM assessments WHERE organization_id=$1 AND id=$2', [identity.organization_id, id]);
    if (!exists.rowCount) throw new HttpError(404, 'assessment_not_found', 'Assessment was not found.');
    throw exists.rows[0].is_released ? new HttpError(409, 'assessment_already_released', 'This assessment was already released.')
      : new HttpError(409, 'assessment_changed', 'This assessment changed. Reload before releasing.');
  }
  return result.rows[0];
}

export async function listAssessmentResults(client, identity, assessmentId) {
  if (!identity.permission_codes?.some((code) => ['assessments.read', 'assessments.manage'].includes(code))) throw new HttpError(403, 'forbidden', 'You cannot view assessment results.');
  const id = uuid(assessmentId, 'Assessment').toLowerCase();
  const result = await client.query(`SELECT id, user_id AS "userId", started_at AS "startedAt", submitted_at AS "submittedAt", total_score AS "totalScore", max_score AS "maxScore"
    FROM assessment_attempts WHERE organization_id=$1 AND assessment_id=$2 ORDER BY user_id`, [identity.organization_id, id]);
  return { items: result.rows };
}

// Starting is idempotent: a repeat call while still in progress returns the
// same attempt rather than erroring, matching how form autosave/reload is
// expected to behave for a quiz-taking screen.
export async function startAssessmentAttempt(client, identity, assessmentId) {
  requireTake(identity); const id = uuid(assessmentId, 'Assessment').toLowerCase();
  const assigned = await client.query('SELECT 1 FROM assessment_assignments WHERE organization_id=$1 AND assessment_id=$2 AND user_id=$3', [identity.organization_id, id, identity.user_id]);
  if (!assigned.rowCount) throw new HttpError(404, 'assessment_not_found', 'Assessment was not found.');
  const assessment = (await client.query('SELECT is_released, from_date, to_date FROM assessments WHERE organization_id=$1 AND id=$2', [identity.organization_id, id])).rows[0];
  if (!assessment) throw new HttpError(404, 'assessment_not_found', 'Assessment was not found.');
  if (!assessment.is_released) throw new HttpError(409, 'assessment_not_released', 'This assessment has not been released yet.');
  const now = new Date();
  if (now < assessment.from_date || now > assessment.to_date) throw new HttpError(409, 'assessment_not_open', 'This assessment is not currently open.');
  const existing = await client.query('SELECT id, submitted_at FROM assessment_attempts WHERE organization_id=$1 AND assessment_id=$2 AND user_id=$3', [identity.organization_id, id, identity.user_id]);
  if (existing.rowCount) {
    if (existing.rows[0].submitted_at) throw new HttpError(409, 'assessment_already_submitted', 'You already submitted this assessment.');
    return { id: existing.rows[0].id };
  }
  const maxScore = (await client.query('SELECT coalesce(sum(points),0) AS total FROM assessment_questions WHERE organization_id=$1 AND assessment_id=$2', [identity.organization_id, id])).rows[0].total;
  const created = await client.query('INSERT INTO assessment_attempts(organization_id, assessment_id, user_id, max_score) VALUES($1,$2,$3,$4) RETURNING id',
    [identity.organization_id, id, identity.user_id, maxScore]);
  return { id: created.rows[0].id };
}

export async function submitAssessmentAttempt(client, identity, attemptId, rawInput) {
  requireTake(identity); const id = uuid(attemptId, 'Attempt').toLowerCase();
  const input = assessmentSubmissionInput(rawInput);
  const attempt = (await client.query('SELECT * FROM assessment_attempts WHERE organization_id=$1 AND id=$2 AND user_id=$3 FOR UPDATE', [identity.organization_id, id, identity.user_id])).rows[0];
  if (!attempt) throw new HttpError(404, 'attempt_not_found', 'Attempt was not found.');
  if (attempt.submitted_at) throw new HttpError(409, 'assessment_already_submitted', 'This attempt was already submitted.');
  const assessment = (await client.query('SELECT time_limit_minutes FROM assessments WHERE organization_id=$1 AND id=$2', [identity.organization_id, attempt.assessment_id])).rows[0];
  if (assessment.time_limit_minutes && new Date() > new Date(attempt.started_at.getTime() + assessment.time_limit_minutes * 60_000)) {
    throw new HttpError(409, 'attempt_time_expired', 'The time limit for this attempt has passed.');
  }
  const questions = (await client.query(`SELECT question.id, question.points, correct.id AS "correctOptionId" FROM assessment_questions question
    LEFT JOIN assessment_question_options correct ON correct.organization_id=question.organization_id AND correct.question_id=question.id AND correct.is_correct
    WHERE question.organization_id=$1 AND question.assessment_id=$2`, [identity.organization_id, attempt.assessment_id])).rows;
  const questionIds = new Set(questions.map((question) => question.id));
  if (input.answers.some((answer) => !questionIds.has(answer.questionId))) throw new HttpError(422, 'invalid_answer', 'An answered question does not belong to this assessment.');
  const answerByQuestion = new Map(input.answers.map((answer) => [answer.questionId, answer.selectedOptionId]));
  let totalScore = 0;
  for (const question of questions) {
    const selected = answerByQuestion.get(question.id) ?? null;
    await client.query('INSERT INTO assessment_answers(organization_id, attempt_id, question_id, selected_option_id) VALUES($1,$2,$3,$4)',
      [identity.organization_id, id, question.id, selected]);
    if (selected !== null && selected === question.correctOptionId) totalScore += question.points;
  }
  const result = await client.query(`UPDATE assessment_attempts SET submitted_at=now(), total_score=$3
    WHERE organization_id=$1 AND id=$2 AND submitted_at IS NULL
    RETURNING id, assessment_id AS "assessmentId", started_at AS "startedAt", submitted_at AS "submittedAt", total_score AS "totalScore", max_score AS "maxScore"`,
  [identity.organization_id, id, totalScore]);
  if (!result.rowCount) throw new HttpError(409, 'assessment_already_submitted', 'This attempt was already submitted.');
  return result.rows[0];
}
