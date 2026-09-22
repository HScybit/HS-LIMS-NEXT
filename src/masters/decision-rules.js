import { HttpError } from '../auth/errors.js';
import { bool, fieldsOnly, integer, requirePermission, text, uuid } from '../templates/input.js';

function requireRead(identity) {
  if (!identity.permission_codes?.some((permission) => ['masters.read', 'masters.manage'].includes(permission))) throw new HttpError(403, 'forbidden', 'You cannot view Decision Rules.');
}

// PERN has no visible code for a plain rule; generate one, like Method/Sample Category. A test group
// parent's own source-visible UID is meaningful and stable, so reuse it instead of a random value.
export function generatedDecisionRuleCode(value) {
  return (value.isTestGroupParent ? value.testGroupUid : value.id).toUpperCase().replace(/[^A-Z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'DECISION-RULE';
}

const optionalText = (value, label, max) => value == null || value === '' ? null : text(value, label, max).trim() || null;
const optionalNumber = (value, label) => {
  if (value == null || value === '') return null;
  const result = Number(value);
  if (!Number.isFinite(result)) throw new HttpError(400, 'invalid_input', `${label} must be a number.`);
  return result;
};
function uniqueIds(value, label, max) {
  if (!Array.isArray(value) || value.length > max) throw new HttpError(400, 'invalid_decision_rule_references', `Select at most ${max} ${label}.`);
  const ids = value.map((id) => uuid(id, label).toLowerCase());
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'invalid_decision_rule_references', `Each ${label} can be selected only once.`);
  return ids;
}

function limitsInput(value) {
  if (!Array.isArray(value) || value.length > 100) throw new HttpError(400, 'invalid_decision_rule_limits', 'Provide at most 100 limit rows.');
  return value.map((limit, index) => {
    fieldsOnly(limit, ['lowerLimit', 'upperLimit', 'lowerInclusive', 'upperInclusive', 'outcome', 'narration']);
    const lowerLimit = optionalNumber(limit.lowerLimit, 'Lower limit'); const upperLimit = optionalNumber(limit.upperLimit, 'Upper limit');
    if (lowerLimit == null && upperLimit == null) throw new HttpError(400, 'invalid_decision_rule_limits', 'Provide at least one limit value in each row.');
    if (lowerLimit != null && upperLimit != null && lowerLimit > upperLimit) throw new HttpError(400, 'invalid_decision_rule_limits', 'Upper limit must not be below lower limit.');
    const outcome = text(limit.outcome, 'Outcome', 100);
    return { lowerLimit, upperLimit, lowerInclusive: bool(limit.lowerInclusive === undefined ? true : limit.lowerInclusive, 'Lower inclusive'),
      upperInclusive: bool(limit.upperInclusive === undefined ? true : limit.upperInclusive, 'Upper inclusive'), outcome,
      narration: optionalText(limit.narration, 'Narration', 2000), displayOrder: index };
  });
}

function formulaVariablesInput(value) {
  if (!Array.isArray(value) || value.length > 100) throw new HttpError(400, 'invalid_decision_rule_formula', 'Provide at most 100 formula variables.');
  const variables = value.map((variable, index) => {
    fieldsOnly(variable, ['key', 'label']);
    const key = text(variable.key, 'Variable key', 64);
    if (!/^[A-Za-z0-9_]+$/.test(key)) throw new HttpError(400, 'invalid_decision_rule_formula', 'Variable keys use only letters, numbers and underscores.');
    return { key, label: text(variable.label, 'Variable label', 200), displayOrder: index };
  });
  if (new Set(variables.map((variable) => variable.key.toLowerCase())).size !== variables.length) {
    throw new HttpError(400, 'invalid_decision_rule_formula', 'Formula variable keys must be unique.');
  }
  return variables;
}

const valueFields = ['name', 'parentDecisionRuleId', 'isTestGroupParent', 'testGroupName', 'testGroupUid', 'productId', 'testParameterId', 'methodId',
  'sampleCategoryIds', 'cutoffValue', 'minimum', 'maximum', 'greaterThanText', 'lessThanText', 'unitOfMeasure', 'templateId', 'isNabl', 'minimumSize',
  'estimatedTimeInDays', 'estimatedCharges', 'expressTime', 'expressCharges', 'resultRepresentation', 'defaultNarration',
  'detectableUpperLimit', 'detectableLowerLimit', 'detectableUpperLimitText', 'detectableLowerLimitText', 'showDetectableLimitText', 'showStandardLimitText',
  'conformanceLimit', 'instrumentIds', 'discipline', 'group', 'uniqueKey', 'hasFormula', 'formula', 'formulaText', 'formulaVariables',
  'hasDerivedFormula', 'customFormula', 'formulaExpression', 'limits'];

export function decisionRuleInput(input) {
  fieldsOnly(input, ['id', 'requestId', 'revision', ...valueFields]);
  const isTestGroupParent = bool(input.isTestGroupParent === undefined ? false : input.isTestGroupParent, 'Is Test Group Parent');
  const parentDecisionRuleId = input.parentDecisionRuleId == null || input.parentDecisionRuleId === '' ? null : uuid(input.parentDecisionRuleId, 'Parent Decision Rule').toLowerCase();
  if (isTestGroupParent && parentDecisionRuleId) throw new HttpError(400, 'invalid_decision_rule_test_group', 'A test group parent cannot itself be a child.');
  let testGroupName = null; let testGroupUid = null;
  if (isTestGroupParent) {
    if (typeof input.testGroupName !== 'string' || !input.testGroupName.trim() || typeof input.testGroupUid !== 'string' || !input.testGroupUid.trim()) {
      throw new HttpError(400, 'invalid_decision_rule_test_group', 'A test group parent requires a Test Group Name and UID.');
    }
    testGroupName = text(input.testGroupName, 'Test Group Name', 200);
    testGroupUid = text(input.testGroupUid, 'Test Group UID', 100);
    if (!/^[A-Za-z0-9_]+$/.test(testGroupUid)) throw new HttpError(400, 'invalid_decision_rule_test_group', 'Test Group UID uses only letters, numbers and underscores.');
  } else if (input.testGroupName || input.testGroupUid) {
    throw new HttpError(400, 'invalid_decision_rule_test_group', 'Only a test group parent may define a group name or UID.');
  }
  const hasFormula = bool(input.hasFormula === undefined ? false : input.hasFormula, 'Has Formula');
  const formula = optionalText(input.formula, 'Formula', 5000);
  if (hasFormula && !formula) throw new HttpError(400, 'invalid_decision_rule_formula', 'Formula is required.');
  const hasDerivedFormula = bool(input.hasDerivedFormula === undefined ? false : input.hasDerivedFormula, 'Has Derived Formula');
  const customFormula = optionalText(input.customFormula, 'Custom Formula', 5000);
  if (hasDerivedFormula && !customFormula) throw new HttpError(400, 'invalid_decision_rule_formula', 'Custom Formula is required.');
  const name = isTestGroupParent ? testGroupName : optionalText(input.name, 'Name', 200);
  return { id: uuid(input.id, 'Decision Rule').toLowerCase(), requestId: uuid(input.requestId, 'Save request').toLowerCase(),
    revision: integer(input.revision, 'Revision', 0, 2_147_483_646), name, parentDecisionRuleId, isTestGroupParent, testGroupName, testGroupUid,
    productId: uuid(input.productId, 'Product').toLowerCase(), testParameterId: uuid(input.testParameterId, 'Parameter').toLowerCase(),
    methodId: uuid(input.methodId, 'MoA').toLowerCase(), sampleCategoryIds: uniqueIds(input.sampleCategoryIds ?? [], 'Sample Category', 500),
    cutoffValue: optionalNumber(input.cutoffValue, 'Cut Off Value') ?? 0, minimum: optionalText(input.minimum, 'Min', 150), maximum: optionalText(input.maximum, 'Max', 150),
    greaterThanText: optionalText(input.greaterThanText, 'If Greater Text', 5000), lessThanText: optionalText(input.lessThanText, 'If Lesser Text', 5000),
    unitOfMeasure: optionalText(input.unitOfMeasure, 'UoM', 100), templateId: input.templateId == null || input.templateId === '' ? null : uuid(input.templateId, 'Template').toLowerCase(),
    isNabl: bool(input.isNabl === undefined ? false : input.isNabl, 'Is NABL'), minimumSize: optionalText(input.minimumSize, 'Min Size', 150),
    estimatedTimeInDays: optionalNumber(input.estimatedTimeInDays, 'Estimated Time in Days') ?? 0, estimatedCharges: optionalNumber(input.estimatedCharges, 'Estimated Charges') ?? 0,
    expressTimeInDays: optionalNumber(input.expressTime, 'Express Time in Days') ?? 0, expressCharges: optionalNumber(input.expressCharges, 'Express Charges') ?? 0,
    resultRepresentation: optionalText(input.resultRepresentation, 'Result Representation', 5000), defaultNarration: optionalText(input.defaultNarration, 'Default Narration', 5000),
    detectableUpperLimit: optionalNumber(input.detectableUpperLimit, 'Detectable Upper Limit'), detectableLowerLimit: optionalNumber(input.detectableLowerLimit, 'Detectable Lower Limit'),
    detectableUpperLimitText: optionalText(input.detectableUpperLimitText, 'Detectable Upper Limit Text', 5000), detectableLowerLimitText: optionalText(input.detectableLowerLimitText, 'Detectable Lower Limit Text', 5000),
    showDetectableLimitText: bool(input.showDetectableLimitText === undefined ? false : input.showDetectableLimitText, 'Show Detectable Limit Text'),
    showStandardLimitText: bool(input.showStandardLimitText === undefined ? false : input.showStandardLimitText, 'Show Standard Limit Text'),
    conformanceLimit: optionalNumber(input.conformanceLimit, 'Conformance Limit'), instrumentIds: uniqueIds(input.instrumentIds ?? [], 'Instrument', 500),
    discipline: optionalText(input.discipline, 'Discipline', 150), ruleGroup: optionalText(input.group, 'Group', 150), uniqueKey: optionalText(input.uniqueKey, 'Unique Key', 100),
    hasFormula, formula, formulaText: optionalText(input.formulaText, 'Formula Text', 5000), formulaVariables: formulaVariablesInput(input.formulaVariables ?? []),
    hasDerivedFormula, customFormula, formulaExpression: optionalText(input.formulaExpression, 'Formula Expression', 5000), limits: limitsInput(input.limits ?? []) };
}

const activeReference = async (client, organizationId, table, ids, label, condition = 'active') => {
  if (!ids.length) return;
  const rows = await client.query(`SELECT id FROM ${table} WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND ${condition}`, [organizationId, ids]);
  if (rows.rowCount !== ids.length) throw new HttpError(400, 'invalid_decision_rule_references', `Select active ${label} in this organization.`);
};

export async function loadDecisionRule(client, identity, ruleId, { atRevision } = {}) {
  requireRead(identity); uuid(ruleId, 'Decision Rule');
  if (atRevision !== undefined) integer(atRevision, 'Revision', 1, 2_147_483_647);
  const history = atRevision !== undefined;
  const record = (await client.query(`SELECT ${history ? 'decision_rule_id' : 'id'} AS id,revision,code,name,parent_decision_rule_id AS "parentDecisionRuleId",
    is_test_group_parent AS "isTestGroupParent",test_group_name AS "testGroupName",test_group_uid AS "testGroupUid",
    product_id AS "productId",test_parameter_id AS "testParameterId",method_id AS "methodId",template_id AS "templateId",
    cutoff_value AS "cutoffValue",greater_than_text AS "greaterThanText",less_than_text AS "lessThanText",minimum_text AS minimum,maximum_text AS maximum,
    unit_of_measure AS "unitOfMeasure",is_nabl AS "isNabl",minimum_size AS "minimumSize",estimated_time_in_days AS "estimatedTimeInDays",
    estimated_charges AS "estimatedCharges",express_time_in_days AS "expressTime",express_charges AS "expressCharges",
    result_representation AS "resultRepresentation",default_narration AS "defaultNarration",detectable_upper_limit AS "detectableUpperLimit",
    detectable_lower_limit AS "detectableLowerLimit",detectable_upper_limit_text AS "detectableUpperLimitText",detectable_lower_limit_text AS "detectableLowerLimitText",
    show_detectable_limit_text AS "showDetectableLimitText",show_standard_limit_text AS "showStandardLimitText",conformance_limit AS "conformanceLimit",
    discipline,rule_group AS "group",unique_key AS "uniqueKey",has_formula AS "hasFormula",formula,formula_text AS "formulaText",
    has_derived_formula AS "hasDerivedFormula",custom_formula AS "customFormula",formula_expression AS "formulaExpression",active,
    names.product_name AS "productName",names.parameter_name AS "parameterName",names.method_name AS "methodName",names.template_name AS "templateName",
    names.parent_name AS "parentDecisionRuleName"
    ${history ? ',saved_by AS "savedBy",saved_at AS "savedAt",previous_revision AS "previousRevision",operation' : ',created_at AS "createdAt",updated_at AS "updatedAt"'}
    FROM ${history ? 'decision_rule_versions' : 'decision_rules'} rule
    LEFT JOIN LATERAL (SELECT
      (SELECT name FROM products WHERE organization_id=rule.organization_id AND id=rule.product_id) AS product_name,
      (SELECT name FROM test_parameters WHERE organization_id=rule.organization_id AND id=rule.test_parameter_id) AS parameter_name,
      (SELECT name FROM methods_of_analysis WHERE organization_id=rule.organization_id AND id=rule.method_id) AS method_name,
      (SELECT name FROM product_template_labels WHERE organization_id=rule.organization_id AND template_id=rule.template_id) AS template_name,
      (SELECT test_group_name FROM decision_rules WHERE organization_id=rule.organization_id AND id=rule.parent_decision_rule_id) AS parent_name
    ) names ON true
    WHERE rule.organization_id=$1 AND ${history ? 'decision_rule_id' : 'rule.id'}=$2
    ${history ? 'AND rule.revision=$3' : 'AND rule.active'}`, history ? [identity.organization_id, ruleId, atRevision] : [identity.organization_id, ruleId])).rows[0];
  if (!record) throw new HttpError(404, 'decision_rule_not_found', 'Decision Rule was not found.');
  // Selected relations carry their current names so the form and view show names, never identifiers.
  const [categories, instruments, formulaVariables, limits] = await Promise.all([
    client.query(`SELECT link.sample_category_id AS id,category.name FROM decision_rule_sample_categories link
      LEFT JOIN sample_categories category ON category.organization_id=link.organization_id AND category.id=link.sample_category_id
      WHERE link.organization_id=$1 AND link.decision_rule_id=$2 ORDER BY link.sample_category_id`, [identity.organization_id, ruleId]),
    client.query(`SELECT link.instrument_id AS id,instrument.name FROM decision_rule_instruments link
      LEFT JOIN instruments instrument ON instrument.organization_id=link.organization_id AND instrument.id=link.instrument_id
      WHERE link.organization_id=$1 AND link.decision_rule_id=$2 ORDER BY link.instrument_id`, [identity.organization_id, ruleId]),
    client.query('SELECT key,label FROM decision_rule_formula_variables WHERE organization_id=$1 AND decision_rule_id=$2 ORDER BY display_order', [identity.organization_id, ruleId]),
    client.query(`SELECT lower_limit AS "lowerLimit",upper_limit AS "upperLimit",lower_inclusive AS "lowerInclusive",upper_inclusive AS "upperInclusive",outcome,narration
      FROM decision_rule_limits WHERE organization_id=$1 AND decision_rule_id=$2 ORDER BY display_order`, [identity.organization_id, ruleId]),
  ]);
  return { ...record, sampleCategoryIds: categories.rows.map((row) => row.id), sampleCategories: categories.rows,
    instrumentIds: instruments.rows.map((row) => row.id), instruments: instruments.rows, formulaVariables: formulaVariables.rows, limits: limits.rows };
}

async function priorSave(client, identity, id, revision, requestId, operation) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('decision-rule-save:'||$1::text||':'||$2::text,0))", [identity.organization_id, requestId]);
  const prior = (await client.query('SELECT decision_rule_id,revision,previous_revision,operation,saved_by FROM decision_rule_versions WHERE organization_id=$1 AND request_id=$2', [identity.organization_id, requestId])).rows[0];
  if (!prior) return null;
  if (prior.decision_rule_id !== id || (prior.previous_revision ?? 0) !== revision || prior.operation !== operation || prior.saved_by !== identity.user_id) {
    throw new HttpError(409, 'save_request_reused', 'This save request was already used for another change.');
  }
  return loadDecisionRule(client, identity, id, { atRevision: prior.revision });
}

// Retry comparisons must tolerate both shapes this function ever sees: a freshly parsed
// decisionRuleInput() result, and a loaded record from loadDecisionRule() (different key
// names for a couple of fields, and every numeric column returned as text by the driver).
const orNull = (value) => value === undefined ? null : value;
const asNumber = (value) => value == null ? null : Number(value);
const normalizedLimits = (limits) => (limits ?? []).map((limit) => ({ lowerLimit: asNumber(limit.lowerLimit), upperLimit: asNumber(limit.upperLimit),
  lowerInclusive: limit.lowerInclusive, upperInclusive: limit.upperInclusive, outcome: limit.outcome, narration: orNull(limit.narration) }));
const normalizedVariables = (variables) => (variables ?? []).map(({ key, label }) => ({ key, label }));
const authoredFields = (value) => ({
  name: orNull(value.name), parentDecisionRuleId: orNull(value.parentDecisionRuleId), isTestGroupParent: value.isTestGroupParent,
  testGroupName: orNull(value.testGroupName), testGroupUid: orNull(value.testGroupUid), productId: value.productId, testParameterId: value.testParameterId,
  methodId: value.methodId, sampleCategoryIds: value.sampleCategoryIds, cutoffValue: asNumber(value.cutoffValue), minimum: orNull(value.minimum), maximum: orNull(value.maximum),
  greaterThanText: orNull(value.greaterThanText), lessThanText: orNull(value.lessThanText), unitOfMeasure: orNull(value.unitOfMeasure), templateId: orNull(value.templateId),
  isNabl: value.isNabl, minimumSize: orNull(value.minimumSize), estimatedTimeInDays: asNumber(value.estimatedTimeInDays), estimatedCharges: asNumber(value.estimatedCharges),
  expressTimeInDays: asNumber(value.expressTimeInDays ?? value.expressTime), expressCharges: asNumber(value.expressCharges),
  resultRepresentation: orNull(value.resultRepresentation), defaultNarration: orNull(value.defaultNarration),
  detectableUpperLimit: asNumber(value.detectableUpperLimit), detectableLowerLimit: asNumber(value.detectableLowerLimit),
  detectableUpperLimitText: orNull(value.detectableUpperLimitText), detectableLowerLimitText: orNull(value.detectableLowerLimitText),
  showDetectableLimitText: value.showDetectableLimitText, showStandardLimitText: value.showStandardLimitText, conformanceLimit: asNumber(value.conformanceLimit),
  instrumentIds: value.instrumentIds, discipline: orNull(value.discipline), ruleGroup: orNull(value.ruleGroup ?? value.group), uniqueKey: orNull(value.uniqueKey),
  hasFormula: value.hasFormula, formula: orNull(value.formula), formulaText: orNull(value.formulaText), formulaVariables: normalizedVariables(value.formulaVariables),
  hasDerivedFormula: value.hasDerivedFormula, customFormula: orNull(value.customFormula), formulaExpression: orNull(value.formulaExpression),
  limits: normalizedLimits(value.limits) });

export async function saveDecisionRule(client, identity, value) {
  requirePermission(identity, 'masters.manage');
  const input = decisionRuleInput(value);
  const prior = await priorSave(client, identity, input.id, input.revision, input.requestId, input.revision ? 'update' : 'create');
  if (prior) {
    if (JSON.stringify(authoredFields(prior)) !== JSON.stringify(authoredFields(input))) throw new HttpError(409, 'save_request_reused', 'This save request was already used for different values.');
    return prior;
  }
  const current = (await client.query('SELECT revision,active,code FROM decision_rules WHERE organization_id=$1 AND id=$2 FOR UPDATE', [identity.organization_id, input.id])).rows[0];
  if (input.revision && !current?.active) throw new HttpError(404, 'decision_rule_not_found', 'Decision Rule was not found.');
  if ((current?.revision ?? 0) !== input.revision) throw new HttpError(409, 'stale_decision_rule', 'The Decision Rule changed. Reload before saving.');
  let parent = null;
  if (input.parentDecisionRuleId) {
    parent = (await client.query('SELECT id,product_id AS "productId",method_id AS "methodId",is_test_group_parent AS "isTestGroupParent" FROM decision_rules WHERE organization_id=$1 AND id=$2 AND active',
      [identity.organization_id, input.parentDecisionRuleId])).rows[0];
    if (!parent?.isTestGroupParent) throw new HttpError(400, 'invalid_decision_rule_test_group', 'Select an active test group parent Decision Rule.');
    if (parent.productId !== input.productId || parent.methodId !== input.methodId) {
      throw new HttpError(400, 'invalid_decision_rule_test_group', 'A test group child shares its parent Product and MoA.');
    }
  }
  await Promise.all([
    activeReference(client, identity.organization_id, 'products', [input.productId], 'Products'),
    activeReference(client, identity.organization_id, 'test_parameters', [input.testParameterId], 'Parameters'),
    activeReference(client, identity.organization_id, 'methods_of_analysis', [input.methodId], 'MoA'),
    activeReference(client, identity.organization_id, 'sample_categories', input.sampleCategoryIds, 'Sample Categories'),
    activeReference(client, identity.organization_id, 'instruments', input.instrumentIds, 'Instruments', 'NOT retired'),
  ]);
  if (input.templateId && !(await client.query('SELECT 1 FROM product_template_labels WHERE organization_id=$1 AND template_id=$2 AND active', [identity.organization_id, input.templateId])).rowCount) {
    throw new HttpError(400, 'invalid_decision_rule_template', 'Select an active Template in this organization.');
  }
  const code = current ? current.code : generatedDecisionRuleCode(input);
  const args = [identity.organization_id, input.id, code, input.name, input.parentDecisionRuleId, input.isTestGroupParent, input.testGroupName, input.testGroupUid,
    input.productId, input.testParameterId, input.methodId, input.templateId, input.cutoffValue, input.greaterThanText, input.lessThanText, input.minimum, input.maximum,
    input.unitOfMeasure, input.isNabl, input.minimumSize, input.estimatedTimeInDays, input.estimatedCharges, input.expressTimeInDays, input.expressCharges,
    input.resultRepresentation, input.defaultNarration, input.detectableUpperLimit, input.detectableLowerLimit, input.detectableUpperLimitText, input.detectableLowerLimitText,
    input.showDetectableLimitText, input.showStandardLimitText, input.conformanceLimit, input.discipline, input.ruleGroup, input.uniqueKey,
    input.hasFormula, input.formula, input.formulaText, input.hasDerivedFormula, input.customFormula, input.formulaExpression, input.requestId];
  try {
    if (!input.revision) await client.query(`INSERT INTO decision_rules(organization_id,id,code,name,parent_decision_rule_id,is_test_group_parent,test_group_name,test_group_uid,
      product_id,test_parameter_id,method_id,template_id,cutoff_value,greater_than_text,less_than_text,minimum_text,maximum_text,
      unit_of_measure,is_nabl,minimum_size,estimated_time_in_days,estimated_charges,express_time_in_days,express_charges,
      result_representation,default_narration,detectable_upper_limit,detectable_lower_limit,detectable_upper_limit_text,detectable_lower_limit_text,
      show_detectable_limit_text,show_standard_limit_text,conformance_limit,discipline,rule_group,unique_key,
      has_formula,formula,formula_text,has_derived_formula,custom_formula,formula_expression,save_request_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43)`, args);
    else await client.query(`UPDATE decision_rules SET code=$3,name=$4,parent_decision_rule_id=$5,is_test_group_parent=$6,test_group_name=$7,test_group_uid=$8,
      product_id=$9,test_parameter_id=$10,method_id=$11,template_id=$12,cutoff_value=$13,greater_than_text=$14,less_than_text=$15,minimum_text=$16,maximum_text=$17,
      unit_of_measure=$18,is_nabl=$19,minimum_size=$20,estimated_time_in_days=$21,estimated_charges=$22,express_time_in_days=$23,express_charges=$24,
      result_representation=$25,default_narration=$26,detectable_upper_limit=$27,detectable_lower_limit=$28,detectable_upper_limit_text=$29,detectable_lower_limit_text=$30,
      show_detectable_limit_text=$31,show_standard_limit_text=$32,conformance_limit=$33,discipline=$34,rule_group=$35,unique_key=$36,
      has_formula=$37,formula=$38,formula_text=$39,has_derived_formula=$40,custom_formula=$41,formula_expression=$42,save_request_id=$43,
      active=true,revision=revision+1,updated_at=transaction_timestamp() WHERE organization_id=$1 AND id=$2`, args);
    await client.query('DELETE FROM decision_rule_sample_categories WHERE organization_id=$1 AND decision_rule_id=$2', [identity.organization_id, input.id]);
    if (input.sampleCategoryIds.length) await client.query('INSERT INTO decision_rule_sample_categories(organization_id,decision_rule_id,sample_category_id) SELECT $1,$2,category_id FROM unnest($3::uuid[]) AS categories(category_id)',
      [identity.organization_id, input.id, input.sampleCategoryIds]);
    await client.query('DELETE FROM decision_rule_instruments WHERE organization_id=$1 AND decision_rule_id=$2', [identity.organization_id, input.id]);
    if (input.instrumentIds.length) await client.query('INSERT INTO decision_rule_instruments(organization_id,decision_rule_id,instrument_id) SELECT $1,$2,instrument_id FROM unnest($3::uuid[]) AS instruments(instrument_id)',
      [identity.organization_id, input.id, input.instrumentIds]);
    await client.query('DELETE FROM decision_rule_formula_variables WHERE organization_id=$1 AND decision_rule_id=$2', [identity.organization_id, input.id]);
    if (input.formulaVariables.length) await client.query(`INSERT INTO decision_rule_formula_variables(organization_id,decision_rule_id,key,label,display_order)
      SELECT $1,$2,key,label,position-1 FROM unnest($3::text[],$4::text[]) WITH ORDINALITY AS variables(key,label,position)`,
      [identity.organization_id, input.id, input.formulaVariables.map((variable) => variable.key), input.formulaVariables.map((variable) => variable.label)]);
    await client.query('DELETE FROM decision_rule_limits WHERE organization_id=$1 AND decision_rule_id=$2', [identity.organization_id, input.id]);
    if (input.limits.length) await client.query(`INSERT INTO decision_rule_limits(organization_id,decision_rule_id,lower_limit,upper_limit,lower_inclusive,upper_inclusive,outcome,narration,display_order)
      SELECT $1,$2,lower_limit,upper_limit,lower_inclusive,upper_inclusive,outcome,narration,position-1
      FROM unnest($3::double precision[],$4::double precision[],$5::boolean[],$6::boolean[],$7::text[],$8::text[]) WITH ORDINALITY
        AS limits(lower_limit,upper_limit,lower_inclusive,upper_inclusive,outcome,narration,position)`,
      [identity.organization_id, input.id, input.limits.map((limit) => limit.lowerLimit), input.limits.map((limit) => limit.upperLimit),
        input.limits.map((limit) => limit.lowerInclusive), input.limits.map((limit) => limit.upperInclusive),
        input.limits.map((limit) => limit.outcome), input.limits.map((limit) => limit.narration)]);
  } catch (error) {
    if (error.constraint === 'decision_rule_save_request_key') throw new HttpError(409, 'save_request_reused', 'This save request was already used for another change.');
    if (error.constraint === 'decision_rule_active_scope_key') throw new HttpError(409, 'duplicate_decision_rule', 'An active Decision Rule already exists for this Product, Parameter and MoA.');
    if (error.constraint === 'decision_rules_code_key') throw new HttpError(409, 'duplicate_decision_rule', 'This Test Group UID is already in use.');
    if (error.code === '23505') throw new HttpError(409, 'duplicate_decision_rule', 'The Decision Rule identifier is already in use.');
    throw error;
  }
  return loadDecisionRule(client, identity, input.id);
}

export async function retireDecisionRule(client, identity, input) {
  requirePermission(identity, 'masters.manage'); fieldsOnly(input, ['id', 'requestId', 'revision']);
  const id = uuid(input.id, 'Decision Rule').toLowerCase(); const requestId = uuid(input.requestId, 'Delete request').toLowerCase();
  const revision = integer(input.revision, 'Revision', 1, 2_147_483_646);
  const prior = await priorSave(client, identity, id, revision, requestId, 'retire');
  if (prior) return { id, revision: prior.revision };
  const current = (await client.query('SELECT revision,active FROM decision_rules WHERE organization_id=$1 AND id=$2 FOR UPDATE', [identity.organization_id, id])).rows[0];
  if (!current?.active) throw new HttpError(404, 'decision_rule_not_found', 'Decision Rule was not found.');
  if (current.revision !== revision) throw new HttpError(409, 'stale_decision_rule', 'The Decision Rule changed. Reload before deleting.');
  await client.query(`UPDATE decision_rules SET active=false,save_request_id=$3,revision=revision+1,updated_at=transaction_timestamp() WHERE organization_id=$1 AND id=$2`,
    [identity.organization_id, id, requestId]);
  return { id, revision: revision + 1 };
}

const literalSearch = (value) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
function searchText(value, label) {
  const result = text(value, label, 500, { optional: true }).trim();
  if (result.includes('\0')) throw new HttpError(400, 'invalid_input', `${label} cannot contain null characters.`);
  return result;
}

export async function listDecisionRules(client, identity, input = {}) {
  requireRead(identity); fieldsOnly(input, ['page', 'pageSize', 'search']);
  const page = integer(input.page ?? 1, 'Page', 1, 1_000_000); const pageSize = integer(input.pageSize ?? 10, 'Page size', 1, 100);
  const search = searchText(input.search, 'Search'); const args = [identity.organization_id]; const conditions = ['rule.organization_id=$1', 'rule.active'];
  const bind = (value) => { args.push(value); return `$${args.length}`; };
  if (search) { const value = bind(literalSearch(search)); conditions.push(`(rule.name ILIKE ${value} OR product.name ILIKE ${value} OR parameter.name ILIKE ${value} OR method.name ILIKE ${value})`); }
  const from = `FROM decision_rules rule
    JOIN products product ON product.organization_id=rule.organization_id AND product.id=rule.product_id
    JOIN test_parameters parameter ON parameter.organization_id=rule.organization_id AND parameter.id=rule.test_parameter_id
    JOIN methods_of_analysis method ON method.organization_id=rule.organization_id AND method.id=rule.method_id
    WHERE ${conditions.join(' AND ')}`;
  const totalCount = (await client.query(`SELECT count(*)::integer AS total ${from}`, args)).rows[0].total;
  const rows = (await client.query(`SELECT rule.id AS _id,rule.revision,rule.name,rule.is_test_group_parent AS "isTestGroupParent",rule.is_nabl AS "isNabl",
    product.name AS "productName",parameter.name AS "parameterName",method.name AS "methodName",rule.created_at AS "createdAt"
    ${from} ORDER BY rule.created_at DESC,rule.id DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, pageSize, (page - 1) * pageSize])).rows;
  return { rows, totalCount };
}

async function relationOptions(client, identity, table, condition, nameColumn, search) {
  requireRead(identity);
  const rows = (await client.query(`SELECT id,${nameColumn} AS name FROM ${table} WHERE organization_id=$1 AND ${condition} AND ${nameColumn} ILIKE $2
    ORDER BY ${nameColumn},id LIMIT 101`, [identity.organization_id, literalSearch(searchText(search, 'Search'))])).rows;
  return { rows: rows.slice(0, 100), hasMore: rows.length > 100 };
}
export const decisionRuleProductOptions = (client, identity, input = {}) => { fieldsOnly(input, ['search']); return relationOptions(client, identity, 'products', 'active', 'name', input.search); };
export const decisionRuleParameterOptions = (client, identity, input = {}) => { fieldsOnly(input, ['search']); return relationOptions(client, identity, 'test_parameters', 'active', 'name', input.search); };
export const decisionRuleMethodOptions = (client, identity, input = {}) => { fieldsOnly(input, ['search']); return relationOptions(client, identity, 'methods_of_analysis', 'active', 'name', input.search); };
export const decisionRuleCategoryOptions = (client, identity, input = {}) => { fieldsOnly(input, ['search']); return relationOptions(client, identity, 'sample_categories', 'active', 'name', input.search); };
export const decisionRuleInstrumentOptions = (client, identity, input = {}) => { fieldsOnly(input, ['search']); return relationOptions(client, identity, 'instruments', 'not retired', 'name', input.search); };

export async function decisionRuleTemplateOptions(client, identity, input = {}) {
  requireRead(identity); fieldsOnly(input, ['search']);
  const search = searchText(input.search, 'Template search');
  const rows = (await client.query(`SELECT template_id AS id,name FROM product_template_labels WHERE organization_id=$1 AND active AND name ILIKE $2
    ORDER BY name,template_id LIMIT 101`, [identity.organization_id, literalSearch(search)])).rows;
  return { rows: rows.slice(0, 100), hasMore: rows.length > 100 };
}

export async function decisionRuleParentOptions(client, identity, input = {}) {
  requireRead(identity); fieldsOnly(input, ['search']);
  const search = searchText(input.search, 'Test group search');
  const rows = (await client.query(`SELECT id,test_group_name AS name FROM decision_rules WHERE organization_id=$1 AND active AND is_test_group_parent
    AND test_group_name ILIKE $2 ORDER BY test_group_name,id LIMIT 101`, [identity.organization_id, literalSearch(search)])).rows;
  return { rows: rows.slice(0, 100), hasMore: rows.length > 100 };
}
