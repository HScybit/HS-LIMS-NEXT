import { HttpError } from '../auth/errors.js';
import { capturedParameterRows, loadParameterTitleFields } from './parameter-title-fields.js';
import { parameterTitleProjection } from '../templates/parameter-title.js';
import { parameterDetailCustomFieldKey, parameterDetailValue, parameterDetailBytes, resolveParameterDetail } from '../templates/parameter-detail.js';
import { indexOccurrences } from '../templates/occurrences.js';
import { valueKey } from '../templates/calculations.js';

const unavailable = () => new HttpError(409, 'parameter_detail_unavailable', 'Parameter is not available');
const incomplete = () => new HttpError(409, 'parameter_detail_history_unavailable', 'The recorded parameter detail is unavailable.');
const versionKey = (row) => `${row.parameterId}:${row.parameterRevision}`;

// One metadata batch, an optional custom-field batch and two bounded method queries
// serve all widgets. Nothing is fetched from a mutable parameter/method head.
export async function loadParameterDetails(client, identity, subjects, requests, { rows, silent = false } = {}) {
  if (!requests.size) return new Map();
  if (requests.size > 1000 || [...requests.values()].reduce((count, titles) => count + titles.size, 0) > 20_000) {
    throw new HttpError(422, 'parameter_detail_limit', 'The requested parameter details exceed the supported document size.');
  }
  rows ??= await capturedParameterRows(client, identity, [...requests.keys()].map((id) => subjects.get(id)));
  const customRequests = new Map(); const methodVersions = new Map();
  for (const row of rows) {
    const titles = requests.get(row.testRequestId);
    if (!titles || !row.parameterHistoryAvailable) continue;
    const keys = new Set([...titles].map(parameterDetailCustomFieldKey).filter((key) => key !== null));
    if (keys.size || titles.has('project_field_data')) customRequests.set(row.testRequestId,
      { all: titles.has('project_field_data'), keys, titles: new Map() });
    if (titles.has('moa_applicable')) methodVersions.set(versionKey(row), row);
  }
  const custom = customRequests.size ? await loadParameterTitleFields(client, identity, rows, customRequests) : null;
  const methods = new Map([...methodVersions.keys()].map((key) => [key, []]));
  if (methodVersions.size) {
    const chosen = [...methodVersions.values()];
    const parameters = [identity.organization_id, chosen.map((row) => row.parameterId), chosen.map((row) => row.parameterRevision)];
    const selection = `FROM laboratory_parameter_method_context method JOIN unnest($2::uuid[],$3::integer[]) selected(parameter_id,parameter_revision)
        ON selected.parameter_id=method.parameter_id AND selected.parameter_revision=method.parameter_revision
      WHERE method.organization_id=$1`;
    const budget = (await client.query(`SELECT count(*)::integer AS count,coalesce(sum(octet_length(method.method_name)),0)::text AS bytes ${selection}`, parameters)).rows[0];
    if (budget.count > 500_000 || Number(budget.bytes) > 16 * 1024 * 1024) throw new HttpError(422, 'parameter_detail_limit', 'The requested applicable methods exceed the supported document size.');
    const result = await client.query(`SELECT method.parameter_id AS "parameterId",method.parameter_revision AS "parameterRevision",
      method.method_revision AS "methodRevision",method.method_name AS "methodName" ${selection}
      ORDER BY method.parameter_id,method.parameter_revision,method.method_id LIMIT 500001`, parameters);
    if (result.rows.length !== budget.count) throw incomplete();
    for (const row of result.rows) methods.get(versionKey(row)).push(row);
  }
  const values = new Map(); const captured = [];
  for (const row of rows) {
    const titles = requests.get(row.testRequestId);
    if (!titles) continue;
    const parameter = parameterTitleProjection(row, custom?.fieldsByRequestId.get(row.testRequestId));
    const details = new Map(); values.set(row.testRequestId, details);
    for (const title of titles) {
      try {
        if (!row.parameterHistoryAvailable && !['_id', 'organization_id', 'name', 'key'].includes(title)) throw incomplete();
        if (title === 'moa_applicable') {
          const selected = methods.get(versionKey(row));
          if (!selected || selected.some((method) => method.methodRevision === null || method.methodName === null)) throw incomplete();
          parameter.moa_applicable = selected.map((method) => method.methodName);
        }
        const value = parameterDetailValue(resolveParameterDetail(title, parameter));
        details.set(title, value); captured.push(value);
      } catch (error) {
        if (!silent || !['parameter_detail_history_unavailable', 'unsupported_parameter_detail'].includes(error.code)) throw error;
      }
    }
  }
  parameterDetailBytes(captured);
  return values;
}

// Jobs have no param_id in the source. Their non-loop fallback uses the entire
// sample's parameter set, not just the requests assigned to the job.
export async function parameterDetailFallback(client, identity, { instanceId, testRequestId, specificationId } = {}) {
  if (!instanceId && !testRequestId) return null;
  const row = (await client.query(`SELECT request.id AS "testRequestId",request.is_job AS "isJob",
      coalesce($4::uuid,sheet.specification_id,request.specification_id) AS "specificationId",
      member.id AS "memberId",member.specification_id AS "memberSpecificationId"
    FROM test_requests request LEFT JOIN datasheets sheet ON sheet.organization_id=request.organization_id AND sheet.test_request_id=request.id
      AND sheet.template_instance_id=$2
    LEFT JOIN LATERAL (
      SELECT child.id,child.specification_id FROM test_requests child
      JOIN laboratory_test_request_context context ON context.organization_id=request.organization_id AND context.test_request_id=request.id
      WHERE child.organization_id=request.organization_id AND child.parent_test_request_id=request.id
        AND (SELECT count(DISTINCT test.test_parameter_id) FROM sample_tests test JOIN sample_products product
          ON product.organization_id=test.organization_id AND product.id=test.sample_product_id
          WHERE product.organization_id=request.organization_id AND product.sample_id=context.sample_id)=1
        AND (SELECT count(DISTINCT (spec.test_parameter_id,spec.parameter_revision)) FROM test_requests sibling
          JOIN analytical_specifications spec ON spec.organization_id=sibling.organization_id AND spec.id=sibling.specification_id
          WHERE sibling.organization_id=request.organization_id AND sibling.parent_test_request_id=request.id)=1
      ORDER BY child.job_member_position,child.id LIMIT 1
    ) member ON request.is_job
    WHERE request.organization_id=$1 AND (($2::uuid IS NOT NULL AND sheet.template_instance_id=$2) OR ($2::uuid IS NULL AND request.id=$3))`,
  [identity.organization_id, instanceId ?? null, testRequestId ?? null, specificationId ?? null])).rows[0];
  if (!row) return null;
  return row.isJob ? (row.memberId ? { testRequestId: row.memberId, specificationId: row.memberSpecificationId } : null)
    : { testRequestId: row.testRequestId, specificationId: row.specificationId };
}

export function parameterDetailOccurrences(model, runtime, validation = {}) {
  const result = [];
  function visit(sectionId, parentId) {
    const section = model.sectionsById[sectionId];
    if (section.visible === false) return;
    const instances = section.ownRepeatGroupId ? runtime.forGroup(parentId, section.ownRepeatGroupId) : [{ id: parentId }];
    for (const instance of instances) for (const rowId of section.rowIds) {
      const row = model.rowsById[rowId];
      for (const occurrence of row.ownRepeatGroupId ? runtime.forGroup(instance.id, row.ownRepeatGroupId) : [instance]) for (const columnId of row.columnIds) {
        const column = model.columnsById[columnId]; const field = model.fieldsById[column.fieldId];
        if (field && validation[valueKey(field.id, occurrence.id)]?.visible === false) continue;
        if (field?.widget === 'parameter_detail_widget') result.push({ fieldId: field.id, occurrenceId: occurrence.id });
        for (const childId of column.childSectionIds) visit(childId, occurrence.id);
      }
    }
  }
  for (const id of model.rootSectionIds) visit(id, runtime.root.id);
  return result;
}

export async function captureParameterDetails(client, identity, model, occurrences, { selected, occurrenceIds, validation, context, silent = false } = {}) {
  const fields = Object.values(model.fieldsById).filter((field) => field.widget === 'parameter_detail_widget');
  if (!fields.length && !selected?.length) return [];
  const runtime = indexOccurrences(model, occurrences);
  const visible = parameterDetailOccurrences(model, runtime, validation);
  const visibleKeys = new Set(visible.map((item) => valueKey(item.fieldId, item.occurrenceId)));
  const chosen = selected ?? visible.filter((item) => !occurrenceIds || occurrenceIds.has(item.occurrenceId));
  const needsFallback = chosen.some((item) => !runtime.subjectFor(item.occurrenceId));
  const fallback = needsFallback ? await parameterDetailFallback(client, identity, context) : null;
  const subjects = new Map(); const requests = new Map(); const bindings = [];
  for (const item of chosen) {
    const field = model.fieldsById[item.fieldId]; const occurrence = runtime.byId.get(item.occurrenceId);
    if (!field || field.widget !== 'parameter_detail_widget' || !occurrence || !visibleKeys.has(valueKey(item.fieldId, item.occurrenceId))
      || (field.repeatGroupId ?? null) !== (occurrence.groupId ?? null)) {
      throw new HttpError(400, 'invalid_parameter_detail_field', 'Select a Parameter Detail in this capture occurrence.');
    }
    const subject = runtime.subjectFor(item.occurrenceId) ?? fallback;
    if (!field.label || !subject?.specificationId) {
      if (silent) continue;
      if (!field.label) throw new HttpError(400, 'parameter_detail_key_required', 'Please configure detail key');
      throw unavailable();
    }
    subjects.set(subject.testRequestId, subject);
    if (!requests.has(subject.testRequestId)) requests.set(subject.testRequestId, new Set());
    requests.get(subject.testRequestId).add(field.label);
    bindings.push({ ...item, subject, title: field.label });
  }
  const loaded = await loadParameterDetails(client, identity, subjects, requests, { silent });
  const values = bindings.flatMap(({ fieldId, occurrenceId, subject, title }) => {
    const value = loaded.get(subject.testRequestId)?.get(title);
    return value ? [{ ...value, fieldId, occurrenceId, parameterDetailSpecificationId: subject.specificationId }] : [];
  });
  parameterDetailBytes(values);
  return values;
}
