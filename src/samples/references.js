import { and, eq, inArray, asc } from 'drizzle-orm';
import { HttpError } from '../auth/errors.js';
import { database } from '../db/pool.js';
import * as masters from '../db/master-schema.js';
import { lockReferences } from './reference-locks.js';
import { sampleImageReferences } from './images.js';

const invalid = (message) => { throw new HttpError(422, 'invalid_sample_reference', message); };
const uniqueIds = (values) => [...new Set(values.filter(Boolean))];

export async function registrationReferences(client, organizationId, input) {
  await sampleImageReferences(client, organizationId, input.products);
  const db = database(client);
  async function activeRows(table, ids, label) {
    const selected = uniqueIds(ids);
    if (!selected.length) return new Map();
    await lockReferences(client, table, selected);
    const rows = await db.select().from(table).where(and(eq(table.organizationId, organizationId), inArray(table.id, selected), eq(table.active, true))).orderBy(asc(table.id));
    if (rows.length !== selected.length) invalid(`Select active ${label} from this organization.`);
    return new Map(rows.map((row) => [row.id, row]));
  }
  const selectedTests = input.products.flatMap((product) => product.tests);
  const categories = await activeRows(masters.sampleCategories, [input.sampleCategoryId, ...input.products.map((product) => product.sampleCategoryId)], 'sample categories');
  const customers = await activeRows(masters.customers, [input.customerId], 'customers');
  if (input.customerQuotationId) {
    await lockReferences(client, masters.customerQuotations, [input.customerQuotationId]);
    const quotation = await client.query(`SELECT id FROM customer_quotations WHERE organization_id = $1 AND id = $2 AND customer_id = $3
      AND status = 'approved' AND (valid_until IS NULL OR valid_until >= current_date)`, [organizationId, input.customerQuotationId, input.customerId]);
    if (!quotation.rowCount) invalid('Select an approved, unexpired quotation for this customer.');
  }
  const products = await activeRows(masters.products, input.products.map((product) => product.productId), 'products');
  await lockReferences(client, masters.productSampleCategories, [...products.keys()]);
  const categoryLinks = await db.select().from(masters.productSampleCategories).where(and(eq(masters.productSampleCategories.organizationId, organizationId), inArray(masters.productSampleCategories.productId, [...products.keys()])));
  const productCategories = new Set(categoryLinks.map((row) => `${row.productId}:${row.sampleCategoryId}`));
  for (const product of input.products) if (!productCategories.has(`${product.productId}:${product.sampleCategoryId}`)) invalid('The selected product does not belong to this sample category.');
  const tags = await activeRows(masters.tags, input.products.map((product) => product.tagId), 'tags');
  if (tags.size) {
    await lockReferences(client, masters.productTags, [...products.keys()]);
    const links = await db.select().from(masters.productTags).where(and(eq(masters.productTags.organizationId, organizationId), inArray(masters.productTags.productId, [...products.keys()])));
    const productTags = new Set(links.map((row) => `${row.productId}:${row.tagId}`));
    for (const product of input.products) if (product.tagId && !productTags.has(`${product.productId}:${product.tagId}`)) invalid('The tag does not belong to the selected product.');
  }
  const parameters = await activeRows(masters.testParameters, selectedTests.map((test) => test.testParameterId), 'parameters');
  const methods = await activeRows(masters.methodsOfAnalysis, selectedTests.map((test) => test.methodId), 'methods');
  await lockReferences(client, masters.parameterMethods, [...parameters.keys()]);
  const methodLinks = await db.select().from(masters.parameterMethods).where(and(eq(masters.parameterMethods.organizationId, organizationId), inArray(masters.parameterMethods.testParameterId, [...parameters.keys()])));
  const parameterMethods = new Set(methodLinks.map((row) => `${row.testParameterId}:${row.methodId}`));
  for (const test of selectedTests) if (!parameterMethods.has(`${test.testParameterId}:${test.methodId}`)) invalid('The method does not belong to the selected parameter.');
  const rules = await activeRows(masters.decisionRules, selectedTests.map((test) => test.decisionRuleId), 'decision rules');
  for (const product of input.products) for (const test of product.tests) {
    if (!test.decisionRuleId) continue;
    const rule = rules.get(test.decisionRuleId);
    if (rule.productId !== product.productId || rule.testParameterId !== test.testParameterId
      || (rule.methodId && rule.methodId !== test.methodId) || (rule.sampleCategoryId && rule.sampleCategoryId !== product.sampleCategoryId)) invalid('The decision rule does not match the selected product, parameter, method and category.');
  }
  const units = await activeRows(masters.measurementUnits, input.products.map((product) => product.measurementUnitId), 'measurement units');
  const laboratories = await activeRows(masters.laboratories, input.participatingLabs.map((lab) => lab.laboratoryId), 'laboratories');
  return { categories, customers, products, parameters, methods, rules, units, laboratories, tags };
}
