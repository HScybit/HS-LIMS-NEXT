import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { database } from '../db/pool.js';
import { samples, sampleProducts, sampleTests, sampleParticipatingLabs, sampleEvents } from '../db/sample-schema.js';
import { requirePermission } from '../templates/input.js';
import { insertBatch } from '../templates/authoring.js';
import { createWorkflowCapture } from '../templates/capture.js';
import { sampleRegistrationInput } from './input.js';
import { registrationReferences } from './references.js';
import { startWorkflow } from '../workflows/start.js';
import { generateTestRequests } from '../test-requests/generate.js';

async function sampleCapture(client, identity, categoryId) {
  const result = await client.query(`SELECT version.id FROM sample_category_templates mapping JOIN template_versions version
    ON version.organization_id = mapping.organization_id AND version.template_id = mapping.template_id
    JOIN templates template ON template.organization_id = version.organization_id AND template.id = version.template_id AND template.active
    WHERE mapping.organization_id = $1 AND mapping.sample_category_id = $2 AND mapping.purpose = 'sample' AND mapping.is_default
      AND version.status = 'frozen' AND version.kind = 'sample' ORDER BY version.number DESC LIMIT 1`, [identity.organization_id, categoryId]);
  return result.rowCount ? createWorkflowCapture(client, identity, result.rows[0].id) : null;
}

export async function registerSample(client, identity, rawInput) {
  requirePermission(identity, 'samples.create');
  const input = sampleRegistrationInput(rawInput);
  const references = await registrationReferences(client, identity.organization_id, input);
  const organizationId = identity.organization_id;
  const db = database(client);
  const id = randomUUID();
  await client.query("SELECT set_config('app.registration_sample_id', $1, true)", [id]);
  const period = String(new Date(input.receivedAt).getUTCFullYear()).padStart(4, '0');
  const number = await client.query("SELECT laboratory_next_number('sample', $1) AS number", [period]);
  const capture = await sampleCapture(client, identity, input.sampleCategoryId);
  const category = references.categories.get(input.sampleCategoryId);
  const customer = references.customers.get(input.customerId);
  const { products: productsInput, participatingLabs, ...header } = input;
  await db.insert(samples).values({ ...header, organizationId, id, sampleNumber: number.rows[0].number, registeredBy: identity.user_id,
    receivedAt: new Date(input.receivedAt), dueAt: input.dueAt ? new Date(input.dueAt) : null, templateInstanceId: capture?.instanceId ?? null,
    categoryCode: category.code, categoryName: category.name, categoryAbbreviation: category.abbreviation,
    customerCode: customer?.code ?? null, customerName: customer?.name ?? null, customerLegalName: customer?.legalName ?? null,
    retentionDueOn: category.retentionDays === null ? null : sql`(${input.receivedAt}::timestamptz AT TIME ZONE 'UTC')::date + ${category.retentionDays}::integer` });
  const productRecords = []; const testRecords = [];
  for (const [displayOrder, line] of productsInput.entries()) {
    const product = references.products.get(line.productId); const category = references.categories.get(line.sampleCategoryId);
    const unit = references.units.get(line.measurementUnitId); const productId = randomUUID();
    const { tests, ...details } = line;
    productRecords.push({ ...details, organizationId, id: productId, sampleId: id, displayOrder, productCode: product.code, productName: product.name,
      categoryCode: category.code, categoryName: category.name, unitCode: unit?.code ?? null, unitSymbol: unit?.symbol ?? null,
      tag: line.tagId ? references.tags.get(line.tagId).name : line.tag });
    for (const [testOrder, selected] of tests.entries()) testRecords.push({ ...selected, organizationId, id: randomUUID(), sampleProductId: productId, displayOrder: testOrder });
  }
  await insertBatch(db, sampleProducts, productRecords);
  await insertBatch(db, sampleTests, testRecords);
  await insertBatch(db, sampleParticipatingLabs, participatingLabs.map((lab, displayOrder) => ({ ...lab, organizationId, sampleId: id, displayOrder })));
  const workflow = await startWorkflow(client, identity, { type: 'sample', id }, input.sampleCategoryId);
  await db.insert(sampleEvents).values({ organizationId, sampleId: id, eventType: 'sample_registered', actorUserId: identity.user_id, description: 'Sample registered' });
  const generated = workflow.generateTestRequests ? await generateTestRequests(client, identity, id, {}, { automatic: true }) : { items: [], jobs: [] };
  await client.query("SELECT set_config('app.registration_sample_id', '', true)");
  return { id, sampleNumber: number.rows[0].number, revision: 1, workflowRunId: workflow.id, templateInstanceId: capture?.instanceId ?? null,
    sampleTestIds: testRecords.map((test) => test.id), status: 'registered', testRequests: generated.items };
}
