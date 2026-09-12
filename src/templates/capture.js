import { randomUUID } from 'node:crypto';
import { initialOccurrences } from './occurrences.js';
import { isContextWidget } from './context-widgets.js';
import { database } from '../db/pool.js';
import { HttpError } from '../auth/errors.js';
import { templateInstances, templateOccurrences, templateValues } from '../db/template-schema.js';
import { loadDefinition, loadCapture } from './loader.js';
import { insertBatch } from './authoring.js';
import { calculateCapture, valueKey } from './calculations.js';
import { requirePermission, uuid, revision, fieldsOnly, decimal, bool, dateOnly, text } from './input.js';
import { setCaptureContext, requireCaptureWrite } from './access.js';
import { assertCaptureSize } from './runtime-limits.js';
import { agreedResultNumber, recordJobResultEntries } from '../datasheets/job-results.js';

function storedValues(identity, instance, versionId, nextRevision, values) {
  return values.map((value) => ({ ...value, organizationId: identity.organization_id, instanceId: instance.id, versionId,
    revision: nextRevision, savedBy: identity.user_id }));
}

function defaults(model, occurrences) {
  const fieldsByGroup = new Map();
  for (const field of Object.values(model.fieldsById)) {
    if (field.widget === 'formula_widget' || field.defaultState === 'absent') continue;
    const group = field.repeatGroupId ?? null;
    if (!fieldsByGroup.has(group)) fieldsByGroup.set(group, []);
    fieldsByGroup.get(group).push(field);
  }
  return occurrences.flatMap((occurrence) => (fieldsByGroup.get(occurrence.groupId ?? null) ?? []).map((field) => ({
    fieldId: field.id, occurrenceId: occurrence.id, valueType: field.valueType, state: field.defaultState, origin: 'default',
    numberValue: field.defaultNumber, textValue: field.defaultText, booleanValue: field.defaultBoolean, dateValue: field.defaultDate,
  })));
}

export async function createCapture(client, identity, versionId) {
  requirePermission(identity, 'datasheets.execute');
  return initializeCapture(client, identity, versionId);
}

export async function createWorkflowCapture(client, identity, versionId, options = {}) {
  if (!['samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute'].some((permission) => identity.permission_codes?.includes(permission))) {
    if (!(await client.query('SELECT laboratory_auto_job_request() AS id')).rows[0]?.id) throw new HttpError(403, 'forbidden', 'You cannot initialize this capture.');
  }
  return initializeCapture(client, identity, versionId, options);
}

async function initializeCapture(client, identity, versionId, { subjects = [] } = {}) {
  uuid(versionId);
  const { model } = await loadDefinition(client, identity.organization_id, versionId, { forFreeze: true });
  if (model.version.status !== 'frozen') throw new HttpError(400, 'unfrozen_template', 'Capture must use a frozen template version.');
  const instance = { organizationId: identity.organization_id, id: randomUUID(), versionId, createdBy: identity.user_id };
  const { occurrences, bindings } = initialOccurrences(model, { rootId: randomUUID(), newId: randomUUID, revision: 1, subjects });
  assertCaptureSize(model, occurrences);
  const initialValues = defaults(model, occurrences);
  const calculation = calculateCapture(model, occurrences, initialValues);
  const db = database(client);
  await setCaptureContext(client, instance.id);
  await db.insert(templateInstances).values(instance);
  // Breadth-first order ensures the parent exists before the repeat ancestry trigger runs.
  await insertBatch(db, templateOccurrences, occurrences.map((row) => ({ ...row, organizationId: identity.organization_id, instanceId: instance.id, versionId })));
  await insertBatch(db, templateValues, storedValues(identity, instance, versionId, 1, [...initialValues, ...calculation.calculated]));
  return { instanceId: instance.id, versionId, revision: 1, subjectBindings: bindings };
}

function enteredValue(model, occurrences, input) {
  fieldsOnly(input, ['fieldId', 'occurrenceId', 'state', 'value']);
  uuid(input.fieldId, 'Field'); uuid(input.occurrenceId, 'Occurrence');
  const field = model.fieldsById[input.fieldId];
  const occurrence = occurrences.get(input.occurrenceId);
  if (!field || !occurrence || (field.repeatGroupId ?? null) !== (occurrence.groupId ?? null)) throw new HttpError(400, 'invalid_capture_field', 'Field does not belong to this capture occurrence.');
  if (field.widget === 'formula_widget' || isContextWidget(field.widget) || (field.widget === 'text_widget' && !field.editable)) throw new HttpError(403, 'readonly_field', 'This field cannot accept entered values.');
  if (!['present', 'empty', 'absent'].includes(input.state)) throw new HttpError(400, 'invalid_value_state', 'Select a supported value state.');
  const result = { fieldId: field.id, occurrenceId: occurrence.id, valueType: field.valueType, state: input.state, origin: 'entered' };
  if (input.state !== 'present') {
    if (input.value !== undefined && input.value !== null && input.value !== '') throw new HttpError(400, 'unexpected_value', 'An empty or absent value cannot include a payload.');
    return result;
  }
  if (field.valueType === 'numeric') { result.numberValue = field.widget === 'result_widget' ? agreedResultNumber(field, input.value) : decimal(input.value, 'Value'); result.lexical = String(input.value); }
  if (field.valueType === 'text') {
    if (typeof input.value !== 'string') throw new HttpError(400, 'invalid_input', 'A present text value must be text.');
    result.textValue = text(input.value, 'Value', 16000, { optional: true });
  }
  if (field.valueType === 'boolean') result.booleanValue = bool(input.value, 'Value');
  if (field.valueType === 'date') result.dateValue = dateOnly(input.value);
  if (field.valueType === 'option') {
    uuid(input.value, 'Option');
    if (!field.options.some((option) => option.id === input.value)) throw new HttpError(400, 'invalid_option', 'Select an option from this template version.');
    result.optionId = input.value;
  }
  return result;
}

export async function saveCapture(client, identity, instanceId, expectedRevision, inputs) {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 1000) throw new HttpError(400, 'invalid_values', 'Save between 1 and 1,000 values at a time.');
  return updateCapture(client, identity, instanceId, expectedRevision, inputs);
}

export async function recalculateCapture(client, identity, instanceId, expectedRevision) {
  return updateCapture(client, identity, instanceId, expectedRevision, []);
}

async function updateCapture(client, identity, instanceId, expectedRevision, inputs) {
  requirePermission(identity, 'datasheets.execute'); uuid(instanceId); revision(expectedRevision);
  await requireCaptureWrite(client, instanceId);
  const changed = await client.query(`UPDATE template_instances SET revision = revision + 1
    WHERE organization_id = $1 AND id = $2 AND revision = $3 AND status = 'editing' RETURNING version_id`, [identity.organization_id, instanceId, expectedRevision]);
  if (!changed.rowCount) throw new HttpError(409, 'stale_capture', 'This datasheet changed or was frozen. Reload before saving.');
  const versionId = changed.rows[0].version_id;
  const { model } = await loadDefinition(client, identity.organization_id, versionId);
  const capture = await loadCapture(client, identity.organization_id, instanceId);
  const occurrences = new Map(capture.occurrences.map((row) => [row.id, row]));
  const entered = inputs.map((input) => enteredValue(model, occurrences, input));
  const keys = new Set(entered.map((value) => valueKey(value.fieldId, value.occurrenceId)));
  if (keys.size !== entered.length) throw new HttpError(400, 'duplicate_value', 'A save cannot contain the same field occurrence twice.');
  const priorValues = capture.values.filter((value) => !keys.has(valueKey(value.fieldId, value.occurrenceId)));
  const calculation = calculateCapture(model, capture.occurrences, [...priorValues, ...entered]);
  const previous = new Map(capture.values.map((value) => [valueKey(value.fieldId, value.occurrenceId), value]));
  const calculated = calculation.calculated.filter((value) => {
    const old = previous.get(valueKey(value.fieldId, value.occurrenceId));
    return !old || ['state', 'numberValue', 'errorCode', 'errorMessage'].some((key) => (value[key] ?? null) !== (old[key] ?? null));
  });
  await insertBatch(database(client), templateValues, storedValues(identity, { id: instanceId }, versionId, expectedRevision + 1, [...entered, ...calculated]));
  await recordJobResultEntries(client, instanceId, model, entered);
  return { instanceId, versionId, revision: expectedRevision + 1, values: calculation.values, validation: calculation.validation, calculationMs: calculation.durationMs };
}

export async function changeRepeat(client, identity, instanceId, expectedRevision, command) {
  requirePermission(identity, 'datasheets.execute'); uuid(instanceId); revision(expectedRevision);
  fieldsOnly(command, ['type', 'occurrenceId', 'withData']); uuid(command.occurrenceId);
  if (!['clone', 'remove'].includes(command.type)) throw new HttpError(400, 'invalid_repeat_action', 'Select a supported repeat action.');
  if (command.withData !== undefined) bool(command.withData, 'Clone with data');
  await requireCaptureWrite(client, instanceId);
  const nextRevision = expectedRevision + 1;
  const changed = await client.query(`UPDATE template_instances SET revision = revision + 1 WHERE organization_id = $1 AND id = $2
    AND revision = $3 AND status = 'editing' RETURNING version_id`, [identity.organization_id, instanceId, expectedRevision]);
  if (!changed.rowCount) throw new HttpError(409, 'stale_capture', 'This datasheet changed or was frozen. Reload before continuing.');
  const versionId = changed.rows[0].version_id;
  const capture = await loadCapture(client, identity.organization_id, instanceId);
  const { model } = await loadDefinition(client, identity.organization_id, versionId);
  const source = capture.occurrences.find((row) => row.id === command.occurrenceId);
  if (!source?.groupId) throw new HttpError(400, 'invalid_repeat', 'Select an active repeated row.');
  const group = model.groupsById[source.groupId];
  if (group.source === 'test_requests') throw new HttpError(409, 'fixed_parameter_subject', 'Parameter rows belong to their test requests and cannot be cloned or removed individually.');
  const siblings = capture.occurrences.filter((row) => row.parentId === source.parentId && row.groupId === source.groupId);
  const children = new Map();
  for (const row of capture.occurrences) {
    if (!children.has(row.parentId)) children.set(row.parentId, []);
    children.get(row.parentId).push(row);
  }
  const subtree = [{ ...source, depth: 0 }];
  for (let index = 0; index < subtree.length; index += 1) {
    const parent = subtree[index];
    subtree.push(...(children.get(parent.id) ?? []).map((row) => ({ ...row, depth: parent.depth + 1 })));
  }
  let occurrences; let additions = [];
  const db = database(client);
  if (command.type === 'clone') {
    if (siblings.length >= group.maximum || capture.occurrences.length + subtree.length > 5000) throw new HttpError(400, 'repeat_limit', 'The repeat limit has been reached.');
    const mapping = new Map(subtree.map((row) => [row.id, randomUUID()]));
    const positionResult = await client.query(`SELECT (o.position + coalesce((SELECT min(n.position) FROM template_occurrences n
      WHERE n.organization_id = o.organization_id AND n.instance_id = o.instance_id AND n.parent_id = o.parent_id AND n.group_id = o.group_id
      AND n.removed_revision IS NULL AND n.position > o.position), o.position + 2)) * 0.5 AS position
      FROM template_occurrences o WHERE o.organization_id = $1 AND o.instance_id = $2 AND o.id = $3`, [identity.organization_id, instanceId, source.id]);
    const copies = subtree.map((row) => ({ id: mapping.get(row.id), groupId: row.groupId, parentId: mapping.get(row.parentId) ?? row.parentId,
      position: row.id === source.id ? positionResult.rows[0].position : row.position, createdRevision: nextRevision }));
    assertCaptureSize(model, [...capture.occurrences, ...copies]);
    await insertBatch(db, templateOccurrences, copies.map((row) => ({ ...row, organizationId: identity.organization_id, instanceId, versionId })));
    if (subtree.some((row) => row.subject)) {
      const inserted = await client.query(`INSERT INTO datasheet_subjects(organization_id,datasheet_id,instance_id,version_id,occurrence_id,test_request_id,specification_id,created_revision,created_by)
        SELECT source.organization_id,source.datasheet_id,source.instance_id,source.version_id,mapping.new_id,source.test_request_id,source.specification_id,$3,$4
        FROM datasheet_subjects source JOIN unnest($5::uuid[],$6::uuid[]) mapping(old_id,new_id) ON mapping.old_id=source.occurrence_id
        WHERE source.organization_id=$1 AND source.instance_id=$2 RETURNING id,occurrence_id`,
      [identity.organization_id, instanceId, nextRevision, identity.user_id, [...mapping.keys()], [...mapping.values()]]);
      const copiesById = new Map(copies.map((row) => [row.id, row])); const subjectsByOccurrence = new Map(inserted.rows.map((row) => [row.occurrence_id, row.id]));
      for (const original of subtree) if (original.subject) {
        const copy = copiesById.get(mapping.get(original.id)); copy.subject = { ...original.subject, id: subjectsByOccurrence.get(copy.id) };
      }
    }
    occurrences = [...capture.occurrences, ...copies];
    additions = command.withData ? capture.values.filter((value) => mapping.has(value.occurrenceId) && value.origin !== 'calculated')
      .map(({ revision: _revision, savedAt: _savedAt, savedBy: _savedBy, ...value }) => ({ ...value, occurrenceId: mapping.get(value.occurrenceId), origin: 'entered' })) : defaults(model, copies);
  } else {
    if (siblings.length <= group.minimum) throw new HttpError(400, 'repeat_minimum', 'The minimum number of repeated rows must remain.');
    // Remove children before parents to preserve the ancestry constraint throughout the transaction.
    for (let depth = subtree.at(-1).depth; depth >= 0; depth -= 1) {
      const ids = subtree.filter((row) => row.depth === depth).map((row) => row.id);
      await client.query('UPDATE template_occurrences SET removed_revision = $3 WHERE organization_id = $1 AND instance_id = $2 AND id = ANY($4::uuid[])', [identity.organization_id, instanceId, nextRevision, ids]);
    }
    const removed = new Set(subtree.map((row) => row.id));
    occurrences = capture.occurrences.filter((row) => !removed.has(row.id));
  }
  const calculation = calculateCapture(model, occurrences, [...capture.values, ...additions]);
  await insertBatch(db, templateValues, storedValues(identity, { id: instanceId }, versionId, nextRevision, [...additions, ...calculation.calculated]));
  return { instanceId, versionId, revision: nextRevision, occurrences, values: calculation.values, validation: calculation.validation };
}
