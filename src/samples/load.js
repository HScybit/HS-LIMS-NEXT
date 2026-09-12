import { and, asc, eq } from 'drizzle-orm';
import { database } from '../db/pool.js';
import { samples, sampleProducts, sampleParticipatingLabs } from '../db/sample-schema.js';
import { uuid, requirePermission } from '../templates/input.js';
import { HttpError } from '../auth/errors.js';
import { workflowStateAccess } from '../workflows/access.js';

export async function loadSample(client, identity, sampleId) {
  requirePermission(identity, 'samples.read'); uuid(sampleId, 'Sample');
  const organizationId = identity.organization_id; const db = database(client);
  const [sample] = await db.select().from(samples).where(and(eq(samples.organizationId, organizationId), eq(samples.id, sampleId)));
  if (!sample) throw new HttpError(404, 'sample_not_found', 'Sample was not found.');
  const products = await db.select().from(sampleProducts).where(and(eq(sampleProducts.organizationId, organizationId), eq(sampleProducts.sampleId, sampleId))).orderBy(asc(sampleProducts.displayOrder), asc(sampleProducts.id));
  const tests = await client.query(`SELECT selected.id, selected.sample_product_id AS "sampleProductId", selected.test_parameter_id AS "testParameterId",
    selected.method_id AS "methodId", coalesce(specification.parameter_name, parameter.name) AS "parameterName",
    coalesce(specification.method_name, method.name) AS "methodName", selected.requested_quantity AS "requestedQuantity", selected.requested_size AS "requestedSize",
    selected.rate, selected.currency_code AS "currencyCode", selected.estimated_duration_minutes AS "estimatedDurationMinutes", selected.is_accredited AS "isAccredited",
    selected.is_retest AS "isRetest", selected.is_subcontracted AS "isSubcontracted", selected.status,
    request.id AS "requestId", request.request_number AS "requestNumber", request.status AS "requestStatus", request.revision AS "requestRevision"
    FROM sample_tests selected JOIN sample_products product ON product.organization_id=selected.organization_id AND product.id=selected.sample_product_id
    JOIN test_parameters parameter ON parameter.organization_id=selected.organization_id AND parameter.id=selected.test_parameter_id
    JOIN methods_of_analysis method ON method.organization_id=selected.organization_id AND method.id=selected.method_id
    LEFT JOIN LATERAL (SELECT organization_id, id, request_number, status, revision, specification_id FROM test_requests
      WHERE organization_id=selected.organization_id AND sample_test_id=selected.id ORDER BY attempt_number DESC LIMIT 1) request ON true
    LEFT JOIN analytical_specifications specification ON specification.organization_id=request.organization_id AND specification.id=request.specification_id
    WHERE selected.organization_id=$1 AND product.sample_id=$2 ORDER BY product.display_order, selected.display_order, selected.id`, [organizationId, sampleId]);
  const participatingLabs = await db.select().from(sampleParticipatingLabs).where(and(eq(sampleParticipatingLabs.organizationId, organizationId), eq(sampleParticipatingLabs.sampleId, sampleId))).orderBy(asc(sampleParticipatingLabs.displayOrder));
  const quotation = sample.customerQuotationId ? (await client.query('SELECT quotation_number AS "quotationNumber" FROM customer_quotations WHERE organization_id=$1 AND id=$2', [organizationId, sample.customerQuotationId])).rows[0] : null;
  const workflow = await workflowStateAccess(client, identity, { type: 'sample', id: sampleId });
  const events = await client.query(`SELECT id, event_type AS "eventType", actor_user_id AS "actorUserId", description, occurred_at AS "occurredAt"
    FROM sample_events WHERE organization_id=$1 AND sample_id=$2 ORDER BY occurred_at DESC, id DESC LIMIT 100`, [organizationId, sampleId]);
  const actorIds = [...new Set(events.rows.map((event) => event.actorUserId))];
  const actors = actorIds.length ? (await client.query('SELECT * FROM laboratory_actor_labels($1::uuid[])', [actorIds])).rows : [];
  const actorNames = new Map(actors.map((actor) => [actor.user_id, actor.display_name]));
  const productMap = new Map(products.map((product) => [product.id, { ...product, tests: [] }]));
  for (const test of tests.rows) productMap.get(test.sampleProductId).tests.push(test);
  return { ...sample, products: [...productMap.values()], participatingLabs, quotationNumber: quotation?.quotationNumber ?? null,
    workflowRunId: workflow.state?.workflow_run_id ?? null, stateName: workflow.state?.name ?? null, stateColor: workflow.state?.color ?? null,
    canPrintCoa: workflow.allowedActions.printCoa,
    canGenerateRequests: ['samples.manage', 'test_requests.allocate'].some((permission) => identity.permission_codes.includes(permission))
      && workflow.allowedActions.allocate && Boolean(workflow.state?.generate_test_requests || workflow.permissionFallbackActions.allocate),
    activity: events.rows.map((event) => ({ ...event, actorName: actorNames.get(event.actorUserId) ?? event.actorUserId })) };
}
