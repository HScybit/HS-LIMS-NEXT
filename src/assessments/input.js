import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, uuid, text } from '../templates/input.js';
import { sampleTimestamp } from '../samples/input.js';

function optionInput(option) {
  fieldsOnly(option, ['optionText', 'isCorrect']);
  if (typeof option.isCorrect !== 'boolean') throw new HttpError(400, 'invalid_input', 'Each option must mark whether it is correct.');
  return { optionText: text(option.optionText, 'Option text', 500), isCorrect: option.isCorrect };
}

function questionInput(question) {
  fieldsOnly(question, ['questionText', 'points', 'options']);
  const questionText = text(question.questionText, 'Question text', 2000);
  const points = integer(question.points ?? 1, 'Points', 1, 100);
  if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 10) throw new HttpError(400, 'invalid_question_options', 'Each question needs between 2 and 10 options.');
  const options = question.options.map(optionInput);
  if (options.filter((option) => option.isCorrect).length !== 1) throw new HttpError(400, 'invalid_question_options', 'Each question needs exactly one correct option.');
  return { questionText, points, options };
}

export function assessmentInput(input, { partial = false } = {}) {
  fieldsOnly(input, [...(partial ? ['revision'] : []), 'name', 'description', 'fromDate', 'toDate', 'timeLimitMinutes', 'questions', 'assigneeIds']);
  const name = text(input.name, 'Name', 200);
  const description = input.description == null || input.description === '' ? null : text(input.description, 'Description', 10000);
  const fromDate = sampleTimestamp(input.fromDate, 'From date');
  const toDate = sampleTimestamp(input.toDate, 'To date');
  if (toDate < fromDate) throw new HttpError(400, 'invalid_assessment_dates', 'The end date cannot be before the start date.');
  const timeLimitMinutes = input.timeLimitMinutes == null ? null : integer(input.timeLimitMinutes, 'Time limit', 1, 1440);
  if (!Array.isArray(input.questions) || !input.questions.length || input.questions.length > 100) throw new HttpError(400, 'invalid_questions', 'An assessment needs between 1 and 100 questions.');
  const questions = input.questions.map(questionInput);
  if (!Array.isArray(input.assigneeIds) || !input.assigneeIds.length || input.assigneeIds.length > 500) throw new HttpError(400, 'invalid_assignees', 'Assign between 1 and 500 users.');
  const assigneeIds = input.assigneeIds.map((id) => uuid(id, 'Assignee').toLowerCase());
  if (new Set(assigneeIds).size !== assigneeIds.length) throw new HttpError(400, 'duplicate_assignee', 'Assign each user only once.');
  return { name, description, fromDate, toDate, timeLimitMinutes, questions, assigneeIds,
    ...(partial ? { revision: integer(input.revision, 'Assessment revision', 1, 2_147_483_647) } : {}) };
}

export function assessmentSubmissionInput(input) {
  fieldsOnly(input, ['answers']);
  if (!Array.isArray(input.answers) || input.answers.length > 1000) throw new HttpError(400, 'invalid_answers', 'Submit a valid set of answers.');
  const answers = input.answers.map((answer) => {
    fieldsOnly(answer, ['questionId', 'selectedOptionId']);
    return { questionId: uuid(answer.questionId, 'Question').toLowerCase(),
      selectedOptionId: answer.selectedOptionId == null ? null : uuid(answer.selectedOptionId, 'Selected option').toLowerCase() };
  });
  const questionIds = answers.map((answer) => answer.questionId);
  if (new Set(questionIds).size !== questionIds.length) throw new HttpError(400, 'duplicate_answer', 'Answer each question only once.');
  return { answers };
}
