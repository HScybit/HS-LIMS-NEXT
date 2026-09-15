import { and, eq, sql } from 'drizzle-orm';
import { HttpError } from '../auth/errors.js';
import { database } from '../db/pool.js';
import { customers, customerQuotations, sampleCategories } from '../db/master-schema.js';
import { samples, sampleEvents } from '../db/sample-schema.js';
import { requirePermission, uuid } from '../templates/input.js';
import { requireWorkflowAction } from '../workflows/access.js';
import { lockReferences } from './reference-locks.js';
import { sampleHeaderRevision, sampleHeaderUpdateInput, validateSampleHeaderChanges } from './update-input.js';

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

// The caller owns the transaction, so the revision, changed references and actor
// event commit together. This command edits headers only; line/capture identity
// and scientific histories have separate adapters and remain untouched.
export async function updateSampleHeader(client, identity, sampleId, rawInput) {
  requirePermission(identity, 'samples.manage'); uuid(sampleId, 'Sample');
  const expectedRevision = sampleHeaderRevision(rawInput);
  const organizationId = identity.organization_id; const db = database(client);
  const [existing] = await db.select().from(samples).where(and(eq(samples.organizationId, organizationId), eq(samples.id, sampleId))).for('update');
  if (!existing) throw new HttpError(404, 'sample_not_found', 'Sample was not found.');
  // Workflow commands also lock the owner before its run. Holding both prevents
  // an edit permission check from racing a transition into a different state.
  await client.query('SELECT id FROM workflow_runs WHERE organization_id=$1 AND sample_id=$2 FOR UPDATE', [organizationId, sampleId]);
  await requireWorkflowAction(client, identity, { type: 'sample', id: sampleId }, 'edit');
  if (existing.revision !== expectedRevision) throw new HttpError(409, 'sample_changed', 'The sample changed after it was opened. Reload it before saving.');
  const { changes } = sampleHeaderUpdateInput(rawInput, existing.sampleType);
  if (!Object.keys(changes).length) return { id: existing.id, sampleNumber: existing.sampleNumber, revision: existing.revision };
  if (existing.revision === 2_147_483_647) throw new HttpError(409, 'sample_revision_limit', 'This sample has reached its revision limit.');
  validateSampleHeaderChanges(existing, changes);
  const captured = await changedCustomerReferences(client, organizationId, existing, changes);
  const updates = { ...changes, ...captured, revision: existing.revision + 1 };
  if (Object.hasOwn(changes, 'receivedAt')) {
    await lockReferences(client, sampleCategories, [existing.sampleCategoryId]);
    updates.receivedAt = sql`${changes.receivedAt}::timestamptz`;
    updates.retentionDueOn = sql`CASE WHEN ${samples.receivedAt} IS DISTINCT FROM ${changes.receivedAt}::timestamptz
      THEN (${changes.receivedAt}::timestamptz AT TIME ZONE 'UTC')::date +
        (SELECT retention_days FROM sample_categories WHERE organization_id=${organizationId} AND id=${existing.sampleCategoryId})
      ELSE ${samples.retentionDueOn} END`;
  }
  if (Object.hasOwn(changes, 'dueAt')) updates.dueAt = changes.dueAt === null ? null : sql`${changes.dueAt}::timestamptz`;
  let result;
  try {
    [result] = await db.update(samples).set(updates).where(and(eq(samples.organizationId, organizationId), eq(samples.id, sampleId), eq(samples.revision, expectedRevision)))
      .returning({ id: samples.id, sampleNumber: samples.sampleNumber, revision: samples.revision });
  } catch (error) {
    // PostgreSQL checks the full timestamp precision, including microseconds
    // below JavaScript Date's resolution, without rounding saved timestamps.
    const cause = error.cause ?? error;
    if (cause.code === '23514' && cause.constraint === 'sample_dates_quantity') throw new HttpError(400, 'invalid_sample', 'Due date cannot be earlier than the received date.');
    if (['22003', '22008'].includes(cause.code)) throw new HttpError(400, 'invalid_sample', 'A sample number or date is outside the supported range.');
    throw error;
  }
  if (!result) throw new HttpError(409, 'sample_changed', 'The sample changed while it was being saved.');
  await db.insert(sampleEvents).values({ organizationId, sampleId, eventType: 'sample_updated', actorUserId: identity.user_id, description: 'Sample updated' });
  return result;
}
