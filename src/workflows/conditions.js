// These comparison semantics are characterized from the routed PERN workflow
// service. They are workflow conditions, separate from scientific calculations.
export function conditionValue(source, field) {
  return field.split('.').reduce((value, key) => {
    if (value == null || typeof value !== 'object') return undefined;
    if (Object.hasOwn(value, key)) return value[key];
    const snakeKey = key.replaceAll(/([A-Z])/g, '_$1').toLowerCase();
    return Object.hasOwn(value, snakeKey) ? value[snakeKey] : undefined;
  }, source);
}
export function matchesCondition(actual, operator, expected) {
  if (operator === 'is_null') return actual == null || actual === '';
  if (operator === 'is_not_null') return actual != null && actual !== '';
  const actualText = String(actual ?? ''); const expectedText = String(expected ?? '');
  if (operator === 'eq') return actualText === expectedText;
  if (operator === 'neq') return actualText !== expectedText;
  if (operator === 'contains') return actualText.toLowerCase().includes(expectedText.toLowerCase());
  if (operator === 'in') return expectedText.split(',').map((value) => value.trim()).includes(actualText);
  const actualNumber = Number(actual); const expectedNumber = Number(expected);
  const numeric = Number.isFinite(actualNumber) && Number.isFinite(expectedNumber);
  const left = numeric ? actualNumber : actualText; const right = numeric ? expectedNumber : expectedText;
  if (operator === 'gt') return left > right;
  if (operator === 'gte') return left >= right;
  if (operator === 'lt') return left < right;
  if (operator === 'lte') return left <= right;
  return false;
}
export function workflowConditionsMatch(source, conditions) {
  return conditions.every((condition) => matchesCondition(conditionValue(source, condition.sourceField), condition.operator,
    condition.comparisonText ?? condition.comparisonNumber ?? condition.comparisonBoolean ?? condition.comparisonDate ?? null));
}
