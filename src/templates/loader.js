import { and, eq, asc, desc, ne, sql } from 'drizzle-orm';
import { database } from '../db/pool.js';
import { HttpError } from '../auth/errors.js';
import * as tables from '../db/template-schema.js';
import { assembleDefinition } from './model.js';

// Eight definition SELECTs, including optional version selection, independent of template size.
// Numeric configuration is batched separately to avoid a three-way join explosion with fresh-data estimates.
export async function loadDefinition(client, organizationId, versionId, options = {}) {
  const db = database(client);
  const metrics = { queries: [], queryCount: 0, databaseMs: 0, assemblyMs: 0 };
  async function query(name, operation) {
    const start = performance.now();
    const result = await operation();
    const durationMs = performance.now() - start;
    metrics.queries.push({ name, durationMs, rows: result.length });
    metrics.queryCount += 1;
    metrics.databaseMs += durationMs;
    return result;
  }
  const where = (table) => and(eq(table.organizationId, organizationId), eq(table.versionId, versionId));
  const { templates, templateVersions: versions, templateSections: sections, templateRows: rows,
    templateColumns: columns, templateFields: fields, templateNumericConfig: numeric,
    templateOptions: choices, templateExpressions: expressions, templateExpressionNodes: nodes, templateRepeatGroups: groups } = tables;
  const versionRows = await query('version', () => db.select({ version: versions, code: templates.code, active: templates.active }).from(versions)
    .innerJoin(templates, and(eq(versions.organizationId, templates.organizationId), eq(versions.templateId, templates.id)))
    .where(and(eq(versions.organizationId, organizationId), ne(versions.status, 'building'), options.templateId ? eq(versions.templateId, options.templateId) : eq(versions.id, versionId)))
    .orderBy(desc(sql`${versions.status} = 'draft'`), desc(versions.number)));
  const selectedVersion = versionId ? versionRows.find((row) => row.version.id === versionId) : versionRows[0];
  if (!selectedVersion) throw new HttpError(404, 'template_not_found', 'Template version was not found.');
  versionId = selectedVersion.version.id;
  const sectionRows = await query('sections', () => db.select().from(sections).where(where(sections)).orderBy(asc(sections.position), asc(sections.id)));
  const layoutRows = await query('rows', () => db.select().from(rows).where(where(rows)).orderBy(asc(rows.position), asc(rows.id)));
  const columnRows = await query('columns_fields', () => db.select({ column: columns, field: fields }).from(columns)
    .leftJoin(fields, and(eq(columns.organizationId, fields.organizationId), eq(columns.versionId, fields.versionId), eq(columns.id, fields.columnId)))
    .where(where(columns)).orderBy(asc(columns.position), asc(columns.id)));
  const numericRows = await query('numeric_configuration', () => db.select().from(numeric).where(where(numeric)));
  const optionRows = await query('options', () => db.select().from(choices).where(where(choices)).orderBy(asc(choices.position), asc(choices.id)));
  const expressionRows = await query('expressions_dependencies', () => db.select({ expression: expressions, node: nodes }).from(expressions)
    .leftJoin(nodes, and(eq(expressions.organizationId, nodes.organizationId), eq(expressions.versionId, nodes.versionId), eq(expressions.id, nodes.expressionId)))
    .where(where(expressions)).orderBy(asc(expressions.id), asc(nodes.nodeIndex)));
  const groupRows = await query('repeat_definitions', () => db.select().from(groups).where(where(groups)));
  const assemblyStart = performance.now();
  const numericByField = new Map(numericRows.map((row) => [row.fieldId, row]));
  const expressionMap = new Map();
  for (const { expression, node } of expressionRows) {
    if (!expressionMap.has(expression.id)) expressionMap.set(expression.id, { ...expression, nodes: [] });
    if (node) expressionMap.get(expression.id).nodes.push({
      index: node.nodeIndex, parentIndex: node.parentIndex, operandOrder: node.operandOrder, kind: node.kind,
      number: node.numberLiteral, text: node.textLiteral, boolean: node.booleanLiteral,
      fieldId: node.referenceFieldId, scope: node.referenceScope, operator: node.operator, functionName: node.functionName,
    });
  }
  const records = {
    version: { ...selectedVersion.version, code: selectedVersion.code, active: selectedVersion.active },
    sections: sectionRows, rows: layoutRows, columns: columnRows.map((row) => row.column),
    fields: columnRows.filter((row) => row.field).map((row) => ({ ...row.field, numeric: numericByField.get(row.field.id) ?? null })),
    options: optionRows, expressions: [...expressionMap.values()], groups: groupRows,
  };
  const model = assembleDefinition(records, options);
  metrics.assemblyMs = performance.now() - assemblyStart;
  return { model, records, metrics, versions: versionRows.map(({ version: { id, number, status, revision } }) => ({ id, number, status, revision })) };
}

export async function loadCapture(client, organizationId, instanceId, revision) {
  const started = performance.now();
  const result = await client.query('SELECT * FROM template_instances WHERE organization_id = $1 AND id = $2', [organizationId, instanceId]);
  const instance = result.rows[0];
  if (!instance) throw new HttpError(404, 'capture_not_found', 'Datasheet capture was not found.');
  const atRevision = revision ?? instance.revision;
  if (!Number.isSafeInteger(atRevision) || atRevision < 1 || atRevision > instance.revision) throw new HttpError(400, 'invalid_revision', 'Capture revision is invalid.');
  const occurrences = await client.query(`SELECT id, group_id AS "groupId", parent_id AS "parentId", position,
    created_revision AS "createdRevision", removed_revision AS "removedRevision" FROM template_occurrences
    WHERE organization_id = $1 AND instance_id = $2 AND created_revision <= $3 AND (removed_revision IS NULL OR removed_revision > $3)
    ORDER BY position, id`, [organizationId, instanceId, atRevision]);
  const values = await client.query(`SELECT DISTINCT ON (field_id, occurrence_id) field_id AS "fieldId", occurrence_id AS "occurrenceId",
    revision, value_type AS "valueType", state, origin, number_value AS "numberValue", text_value AS "textValue", boolean_value AS "booleanValue",
    date_value::text AS "dateValue", option_id AS "optionId", lexical, error_code AS "errorCode", error_message AS "errorMessage", saved_at AS "savedAt", saved_by AS "savedBy"
    FROM template_values WHERE organization_id = $1 AND instance_id = $2 AND revision <= $3 ORDER BY field_id, occurrence_id, revision DESC`, [organizationId, instanceId, atRevision]);
  const activeOccurrenceIds = new Set(occurrences.rows.map((occurrence) => occurrence.id));
  return { instance, revision: atRevision, occurrences: occurrences.rows, values: values.rows.filter((value) => activeOccurrenceIds.has(value.occurrenceId)),
    metrics: { queryCount: 3, databaseMs: performance.now() - started } };
}
