import { and, eq, sql } from 'drizzle-orm';
import { HttpError } from '../auth/errors.js';
import { database } from '../db/pool.js';
import { customers, customerQuotations, sampleCategories } from '../db/master-schema.js';
import { samples, sampleEvents } from '../db/sample-schema.js';
import { fieldsOnly, requirePermission, uuid } from '../templates/input.js';
import { requireWorkflowAction } from '../workflows/access.js';
import { lockReferences } from './reference-locks.js';
import { sampleHeaderFields, sampleHeaderRevision, sampleHeaderUpdateInput, validateSampleHeaderChanges } from './update-input.js';
import { reconcileSampleProducts } from './reconcile.js';

const invalidReference = message => { throw new HttpError(422, 'invalid_sample_reference', message); };

async function changedCustomerReferences(client, organizationId, existing, changes) {
  const customerId = Object.hasOwn(changes, 'customerId') ? changes.customerId : existing.customerId;
  const quotationId = Object.hasOwn(changes, 'customerQuotationId') ? changes.customerQuotationId : existing.customerQuotationId;
  const customerChanged = customerId !== existing.customerId;
  const captured = {};
  if (customerChanged) {
    if (customerId) {
      await lockReferences(client, customers, [customerId]);
      const customer = (await client.query('SELECT code,name,legal_name FROM customers WHERE organization_id=$1 AND id=$2 AND active', [organizationId, customerId])).rows[0];
      if (!customer) invalidReference('Select an active customer from this organization.');
      Object.assign(captured, { customerCode: customer.code, customerName: customer.name, customerLegalName: customer.legal_name });
    } else Object.assign(captured, { customerCode: null, customerName: null, customerLegalName: null });
  }
  if (quotationId && (customerChanged || quotationId !== existing.customerQuotationId)) {
    await lockReferences(client, customerQuotations, [quotationId]);
    const quotation = await client.query(`SELECT id FROM customer_quotations WHERE organization_id=$1 AND id=$2 AND customer_id=$3
      AND status='approved' AND (valid_until IS NULL OR valid_until>=current_date)`, [organizationId, quotationId, customerId]);
    if (!quotation.rowCount) invalidReference('Select an approved, unexpired quotation for this customer.');
  }
  return captured;
}

// Retain the narrower programmatic header command for existing callers.
export async function updateSampleHeader(client, identity, sampleId, rawInput) {
  requirePermission(identity, 'samples.manage');
  sampleHeaderRevision(rawInput);
  return updateSample(client, identity, sampleId, rawInput);
}

// The caller owns the transaction. Lines, headers, revision and actor event
// either commit together or leave the previous sample intact.
export async function updateSample(client, identity, sampleId, rawInput) {
  requirePermission(identity, 'samples.manage'); uuid(sampleId, 'Sample');
  fieldsOnly(rawInput, ['revision', ...sampleHeaderFields, 'products', 'sampleCategoryId']);
  const { products, sampleCategoryId, ...headerInput } = rawInput;
  const expectedRevision = sampleHeaderRevision(headerInput);
  const organizationId = identity.organization_id; const db = database(client);
  const [existing] = await db.select().from(samples).where(and(eq(samples.organizationId, organizationId), eq(samples.id, sampleId))).for('update');
  if (!existing) throw new HttpError(404, 'sample_not_found', 'Sample was not found.');
  // Workflow commands also lock the owner before its run. Holding both prevents
  // an edit permission check from racing a transition into a different state.
  await client.query('SELECT id FROM workflow_runs WHERE organization_id=$1 AND sample_id=$2 FOR UPDATE', [organizationId, sampleId]);
  await requireWorkflowAction(client, identity, { type: 'sample', id: sampleId }, 'edit');
  if (existing.revision !== expectedRevision) throw new HttpError(409, 'sample_changed', 'The sample changed after it was opened. Reload it before saving.');
  const { changes } = sampleHeaderUpdateInput(headerInput, existing.sampleType);
  const ordinary = ['customer', 'internal', 'proficiency', 'interlaboratory'].includes(existing.sampleType);
  const editLines = ordinary && Object.hasOwn(rawInput, 'products');
  if (ordinary && Object.hasOwn(rawInput, 'sampleCategoryId') && !editLines) throw new HttpError(400, 'invalid_sample', 'Supply the sample lines when changing the primary category.');
  const categoryId = editLines && Object.hasOwn(rawInput, 'sampleCategoryId') ? uuid(sampleCategoryId, 'Sample category').toLowerCase() : existing.sampleCategoryId;
  if (!Object.keys(changes).length && !editLines) return { id: existing.id, sampleNumber: existing.sampleNumber, revision: existing.revision };
  if (existing.revision === 2_147_483_647) throw new HttpError(409, 'sample_revision_limit', 'This sample has reached its revision limit.');
  const captured = await changedCustomerReferences(client, organizationId, existing, changes);
  let lineChanges = {}; let reportingDate = '';
  const receivedValue = changes.receivedAt ?? existing.receivedAt;
  try { if (editLines) ({ changes: lineChanges, reportingDate } = await reconcileSampleProducts(client, identity, existing, products, categoryId, receivedValue)); }
  catch (error) {
    const cause = error.cause ?? error;
    if (cause.code === '55000' || cause.code === '23503') throw new HttpError(409, 'sample_lines_changed', 'A sample line or test is in use or its references changed. Reload the sample before saving.');
    if (cause.code === '22003') throw new HttpError(400, 'invalid_sample', 'A sample line number is outside the supported range.');
    if (['22007', '22008', '22009'].includes(cause.code)) throw new HttpError(400, 'invalid_sample', 'A sample date is outside the supported range.');
    throw error;
  }
  validateSampleHeaderChanges(existing, { ...changes, ...(reportingDate ? {
    dueAt: new Date(Math.max(new Date(`${reportingDate}T00:00:00Z`).getTime(), new Date(receivedValue).getTime())),
  } : {}) });
  const updates = { ...changes, ...captured, ...lineChanges, revision: existing.revision + 1 };
  if (Object.hasOwn(changes, 'receivedAt') || categoryId !== existing.sampleCategoryId) {
    await lockReferences(client, sampleCategories, [categoryId]);
    const receivedAt = Object.hasOwn(changes, 'receivedAt') ? sql`${changes.receivedAt}::timestamptz` : samples.receivedAt;
    if (Object.hasOwn(changes, 'receivedAt')) updates.receivedAt = receivedAt;
    updates.retentionDueOn = sql`CASE WHEN ${samples.receivedAt} IS DISTINCT FROM ${receivedAt} OR ${samples.sampleCategoryId} IS DISTINCT FROM ${categoryId}::uuid
      THEN (${receivedAt} AT TIME ZONE 'UTC')::date +
        (SELECT retention_days FROM sample_categories WHERE organization_id=${organizationId} AND id=${categoryId})
      ELSE ${samples.retentionDueOn} END`;
  }
  if (Object.hasOwn(changes, 'dueAt')) updates.dueAt = changes.dueAt === null ? null : sql`${changes.dueAt}::timestamptz`;
  if (reportingDate) {
    const receivedAt = Object.hasOwn(changes, 'receivedAt') ? sql`${changes.receivedAt}::timestamptz` : samples.receivedAt;
    // A source calendar date must not truncate an unchanged saved due instant
    // or precede receipt when a fractional estimate lands on the receiving day.
    updates.dueAt = sql`GREATEST(CASE WHEN (${samples.dueAt} AT TIME ZONE 'UTC')::date=${reportingDate}::date
      THEN ${samples.dueAt} ELSE ${reportingDate}::date::timestamp AT TIME ZONE 'UTC' END, ${receivedAt})`;
  }
  let result;
  try {
    [result] = await db.update(samples).set(updates).where(and(eq(samples.organizationId, organizationId), eq(samples.id, sampleId), eq(samples.revision, expectedRevision)))
      .returning({ id: samples.id, sampleNumber: samples.sampleNumber, revision: samples.revision });
  } catch (error) {
    // PostgreSQL checks the full timestamp precision, including microseconds
    // below JavaScript Date's resolution, without rounding saved timestamps.
    const cause = error.cause ?? error;
    if (cause.code === '23514' && cause.constraint === 'sample_dates_quantity') throw new HttpError(400, 'invalid_sample', 'Due date cannot be earlier than the received date.');
    if (['22003', '22007', '22008', '22009'].includes(cause.code)) throw new HttpError(400, 'invalid_sample', 'A sample number or date is outside the supported range.');
    throw error;
  }
  if (!result) throw new HttpError(409, 'sample_changed', 'The sample changed while it was being saved.');
  await db.insert(sampleEvents).values({ organizationId, sampleId, eventType: 'sample_updated', actorUserId: identity.user_id, description: 'Sample updated' });
  return result;
}
