/**
 * Industry-aware seed catalog.
 *
 * Ported from PERN's `seedCatalog.js` + `v3SharedCatalog.js`. Six industry
 * catalogs live in `industries/`; everything organization-shaped (the org
 * chart, the shared laboratories, material categories, service vendors, data
 * masters and sample custom fields) is industry independent and lives in
 * `shared-catalog.js`.
 *
 * `buildSeedCatalog(keys)` flattens the selected industries into the plain
 * shapes `provision.js` consumes. Every industry namespaces its refs (`ph_`,
 * `ch_`, ...) so several industries can be seeded into one organization
 * without colliding.
 */
import chemical from './industries/chemical.js';
import coalMinerals from './industries/coal_minerals.js';
import foodBeverage from './industries/food_beverage.js';
import lubricants from './industries/lubricants.js';
import pharmaceutical from './industries/pharmaceutical.js';
import textile from './industries/textile.js';
import { roleCapabilityKeys } from '../roles/capabilities.js';
import {
  ANALYST_REFS, DATA_MASTERS, LAB_ENVIRONMENT, LAB_HEADS, MATERIAL_CATEGORIES, MATERIAL_SUPPLIERS,
  PROJECT_FIELDS, ROLES, SAMPLE_RECEIVER_REF, SERVICE_VENDORS, SHARED_LABS, USERS,
  buildOrganizationSlug, buildSpecificationText, buildUserEmailDomain,
} from './shared-catalog.js';

export { buildOrganizationSlug, buildSpecificationText, buildUserEmailDomain };
export { ANALYST_REFS, LAB_ENVIRONMENT, LAB_HEADS, MATERIAL_SUPPLIERS, SAMPLE_RECEIVER_REF };

export const SEED_VERSION = '1.0.0-industry-catalog';

const industryDescriptions = Object.freeze({
  pharmaceutical: 'Formulations and APIs: assay, dissolution, related substances, sterility.',
  chemical: 'Bulk and specialty chemicals: purity, titrimetric assay, heavy metals.',
  textile: 'Yarn, fabric and garments: strength, colour fastness, restricted substances.',
  lubricants: 'Oils, greases and fuels: viscosity, flash point, TAN/TBN, elemental wear metals.',
  coal_minerals: 'Coal, coke and ores: proximate analysis, calorific value, oxide assays.',
  food_beverage: 'Ingredients and packaged food: proximate analysis, microbiology, contaminants.',
});

export const seedIndustryCatalog = Object.freeze({
  pharmaceutical: { ...pharmaceutical, label: 'Pharmaceutical' },
  chemical: { ...chemical, label: 'Chemical' },
  textile: { ...textile, label: 'Textile' },
  lubricants: { ...lubricants, label: 'Lubricants and Petroleum' },
  coal_minerals: { ...coalMinerals, label: 'Coal and Minerals' },
  food_beverage: { ...foodBeverage, label: 'Food and Beverage' },
});

export const SEED_INDUSTRY_KEYS = Object.freeze(Object.keys(seedIndustryCatalog));

export const industryCodePrefixes = Object.freeze({
  pharmaceutical: 'PH', chemical: 'CH', textile: 'TX', lubricants: 'LB', coal_minerals: 'CL', food_beverage: 'FD',
});

const TEST_GROUP_PRODUCTS_PER_INDUSTRY = 3;
const MIN_SUB_DECISION_RULES_PER_GROUP = 3;
const MAX_SUB_DECISION_RULES_PER_GROUP = 6;

/**
 * Test groups, ported from PERN's `buildIndustryTestGroupDefinitions`.
 *
 * A test group is a parent decision rule standing for a panel of tests, with
 * the panel's own rules as its children, so one selection on a sample raises
 * the whole panel. Every panel brings a parent parameter and a parent method of
 * its own, which is why the seeded parameter and method counts exceed the
 * industry's own lists.
 *
 * Each industry contributes four: two panels for its first product — a complete
 * one and a shorter release panel — and one each for the next two. A panel's
 * members share its product and its method, which is what keeps them distinct
 * from the product's own rules on their own methods.
 */
function buildIndustryTestGroups(industryKey, industry) {
  const prefix = industryCodePrefixes[industryKey];
  const parameterByRef = new Map(industry.parameters.map((parameter) => [parameter.ref, parameter]));
  const productByRef = new Map(industry.products.map((product) => [product.ref, product]));
  const chosenProducts = new Set();
  const sources = [];
  for (const group of industry.decisionRules) {
    const childParameterRefs = [...new Set(group.rows.map((row) => row.parameter))]
      .filter((ref) => parameterByRef.has(ref))
      .slice(0, MAX_SUB_DECISION_RULES_PER_GROUP);
    if (chosenProducts.has(group.product) || childParameterRefs.length < MIN_SUB_DECISION_RULES_PER_GROUP) continue;
    chosenProducts.add(group.product);
    sources.push({ ...group, childParameterRefs });
    if (sources.length === TEST_GROUP_PRODUCTS_PER_INDUSTRY) break;
  }
  if (!prefix || sources.length !== TEST_GROUP_PRODUCTS_PER_INDUSTRY) {
    throw new Error(`Industry ${industryKey} cannot provide ${TEST_GROUP_PRODUCTS_PER_INDUSTRY} test-group products`);
  }
  const repeated = sources[0];
  const panels = [
    { ...repeated, variantLabel: 'Complete Quality Panel' },
    { ...repeated, variantLabel: 'Focused Release Panel',
      childParameterRefs: repeated.childParameterRefs.slice(-Math.min(4, repeated.childParameterRefs.length)) },
    ...sources.slice(1).map((group) => ({ ...group, variantLabel: 'Complete Quality Panel' })),
  ];
  const maximumOrder = Math.max(...industry.parameters.map((parameter) => parameter.order ?? 0));
  return panels.map((panel, index) => {
    const sequence = String(index + 1).padStart(3, '0');
    const product = productByRef.get(panel.product);
    const firstChild = parameterByRef.get(panel.childParameterRefs[0]);
    const name = `${product.name} ${panel.variantLabel}`;
    return {
      name, uid: `${prefix}_TEST_GROUP_${sequence}`, productRef: panel.product, categoryRef: panel.category,
      parameter: { ref: `${industryKey}_test_group_parameter_${sequence}`, key: `${prefix}-TEST-GROUP-${sequence}`, name,
        description: `Parent parameter grouping the seeded tests for ${product.name}.`,
        scheme_abbr: `${prefix}TG${index + 1}`, lab: firstChild.lab, order: maximumOrder + ((index + 1) * 10) },
      method: { ref: `${industryKey}_test_group_method_${sequence}`, uuid: `${prefix}/MOA/GRP/${900 + index + 1}`,
        name: `${product.name} Group Testing Protocol`,
        description: `Controlled protocol grouping the seeded ${product.name} tests under one test request.`,
        decimal_places: 2, parse_num: true, lab: firstChild.lab },
      childParameterRefs: panel.childParameterRefs, industryKey,
    };
  });
}

// A ref is namespaced per industry, so upper-casing it yields a code that is
// unique across every combination of industries.
const codeFromRef = (ref) => String(ref).toUpperCase().replace(/_/g, '-');

const rolePermissions = Object.freeze({
  lab_head: ['masters.read', 'masters.manage', 'templates.read', 'workflows.read', 'samples.read', 'samples.create', 'samples.manage', 'test_requests.allocate', 'datasheets.execute', 'approvals.respond', 'instruments.read', 'checklists.read'],
  analyst: ['masters.read', 'templates.read', 'samples.read', 'datasheets.execute', 'test_requests.allocate', 'instruments.read'],
  reviewer: ['masters.read', 'templates.read', 'samples.read', 'datasheets.execute', 'approvals.respond'],
  qa_approver: ['masters.read', 'templates.read', 'samples.read', 'samples.manage', 'approvals.respond', 'compliance.read', 'compliance.manage'],
  sample_manager: ['masters.read', 'templates.read', 'samples.read', 'samples.create', 'samples.manage', 'test_requests.allocate'],
  lab_assistant: ['masters.read', 'templates.read', 'samples.read', 'instruments.read'],
});

const knownCapabilities = new Set(roleCapabilityKeys);

export const roleDefinitions = Object.freeze(ROLES.map((role) => Object.freeze({
  ref: role.ref,
  code: role.ref.replace(/_/g, '-'),
  name: role.name,
  description: role.description,
  permissions: rolePermissions[role.ref],
  // PERN carries capabilities as boolean flags on the role itself; ours are a
  // key list. `can_access_dms` has no equivalent here and is dropped.
  capabilities: Object.keys(role).filter((key) => knownCapabilities.has(key) && role[key] === true),
})));

export const materialCategories = Object.freeze(MATERIAL_CATEGORIES.map((category) => Object.freeze({
  ref: category.ref, code: codeFromRef(category.ref), name: category.name,
  description: category.description, reusable: category.reusable, expirable: category.expirable,
})));

export const vendors = Object.freeze(SERVICE_VENDORS.map((vendor) => Object.freeze({
  ref: vendor.ref, code: codeFromRef(vendor.ref), name: vendor.name,
  legalName: `${vendor.name} Pvt Ltd`, city: vendor.city, services: vendor.services,
})));

export const dataMasters = DATA_MASTERS;
export const projectFields = PROJECT_FIELDS;

// Units referenced by industry materials and by acceptance limits. Materials
// carry a unit name; limits carry free-text UOM that is stored as written.
export const measurementUnits = Object.freeze([
  { code: 'UNITS', name: 'Units', symbol: 'unit' },
  { code: 'GRAMS', name: 'Grams', symbol: 'g' },
  { code: 'KGS', name: 'Kilograms', symbol: 'kg' },
  { code: 'LITRES', name: 'Litres', symbol: 'L' },
  { code: 'MILLILITRES', name: 'Millilitres', symbol: 'mL' },
  { code: 'BOXES', name: 'Boxes', symbol: 'box' },
  { code: 'PACKETS', name: 'Packets', symbol: 'packet' },
]);

const unitCodeByName = Object.freeze(Object.fromEntries(measurementUnits.map((unit) => [unit.name, unit.code])));

export const checklists = Object.freeze([
  { name: 'Sample Receipt Verification', items: ['Sample container intact', 'Labeling matches request', 'Quantity as declared', 'Temperature within range on receipt', 'Chain-of-custody form signed'] },
  { name: 'Analytical Result Review', items: ['Raw data attached', 'Calculations verified', 'Instrument calibration current', 'Result within expected range', 'Reviewer sign-off recorded'] },
  { name: 'COA Release Checklist', items: ['All test results approved', 'Customer details verified', 'Report format correct', 'Digital signature applied', 'Report archived'] },
]);

function assertKnownIndustries(keys) {
  const unknown = keys.filter((key) => !seedIndustryCatalog[key]);
  if (unknown.length) throw new Error(`Unknown seed industry: ${unknown.join(', ')}`);
  if (!keys.length) throw new Error('Select at least one seed industry.');
}

/**
 * Flattens the chosen industries into one catalog.
 *
 * Laboratories are the shared four plus each industry's own; everything else
 * is the concatenation of the selected industries, with refs carried through
 * so the lifecycle scenarios can still resolve what they point at.
 */
export function buildSeedCatalog(industryKeys) {
  const keys = [...new Set(industryKeys)];
  assertKnownIndustries(keys);
  const industries = keys.map((key) => ({ key, ...seedIndustryCatalog[key], testGroups: buildIndustryTestGroups(key, seedIndustryCatalog[key]) }));

  const laboratories = [
    ...SHARED_LABS.map((lab) => ({ ref: lab.ref, code: codeFromRef(lab.ref), name: lab.name, abbreviation: lab.abbreviation })),
    ...industries.flatMap((industry) => industry.labs.map((lab) => ({
      ref: lab.ref, code: codeFromRef(lab.ref), name: lab.name, abbreviation: lab.abbreviation,
    }))),
  ];

  const sampleCategories = industries.flatMap((industry) => industry.categories.map((category) => ({
    ref: category.ref, code: codeFromRef(category.ref), name: category.name, abbreviation: category.abbr,
    retentionDays: category.retention_days, estimatedTimeInDays: category.estimated_time_in_days,
    description: category.description,
  })));

  // A product's sample categories are not declared directly; they are implied
  // by the decision rules and scenarios that pair the two.
  const categoryRefsByProduct = new Map();
  for (const industry of industries) {
    const pair = (productRef, categoryRef) => {
      if (!productRef || !categoryRef) return;
      if (!categoryRefsByProduct.has(productRef)) categoryRefsByProduct.set(productRef, new Set());
      categoryRefsByProduct.get(productRef).add(categoryRef);
    };
    for (const group of industry.decisionRules) pair(group.product, group.category);
    for (const group of industry.testGroups) pair(group.productRef, group.categoryRef);
    for (const scenario of industry.scenarios) pair(scenario.product, scenario.category);
    for (const line of industry.multiProductScenario?.lines ?? []) pair(line.product, industry.multiProductScenario.category);
  }

  const products = industries.flatMap((industry) => industry.products.map((product) => ({
    ref: product.ref, key: product.key, name: product.name, abbreviation: product.abbr, description: product.description,
    // A product no rule or scenario mentions is still offered under every
    // category its industry defines, so it stays selectable in the UI.
    categoryRefs: [...(categoryRefsByProduct.get(product.ref) ?? new Set(industry.categories.map((category) => category.ref)))],
  })));

  const parameterSource = (industry) => [...industry.parameters, ...industry.testGroups.map((group) => group.parameter)];
  const testParameters = industries.flatMap((industry) => parameterSource(industry).map((parameter) => ({
    ref: parameter.ref, key: parameter.key, name: parameter.name, schemeAbbreviation: parameter.scheme_abbr,
    description: parameter.description, laboratoryRef: parameter.lab, displayOrder: parameter.order,
  })));

  const methods = industries.flatMap((industry) => [...industry.methods, ...industry.testGroups.map((group) => group.method)].map((method) => ({
    ref: method.ref, uuid: method.uuid, name: method.name, description: method.description,
    decimalScale: method.decimal_places, parseNumber: method.parse_num !== false, laboratoryRef: method.lab,
  })));

  const instruments = industries.flatMap((industry) => industry.equipment.map((equipment) => ({
    ref: equipment.ref, code: equipment.key, name: equipment.name, laboratoryRef: equipment.lab,
    make: equipment.make, modelName: equipment.model_name, serialNumber: equipment.serial_number,
    calibrationAgency: equipment.calibration_agency,
  })));

  const materials = industries.flatMap((industry) => industry.materials.map((material) => ({
    ref: material.ref, code: material.key, name: material.name, categoryRef: material.category,
    unitCode: unitCodeByName[material.unit] ?? 'UNITS',
    initialQuantity: material.initial_qty, minimumQuantity: material.min_qty,
  })));

  const customers = industries.flatMap((industry) => industry.customers.map((customer) => ({
    ref: customer.ref, code: codeFromRef(customer.ref), name: customer.name, abbreviation: customer.abbr,
    legalName: `${customer.name}`, city: customer.city, state: customer.state,
  })));

  // PERN groups rules by product and category with the limits held separately;
  // ours are per parameter, so the two are joined here. A rule covers every
  // category its product is registered under, not just the one its group names:
  // the same assay applies to a finished product and to its stability pull, and
  // sample registration rejects a rule that does not cover the chosen category.
  const decisionRules = industries.flatMap((industry) => industry.decisionRules.flatMap((group) => group.rows.map((row) => {
    const limits = industry.limits[row.parameter] ?? {};
    const product = industry.products.find((entry) => entry.ref === group.product);
    const parameter = industry.parameters.find((entry) => entry.ref === row.parameter);
    return {
      productRef: group.product,
      categoryRefs: [...(categoryRefsByProduct.get(group.product) ?? new Set([group.category]))],
      parameterRef: row.parameter, methodRef: row.moa,
      // A specification snapshot copies the rule's name, and the
      // analytical_specification_rule constraint refuses a snapshot that cites
      // a rule without one, so every rule must be named.
      name: `${product?.name ?? group.product} - ${parameter?.name ?? row.parameter}`,
      minimum: limits.min || null, maximum: limits.max || null, unitOfMeasure: limits.uom || null,
      resultRepresentation: limits.text || null, expectedResult: limits.result ?? null,
      specification: buildSpecificationText(limits),
      days: row.days ?? 1, charges: row.charges ?? null, instrumentRefs: row.instruments ?? [],
    };
  })));

  // A panel's parent rule carries the group's name and uid; its children are
  // the same product's rules for the panel's parameters, re-pointed at the
  // parent so one selection raises the whole panel.
  const testGroups = industries.flatMap((industry) => industry.testGroups.map((group) => ({
    productRef: group.productRef, industryKey: group.industryKey,
    categoryRefs: [...(categoryRefsByProduct.get(group.productRef) ?? new Set([group.categoryRef]))],
    parameterRef: group.parameter.ref, methodRef: group.method.ref,
    name: group.name, uid: group.uid,
    // A member shares the panel's product and method, and carries its own
    // parameter's acceptance limits.
    members: group.childParameterRefs.map((parameterRef) => {
      const industry = seedIndustryCatalog[group.industryKey];
      const limits = industry.limits[parameterRef] ?? {};
      const row = industry.decisionRules
        .filter((candidate) => candidate.product === group.productRef)
        .flatMap((candidate) => candidate.rows)
        .find((candidate) => candidate.parameter === parameterRef);
      const parameter = industry.parameters.find((candidate) => candidate.ref === parameterRef);
      return {
        parameterRef,
        name: `${group.name} - ${parameter?.name ?? parameterRef}`,
        minimum: limits.min || null, maximum: limits.max || null, unitOfMeasure: limits.uom || null,
        resultRepresentation: limits.text || null, days: row?.days ?? 1, charges: row?.charges ?? null,
      };
    }),
  })));

  const scenarios = industries.flatMap((industry) => [
    ...industry.scenarios.map((scenario) => ({ ...scenario, industry: industry.key, lines: null })),
    ...(industry.multiProductScenario ? [{ ...industry.multiProductScenario, industry: industry.key, product: null, parameters: null }] : []),
  ]);

  const methodMaterials = Object.fromEntries(industries.flatMap((industry) => Object.entries(industry.methodMaterials ?? {})));
  const batchSizes = Object.fromEntries(industries.map((industry) => [industry.key, industry.batchSizes]));
  const manufacturers = Object.fromEntries(industries.map((industry) => [industry.key, industry.manufacturers]));
  const limits = Object.fromEntries(industries.flatMap((industry) => Object.entries(industry.limits)));

  return {
    industryKeys: keys, laboratories, roleDefinitions, users: USERS, sampleCategories, products,
    testParameters, methods, instruments, materials, materialCategories, customers, vendors,
    decisionRules, testGroups, scenarios, methodMaterials, batchSizes, manufacturers, limits,
    measurementUnits, dataMasters, projectFields, checklists,
  };
}

function industryCounts(key) {
  const catalog = buildSeedCatalog([key]);
  return {
    laboratories: catalog.laboratories.length,
    sampleCategories: catalog.sampleCategories.length,
    products: catalog.products.length,
    testParameters: catalog.testParameters.length,
    methods: catalog.methods.length,
    instruments: catalog.instruments.length,
    materials: catalog.materials.length,
    customers: catalog.customers.length,
    decisionRules: catalog.decisionRules.length + catalog.testGroups.length,
    samples: catalog.scenarios.length,
  };
}

export const seedIndustriesInfo = Object.freeze(SEED_INDUSTRY_KEYS.map((key) => Object.freeze({
  key, label: seedIndustryCatalog[key].label, description: industryDescriptions[key],
  estimatedCounts: industryCounts(key),
})));
