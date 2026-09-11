import { randomUUID } from 'node:crypto';
import { and, eq, inArray, asc } from 'drizzle-orm';
import { HttpError } from '../auth/errors.js';
import { database } from '../db/pool.js';
import * as masters from '../db/master-schema.js';
import { analyticalSpecifications, analyticalSpecificationLimits } from '../db/sample-schema.js';
import { insertBatch } from '../templates/authoring.js';
import { lockReferences } from '../samples/reference-locks.js';

const missing = () => { throw new HttpError(422, 'analytical_reference_changed', 'A selected scientific reference changed. Review the selected test before continuing.'); };

// Load each kind of master once, regardless of the number of selected tests.
export async function createSpecifications(client, identity, tests) {
  if (!tests.length) return new Map();
  const organizationId = identity.organization_id;
  const db = database(client);
  async function references(table, ids) {
    const selected = [...new Set(ids.filter(Boolean))];
    if (!selected.length) return new Map();
    await lockReferences(client, table, selected);
    const rows = await db.select().from(table).where(and(eq(table.organizationId, organizationId), inArray(table.id, selected))).orderBy(asc(table.id));
    if (rows.length !== selected.length) missing();
    return new Map(rows.map((row) => [row.id, row]));
  }
  const parameters = await references(masters.testParameters, tests.map((test) => test.testParameterId));
  const methods = await references(masters.methodsOfAnalysis, tests.map((test) => test.methodId));
  const rules = await references(masters.decisionRules, tests.map((test) => test.decisionRuleId));
  const units = await references(masters.measurementUnits, [...parameters.values()].map((parameter) => parameter.measurementUnitId));
  const limits = rules.size ? await db.select().from(masters.decisionRuleLimits).where(and(eq(masters.decisionRuleLimits.organizationId, organizationId),
    inArray(masters.decisionRuleLimits.decisionRuleId, [...rules.keys()]))).orderBy(asc(masters.decisionRuleLimits.displayOrder), asc(masters.decisionRuleLimits.id)) : [];
  const limitsByRule = new Map();
  for (const limit of limits) {
    if (!limitsByRule.has(limit.decisionRuleId)) limitsByRule.set(limit.decisionRuleId, []);
    limitsByRule.get(limit.decisionRuleId).push(limit);
  }
  const snapshots = []; const snapshotLimits = []; const byTest = new Map();
  for (const test of tests) {
    const parameter = parameters.get(test.testParameterId); const method = methods.get(test.methodId);
    const unit = units.get(parameter.measurementUnitId); const rule = rules.get(test.decisionRuleId);
    if (rule && (rule.productId !== test.productId || rule.testParameterId !== test.testParameterId
      || (rule.methodId && rule.methodId !== test.methodId) || (rule.sampleCategoryId && rule.sampleCategoryId !== test.sampleCategoryId))) missing();
    const snapshot = {
      organizationId, id: randomUUID(), recordedBy: identity.user_id,
      testParameterId: parameter.id, parameterRevision: parameter.revision, parameterCode: parameter.code, parameterName: parameter.name,
      parameterMasterKey: parameter.masterKey, parameterScale: parameter.defaultScale,
      methodId: method.id, methodRevision: method.revision, methodCode: method.code, methodName: method.name, methodDescription: method.description,
      methodUuid: method.methodUuid, decimalScale: method.decimalScale, parseNumber: method.parseNumber,
      measurementUnitId: unit?.id ?? null, unitRevision: unit?.revision ?? null, unitCode: unit?.code ?? null, unitName: unit?.name ?? null,
      unitSymbol: unit?.symbol ?? null, unitDimension: unit?.dimension ?? null,
      decisionRuleId: rule?.id ?? null, ruleRevision: rule?.revision ?? null, ruleCode: rule?.code ?? null, ruleName: rule?.name ?? null, templateId: rule?.templateId ?? null,
      cutoffValue: rule?.cutoffValue ?? null, greaterThanText: rule?.greaterThanText ?? null, lessThanText: rule?.lessThanText ?? null,
      minimumText: rule?.minimumText ?? null, maximumText: rule?.maximumText ?? null, unitOfMeasure: rule?.unitOfMeasure ?? null,
      resultRepresentation: rule?.resultRepresentation ?? null, defaultNarration: rule?.defaultNarration ?? null,
      detectableUpperLimit: rule?.detectableUpperLimit ?? null, detectableLowerLimit: rule?.detectableLowerLimit ?? null,
      detectableUpperLimitText: rule?.detectableUpperLimitText ?? null, detectableLowerLimitText: rule?.detectableLowerLimitText ?? null,
      showDetectableLimitText: rule?.showDetectableLimitText ?? false, showStandardLimitText: rule?.showStandardLimitText ?? false, conformanceLimit: rule?.conformanceLimit ?? null,
    };
    snapshots.push(snapshot);
    byTest.set(test.id, snapshot);
    for (const limit of limitsByRule.get(rule?.id) ?? []) {
      const { decisionRuleId: _ruleId, ...values } = limit;
      snapshotLimits.push({ ...values, specificationId: snapshot.id });
    }
  }
  await insertBatch(db, analyticalSpecifications, snapshots);
  await insertBatch(db, analyticalSpecificationLimits, snapshotLimits);
  return byTest;
}
