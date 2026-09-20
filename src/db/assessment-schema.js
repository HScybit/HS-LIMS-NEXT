import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, boolean, integer, timestamp, primaryKey, foreignKey, unique, uniqueIndex, check, index } from 'drizzle-orm/pg-core';
import { organizations, memberships } from './schema.js';

const time = (name) => timestamp(name, { withTimezone: true, mode: 'date' });
const tenant = () => uuid('organization_id').notNull().references(() => organizations.id);

// Step 10f part 2: Assessments (quizzes). Unlike the rest of step 10, this
// has no real Meteor behaviour to port — its scoring logic and quiz-taking
// UI were never built there (only the data model and an unfinished release/
// clone mechanism exist). Built from scratch as a single-question-type
// (multiple choice, one correct option, auto-scored) quiz rather than
// attempting to reproduce Meteor's richer but non-functional
// "assessment_configs" concept, which has no working behaviour to match.
// Lower rigor than a regulated compliance record: attempt immutability
// after submission is enforced at the application layer, not by a trigger.
export const assessments = pgTable('assessments', {
  organizationId: tenant(), id: uuid('id').notNull().defaultRandom(),
  name: text('name').notNull(), description: text('description'),
  fromDate: time('from_date').notNull(), toDate: time('to_date').notNull(), timeLimitMinutes: integer('time_limit_minutes'),
  isReleased: boolean('is_released').notNull().default(false),
  revision: integer('revision').notNull().default(1),
  createdBy: uuid('created_by').notNull(), createdAt: time('created_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by').notNull(), updatedAt: time('updated_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'assessment_created_actor_fk', columns: [t.organizationId, t.createdBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  foreignKey({ name: 'assessment_updated_actor_fk', columns: [t.organizationId, t.updatedBy], foreignColumns: [memberships.organizationId, memberships.userId] }),
  check('assessment_fields', sql`length(trim(${t.name})) between 1 and 200 and (${t.description} is null or length(${t.description}) between 1 and 10000)
    and ${t.toDate} >= ${t.fromDate} and (${t.timeLimitMinutes} is null or ${t.timeLimitMinutes} between 1 and 1440) and ${t.revision} > 0`),
  index('assessment_listing').on(t.organizationId, t.fromDate, t.id),
]);

export const assessmentQuestions = pgTable('assessment_questions', {
  organizationId: tenant(), id: uuid('id').notNull().defaultRandom(), assessmentId: uuid('assessment_id').notNull(),
  displayOrder: integer('display_order').notNull(), questionText: text('question_text').notNull(), points: integer('points').notNull().default(1),
}, (t) => [primaryKey({ columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'assessment_question_assessment_fk', columns: [t.organizationId, t.assessmentId], foreignColumns: [assessments.organizationId, assessments.id] }),
  unique('assessment_question_order_key').on(t.organizationId, t.assessmentId, t.displayOrder),
  check('assessment_question_fields', sql`length(trim(${t.questionText})) between 1 and 2000 and ${t.points} between 1 and 100 and ${t.displayOrder} >= 0`),
]);

export const assessmentQuestionOptions = pgTable('assessment_question_options', {
  organizationId: tenant(), id: uuid('id').notNull().defaultRandom(), questionId: uuid('question_id').notNull(),
  displayOrder: integer('display_order').notNull(), optionText: text('option_text').notNull(), isCorrect: boolean('is_correct').notNull().default(false),
}, (t) => [primaryKey({ columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'assessment_option_question_fk', columns: [t.organizationId, t.questionId], foreignColumns: [assessmentQuestions.organizationId, assessmentQuestions.id] }),
  unique('assessment_option_order_key').on(t.organizationId, t.questionId, t.displayOrder),
  // At most one correct option per question is guaranteed here; "at least
  // one" is enforced at the application layer when questions are authored.
  uniqueIndex('assessment_option_single_correct').on(t.organizationId, t.questionId).where(sql`${t.isCorrect}`),
  check('assessment_option_fields', sql`length(trim(${t.optionText})) between 1 and 500 and ${t.displayOrder} >= 0`),
]);

export const assessmentAssignments = pgTable('assessment_assignments', {
  organizationId: tenant(), assessmentId: uuid('assessment_id').notNull(), userId: uuid('user_id').notNull(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.assessmentId, t.userId] }),
  foreignKey({ name: 'assessment_assignment_assessment_fk', columns: [t.organizationId, t.assessmentId], foreignColumns: [assessments.organizationId, assessments.id] }),
  foreignKey({ name: 'assessment_assignment_user_fk', columns: [t.organizationId, t.userId], foreignColumns: [memberships.organizationId, memberships.userId] }),
]);

export const assessmentAttempts = pgTable('assessment_attempts', {
  organizationId: tenant(), id: uuid('id').notNull().defaultRandom(), assessmentId: uuid('assessment_id').notNull(), userId: uuid('user_id').notNull(),
  startedAt: time('started_at').notNull().defaultNow(), submittedAt: time('submitted_at'), totalScore: integer('total_score'), maxScore: integer('max_score').notNull(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.id] }),
  foreignKey({ name: 'assessment_attempt_assessment_fk', columns: [t.organizationId, t.assessmentId], foreignColumns: [assessments.organizationId, assessments.id] }),
  foreignKey({ name: 'assessment_attempt_user_fk', columns: [t.organizationId, t.userId], foreignColumns: [memberships.organizationId, memberships.userId] }),
  unique('assessment_attempt_key').on(t.organizationId, t.assessmentId, t.userId),
  check('assessment_attempt_fields', sql`${t.maxScore} >= 0 and (${t.submittedAt} is null and ${t.totalScore} is null
    or ${t.submittedAt} is not null and ${t.submittedAt} >= ${t.startedAt} and ${t.totalScore} is not null and ${t.totalScore} between 0 and ${t.maxScore})`),
]);

export const assessmentAnswers = pgTable('assessment_answers', {
  organizationId: tenant(), attemptId: uuid('attempt_id').notNull(), questionId: uuid('question_id').notNull(), selectedOptionId: uuid('selected_option_id'),
}, (t) => [primaryKey({ columns: [t.organizationId, t.attemptId, t.questionId] }),
  foreignKey({ name: 'assessment_answer_attempt_fk', columns: [t.organizationId, t.attemptId], foreignColumns: [assessmentAttempts.organizationId, assessmentAttempts.id] }),
  foreignKey({ name: 'assessment_answer_question_fk', columns: [t.organizationId, t.questionId], foreignColumns: [assessmentQuestions.organizationId, assessmentQuestions.id] }),
  foreignKey({ name: 'assessment_answer_option_fk', columns: [t.organizationId, t.selectedOptionId], foreignColumns: [assessmentQuestionOptions.organizationId, assessmentQuestionOptions.id] }),
]);
