import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { listAssessments, getAssessment, createAssessment, updateAssessment, releaseAssessment, listAssessmentResults,
  getAssessmentForAttempt, startAssessmentAttempt, submitAssessmentAttempt } from '../../src/assessments/service.js';

const owner = ownerPool(); let author; let taker;
const work = (action, user = author) => withSession(user.token, action, { csrfToken: user.csrfToken });
before(async () => {
  const account = async (options = {}) => {
    const user = await createAccount(owner, options);
    return { ...user, ...await signIn({ identifier: user.username, password: user.password }) };
  };
  author = await account({ permissions: ['assessments.manage', 'assessments.read'] });
  taker = await account({ organizationId: author.organizationId, permissions: ['assessments.take'] });
});
after(async () => { await closePool(); await owner.end(); });

function draft(changes = {}) {
  return { name: 'Synthetic Assessment', fromDate: '2026-01-01T00:00:00Z', toDate: '2030-01-01T00:00:00Z',
    questions: [{ questionText: 'What is 2+2?', points: 2, options: [{ optionText: '3', isCorrect: false }, { optionText: '4', isCorrect: true }] },
      { questionText: 'What is the boiling point of water at sea level (C)?', points: 3, options: [{ optionText: '90', isCorrect: false }, { optionText: '100', isCorrect: true }, { optionText: '110', isCorrect: false }] }],
    assigneeIds: [taker.userId], ...changes };
}

test('an assessment can be authored, listed and fetched with its correct answers, but not edited after release', async () => {
  const created = await work((client, identity) => createAssessment(client, identity, draft()));
  assert.equal(created.revision, 1); assert.equal(created.questions.length, 2); assert.equal(created.isReleased, false);
  assert.equal(created.questions[0].options.find((option) => option.optionText === '4').isCorrect, true);
  const listed = await work((client, identity) => listAssessments(client, identity));
  assert(listed.items.some((item) => item.id === created.id));
  const updated = await work((client, identity) => updateAssessment(client, identity, created.id, draft({ revision: created.revision, name: 'Renamed Assessment' })));
  assert.equal(updated.name, 'Renamed Assessment'); assert.equal(updated.revision, 2);
  const released = await work((client, identity) => releaseAssessment(client, identity, created.id, updated.revision));
  assert.equal(released.isReleased, true);
  await assert.rejects(work((client, identity) => updateAssessment(client, identity, created.id, draft({ revision: released.revision }))), { code: 'assessment_already_released' });
  await assert.rejects(work((client, identity) => releaseAssessment(client, identity, created.id, released.revision)), { code: 'assessment_already_released' });
});

test('a question needs exactly one correct option, and the attempt view never exposes which option is correct', async () => {
  await assert.rejects(work((client, identity) => createAssessment(client, identity, draft({
    questions: [{ questionText: 'No correct answer', points: 1, options: [{ optionText: 'A', isCorrect: false }, { optionText: 'B', isCorrect: false }] }] }))), { code: 'invalid_question_options' });
  await assert.rejects(work((client, identity) => createAssessment(client, identity, draft({
    questions: [{ questionText: 'Two correct answers', points: 1, options: [{ optionText: 'A', isCorrect: true }, { optionText: 'B', isCorrect: true }] }] }))), { code: 'invalid_question_options' });
  const created = await work((client, identity) => createAssessment(client, identity, draft()));
  await work((client, identity) => releaseAssessment(client, identity, created.id, created.revision));
  const view = await work((client, identity) => getAssessmentForAttempt(client, identity, created.id), taker);
  assert(view.questions.every((question) => question.options.every((option) => !Object.hasOwn(option, 'isCorrect'))));
});

test('an assigned user can start, answer and submit an attempt, which is auto-scored and then immutable', async () => {
  const created = await work((client, identity) => createAssessment(client, identity, draft()));
  await work((client, identity) => releaseAssessment(client, identity, created.id, created.revision));
  const view = await work((client, identity) => getAssessmentForAttempt(client, identity, created.id), taker);
  const started = await work((client, identity) => startAssessmentAttempt(client, identity, created.id), taker);
  const again = await work((client, identity) => startAssessmentAttempt(client, identity, created.id), taker);
  assert.equal(again.id, started.id, 'starting again while in progress returns the same attempt');
  // Both synthetic questions happen to have their correct option at index 1.
  const answers = view.questions.map((question) => ({ questionId: question.id, selectedOptionId: question.options[1].id }));
  const submitted = await work((client, identity) => submitAssessmentAttempt(client, identity, started.id, { answers }), taker);
  assert.equal(submitted.totalScore, 5); assert.equal(submitted.maxScore, 5);
  await assert.rejects(work((client, identity) => submitAssessmentAttempt(client, identity, started.id, { answers }), taker), { code: 'assessment_already_submitted' });
  await assert.rejects(work((client, identity) => startAssessmentAttempt(client, identity, created.id), taker), { code: 'assessment_already_submitted' });
  const results = await work((client, identity) => listAssessmentResults(client, identity, created.id));
  assert.equal(results.items.find((item) => item.userId === taker.userId).totalScore, 5);
});

test('an unassigned user cannot start an attempt, and starting before release is rejected', async () => {
  const created = await work((client, identity) => createAssessment(client, identity, draft()));
  await assert.rejects(work((client, identity) => startAssessmentAttempt(client, identity, created.id), taker), { code: 'assessment_not_released' });
  const other = await createAccount(owner, { organizationId: author.organizationId, permissions: ['assessments.take'] });
  const otherSignedIn = { ...other, ...await signIn({ identifier: other.username, password: other.password }) };
  await work((client, identity) => releaseAssessment(client, identity, created.id, created.revision));
  await assert.rejects(work((client, identity) => startAssessmentAttempt(client, identity, created.id), otherSignedIn), { code: 'assessment_not_found' });
});

test('a partial answer set scores only the answered questions correctly, including a wrong answer', async () => {
  const created = await work((client, identity) => createAssessment(client, identity, draft()));
  await work((client, identity) => releaseAssessment(client, identity, created.id, created.revision));
  const view = await work((client, identity) => getAssessmentForAttempt(client, identity, created.id), taker);
  const started = await work((client, identity) => startAssessmentAttempt(client, identity, created.id), taker);
  const wrongFirst = view.questions[0].options.find((option) => option.optionText === '3');
  const submitted = await work((client, identity) => submitAssessmentAttempt(client, identity, started.id,
    { answers: [{ questionId: view.questions[0].id, selectedOptionId: wrongFirst.id }] }), taker);
  assert.equal(submitted.totalScore, 0); assert.equal(submitted.maxScore, 5);
});
