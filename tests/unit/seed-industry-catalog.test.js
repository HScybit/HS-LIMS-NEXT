import test from 'node:test';
import assert from 'node:assert/strict';
import { roleCapabilityKeys } from '../../src/roles/capabilities.js';
import { PERMISSION_CATALOG } from '../../src/auth/permission-catalog.js';
import { buildSeedCatalog, seedIndustriesInfo, SEED_INDUSTRY_KEYS, buildOrganizationSlug, buildSpecificationText } from '../../src/seed/industry-catalog.js';

const everyIndustry = buildSeedCatalog(SEED_INDUSTRY_KEYS);
const refs = (list) => new Set(list.map((item) => item.ref));

test('all six industries are published with counts', () => {
  assert.deepEqual(SEED_INDUSTRY_KEYS, ['pharmaceutical', 'chemical', 'textile', 'lubricants', 'coal_minerals', 'food_beverage']);
  assert.equal(seedIndustriesInfo.length, 6);
  for (const industry of seedIndustriesInfo) {
    assert.ok(industry.label && industry.description, `${industry.key} is described`);
    assert.ok(industry.estimatedCounts.products > 0 && industry.estimatedCounts.decisionRules > 0);
  }
});

test('an unknown or empty industry selection is rejected', () => {
  assert.throws(() => buildSeedCatalog(['nuclear']), /Unknown seed industry/);
  assert.throws(() => buildSeedCatalog([]), /at least one/);
});

test('every reference a decision rule makes resolves within the merged catalog', () => {
  const products = refs(everyIndustry.products); const parameters = refs(everyIndustry.testParameters);
  const methods = refs(everyIndustry.methods); const categories = refs(everyIndustry.sampleCategories);
  const instruments = refs(everyIndustry.instruments);
  for (const rule of everyIndustry.decisionRules) {
    assert.ok(products.has(rule.productRef), `product ${rule.productRef}`);
    assert.ok(parameters.has(rule.parameterRef), `parameter ${rule.parameterRef}`);
    assert.ok(methods.has(rule.methodRef), `method ${rule.methodRef}`);
    for (const category of rule.categoryRefs) assert.ok(categories.has(category), `category ${category}`);
    for (const instrument of rule.instrumentRefs) assert.ok(instruments.has(instrument), `instrument ${instrument}`);
  }
});

test('every reference a lifecycle scenario makes resolves within the merged catalog', () => {
  const products = refs(everyIndustry.products); const parameters = refs(everyIndustry.testParameters);
  const categories = refs(everyIndustry.sampleCategories); const customers = refs(everyIndustry.customers);
  for (const scenario of everyIndustry.scenarios) {
    assert.ok(categories.has(scenario.category), `category ${scenario.category}`);
    assert.ok(customers.has(scenario.customer), `customer ${scenario.customer}`);
    if (scenario.product) assert.ok(products.has(scenario.product), `product ${scenario.product}`);
    for (const parameter of scenario.parameters ?? []) assert.ok(parameters.has(parameter), `parameter ${parameter}`);
    for (const line of scenario.lines ?? []) {
      assert.ok(products.has(line.product), `line product ${line.product}`);
      for (const parameter of line.parameters) assert.ok(parameters.has(parameter), `line parameter ${parameter}`);
    }
  }
});

test('parameters, instruments and materials resolve their laboratory and category', () => {
  const laboratories = refs(everyIndustry.laboratories); const materialCategories = refs(everyIndustry.materialCategories);
  for (const parameter of everyIndustry.testParameters) assert.ok(laboratories.has(parameter.laboratoryRef), `parameter lab ${parameter.laboratoryRef}`);
  for (const instrument of everyIndustry.instruments) assert.ok(laboratories.has(instrument.laboratoryRef), `instrument lab ${instrument.laboratoryRef}`);
  for (const material of everyIndustry.materials) assert.ok(materialCategories.has(material.categoryRef), `material category ${material.categoryRef}`);
});

// Refs are namespaced per industry precisely so several can share one
// organization; a collision here would silently merge two industries' records.
test('seeding every industry at once produces no duplicate identifiers', () => {
  const identified = [
    ['laboratory', everyIndustry.laboratories, 'code'], ['sample category', everyIndustry.sampleCategories, 'code'],
    ['product', everyIndustry.products, 'key'], ['test parameter', everyIndustry.testParameters, 'key'],
    ['method', everyIndustry.methods, 'uuid'], ['instrument', everyIndustry.instruments, 'code'],
    ['material', everyIndustry.materials, 'code'], ['customer', everyIndustry.customers, 'code'],
  ];
  for (const [label, list, field] of identified) {
    const values = list.map((item) => item[field]);
    assert.equal(new Set(values).size, values.length, `${label} ${field} values are unique`);
  }
});

test('seeded roles only claim capabilities and permissions this app defines', () => {
  const capabilities = new Set(roleCapabilityKeys);
  const permissions = new Set(PERMISSION_CATALOG.map(([code]) => code));
  for (const role of everyIndustry.roleDefinitions) {
    assert.ok(role.permissions?.length, `${role.code} has permissions`);
    for (const capability of role.capabilities) assert.ok(capabilities.has(capability), `${role.code} capability ${capability}`);
    for (const permission of role.permissions) assert.ok(permissions.has(permission), `${role.code} permission ${permission}`);
  }
});

test('each seeded product is offered under at least one sample category', () => {
  const categories = refs(everyIndustry.sampleCategories);
  for (const product of everyIndustry.products) {
    assert.ok(product.categoryRefs.length, `${product.key} has categories`);
    for (const category of product.categoryRefs) assert.ok(categories.has(category), `${product.key} category ${category}`);
  }
});

test('selecting one industry yields only that industry', () => {
  const pharma = buildSeedCatalog(['pharmaceutical']);
  assert.ok(pharma.products.every((product) => product.ref.startsWith('ph_')));
  assert.ok(pharma.products.length < everyIndustry.products.length);
  // The four shared laboratories are present whichever industry is chosen.
  for (const code of ['LAB-CHEM', 'LAB-MICRO', 'LAB-INSTR', 'LAB-PHYS']) {
    assert.ok(pharma.laboratories.some((laboratory) => laboratory.code === code), code);
  }
});

test('organization slugs and specification text follow the source rules', () => {
  assert.equal(buildOrganizationSlug('Universal Laboratory'), 'ul');
  assert.equal(buildOrganizationSlug('Apex Pharma Laboratories'), 'apl');
  assert.equal(buildOrganizationSlug('Universal'), 'universal');
  assert.equal(buildSpecificationText({ min: '95.0', max: '105.0', uom: '%' }), '95.0 to 105.0 %');
  assert.equal(buildSpecificationText({ max: '0.5', uom: '%' }), 'Not more than 0.5 %');
  assert.equal(buildSpecificationText({ min: '80.0', uom: '%' }), 'Not less than 80.0 %');
  assert.equal(buildSpecificationText({ text: 'Complies with reference' }), 'Complies with reference');
  assert.equal(buildSpecificationText({}), 'Complies');
});
