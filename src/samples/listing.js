import { fieldsOnly, integer, text, requirePermission } from '../templates/input.js';
import { HttpError } from '../auth/errors.js';

export async function listSamples(client, identity, input = {}) {
  requirePermission(identity, 'samples.read');
  fieldsOnly(input, ['page', 'pageSize', 'search', 'sampleType']);
  const page = integer(input.page ?? 1, 'Page', 1, 1_000_000); const pageSize = integer(input.pageSize ?? 10, 'Page size', 1, 50);
  const search = text(input.search, 'Search', 500, { optional: true }).trim();
  const sampleType = input.sampleType || null;
  if (sampleType && !['customer', 'internal', 'quality_control', 'proficiency', 'interlaboratory', 'amendment', 'complaint'].includes(sampleType)) throw new HttpError(400, 'invalid_sample_type', 'Select a valid sample type.');
  const parameters = [identity.organization_id, sampleType, search ? `%${search.replace(/[\\%_]/g, '\\$&')}%` : null];
  const where = `sample.organization_id=$1 AND ($2::text IS NULL OR sample.sample_type=$2)
    AND ($3::text IS NULL OR sample.sample_number ILIKE $3 OR sample.customer_name ILIKE $3 OR sample.category_name ILIKE $3 OR sample.customer_reference ILIKE $3)`;
  const count = await client.query(`SELECT count(*)::integer AS total FROM samples sample WHERE ${where}`, parameters);
  const result = await client.query(`SELECT sample.id, sample.sample_number AS "sampleNumber", sample.sample_type AS "sampleType", sample.status,
    sample.customer_name AS "customerName", sample.customer_reference AS "customerReference", sample.received_by_name AS "receivedByName",
    sample.category_name AS "categoryName", sample.mode_of_receipt AS "modeOfReceipt", sample.registered_at AS "registeredAt", sample.due_at AS "dueAt",
    state.name AS "stateName", state.color AS "stateColor" FROM samples sample
    LEFT JOIN workflow_runs run ON run.organization_id=sample.organization_id AND run.sample_id=sample.id
    LEFT JOIN workflow_states state ON state.organization_id=run.organization_id AND state.id=run.current_state_id
    WHERE ${where} ORDER BY sample.registered_at DESC, sample.id LIMIT $4 OFFSET $5`, [...parameters, pageSize, (page - 1) * pageSize]);
  const byId = new Map(result.rows.map((sample) => [sample.id, { ...sample, parameters: [] }]));
  if (byId.size) {
    const tests = await client.query(`SELECT selected.id, product.sample_id AS "sampleId", coalesce(specification.parameter_name, parameter.name) AS name,
      request.id AS "requestId", coalesce(request.status, 'created') AS status
      FROM sample_tests selected JOIN sample_products product ON product.organization_id=selected.organization_id AND product.id=selected.sample_product_id
      JOIN test_parameters parameter ON parameter.organization_id=selected.organization_id AND parameter.id=selected.test_parameter_id
      LEFT JOIN LATERAL (SELECT id, specification_id, status FROM test_requests WHERE organization_id=selected.organization_id AND sample_test_id=selected.id
        ORDER BY attempt_number DESC LIMIT 1) request ON true
      LEFT JOIN analytical_specifications specification ON specification.organization_id=selected.organization_id AND specification.id=request.specification_id
      WHERE selected.organization_id=$1 AND product.sample_id=ANY($2::uuid[]) ORDER BY product.display_order, selected.display_order, selected.id`, [identity.organization_id, [...byId.keys()]]);
    for (const test of tests.rows) byId.get(test.sampleId).parameters.push(test);
  }
  return { rows: [...byId.values()], totalCount: count.rows[0].total, page, pageSize };
}
