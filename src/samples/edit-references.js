import { and, eq, inArray } from 'drizzle-orm';
import { database } from '../db/pool.js';
import { HttpError } from '../auth/errors.js';
import * as masters from '../db/master-schema.js';
import { lockReferences } from './reference-locks.js';

const invalid = message => { throw new HttpError(422, 'invalid_sample_reference', message); };
const ids = values => [...new Set(values.filter(Boolean))];

export async function sampleEditReferences(client, organizationId, sample, categoryId, lines, previousLines, previousTests) {
  const db = database(client);
  const changed = (line, key) => !line.id || line[key] !== previousLines.get(line.id)?.[key];
  const selections = lines.flatMap(line => line.tests.map(test => ({ line, test, previous: previousTests.get(test.id) })));
  async function active(table, selected, label) {
    const requested = ids(selected);
    if (!requested.length) return new Map();
    await lockReferences(client, table, requested);
    const rows = await db.select().from(table).where(and(eq(table.organizationId, organizationId), inArray(table.id, requested), eq(table.active, true)));
    if (rows.length !== requested.length) invalid(`Select active ${label} from this organization.`);
    return new Map(rows.map(row => [row.id, row]));
  }
  const categories = await active(masters.sampleCategories, [categoryId !== sample.sampleCategoryId ? categoryId : null,
    ...lines.filter(line => changed(line, 'sampleCategoryId')).map(line => line.sampleCategoryId)], 'sample categories');
  const products = await active(masters.products, lines.filter(line => changed(line, 'productId')).map(line => line.productId), 'products');
  const categoryChanges = lines.filter(line => changed(line, 'productId') || changed(line, 'sampleCategoryId'));
  if (categoryChanges.length) {
    const selected = ids(categoryChanges.map(line => line.productId));
    await lockReferences(client, masters.productSampleCategories, selected);
    const links = await db.select().from(masters.productSampleCategories).where(and(eq(masters.productSampleCategories.organizationId, organizationId), inArray(masters.productSampleCategories.productId, selected)));
    const allowed = new Set(links.map(link => `${link.productId}:${link.sampleCategoryId}`));
    for (const line of categoryChanges) if (!allowed.has(`${line.productId}:${line.sampleCategoryId}`)) invalid('The selected product does not belong to this sample category.');
  }
  const tagChanges = lines.filter(line => changed(line, 'tagId') || changed(line, 'productId'));
  const tags = await active(masters.tags, tagChanges.map(line => line.tagId), 'tags');
  if (tags.size) {
    const selected = ids(tagChanges.filter(line => line.tagId).map(line => line.productId));
    await lockReferences(client, masters.productTags, selected);
    const links = await db.select().from(masters.productTags).where(and(eq(masters.productTags.organizationId, organizationId), inArray(masters.productTags.productId, selected)));
    const allowed = new Set(links.map(link => `${link.productId}:${link.tagId}`));
    for (const line of tagChanges) if (line.tagId && !allowed.has(`${line.productId}:${line.tagId}`)) invalid('The tag does not belong to the selected product.');
  }
  await active(masters.testParameters, selections.filter(({ test, previous }) => test.testParameterId !== previous?.testParameterId).map(({ test }) => test.testParameterId), 'parameters');
  await active(masters.methodsOfAnalysis, selections.filter(({ test, previous }) => test.methodId !== previous?.methodId).map(({ test }) => test.methodId), 'methods');
  const methodChanges = selections.filter(({ test, previous }) => test.testParameterId !== previous?.testParameterId || test.methodId !== previous?.methodId);
  if (methodChanges.length) {
    const selected = ids(methodChanges.map(({ test }) => test.testParameterId));
    await lockReferences(client, masters.parameterMethods, selected);
    const links = await db.select().from(masters.parameterMethods).where(and(eq(masters.parameterMethods.organizationId, organizationId), inArray(masters.parameterMethods.testParameterId, selected)));
    const allowed = new Set(links.map(link => `${link.testParameterId}:${link.methodId}`));
    for (const { test } of methodChanges) if (!allowed.has(`${test.testParameterId}:${test.methodId}`)) invalid('The method does not belong to the selected parameter.');
  }
  const ruleChanges = selections.filter(({ line, test, previous }) => test.decisionRuleId && (test.decisionRuleId !== previous?.decisionRuleId
    || test.testParameterId !== previous?.testParameterId || test.methodId !== previous?.methodId || changed(line, 'productId') || changed(line, 'sampleCategoryId')));
  const rules = await active(masters.decisionRules, ruleChanges.map(({ test }) => test.decisionRuleId), 'decision rules');
  const ruleCategoryLinks = rules.size
    ? await db.select().from(masters.decisionRuleSampleCategories).where(and(eq(masters.decisionRuleSampleCategories.organizationId, organizationId), inArray(masters.decisionRuleSampleCategories.decisionRuleId, [...rules.keys()])))
    : [];
  const ruleCategoryIds = new Map();
  for (const link of ruleCategoryLinks) ruleCategoryIds.set(link.decisionRuleId, [...(ruleCategoryIds.get(link.decisionRuleId) ?? []), link.sampleCategoryId]);
  for (const { line, test } of ruleChanges) {
    const rule = rules.get(test.decisionRuleId);
    const ruleCategories = ruleCategoryIds.get(test.decisionRuleId) ?? [];
    if (rule.productId !== line.productId || rule.testParameterId !== test.testParameterId
      || (rule.methodId && rule.methodId !== test.methodId) || (ruleCategories.length && !ruleCategories.includes(line.sampleCategoryId))) {
      invalid('The decision rule does not match the selected product, parameter, method and category.');
    }
  }
  const units = await active(masters.measurementUnits, lines.filter(line => changed(line, 'measurementUnitId')).map(line => line.measurementUnitId), 'measurement units');
  return { categories, products, tags, units };
}
