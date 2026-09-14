import { randomUUID } from 'node:crypto';
import { initialOccurrences } from './occurrences.js';
import { isContextWidget } from './context-widgets.js';
import { database } from '../db/pool.js';
import { HttpError } from '../auth/errors.js';
import { templateInstances, templateOccurrences, templateValues, templateParameterDetailItems } from '../db/template-schema.js';
import { loadDefinition, loadCapture } from './loader.js';
import { insertBatch } from './authoring.js';
import { calculateCapture, valueKey } from './calculations.js';
import { requirePermission, uuid, revision, fieldsOnly, decimal, bool, dateOnly, text } from './input.js';
import { setCaptureContext, requireCaptureWrite } from './access.js';
import { assertCaptureSize } from './runtime-limits.js';
import { agreedResultNumber, agreedResultValue, recordJobResultEntries } from '../datasheets/job-results.js';
import { resolveResultInput } from './defaults.js';
import { assertTemplateImageBudget } from '../template-assets/service.js';
import { capturedParameterTitles } from '../datasheets/parameter-title-fields.js';
import { captureParameterDetails } from '../datasheets/parameter-details.js';
import { parameterDetailBytes } from './parameter-detail.js';

function storedValues(identity, instance, versionId, nextRevision, values) {
  return values.map(({ parameterDetailItems: _items, ...value }) => ({ ...value, organizationId: identity.organization_id, instanceId: instance.id, versionId,
    revision: nextRevision, savedBy: identity.user_id }));
}

async function appendCaptureValues(client, identity, instanceId, versionId, nextRevision, values) {
  parameterDetailBytes(values);
  const db = database(client);
  await insertBatch(db, templateValues, storedValues(identity, { id: instanceId }, versionId, nextRevision, values));
  const items = values.flatMap((value) => (value.parameterDetailItems ?? []).map((item) => ({ ...item,
    organizationId: identity.organization_id, instanceId, fieldId: value.fieldId, occurrenceId: value.occurrenceId, revision: nextRevision })));
  await insertBatch(db, templateParameterDetailItems, items);
}

function defaults(model, occurrences) {
  const fieldsByGroup = new Map();
  for (const field of Object.values(model.fieldsById)) {
    if (['formula_widget', 'product_detail_widget', 'sample_line_item_data_widget', 'vertical_text_widget', 'parameter_detail_widget', 'tr_data_widget'].includes(field.widget) || field.defaultState === 'absent') continue;
    const group = field.repeatGroupId ?? null;
    if (!fieldsByGroup.has(group)) fieldsByGroup.set(group, []);
    fieldsByGroup.get(group).push(field);
  }
  return occurrences.flatMap((occurrence) => (fieldsByGroup.get(occurrence.groupId ?? null) ?? []).map((field) => ({
    fieldId: field.id, occurrenceId: occurrence.id, valueType: field.valueType, state: field.defaultState, origin: 'default',
    numberValue: field.defaultNumber, textValue: field.defaultText, booleanValue: field.defaultBoolean, dateValue: field.defaultDate, lexical: field.defaultLexical, imageId: field.defaultImageId,
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

async function initializeCapture(client, identity, versionId, { subjects = [], testRequestId, specificationId } = {}) {
  uuid(versionId);
  const { model } = await loadDefinition(client, identity.organization_id, versionId, { forFreeze: true });
  if (model.version.status !== 'frozen') throw new HttpError(400, 'unfrozen_template', 'Capture must use a frozen template version.');
  const instance = { organizationId: identity.organization_id, id: randomUUID(), versionId, createdBy: identity.user_id };
  const { occurrences, bindings } = initialOccurrences(model, { rootId: randomUUID(), newId: randomUUID, revision: 1, subjects });
  assertCaptureSize(model, occurrences);
  const initialValues = defaults(model, occurrences);
  await assertTemplateImageBudget(client, identity.organization_id, model, { occurrences, values: initialValues });
  const subjectsByOccurrence = new Map(bindings.map((binding) => [binding.occurrenceId, binding]));
  const boundOccurrences = occurrences.map((row) => ({ ...row, subject: subjectsByOccurrence.get(row.id) }));
  const beforeDetails = calculateCapture(model, boundOccurrences, initialValues);
  const details = await captureParameterDetails(client, identity, model, boundOccurrences,
    { context: { testRequestId, specificationId }, validation: beforeDetails.validation, silent: true });
  initialValues.push(...details);
  const calculation = details.length ? calculateCapture(model, occurrences, initialValues) : beforeDetails;
  await capturedParameterTitles(client, identity, model, { values: calculation.values,
    occurrences: boundOccurrences }, calculation.validation);
  const db = database(client);
  await setCaptureContext(client, instance.id);
  await db.insert(templateInstances).values(instance);
  // Breadth-first order ensures the parent exists before the repeat ancestry trigger runs.
  await insertBatch(db, templateOccurrences, occurrences.map((row) => ({ ...row, organizationId: identity.organization_id, instanceId: instance.id, versionId })));
  await appendCaptureValues(client, identity, instance.id, versionId, 1, [...initialValues, ...calculation.calculated]);
  return { instanceId: instance.id, versionId, revision: 1, subjectBindings: bindings };
}

function enteredValue(model, occurrences, input) {
  fieldsOnly(input, ['fieldId', 'occurrenceId', 'state', 'value']);
  uuid(input.fieldId, 'Field'); uuid(input.occurrenceId, 'Occurrence');
  const field = model.fieldsById[input.fieldId];
  const occurrence = occurrences.get(input.occurrenceId);
  if (!field || !occurrence || (field.repeatGroupId ?? null) !== (occurrence.groupId ?? null)) throw new HttpError(400, 'invalid_capture_field', 'Field does not belong to this capture occurrence.');
  if (['formula_widget', 'template_image_widget', 'vertical_text_widget', 'parameter_detail_widget'].includes(field.widget) || isContextWidget(field.widget) || (field.widget === 'text_widget' && !field.editable)) throw new HttpError(403, 'readonly_field', 'This field cannot accept entered values.');
  if (!['present', 'empty', 'absent'].includes(input.state)) throw new HttpError(400, 'invalid_value_state', 'Select a supported value state.');
  if (input.state !== 'present' && input.value !== undefined && input.value !== null && input.value !== '') throw new HttpError(400, 'unexpected_value', 'An empty or absent value cannot include a payload.');
  input = resolveResultInput(field, input);
  const result = { fieldId: field.id, occurrenceId: occurrence.id, valueType: field.valueType, state: input.state, origin: 'entered' };
  if (input.state !== 'present') return result;
  if (field.valueType === 'numeric') { result.numberValue = field.widget === 'result_widget' ? agreedResultNumber(field, input.value) : decimal(input.value, 'Value'); result.lexical = String(input.value); }
  if (field.valueType === 'result') Object.assign(result, agreedResultValue(field, input.value));
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

export async function refreshParameterDetails(client, identity, instanceId, input) {
  requirePermission(identity, 'datasheets.execute'); uuid(instanceId);
  fieldsOnly(input, ['revision', 'requestId', 'fields']); revision(input.revision); uuid(input.requestId, 'Refresh request');
  if (!Array.isArray(input.fields) || !input.fields.length || input.fields.length > 1000) {
    throw new HttpError(400, 'invalid_parameter_details', 'Refresh between 1 and 1,000 Parameter Details at a time.');
  }
  instanceId = instanceId.toLowerCase();
  const requestId = input.requestId.toLowerCase();
  const selected = input.fields.map((item) => {
    fieldsOnly(item, ['fieldId', 'occurrenceId']);
    return { fieldId: uuid(item.fieldId, 'Field').toLowerCase(), occurrenceId: uuid(item.occurrenceId, 'Occurrence').toLowerCase() };
  });
  const keys = new Set(selected.map((item) => valueKey(item.fieldId, item.occurrenceId)));
  if (keys.size !== selected.length) throw new HttpError(400, 'duplicate_value', 'A refresh cannot contain the same field occurrence twice.');
  await requireCaptureWrite(client, instanceId);
  const instance = (await client.query('SELECT version_id,revision,status FROM template_instances WHERE organization_id=$1 AND id=$2 FOR UPDATE',
    [identity.organization_id, instanceId])).rows[0];
  if (!instance) throw new HttpError(404, 'capture_not_found', 'Datasheet capture was not found.');
  const prior = (await client.query(`SELECT instance_id,revision,recorded_by,parameter_detail_field_count FROM template_capture_revisions
    WHERE organization_id=$1 AND parameter_detail_request_id=$2`, [identity.organization_id, requestId])).rows[0];
  if (prior) {
    const recorded = (await client.query(`SELECT field_id,occurrence_id FROM template_values
      WHERE organization_id=$1 AND instance_id=$2 AND revision=$3 AND origin='parameter'`,
    [identity.organization_id, prior.instance_id, prior.revision])).rows;
    if (prior.instance_id !== instanceId || prior.revision !== input.revision + 1 || prior.recorded_by !== identity.user_id
      || prior.parameter_detail_field_count !== selected.length || recorded.length !== selected.length
      || recorded.some((row) => !keys.has(valueKey(row.field_id, row.occurrence_id)))) {
      throw new HttpError(409, 'parameter_detail_request_reused', 'This refresh request was already used with different details.');
    }
    const { model } = await loadDefinition(client, identity.organization_id, instance.version_id);
    const capture = await loadCapture(client, identity.organization_id, instanceId, prior.revision);
    const calculation = calculateCapture(model, capture.occurrences, capture.values);
    return { instanceId, versionId: instance.version_id, revision: prior.revision, values: calculation.values, validation: calculation.validation,
      parameterTitleValuesByRequestId: await capturedParameterTitles(client, identity, model, capture, calculation.validation), replayed: true };
  }
  if (instance.revision !== input.revision || instance.status !== 'editing') throw new HttpError(409, 'stale_capture', 'This datasheet changed or was frozen. Reload before refreshing.');
  const { model } = await loadDefinition(client, identity.organization_id, instance.version_id);
  const capture = await loadCapture(client, identity.organization_id, instanceId);
  const before = calculateCapture(model, capture.occurrences, capture.values);
  const details = await captureParameterDetails(client, identity, model, capture.occurrences,
    { selected, context: { instanceId }, validation: before.validation });
  const calculation = calculateCapture(model, capture.occurrences,
    [...capture.values.filter((value) => !keys.has(valueKey(value.fieldId, value.occurrenceId))), ...details]);
  parameterDetailBytes(calculation.values);
  const parameterTitleValuesByRequestId = await capturedParameterTitles(client, identity, model,
    { occurrences: capture.occurrences, values: calculation.values }, calculation.validation);
  await client.query(`SELECT set_config('app.parameter_detail_capture_id',$1,true),set_config('app.parameter_detail_request_id',$2,true),
    set_config('app.parameter_detail_field_count',$3,true)`, [instanceId, requestId, String(details.length)]);
  try {
    await client.query('UPDATE template_instances SET revision=revision+1 WHERE organization_id=$1 AND id=$2', [identity.organization_id, instanceId]);
  } catch (error) {
    if (error.constraint === 'capture_parameter_detail_request') throw new HttpError(409, 'parameter_detail_request_reused', 'This refresh request was already used with different details.');
    throw error;
  }
  await client.query(`SELECT set_config('app.parameter_detail_capture_id','',true),set_config('app.parameter_detail_request_id','',true),
    set_config('app.parameter_detail_field_count','',true)`);
  await appendCaptureValues(client, identity, instanceId, instance.version_id, input.revision + 1, [...details, ...calculation.calculated]);
  return { instanceId, versionId: instance.version_id, revision: input.revision + 1, values: calculation.values, validation: calculation.validation,
    parameterTitleValuesByRequestId, replayed: false, calculationMs: calculation.durationMs };
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
  const parameterTitleValuesByRequestId = await capturedParameterTitles(client, identity, model,
    { occurrences: capture.occurrences, values: calculation.values }, calculation.validation);
  const previous = new Map(capture.values.map((value) => [valueKey(value.fieldId, value.occurrenceId), value]));
  const calculated = calculation.calculated.filter((value) => {
    const old = previous.get(valueKey(value.fieldId, value.occurrenceId));
    return !old || ['state', 'numberValue', 'errorCode', 'errorMessage'].some((key) => (value[key] ?? null) !== (old[key] ?? null));
  });
  await appendCaptureValues(client, identity, instanceId, versionId, expectedRevision + 1, [...entered, ...calculated]);
  await recordJobResultEntries(client, instanceId, model, entered);
  return { instanceId, versionId, revision: expectedRevision + 1, values: calculation.values, validation: calculation.validation,
    parameterTitleValuesByRequestId, calculationMs: calculation.durationMs };
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
    additions = command.withData ? capture.values.filter((value) => mapping.has(value.occurrenceId) && value.origin !== 'calculated' && model.fieldsById[value.fieldId]?.widget !== 'tr_data_widget')
      .map(({ revision: _revision, savedAt: _savedAt, savedBy: _savedBy, ...value }) => {
        // Static defaults remain tied to the frozen field on the new row;
        // promoting them to entered data changes Text titles or rejects images.
        const staticDefault = value.origin === 'default' && ['text_widget', 'template_image_widget'].includes(model.fieldsById[value.fieldId].widget);
        return { ...value, occurrenceId: mapping.get(value.occurrenceId), origin: value.origin === 'parameter' ? 'parameter' : staticDefault ? 'default' : 'entered' };
      }) : defaults(model, copies);
    if (!command.withData) additions.push(...await captureParameterDetails(client, identity, model, occurrences,
      { occurrenceIds: new Set(copies.map((row) => row.id)), context: { instanceId }, silent: true,
        validation: calculateCapture(model, occurrences, [...capture.values, ...additions]).validation }));
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
  // Deletion can only reduce the budget, including for older oversized captures.
  if (command.type === 'clone') await assertTemplateImageBudget(client, identity.organization_id, model, { occurrences, values: [...capture.values, ...additions] });
  const calculation = calculateCapture(model, occurrences, [...capture.values, ...additions]);
  if (command.type === 'clone') parameterDetailBytes(calculation.values);
  const parameterTitleValuesByRequestId = command.type === 'clone' ? await capturedParameterTitles(client, identity, model,
    { occurrences, values: calculation.values }, calculation.validation) : undefined;
  await appendCaptureValues(client, identity, instanceId, versionId, nextRevision, [...additions, ...calculation.calculated]);
  return { instanceId, versionId, revision: nextRevision, occurrences, values: calculation.values, validation: calculation.validation,
    ...(parameterTitleValuesByRequestId ? { parameterTitleValuesByRequestId } : {}) };
}
