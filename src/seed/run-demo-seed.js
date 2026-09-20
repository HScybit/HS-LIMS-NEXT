import { withSession } from '../auth/service.js';
import * as provision from './provision.js';
import { buildSeedCatalog, SEED_INDUSTRY_KEYS } from './industry-catalog.js';
import { provisionSampleLifecycle } from './lifecycle.js';

// Shared by the CLI orchestrator (scripts/seed-demo.js) and the platform
// administrator's organization seeding screen, so both exercise the exact same
// real service-layer provisioning pipeline.
// The generation order the seeding plan shows before a run. `key` is the label
// each step reports as it completes; `group` splits the plan into the
// configuration a LIMS needs before it can accept samples, and the records that
// represent actual laboratory activity.
export const seedDomains = Object.freeze([
  { key: 'resolve admin identity', label: 'Administrator', group: 'master', owns: ['Seeding Identity'], note: 'The organization\u2019s own administrator is preserved.' },
  { key: 'business unit', label: 'Business Unit', group: 'master', owns: ['Business Units'] },
  { key: 'laboratories', label: 'Lab', group: 'master', owns: ['Laboratories'], note: 'Four shared laboratories plus each industry\u2019s own.' },
  { key: 'roles', label: 'Role', group: 'master', owns: ['Roles', 'Role Capabilities'] },
  { key: 'users', label: 'User', group: 'master', owns: ['Users', 'Memberships'], note: 'Named for the organization and the job, never for a person.' },
  { key: 'laboratory heads', label: 'Head of Department', group: 'master', owns: ['Laboratory Heads'] },
  { key: 'data masters', label: 'Data Master', group: 'master', owns: ['Data Masters', 'Data Master Values'], note: 'Sampling locations, storage conditions and receipt conditions.' },
  { key: 'project fields', label: 'Project Field', group: 'master', owns: ['Project Fields'], note: 'AR number, batch, manufacturing and expiry dates, storage condition.' },
  { key: 'measurement units', label: 'Measurement Unit', group: 'master', owns: ['Measurement Units'] },
  { key: 'templates', label: 'Templates', group: 'master', owns: ['Master Templates', 'Template Sections'], note: 'Analytical Datasheet, Certificate of Analysis and Instrument Service Record.' },
  { key: 'workflows', label: 'Workflow', group: 'master', owns: ['Workflow Masters'], note: 'Required by samples and test requests.' },
  { key: 'sample categories', label: 'Sample Category', group: 'master', owns: ['Sample Categories'] },
  { key: 'organization settings', label: 'Organization Settings', group: 'master', owns: ['Laboratory Settings', 'Module Access'] },
  { key: 'vendors', label: 'Vendor', group: 'master', owns: ['Vendor Master'] },
  { key: 'customers', label: 'Customer', group: 'master', owns: ['Customer Master'], note: 'Named customers with their city and state.' },
  { key: 'products', label: 'Product', group: 'master', owns: ['Products'] },
  { key: 'methods', label: 'Method of Analysis', group: 'master', owns: ['Methods of Analysis'] },
  { key: 'test parameters', label: 'Test Parameter', group: 'master', owns: ['Test Parameters'] },
  { key: 'parameter methods', label: 'Parameter Method', group: 'master', owns: ['Parameter Methods'], note: 'Registration requires a parameter and method to be linked.' },
  { key: 'material categories', label: 'Material Category', group: 'master', owns: ['Material Categories'] },
  { key: 'materials', label: 'Material', group: 'master', owns: ['Materials', 'Material Transactions'], note: 'Includes opening stock and minimum stock levels.' },
  { key: 'instruments', label: 'Equipment', group: 'master', owns: ['Instruments'], note: 'Real makes, models and serial numbers.' },
  { key: 'decision rules', label: 'Decision Rule', group: 'master', owns: ['Decision Rules'], note: 'Acceptance limits, estimated days and charges per parameter.' },
  { key: 'test groups', label: 'Test Group', group: 'master', owns: ['Test Group Panels'], note: 'One panel per product, raising every test in it from a single selection.' },
  { key: 'checklists', label: 'Checklist', group: 'master', owns: ['Workflow Checklists'] },
  { key: 'service agreements', label: 'Service Agreement', group: 'master', owns: ['Service Agreements'], note: 'Connects service vendors to the instruments they cover.' },
  { key: 'demo samples', label: 'Sample', group: 'transaction', owns: ['Samples', 'Sample Line Items', 'Test Requests', 'Datasheets'], note: 'Spread across the workflow stages, not all completed.' },
  { key: 'sample lifecycle', label: 'Results and Approvals', group: 'transaction', owns: ['Datasheet Results', 'Submissions', 'Approval Requests'], note: 'Recorded by the analyst and approved by the QA approver, as they would really be.' },
]);

export const seedDomainGroups = Object.freeze([
  { key: 'master', label: 'Master Data', description: 'Configuration required before the LIMS can accept samples.' },
  { key: 'transaction', label: 'Transaction / Entity Data', description: 'Records that represent actual laboratory activity.' },
]);

export const DEFAULT_SEED_INDUSTRIES = Object.freeze(['pharmaceutical']);

export async function runDemoSeedProvisioning(session, { onStep, accountAction = false, industries = DEFAULT_SEED_INDUSTRIES, sessionFor = null } = {}) {
  const catalog = buildSeedCatalog(industries);
  const work = async (label, fn) => {
    // A freshly provisioned administrator still has to change their password, a
    // gate that must not block administrative seeding.
    const result = await withSession(session.token, fn, { csrfToken: session.csrfToken, accountAction });
    onStep?.(label);
    return result;
  };
  const adminUserId = await work('resolve admin identity', (client, identity) => identity.user_id);
  await work('business unit', (client, identity) => provision.provisionBusinessUnit(client, identity));
  const laboratoryIds = await work('laboratories', (client, identity) => provision.provisionLaboratories(client, identity, { catalog }));
  const roleIds = await work('roles', (client, identity) => provision.provisionRoles(client, identity, { catalog }));
  const userIds = await work('users', (client, identity) => provision.provisionUsers(client, identity, { catalog, roleIds, laboratoryIds }));
  const credentials = userIds.credentials ?? [];
  await work('laboratory heads', (client, identity) => provision.provisionLaboratoryHeads(client, identity, { catalog, laboratoryIds, userIds }));
  const dataMasterIds = await work('data masters', (client, identity) => provision.provisionDataMasters(client, identity, { catalog }));
  await work('project fields', (client, identity) => provision.provisionProjectFields(client, identity, { catalog, dataMasterIds }));
  const measurementUnitIds = await work('measurement units', (client, identity) => provision.provisionMeasurementUnits(client, identity, { catalog }));
  const templates = await work('templates', (client, identity) => provision.provisionTemplates(client, identity));
  const template = templates['STD-ANALYTICAL-DATASHEET'];
  const workflowSet = await work('workflows', (client, identity) => provision.provisionWorkflows(client, identity, { catalog, roleIds }));
  const sampleCategoryIds = await work('sample categories', (client, identity) => provision.provisionSampleCategories(client, identity, { catalog, workflowId: workflowSet.sample.id, templateId: template.templateId }));
  await work('organization settings', (client, identity) => provision.provisionOrganizationSettings(client, identity, { sampleWorkflowId: workflowSet.sample.id, testRequestWorkflowId: workflowSet.testRequest.id, adminUserId }));
  const vendorIds = await work('vendors', (client, identity) => provision.provisionVendors(client, identity, { catalog }));
  const customerIds = await work('customers', (client, identity) => provision.provisionCustomers(client, identity, { catalog }));
  const productIds = await work('products', (client, identity) => provision.provisionProducts(client, identity, { catalog, sampleCategoryIds }));
  const methodIds = await work('methods', (client, identity) => provision.provisionMethods(client, identity, { catalog }));
  const parameterIds = await work('test parameters', (client, identity) => provision.provisionTestParameters(client, identity, { catalog, laboratoryIds }));
  await work('parameter methods', (client, identity) => provision.provisionParameterMethods(client, identity, { catalog, parameterIds, methodIds }));
  const materialCategoryIds = await work('material categories', (client, identity) => provision.provisionMaterialCategories(client, identity, { catalog }));
  const materialIds = await work('materials', (client, identity) => provision.provisionMaterials(client, identity, { catalog, materialCategoryIds, measurementUnitIds }));
  const instrumentIds = await work('instruments', (client, identity) => provision.provisionInstruments(client, identity, { catalog, laboratoryIds, userIds }));
  const decisionRuleIds = await work('decision rules', (client, identity) => provision.provisionDecisionRules(client, identity, { catalog, productIds, parameterIds, methodIds, sampleCategoryIds, instrumentIds, templateId: template.templateId }));
  await work('test groups', (client, identity) => provision.provisionTestGroups(client, identity, { catalog, productIds, parameterIds, methodIds, sampleCategoryIds, templateId: template.templateId }));
  await work('checklists', (client, identity) => provision.provisionChecklists(client, identity, { catalog }));
  await work('service agreements', (client, identity) => provision.provisionServiceAgreements(client, identity, { catalog, vendorIds, instrumentIds }));
  const samples = await work('demo samples', (client, identity) => provision.provisionDemoSamples(client, identity, {
    catalog, sampleCategoryIds, customerIds, productIds, parameterIds, methodIds, decisionRuleIds, materialIds, userIds,
  }));
  // Recording, submitting and approving results is done by the users who would
  // really do it, which needs a session each; without one the samples rest at
  // the allocated stage.
  const lifecycle = sessionFor
    ? await provisionSampleLifecycle({ sessionFor, catalog, samples, userIds })
    : null;
  if (lifecycle) onStep?.('sample lifecycle');
  return { credentials, samples, lifecycle, industries: catalog.industryKeys };
}

export { SEED_INDUSTRY_KEYS };
