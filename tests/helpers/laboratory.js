import { randomUUID } from 'node:crypto';
import { database } from '../../src/db/pool.js';
import * as masters from '../../src/db/master-schema.js';
import { workflows, workflowVersions, workflowStates, workflowTransitions, sampleCategoryWorkflows, workflowStateCapabilityRoles } from '../../src/db/workflow-schema.js';
import { createAnalyticalTemplate } from './templates.js';

// Entirely synthetic. The owner connection is restricted by ownerPool(); no
// source records, remote databases or source application initialization is used.
export async function createLaboratoryFixture(owner, account, options = {}) {
  const client = await owner.connect();
  const organizationId = account.organizationId;
  try {
    await client.query('BEGIN');
    const db = database(client);
    const code = () => randomUUID();
    const [unit] = await db.insert(masters.measurementUnits).values({ organizationId, code: code(), name: 'Synthetic concentration unit', symbol: 'mg/L', dimension: 'concentration' }).returning();
    const [laboratory] = await db.insert(masters.laboratories).values({ organizationId, code: code(), name: 'Synthetic analytical lab' }).returning();
    const [category] = await db.insert(masters.sampleCategories).values({ organizationId, code: options.categoryCode ?? code(), name: 'Synthetic water', abbreviation: 'SYN-W', retentionDays: 30, estimatedTimeInDays: 2 }).returning();
    const [product] = await db.insert(masters.products).values({ organizationId, code: code(), name: 'Synthetic water specimen' }).returning();
    await db.insert(masters.productSampleCategories).values({ organizationId, productId: product.id, sampleCategoryId: category.id });
    const [customer] = await db.insert(masters.customers).values({ organizationId, code: options.customerCode ?? code(), name: 'Synthetic customer', legalName: 'Synthetic customer laboratory', creditDays: 30 }).returning();
    const [parameter] = await db.insert(masters.testParameters).values({ organizationId, code: code(), name: 'Synthetic concentration', masterKey: code(), schemeAbbreviation: code(), laboratoryId: laboratory.id, measurementUnitId: unit.id }).returning();
    const [method] = await db.insert(masters.methodsOfAnalysis).values({ organizationId, code: code(), name: 'Synthetic two-times method', methodUuid: code(), decimalScale: 2, parseNumber: true }).returning();
    await db.insert(masters.parameterMethods).values({ organizationId, testParameterId: parameter.id, methodId: method.id, isDefault: true });
    const template = options.template ?? await createAnalyticalTemplate(client, { organization_id: organizationId, user_id: account.userId, permission_codes: ['templates.manage'] }, { repeated: options.repeated ?? true });
    const [rule] = await db.insert(masters.decisionRules).values({ organizationId, code: code(), name: 'Synthetic acceptance criterion', productId: product.id,
      testParameterId: parameter.id, methodId: method.id, sampleCategoryId: category.id, templateId: template.templateId, cutoffValue: '10', lessThanText: 'Within synthetic limit', greaterThanText: 'Above synthetic limit' }).returning();
    await db.insert(masters.decisionRuleLimits).values({ organizationId, decisionRuleId: rule.id, lowerLimit: '0', upperLimit: '10', outcome: 'Within synthetic limit', displayOrder: 0 });
    await db.insert(masters.sampleCategoryTemplates).values({ organizationId, sampleCategoryId: category.id, templateId: template.templateId, purpose: 'datasheet', isDefault: true });
    const workflowRecords = [];
    if (options.workflow !== false) for (const appliesTo of ['sample', 'test_request']) {
      const [workflow] = await db.insert(workflows).values({ organizationId, code: code(), name: `Synthetic ${appliesTo} workflow`, appliesTo }).returning();
      const [version] = await db.insert(workflowVersions).values({ organizationId, workflowId: workflow.id, number: 1, createdBy: account.userId }).returning();
      const [state] = await db.insert(workflowStates).values({ organizationId, workflowVersionId: version.id, code: 'initial', name: 'In Progress', stateType: 'initial',
        showSampleEdit: true, showAddResult: true, canWorkOnTestRequest: true, generateTestRequests: appliesTo === 'sample' && Boolean(options.generateTestRequests) }).returning();
      const [finalState] = await db.insert(workflowStates).values({ organizationId, workflowVersionId: version.id, code: 'complete', name: 'Completed', stateType: 'final', isPositiveTermination: true }).returning();
      await db.insert(workflowTransitions).values({ organizationId, workflowVersionId: version.id, code: 'complete', name: 'Complete', sourceStateId: state.id, targetStateId: finalState.id });
      if (options.capabilityRoleId) await db.insert(workflowStateCapabilityRoles).values({ organizationId, workflowStateId: state.id, capability: 'allocate', roleId: options.capabilityRoleId });
      if (appliesTo === 'sample' && options.printRoleId) await db.insert(workflowStateCapabilityRoles).values({ organizationId, workflowStateId: state.id, capability: 'download_report', roleId: options.printRoleId });
      await client.query("UPDATE workflow_versions SET status = 'published', revision = 2, published_by = $3, published_at = now() WHERE organization_id = $1 AND id = $2", [organizationId, version.id, account.userId]);
      await db.insert(sampleCategoryWorkflows).values({ organizationId, sampleCategoryId: category.id, workflowId: workflow.id, appliesTo, isDefault: true });
      workflowRecords.push({ workflow, version, state });
    }
    await client.query('COMMIT');
    const registration = { sampleType: 'internal', sampleCategoryId: category.id, receivedAt: '2026-09-12T10:30:00+05:30', dueAt: '2026-09-14T10:30:00+05:30',
      description: 'Synthetic analytical sample', products: [{ productId: product.id, measurementUnitId: unit.id, quantity: '1.25',
        tests: [{ testParameterId: parameter.id, methodId: method.id, decisionRuleId: rule.id, requestedQuantity: 1, rate: '0', currencyCode: 'INR' }] }] };
    return { organizationId, unit, laboratory, category, product, customer, parameter, method, rule, template, workflowRecords, registration };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
