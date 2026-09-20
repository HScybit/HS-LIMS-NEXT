// HyperFormula-backed formula language. Formulas are stored as their raw authored text plus
// the stable field references resolved out of it at author time (aliases are not identity —
// resolving on every load lets fields be renamed without breaking stored formulas). Evaluation
// substitutes each reference with a small HyperFormula workspace cell/range and delegates all
// arithmetic, comparison and function semantics to HyperFormula itself.
import { HyperFormula } from 'hyperformula';
import { HttpError } from '../auth/errors.js';

export const EXPRESSION_SEMANTICS = 'hyperformula-v1';
const MAX_LENGTH = 16_000;
const MAX_REFERENCES = 1000;
const MAX_DEPTH = 64;
const MAX_OPERAND_VALUES = 100_000;
const AGGREGATE_FUNCTIONS = new Set(['SUM', 'MIN', 'MAX', 'AVERAGE']);
const HYPERFORMULA_CONFIG = { licenseKey: 'gpl-v3', useColumnIndex: false, smartRounding: false };
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOKEN_PATTERN = /\s+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|<=|>=|<>|[+\-*/^%(),=<>]|"(?:[^"]|"")*"/gy;

const ERROR_CODES = {
  DIV_BY_ZERO: 'expression_divide_by_zero', NAME: 'expression_reference', VALUE: 'expression_value',
  NUM: 'expression_overflow', NA: 'expression_arguments', CYCLE: 'expression_cycle', REF: 'expression_reference',
  SPILL: 'expression_result_type', LIC: 'expression_engine', ERROR: 'expression_error',
};
const ERROR_MESSAGES = {
  DIV_BY_ZERO: 'Formula attempted to divide by zero.', NAME: 'Formula references an unknown variable or function.',
  VALUE: 'A formula input is not numeric.', NUM: 'Formula result is outside the supported numeric range.',
  NA: 'Formula function received an invalid number of arguments.', CYCLE: 'Formula dependencies contain a cycle.',
  REF: 'Formula has an invalid reference.', SPILL: 'Formula result could not be placed.',
  LIC: 'Formula engine license is invalid.', ERROR: 'Formula could not be evaluated.',
};

export class ExpressionError extends HttpError {
  constructor(code, message) { super(400, code, message); this.name = 'ExpressionError'; }
}
function fail(code, message) { throw new ExpressionError(code, message); }

function tokenize(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_LENGTH) fail('expression_syntax', 'A formula of at most 16,000 characters is required.');
  const tokens = [];
  let position = 0;
  while (position < text.length) {
    TOKEN_PATTERN.lastIndex = position;
    const match = TOKEN_PATTERN.exec(text);
    if (!match) fail('expression_syntax', `Unexpected character at position ${position + 1}.`);
    position = TOKEN_PATTERN.lastIndex;
    if (!/^\s/.test(match[0])) tokens.push(match[0]);
    if (tokens.length > MAX_REFERENCES * 3) fail('expression_limit', 'Formula is too complex.');
  }
  if (!tokens.length) fail('expression_syntax', 'Formula ends unexpectedly.');
  return tokens;
}

// One pass over tokens: resolves every bare identifier that isn't a function name or TRUE/FALSE
// to a stable field reference, and records, per occurrence, whether it sits alone as a direct
// argument to SUM/MIN/MAX/AVERAGE — the only positions where a multi-occurrence ("descendants")
// value is unambiguous. Also used (with a stored alias map) to re-validate a loaded expression.
function scan(tokens, resolveReference) {
  const stack = [];
  const referencesByAlias = {};
  let referenceCount = 0;
  const occurrences = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '(') {
      const previous = tokens[index - 1];
      if (stack.length >= MAX_DEPTH) fail('expression_limit', 'Formula nesting is too deep.');
      stack.push({ call: previous && IDENTIFIER.test(previous) ? previous.toUpperCase() : null });
      continue;
    }
    if (token === ')') {
      if (!stack.length) fail('expression_syntax', "Unexpected ')'.");
      stack.pop();
      continue;
    }
    if (!IDENTIFIER.test(token) || tokens[index + 1] === '(') continue;
    const upper = token.toUpperCase();
    if (upper === 'TRUE' || upper === 'FALSE') continue;
    const reference = resolveReference(token);
    if (!reference?.fieldId || !['current', 'ancestor', 'descendants'].includes(reference.scope)) {
      fail('expression_reference', `Formula reference '${token}' is missing or ambiguous.`);
    }
    const existing = referencesByAlias[token];
    if (existing && (existing.fieldId !== reference.fieldId || existing.scope !== reference.scope)) {
      fail('expression_reference', `Formula reference '${token}' resolved inconsistently.`);
    }
    if (!existing) referenceCount += 1;
    referencesByAlias[token] = { fieldId: reference.fieldId, scope: reference.scope };
    const top = stack.at(-1);
    const boundaryBefore = index === 0 || ['(', ','].includes(tokens[index - 1]);
    const boundaryAfter = index === tokens.length - 1 || [')', ','].includes(tokens[index + 1]);
    occurrences.push({ index, alias: token, aggregate: Boolean(boundaryBefore && boundaryAfter && top?.call && AGGREGATE_FUNCTIONS.has(top.call)) });
  }
  if (stack.length) fail('expression_syntax', "Formula is missing a closing ')'.");
  if (referenceCount > MAX_REFERENCES) fail('expression_limit', 'Formula is too complex.');
  return { referencesByAlias, referenceCount, occurrences };
}

// Rebuilds formula text, substituting each reference occurrence via `label(occurrence)` and
// bare TRUE/FALSE with HyperFormula's literal call form.
function rewrite(tokens, occurrences, label) {
  const byIndex = new Map(occurrences.map((occurrence) => [occurrence.index, occurrence]));
  return tokens.map((token, index) => {
    const occurrence = byIndex.get(index);
    if (occurrence) return label(occurrence);
    const upper = token.toUpperCase();
    if ((upper === 'TRUE' || upper === 'FALSE') && tokens[index + 1] !== '(') return `${upper}()`;
    return token;
  }).join('');
}

let workspace = null;
function getWorkspace() {
  if (!workspace) {
    const hf = HyperFormula.buildEmpty(HYPERFORMULA_CONFIG);
    const name = hf.addSheet('Formulas');
    workspace = { hf, sheetId: hf.getSheetId(name) };
  }
  return workspace;
}

function columnLetter(index) {
  let value = index + 1; let result = '';
  while (value > 0) { const remainder = (value - 1) % 26; result = String.fromCharCode(65 + remainder) + result; value = Math.floor((value - 1) / 26); }
  return result;
}

function cellValue(value) {
  // A raw string cell starting with '=' would be reinterpreted as a formula by HyperFormula.
  return typeof value === 'string' && value.startsWith('=') ? `'${value}` : value;
}

// resolveReference maps a source alias to a stable field ID and an explicit occurrence scope.
export function parseExpression(formulaText, resolveReference) {
  const tokens = tokenize(formulaText);
  const { referencesByAlias } = scan(tokens, resolveReference);
  const references = Object.entries(referencesByAlias).map(([alias, reference]) => ({ alias, fieldId: reference.fieldId, scope: reference.scope }));
  const stored = { formulaText, references };
  compileExpression(stored);
  return stored;
}

// compileExpression re-derives the token/occurrence structure from a stored {formulaText,
// references} row (a plain, JSON-serializable object — safe to send over HTTP as-is), re-validating
// every stored reference rather than trusting it blindly.
export function compileExpression(stored) {
  if (!stored || typeof stored.formulaText !== 'string' || !Array.isArray(stored.references)) fail('expression_structure', 'Invalid stored expression.');
  const aliasMap = {};
  let aliasCount = 0;
  for (const reference of stored.references) {
    if (!reference || !IDENTIFIER.test(reference.alias) || !reference.fieldId || !['current', 'ancestor', 'descendants'].includes(reference.scope)) {
      fail('expression_structure', 'Invalid stored expression reference.');
    }
    if (Object.hasOwn(aliasMap, reference.alias)) fail('expression_structure', 'Duplicate expression reference.');
    aliasMap[reference.alias] = { fieldId: reference.fieldId, scope: reference.scope };
    aliasCount += 1;
  }
  const tokens = tokenize(stored.formulaText);
  const { referencesByAlias, referenceCount, occurrences } = scan(tokens, (alias) => aliasMap[alias] ?? null);
  if (referenceCount !== aliasCount) fail('expression_structure', 'Stored expression references do not match its formula text.');
  const compiled = { formulaText: stored.formulaText, tokens, occurrences, referencesByAlias };
  validateSyntax(compiled);
  return compiled;
}

// Author-time-only syntax check: binds every reference to a dummy scalar and asks HyperFormula
// to validate the resulting text, catching unknown functions/malformed syntax before storage.
function validateSyntax(compiled) {
  const { hf } = getWorkspace();
  const aliases = Object.keys(compiled.referencesByAlias);
  const text = rewrite(compiled.tokens, compiled.occurrences, (occurrence) => `${columnLetter(aliases.indexOf(occurrence.alias))}1`);
  if (!hf.validateFormula(`=${text}`)) fail('expression_syntax', 'Formula syntax is invalid.');
}

export function evaluateExpression(compiled, resolveValue, { onMissingValue = 'error' } = {}) {
  const { hf, sheetId } = getWorkspace();
  const resolved = {};
  for (const [alias, reference] of Object.entries(compiled.referencesByAlias)) resolved[alias] = resolveValue(reference.fieldId, reference.scope);
  const addresses = new Map();
  let nextColumn = 0;
  for (const occurrence of compiled.occurrences) {
    const value = resolved[occurrence.alias];
    const column = columnLetter(nextColumn); nextColumn += 1;
    if (Array.isArray(value)) {
      if (!occurrence.aggregate) fail('expression_value', 'A scalar expression received multiple values.');
      if (value.length > MAX_OPERAND_VALUES) fail('expression_limit', 'Formula expands to too many values.');
      hf.setCellContents({ sheet: sheetId, row: 0, col: nextColumn - 1 }, value.length ? value.map((item) => [cellValue(item)]) : [[null]]);
      addresses.set(occurrence.index, value.length ? `${column}1:${column}${value.length}` : `${column}1`);
    } else {
      const missing = value === null || value === undefined || value === '';
      if (missing && !occurrence.aggregate) {
        if (onMissingValue === 'error') fail('expression_missing', 'A formula input has no value.');
        if (onMissingValue === 'blank') fail('expression_missing_blank', 'A formula input has no value.');
      }
      hf.setCellContents({ sheet: sheetId, row: 0, col: nextColumn - 1 }, [[missing ? (onMissingValue === 'zero' ? 0 : null) : cellValue(value)]]);
      addresses.set(occurrence.index, `${column}1`);
    }
  }
  const text = rewrite(compiled.tokens, compiled.occurrences, (occurrence) => addresses.get(occurrence.index));
  const result = hf.calculateFormula(`=${text}`, sheetId);
  if (result && typeof result === 'object' && 'type' in result) fail(ERROR_CODES[result.type] ?? 'expression_error', result.message || ERROR_MESSAGES[result.type] || ERROR_MESSAGES.ERROR);
  if (typeof result === 'number' && !Number.isFinite(result)) fail('expression_overflow', 'Formula result is outside the supported numeric range.');
  return result;
}

export function expressionText(compiled, referenceLabel) {
  return rewrite(compiled.tokens, compiled.occurrences, (occurrence) => {
    const reference = compiled.referencesByAlias[occurrence.alias];
    return referenceLabel(reference.fieldId, reference.scope);
  });
}

export function formulaOrder(expressions) {
  const incoming = new Map();
  const dependents = new Map();
  for (const fieldId of expressions.keys()) incoming.set(fieldId, 0);
  for (const [fieldId, compiled] of expressions) {
    const references = new Set(Object.values(compiled.referencesByAlias).map((reference) => reference.fieldId));
    for (const dependency of references) {
      if (!expressions.has(dependency)) continue;
      incoming.set(fieldId, incoming.get(fieldId) + 1);
      if (!dependents.has(dependency)) dependents.set(dependency, []);
      dependents.get(dependency).push(fieldId);
    }
  }
  const ready = [...incoming].filter(([, count]) => count === 0).map(([fieldId]) => fieldId);
  const order = [];
  for (let index = 0; index < ready.length; index += 1) {
    const fieldId = ready[index];
    order.push(fieldId);
    for (const next of dependents.get(fieldId) ?? []) {
      incoming.set(next, incoming.get(next) - 1);
      if (incoming.get(next) === 0) ready.push(next);
    }
  }
  if (order.length !== expressions.size) fail('expression_cycle', 'Formula dependencies contain a cycle.');
  return order;
}
