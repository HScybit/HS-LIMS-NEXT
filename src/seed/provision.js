import { randomUUID } from 'node:crypto';
import { database } from '../db/pool.js';
import { measurementUnits } from '../db/master-schema.js';
import { createTemplate, copyDefinition, freezeTemplate } from '../templates/authoring.js';
import { createWorkflow, saveWorkflowState, saveWorkflowTransition, publishWorkflow } from '../workflows/authoring.js';
import { saveBusinessUnit } from '../masters/business-units.js';
import { saveLaboratory } from '../masters/laboratories.js';
import { createRole } from '../roles/service.js';
import { createUser } from '../users/create.js';
import { saveSampleCategory } from '../masters/sample-categories.js';
import { saveLaboratorySettings } from '../organization-settings/service.js';
import { saveVendor } from '../masters/vendors.js';
import { saveCustomer } from '../masters/customers.js';
import { saveProduct } from '../masters/products.js';
import { saveMethod } from '../masters/methods.js';
import { saveTestParameter } from '../masters/test-parameters.js';
import { saveMaterialCategory } from '../masters/material-categories.js';
import { saveCustomField } from '../masters/custom-fields.js';
import { saveLookupSourceObservation } from '../custom-fields/lookup-sources.js';
import { saveMaterial, createMaterialTransaction } from '../materials/service.js';
import { saveInstrumentCore } from '../instruments/core.js';
import { saveDecisionRule } from '../masters/decision-rules.js';
import { createChecklist } from '../checklists/service.js';
import { saveServiceAgreement } from '../masters/service-agreements.js';
import { registerSample } from '../samples/register.js';
import { generateTestRequests } from '../test-requests/generate.js';
import { allocateTestRequest } from '../test-requests/allocate.js';
import { workflowDefinitions } from './workflow-catalog.js';
import { templateDefinitions } from './template-catalog.js';
import { ANALYST_REFS, buildOrganizationSlug, buildUserEmailDomain, LAB_ENVIRONMENT, LAB_HEADS, MATERIAL_SUPPLIERS } from './industry-catalog.js';

const draft = () => ({ id: randomUUID(), requestId: randomUUID(), revision: 0 });

async function existingId(client, organizationId, table, column, value) {
  const result = await client.query(`SELECT id FROM ${table} WHERE organization_id=$1 AND ${column}=$2 LIMIT 1`, [organizationId, value]);
  return result.rows[0]?.id ?? null;
}

async function ensure(client, organizationId, table, column, value, create) {
  const existing = await existingId(client, organizationId, table, column, value);
  if (existing) return { id: existing, created: false };
  const created = await create();
  return { id: created.id, created: true };
}

export async function provisionBusinessUnit(client, identity) {
  const { id } = await ensure(client, identity.organization_id, 'business_unit_directory', 'code', 'QUALITY',
    () => saveBusinessUnit(client, identity, { ...draft(), code: 'QUALITY', name: 'Quality Assurance' }));
  return id;
}

export async function provisionLaboratories(client, identity, { catalog }) {
  const byRef = {};
  for (const laboratory of catalog.laboratories) {
    const { id } = await ensure(client, identity.organization_id, 'laboratories', 'code', laboratory.code,
      () => saveLaboratory(client, identity, { ...draft(), code: laboratory.code, name: laboratory.name, abbreviation: laboratory.abbreviation,
        minimumTemperature: `${LAB_ENVIRONMENT.min_temperature}°C`, maximumTemperature: `${LAB_ENVIRONMENT.max_temperature}°C`,
        minimumHumidity: `${LAB_ENVIRONMENT.min_humidity}%`, maximumHumidity: `${LAB_ENVIRONMENT.max_humidity}%` }));
    byRef[laboratory.ref] = id;
  }
  return byRef;
}

export async function provisionRoles(client, identity, { catalog }) {
  const byRef = {};
  for (const role of catalog.roleDefinitions) {
    const existing = await client.query('SELECT id FROM roles WHERE organization_id=$1 AND lower(name)=lower($2)', [identity.organization_id, role.name]);
    if (existing.rowCount) { byRef[role.ref] = existing.rows[0].id; continue; }
    const created = await createRole(client, identity, { ...draft(), name: role.name, description: role.description,
      permissionCodes: role.permissions, capabilityKeys: role.capabilities });
    byRef[role.ref] = created.id;
  }
  return byRef;
}

async function seedOrganization(client, identity) {
  const result = await client.query('SELECT name, domain FROM organizations WHERE id=$1', [identity.organization_id]);
  return result.rows[0] ?? { name: 'Laboratory', domain: null };
}

// Seeded users are named for the organization and the job they do, never for a
// person: "Universal Laboratory" produces `ulanalyst` / "Universal Laboratory
// Analyst". Usernames are unique across the whole deployment though, not per
// organization, so a name another organization already holds falls back to one
// disambiguated by this organization's id.
const SEED_USER_PASSWORD = 'Seed-Password-2026!';
const organizationSuffix = (organizationId) => organizationId.replace(/-/g, '').slice(0, 8);

export async function provisionUsers(client, identity, { catalog, roleIds, laboratoryIds }) {
  const organization = await seedOrganization(client, identity);
  const slug = buildOrganizationSlug(organization.name);
  const emailDomain = buildUserEmailDomain(organization, slug);
  const suffix = organizationSuffix(identity.organization_id);
  const byRef = {};
  const credentials = [];
  for (const user of catalog.users) {
    const displayName = `${organization.name} ${user.roleLabel}`;
    const preferred = `${slug}${user.suffix}`;
    const existing = await existingId(client, identity.organization_id, 'user_directory', 'lower(username)', preferred.toLowerCase());
    if (existing) { byRef[user.ref] = existing; continue; }
    let created = null;
    for (const username of [preferred, `${preferred}.${suffix}`]) {
      await client.query('SAVEPOINT before_seed_user');
      try {
        created = await createUser(client, identity, {
          ...draft(), username, email: `${username}@${emailDomain}`, displayName, password: SEED_USER_PASSWORD,
          defaultRoleId: roleIds[user.role], laboratoryId: laboratoryIds[user.lab] ?? null,
          reportingManagerId: user.manager ? byRef[user.manager] ?? null : null, roleIds: [roleIds[user.role]],
        });
        await client.query('RELEASE SAVEPOINT before_seed_user');
        break;
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT before_seed_user');
        if (error.code !== 'sign_in_identifier_taken') throw error;
      }
    }
    if (!created) throw new Error(`Could not allocate a username for the seeded ${user.roleLabel}.`);
    byRef[user.ref] = created.user.id;
    credentials.push({ displayName, username: created.user.username, email: created.user.email, password: SEED_USER_PASSWORD });
  }
  // Non-enumerable so callers that walk the id map are unaffected.
  Object.defineProperty(byRef, 'credentials', { value: credentials });
  return byRef;
}

export async function provisionMeasurementUnits(client, identity, { catalog }) {
  const db = database(client);
  const byCode = {};
  for (const unit of catalog.measurementUnits) {
    const existing = await existingId(client, identity.organization_id, 'measurement_units', 'code', unit.code);
    if (existing) { byCode[unit.code] = existing; continue; }
    const [row] = await db.insert(measurementUnits).values({ organizationId: identity.organization_id, code: unit.code, name: unit.name, symbol: unit.symbol }).returning();
    byCode[unit.code] = row.id;
  }
  return byCode;
}

const WIDGET_VALUE_TYPE = Object.freeze({
  text_widget: 'text', input_widget: 'text', sample_details_widget_v2: 'text', tr_data_widget: 'text',
  decision_rule_widget: 'text', tr_result_widget: 'text', sno_widget: 'text',
  result_widget: 'result', dropdown_widget: 'option',
});

// A field's alias is what a formula and the seeded results refer to, and the
// column that accepts it is what a datasheet submission reads a final result
// from, so both are carried over from the catalog exactly.
function templateRecords(definition) {
  const sections = []; const rows = []; const columns = []; const fields = []; const options = []; const groups = [];
  definition.sections.forEach((section, sectionIndex) => {
    const sectionId = randomUUID();
    sections.push({ id: sectionId, parentColumnId: null, position: sectionIndex, name: section.name,
      cssClass: section.className ?? '', isParameterLoop: Boolean(section.isParameterLoop),
      isParameterLoopHeader: Boolean(section.isParameterLoopHeader) });
    // A parameter loop repeats its section once per test request, but only a
    // datasheet carries the repeat definition: a report's loop is expanded from
    // the sample's own tests when it is rendered.
    const repeatGroupId = section.repeat && definition.kind === 'datasheet' ? randomUUID() : null;
    if (repeatGroupId) {
      groups.push({ id: repeatGroupId, parentGroupId: null, sectionId, rowId: null, source: 'test_requests',
        minimum: section.repeat.minimum, maximum: section.repeat.maximum });
    }
    section.rows.forEach((row, rowIndex) => {
      const rowId = randomUUID();
      rows.push({ id: rowId, sectionId, position: rowIndex });
      row.forEach((entry, columnIndex) => {
        const columnId = randomUUID(); const fieldId = randomUUID();
        columns.push({ id: columnId, rowId, position: columnIndex, span: entry.span,
          cssClass: entry.className ?? '', isFinalResult: Boolean(entry.isFinalResult) });
        const valueType = WIDGET_VALUE_TYPE[entry.widget];
        const present = entry.defaultText !== undefined && valueType === 'text';
        fields.push({ id: fieldId, columnId, repeatGroupId, widget: entry.widget, valueType,
          alias: entry.key.replace(/[^A-Za-z0-9_]/g, '_'), label: entry.label ?? '', placeholder: entry.placeholder ?? '',
          required: Boolean(entry.required), editable: Boolean(entry.editable),
          defaultState: present ? 'present' : 'absent', ...(present ? { defaultText: entry.defaultText } : {}),
          ...(entry.sourceField ? { sourceField: entry.sourceField } : {}),
          ...(entry.serialPadding ? { serialPadding: entry.serialPadding } : {}) });
        (entry.options ?? []).forEach((option, position) => {
          options.push({ id: randomUUID(), fieldId, valueType: 'option', position, label: option, value: option });
        });
      });
    });
  });
  return { sections, rows, columns, fields, options, expressions: [], groups };
}

/**
 * The three template masters, ported from PERN: the Analytical Datasheet a
 * test request is worked on, the Certificate of Analysis issued for a released
 * sample, and the Instrument Service Record.
 */
export async function provisionTemplates(client, identity) {
  const byCode = {};
  for (const definition of templateDefinitions) {
    const existing = await client.query(`SELECT template.id AS "templateId", version.id AS "versionId" FROM templates template
      JOIN template_versions version ON version.organization_id=template.organization_id AND version.template_id=template.id AND version.status='frozen'
      WHERE template.organization_id=$1 AND version.name=$2 ORDER BY version.number DESC LIMIT 1`, [identity.organization_id, definition.name]);
    if (existing.rowCount) { byCode[definition.code] = existing.rows[0]; continue; }

    const created = await createTemplate(client, identity, {
      name: definition.name, description: definition.description, kind: definition.kind, code: definition.code,
      ...(definition.templateType ? { templateType: definition.templateType } : {}),
    });
    await copyDefinition(database(client), templateRecords(definition), identity.organization_id, created.versionId);
    await freezeTemplate(client, identity, created.versionId, created.revision);
    byCode[definition.code] = { templateId: created.templateId, versionId: created.versionId };
  }
  return byCode;
}

async function provisionWorkflow(client, identity, definition, roleIdByCode) {
  const existing = await client.query(`SELECT workflow.id AS "workflowId", version.id AS "versionId"
    FROM workflows workflow JOIN workflow_versions version ON version.organization_id=workflow.organization_id AND version.workflow_id=workflow.id AND version.status='published'
    WHERE workflow.organization_id=$1 AND workflow.name=$2 ORDER BY version.number DESC LIMIT 1`, [identity.organization_id, definition.name]);
  if (existing.rowCount) return { id: existing.rows[0].workflowId, versionId: existing.rows[0].versionId };

  const created = await createWorkflow(client, identity, { code: randomUUID(), name: definition.name, appliesTo: definition.appliesTo });
  let revision = created.revision;
  const stateIds = {};
  for (const state of definition.states) {
    const saved = await saveWorkflowState(client, identity, created.versionId, revision, {
      code: state.code, name: state.name, stateType: state.type, showSampleEdit: state.type === 'initial',
      showAddResult: definition.appliesTo !== 'instrument_service', canWorkOnTestRequest: true,
      generateTestRequests: Boolean(state.generateTestRequests), isPositiveTermination: state.type === 'final',
    });
    stateIds[state.code] = saved.id; revision = saved.revision;
  }
  const roles = (codes) => (codes ?? []).map((code) => roleIdByCode[code]).filter(Boolean);
  const transitionIds = {};
  for (const transition of definition.transitions) {
    const approvers = roles(transition.approverRoles);
    const saved = await saveWorkflowTransition(client, identity, created.versionId, revision, {
      code: transition.code, name: transition.name,
      sourceStateId: stateIds[transition.from], targetStateId: stateIds[transition.to],
      creatorRoleIds: roles(transition.creatorRoles),
      ...(approvers.length ? { approvalMode: 'any', approverStages: [{ stageNumber: 1, roleIds: approvers }] } : {}),
    });
    transitionIds[transition.code] = saved.id; revision = saved.revision;
  }
  await publishWorkflow(client, identity, created.versionId, revision, `Seed ${definition.name}`);
  return { id: created.workflowId, versionId: created.versionId, states: stateIds, transitions: transitionIds };
}

// Every transition names the roles that may ask for it, and the roles that must
// approve it, so a seeded organization exercises real approval routing rather
// than transitions that apply the moment they are requested.
export async function provisionWorkflows(client, identity, { catalog, roleIds } = {}) {
  const roleIdByCode = Object.fromEntries((catalog?.roleDefinitions ?? [])
    .map((role) => [role.code, roleIds?.[role.ref]]).filter(([, id]) => id));
  const byEntity = {};
  for (const definition of workflowDefinitions) {
    byEntity[definition.appliesTo] = await provisionWorkflow(client, identity, definition, roleIdByCode);
  }
  return { sample: byEntity.sample, testRequest: byEntity.test_request, instrumentService: byEntity.instrument_service, byEntity };
}

export async function provisionSampleCategories(client, identity, { catalog, workflowId, templateId }) {
  const byRef = {};
  for (const category of catalog.sampleCategories) {
    const existing = await client.query('SELECT id FROM sample_categories WHERE organization_id=$1 AND lower(name)=lower($2)', [identity.organization_id, category.name]);
    if (existing.rowCount) { byRef[category.ref] = existing.rows[0].id; continue; }
    const created = await saveSampleCategory(client, identity, {
      ...draft(), name: category.name, description: category.description, abbreviation: category.abbreviation,
      retentionDays: category.retentionDays, estimatedTimeInDays: category.estimatedTimeInDays, workflowId, templates: { datasheet: templateId },
    });
    byRef[category.ref] = created.id;
  }
  return byRef;
}

export async function provisionVendors(client, identity, { catalog }) {
  const byRef = {};
  for (const vendor of catalog.vendors) {
    const { id } = await ensure(client, identity.organization_id, 'vendors', 'code', vendor.code, () => saveVendor(client, identity, {
      ...draft(), code: vendor.code, name: vendor.name, legalName: vendor.legalName,
      contacts: [{ id: randomUUID(), name: `${vendor.name} Service Desk`, email: `service@${vendor.code.toLowerCase().replace(/-/g, '')}.example`, phone: '9820000000', isPrimary: true }],
    }));
    byRef[vendor.ref] = id;
  }
  return byRef;
}

export async function provisionCustomers(client, identity, { catalog }) {
  const byRef = {};
  for (const customer of catalog.customers) {
    const { id } = await ensure(client, identity.organization_id, 'customers', 'code', customer.code, () => saveCustomer(client, identity, {
      ...draft(), code: customer.code, name: customer.name, legalName: customer.legalName, creditDays: 30,
      contacts: [{ id: randomUUID(), name: `${customer.abbreviation} Quality Desk`, email: `quality@${customer.abbreviation.toLowerCase()}.example`, phone: '9820000000', isPrimary: true }],
      addresses: [{ id: randomUUID(), addressType: 'billing', freeformAddress: `${customer.name}, ${customer.city}, ${customer.state}, India`, isDefault: true }],
    }));
    byRef[customer.ref] = id;
  }
  return byRef;
}

export async function provisionProducts(client, identity, { catalog, sampleCategoryIds }) {
  const byRef = {};
  for (const product of catalog.products) {
    const { id } = await ensure(client, identity.organization_id, 'products', 'code', product.key, () => saveProduct(client, identity, {
      ...draft(), name: product.name, key: product.key, description: product.description, abbreviation: product.abbreviation,
      sampleCategoryIds: product.categoryRefs.map((ref) => sampleCategoryIds[ref]).filter(Boolean),
    }));
    byRef[product.ref] = id;
  }
  return byRef;
}

export async function provisionMethods(client, identity, { catalog }) {
  const byRef = {};
  for (const method of catalog.methods) {
    const { id } = await ensure(client, identity.organization_id, 'methods_of_analysis', 'method_uuid', method.uuid, () => saveMethod(client, identity, {
      ...draft(), name: method.name, uuid: method.uuid, description: method.description,
      decimalScale: method.decimalScale, parseNumber: method.parseNumber,
    }));
    byRef[method.ref] = id;
  }
  return byRef;
}

export async function provisionTestParameters(client, identity, { catalog, laboratoryIds }) {
  const byRef = {};
  for (const parameter of catalog.testParameters) {
    const { id } = await ensure(client, identity.organization_id, 'test_parameters', 'master_key', parameter.key, () => saveTestParameter(client, identity, {
      ...draft(), name: parameter.name, key: parameter.key, schemeAbbreviation: parameter.schemeAbbreviation,
      description: parameter.description, laboratoryId: laboratoryIds[parameter.laboratoryRef] ?? null,
    }));
    byRef[parameter.ref] = id;
  }
  return byRef;
}

// Sample registration validates that a chosen method is linked to the chosen
// parameter via parameter_methods — decision rules alone don't establish that
// link. No save-function exists for this relation (tests/helpers/laboratory.js
// raw-inserts it too), so this mirrors that established pattern.
export async function provisionParameterMethods(client, identity, { catalog, parameterIds, methodIds }) {
  const seenPairs = new Set(); const parametersWithDefault = new Set();
  // A test group's own method has to be linked to the panel's parameter and to
  // every member's, or the panel cannot be selected on a sample.
  const pairs = [
    ...catalog.decisionRules,
    ...catalog.testGroups.flatMap((group) => [
      { parameterRef: group.parameterRef, methodRef: group.methodRef },
      ...group.members.map((member) => ({ parameterRef: member.parameterRef, methodRef: group.methodRef })),
    ]),
  ];
  for (const rule of pairs) {
    const testParameterId = parameterIds[rule.parameterRef]; const methodId = methodIds[rule.methodRef];
    if (!testParameterId || !methodId) continue;
    const pairKey = `${testParameterId}:${methodId}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    const isDefault = !parametersWithDefault.has(testParameterId);
    parametersWithDefault.add(testParameterId);
    await client.query(`INSERT INTO parameter_methods(organization_id, test_parameter_id, method_id, is_default)
      VALUES($1,$2,$3,$4) ON CONFLICT (organization_id, test_parameter_id, method_id) DO NOTHING`, [identity.organization_id, testParameterId, methodId, isDefault]);
  }
}

export async function provisionMaterialCategories(client, identity, { catalog }) {
  const byRef = {};
  for (const category of catalog.materialCategories) {
    const existing = await client.query('SELECT id FROM material_categories WHERE organization_id=$1 AND lower(name)=lower($2)', [identity.organization_id, category.name]);
    if (existing.rowCount) { byRef[category.ref] = existing.rows[0].id; continue; }
    const created = await saveMaterialCategory(client, identity, { ...draft(), name: category.name, description: category.description, reusable: category.reusable, expirable: category.expirable });
    byRef[category.ref] = created.id;
  }
  return byRef;
}

export async function provisionMaterials(client, identity, { catalog, materialCategoryIds, measurementUnitIds }) {
  const byRef = {};
  let supplier = 0;
  for (const material of catalog.materials) {
    const { id, created } = await ensure(client, identity.organization_id, 'materials', 'code', material.code, () => saveMaterial(client, identity, {
      ...draft(), name: material.name, code: material.code, categoryId: materialCategoryIds[material.categoryRef],
      measurementUnitId: measurementUnitIds[material.unitCode] ?? measurementUnitIds.UNITS,
      initialQuantity: material.initialQuantity, minimumQuantity: material.minimumQuantity,
    }));
    byRef[material.ref] = id;
    if (created) {
      // Opening stock, so the inventory listing shows a real receipt history.
      await createMaterialTransaction(client, identity, { id: randomUUID(), requestId: randomUUID(), materialId: id, type: 'in',
        quantity: material.initialQuantity, cost: '1000',
        supplier: MATERIAL_SUPPLIERS[supplier % MATERIAL_SUPPLIERS.length], batchSerialNumber: `BATCH-${material.code}-1`, expiryDate: '2027-12-31' });
      supplier += 1;
    }
  }
  return byRef;
}

export async function provisionInstruments(client, identity, { catalog, laboratoryIds, userIds }) {
  const byRef = {};
  const allowedUserIds = Object.values(userIds);
  for (const instrument of catalog.instruments) {
    const { id } = await ensure(client, identity.organization_id, 'instruments', 'code', instrument.code, () => saveInstrumentCore(client, identity, {
      ...draft(), code: instrument.code, name: instrument.name, laboratoryId: laboratoryIds[instrument.laboratoryRef], make: instrument.make,
      modelName: instrument.modelName, serialNumber: instrument.serialNumber, dateOfInstallation: '2024-01-15',
      calibrationAgency: instrument.calibrationAgency, calibrated: true, allowedUserIds,
    }));
    byRef[instrument.ref] = id;
  }
  return byRef;
}

export async function provisionDecisionRules(client, identity, { catalog, productIds, parameterIds, methodIds, sampleCategoryIds, instrumentIds, templateId }) {
  const byKey = {};
  for (const rule of catalog.decisionRules) {
    const productId = productIds[rule.productRef]; const testParameterId = parameterIds[rule.parameterRef]; const methodId = methodIds[rule.methodRef];
    if (!productId || !testParameterId || !methodId) continue;
    const key = `${rule.productRef}:${rule.parameterRef}`;
    const existing = await client.query('SELECT id FROM decision_rules WHERE organization_id=$1 AND product_id=$2 AND test_parameter_id=$3 AND method_id=$4',
      [identity.organization_id, productId, testParameterId, methodId]);
    if (existing.rowCount) { byKey[key] = existing.rows[0].id; continue; }
    const saved = await saveDecisionRule(client, identity, {
      ...draft(), name: rule.name, productId, testParameterId, methodId,
      sampleCategoryIds: rule.categoryRefs.map((ref) => sampleCategoryIds[ref]).filter(Boolean),
      minimum: rule.minimum, maximum: rule.maximum, unitOfMeasure: rule.unitOfMeasure,
      resultRepresentation: rule.resultRepresentation, estimatedTimeInDays: rule.days,
      estimatedCharges: rule.charges === null ? null : String(rule.charges),
      instrumentIds: rule.instrumentRefs.map((ref) => instrumentIds?.[ref]).filter(Boolean),
      templateId: templateId ?? null,
    });
    byKey[key] = saved.id;
  }
  return byKey;
}

/**
 * Test groups: a parent rule standing for a panel of tests, whose members are
 * the product's own rules re-pointed at it, so selecting the panel on a sample
 * raises every test in it.
 */
export async function provisionTestGroups(client, identity, { catalog, productIds, parameterIds, methodIds, sampleCategoryIds, templateId }) {
  const created = [];
  for (const group of catalog.testGroups) {
    const productId = productIds[group.productRef];
    const methodId = methodIds[group.methodRef];
    const parameterId = parameterIds[group.parameterRef];
    if (!productId || !methodId || !parameterId) continue;
    const categoryIds = group.categoryRefs.map((ref) => sampleCategoryIds[ref]).filter(Boolean);

    const existing = await client.query('SELECT id FROM decision_rules WHERE organization_id=$1 AND test_group_uid=$2',
      [identity.organization_id, group.uid]);
    let parentId = existing.rows[0]?.id;
    if (!parentId) {
      const saved = await saveDecisionRule(client, identity, {
        ...draft(), productId, testParameterId: parameterId, methodId,
        isTestGroupParent: true, testGroupName: group.name, testGroupUid: group.uid,
        sampleCategoryIds: categoryIds, estimatedTimeInDays: 3, templateId: templateId ?? null,
      });
      parentId = saved.id;
    }
    created.push(parentId);

    for (const member of group.members) {
      const testParameterId = parameterIds[member.parameterRef];
      if (!testParameterId) continue;
      const present = await client.query(
        'SELECT id FROM decision_rules WHERE organization_id=$1 AND product_id=$2 AND test_parameter_id=$3 AND method_id=$4 AND active',
        [identity.organization_id, productId, testParameterId, methodId]);
      if (present.rowCount) continue;
      await saveDecisionRule(client, identity, {
        ...draft(), name: member.name, productId, testParameterId, methodId,
        parentDecisionRuleId: parentId, sampleCategoryIds: categoryIds,
        minimum: member.minimum, maximum: member.maximum, unitOfMeasure: member.unitOfMeasure,
        resultRepresentation: member.resultRepresentation, estimatedTimeInDays: member.days,
        estimatedCharges: member.charges === null ? null : String(member.charges),
        templateId: templateId ?? null,
      });
    }
  }
  return created;
}

export async function provisionChecklists(client, identity, { catalog }) {
  const ids = [];
  for (const checklist of catalog.checklists) {
    const existing = await client.query('SELECT id FROM checklists WHERE organization_id=$1 AND lower(name)=lower($2)', [identity.organization_id, checklist.name]);
    if (existing.rowCount) { ids.push(existing.rows[0].id); continue; }
    const created = await createChecklist(client, identity, { ...draft(), name: checklist.name, items: checklist.items.map((prompt) => ({ id: randomUUID(), prompt })) });
    ids.push(created.id);
  }
  return ids;
}

// The New Service modal only offers a vendor whose agreement covers both the
// instrument and the service type, so each vendor's agreement is given the
// instruments of the laboratories it is closest to — here, a round-robin slice.
export async function provisionServiceAgreements(client, identity, { catalog, vendorIds, instrumentIds }) {
  const vendorRefs = catalog.vendors.map((vendor) => vendor.ref).filter((ref) => vendorIds[ref]);
  const instrumentRefs = Object.keys(instrumentIds);
  const created = [];
  for (let index = 0; index < vendorRefs.length; index += 1) {
    const vendorId = vendorIds[vendorRefs[index]];
    const grouped = instrumentRefs.filter((_, position) => position % vendorRefs.length === index).map((ref) => instrumentIds[ref]);
    if (!grouped.length) continue;
    const existing = await client.query('SELECT id FROM service_agreements WHERE organization_id=$1 AND vendor_id=$2', [identity.organization_id, vendorId]);
    if (existing.rowCount) { created.push(existing.rows[0].id); continue; }
    const saved = await saveServiceAgreement(client, identity, { ...draft(), vendorId, startDate: '2025-01-01', endDate: '2026-12-31', noOfServices: 4, cost: '25000', instrumentIds: grouped });
    created.push(saved.id);
  }
  return created;
}

export async function provisionOrganizationSettings(client, identity, { sampleWorkflowId, testRequestWorkflowId, adminUserId }) {
  const current = (await client.query('SELECT revision FROM organization_laboratory_settings WHERE organization_id=$1', [identity.organization_id])).rows[0];
  if (current) return; // Already configured by a prior run.
  // Inventory is included because this pipeline goes on to seed material
  // categories and materials, which the module gates.
  const moduleAccess = ['customer', 'vendor', 'instrument', 'service_agreements', 'inventory'].map((moduleKey) => ({ moduleKey, enabled: true, roleIds: [], userIds: [adminUserId] }));
  await saveLaboratorySettings(client, identity, {
    revision: 0, autoCreateJobs: false, jobWorkflowId: testRequestWorkflowId, testRequestWorkflowId,
    sampleWorkflows: { base: sampleWorkflowId, iqc: sampleWorkflowId, ilc: sampleWorkflowId, pt: sampleWorkflowId, amendment: sampleWorkflowId, complaint: sampleWorkflowId },
    moduleAccess,
  });
}

/**
 * Data Masters.
 *
 * PERN nests these three levels deep and reads each level with a cascading
 * dropdown. Our lookup sources are a flat list of labelled lines with no
 * parent-child relation, so the hierarchy is preserved in the label itself —
 * "North Plant / Production Block / Granulation Room" — keeping the vocabulary
 * and its structure readable where the cascade cannot be reproduced.
 */
export async function provisionDataMasters(client, identity, { catalog }) {
  const byRef = {};
  for (const master of catalog.dataMasters) {
    const existing = (await client.query('SELECT id FROM custom_field_lookup_sources WHERE organization_id=$1 AND original_source_id=$2',
      [identity.organization_id, master.ref])).rows[0];
    if (existing) { byRef[master.ref] = existing.id; continue; }
    const nameByRef = Object.fromEntries(master.items.map((item) => [item.ref, item]));
    const path = (item) => {
      const names = [item.name];
      let parent = item.parent;
      while (parent && nameByRef[parent]) { names.unshift(nameByRef[parent].name); parent = nameByRef[parent].parent; }
      return names.join(' / ');
    };
    const id = randomUUID();
    await saveLookupSourceObservation(client, identity, {
      id, revision: 0, requestId: randomUUID(), sourceId: master.ref, name: master.name,
      lines: master.items.map((item) => ({ id: item.ref, label: path(item) })),
    });
    byRef[master.ref] = id;
  }
  return byRef;
}

/**
 * Project fields: the sample, sample-product and decision-rule attributes a
 * laboratory records beyond the built-in ones — AR number, batch number,
 * manufacturing and expiry dates, batch size, manufacturer, the composed
 * specification text, and the storage condition drawn from a Data Master.
 */
export async function provisionProjectFields(client, identity, { catalog, dataMasterIds }) {
  const byKey = {};
  for (const field of catalog.projectFields) {
    const existing = (await client.query('SELECT id FROM custom_field_definitions WHERE organization_id=$1 AND lower(key)=lower($2)',
      [identity.organization_id, field.key])).rows[0];
    if (existing) { byKey[field.key] = existing.id; continue; }
    const id = randomUUID();
    await saveCustomField(client, identity, {
      id, requestId: randomUUID(), revision: 0,
      label: field.name, key: field.key,
      description: field.scheme ? `${field.name}; generated using ${field.scheme}` : field.name,
      fieldType: field.data_type === 'lookup' ? 'lookup' : field.data_type,
      associatedWith: field.associated_with,
      isRequired: Boolean(field.mandatory),
      displayOrder: field.order_index,
      ...(field.scheme ? { autoGenerated: 'yes', scheme: field.scheme, splitter: '/', generatedAt: field.generated_at ?? 'on_init', hideFromSampleCreation: true } : {}),
      ...(field.date_format ? { dateFormat: field.date_format } : {}),
      ...(field.data_master && dataMasterIds[field.data_master] ? { lookupSourceId: dataMasterIds[field.data_master] } : {}),
      showInList: Boolean(field.show_in_list),
      showInFilter: Boolean(field.show_in_filter),
      showInReport: Boolean(field.show_in_report),
    });
    byKey[field.key] = id;
  }
  return byKey;
}

// Each shared laboratory's head of department. Users are created after the
// laboratories they belong to, so the head is attached in a second pass.
export async function provisionLaboratoryHeads(client, identity, { catalog, laboratoryIds, userIds }) {
  const laboratoryByRef = Object.fromEntries(catalog.laboratories.map((laboratory) => [laboratory.ref, laboratory]));
  for (const [laboratoryRef, userRef] of Object.entries(LAB_HEADS)) {
    const laboratoryId = laboratoryIds[laboratoryRef]; const userId = userIds[userRef];
    const laboratory = laboratoryByRef[laboratoryRef];
    if (!laboratoryId || !userId || !laboratory) continue;
    const current = (await client.query('SELECT revision, head_user_id AS "headUserId" FROM laboratories WHERE organization_id=$1 AND id=$2',
      [identity.organization_id, laboratoryId])).rows[0];
    if (!current || current.headUserId) continue;
    await saveLaboratory(client, identity, {
      id: laboratoryId, requestId: randomUUID(), revision: current.revision,
      code: laboratory.code, name: laboratory.name, abbreviation: laboratory.abbreviation, headUserId: userId,
      minimumTemperature: `${LAB_ENVIRONMENT.min_temperature}°C`, maximumTemperature: `${LAB_ENVIRONMENT.max_temperature}°C`,
      minimumHumidity: `${LAB_ENVIRONMENT.min_humidity}%`, maximumHumidity: `${LAB_ENVIRONMENT.max_humidity}%`,
    });
  }
}

// Sample lifecycle stages, in the order a sample moves through them. The
// seeded scenarios name the stage each one should come to rest at.
export const FLOW_ORDER = Object.freeze(['registered', 'generated', 'allocated', 'results', 'submitted', 'pending_approval', 'approved', 'coa']);
const flowRank = Object.freeze(Object.fromEntries(FLOW_ORDER.map((flow, index) => [flow, index])));

const scenarioLines = (scenario) => scenario.lines ?? [{ product: scenario.product, parameters: scenario.parameters }];

/**
 * Registers each scenario's sample and advances it as far as the seeding
 * administrator can legitimately take it: generating its test requests and
 * allocating them to an analyst. Stages beyond `allocated` are the analyst's,
 * the reviewer's and the approver's to perform, and are driven separately.
 */
export async function provisionDemoSamples(client, identity, { catalog, sampleCategoryIds, customerIds, productIds, parameterIds, methodIds, userIds }) {
  const analystIds = ANALYST_REFS.map((ref) => userIds[ref]).filter(Boolean);
  const decisionRuleLookup = {};
  // Only the product's own rules: a test group's members share their panel's
  // method, which is not what a scenario asking for that parameter wants.
  const rules = await client.query(`SELECT id, product_id AS "productId", test_parameter_id AS "testParameterId", method_id AS "methodId"
    FROM decision_rules WHERE organization_id=$1 AND active AND parent_decision_rule_id IS NULL AND NOT is_test_group_parent`,
  [identity.organization_id]);
  for (const row of rules.rows) decisionRuleLookup[`${row.productId}:${row.testParameterId}`] = { id: row.id, methodId: row.methodId };

  const results = [];
  for (const [index, scenario] of catalog.scenarios.entries()) {
    const rank = flowRank[scenario.flow];
    if (rank === undefined) throw new Error(`Unsupported seed sample flow ${scenario.flow}`);
    const lines = scenarioLines(scenario).filter((line) => productIds[line.product]);
    if (!lines.length) continue;

    const products = lines.map((line) => ({
      productId: productIds[line.product], quantity: '1',
      tests: line.parameters.map((parameterRef) => {
        const testParameterId = parameterIds[parameterRef];
        const rule = decisionRuleLookup[`${productIds[line.product]}:${testParameterId}`];
        return { testParameterId, methodId: rule?.methodId ?? methodIds[catalog.methods[0].ref], decisionRuleId: rule?.id ?? null, requestedQuantity: 1 };
      }).filter((test) => test.testParameterId && test.methodId),
    })).filter((product) => product.tests.length);
    if (!products.length) continue;

    const customerId = customerIds[scenario.customer];
    const receivedAt = new Date(Date.now() - (20 - Math.min(index, 15)) * 86_400_000).toISOString();
    const customer = catalog.customers.find((entry) => entry.ref === scenario.customer);
    const sample = await registerSample(client, identity, {
      customerId, customerAddress: `${customer?.city ?? 'Industrial Area'}, ${customer?.state ?? 'Maharashtra'}, India`,
      sampleCategoryId: sampleCategoryIds[scenario.category], sampleType: 'customer', receivedAt,
      description: `Batch ${scenario.batch} seeded at the ${scenario.flow.replace(/_/g, ' ')} stage`,
      products,
    });

    const record = { ...sample, scenario: scenario.ref, flow: scenario.flow, industry: scenario.industry, testRequests: [] };
    if (rank >= flowRank.generated) {
      // Deliberately not wrapped in a SAVEPOINT. laboratory_job_generation_sample()
      // proves the caller generated the requests by matching the sample event's
      // xmin against pg_current_xact_id(); inside a savepoint the row carries the
      // subtransaction's id while the function reads the top-level one, so they
      // never match and every generation is refused.
      const existing = await client.query(`SELECT request.id FROM test_requests request
        JOIN sample_tests selected ON selected.organization_id=request.organization_id AND selected.id=request.sample_test_id
        JOIN sample_products product ON product.organization_id=selected.organization_id AND product.id=selected.sample_product_id
        WHERE request.organization_id=$1 AND product.sample_id=$2`, [identity.organization_id, sample.id]);
      const generated = existing.rowCount ? { items: existing.rows } : await generateTestRequests(client, identity, sample.id, {});
      record.testRequests = generated.items;
      if (rank >= flowRank.allocated && analystIds.length) {
        const analystId = analystIds[index % analystIds.length];
        for (const request of generated.items) {
          const current = await client.query('SELECT revision FROM test_requests WHERE organization_id=$1 AND id=$2', [identity.organization_id, request.id]);
          if (current.rows[0]?.revision === undefined) continue;
          await allocateTestRequest(client, identity, request.id, { revision: current.rows[0].revision, assignmentType: 'analyst', assignedUserId: analystId });
        }
        record.assignedUserId = analystId;
      }
    }
    results.push(record);
  }
  return results;
}
