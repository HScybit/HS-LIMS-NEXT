// Versioned Meteor numeric semantics. Expressions are interpreted, never executed as JavaScript.
import { HttpError } from '../auth/errors.js';
export const EXPRESSION_SEMANTICS = 'meteor-number-v1';
const MAX_NODES = 1000;
const MAX_DEPTH = 64;
const calls = { ABS: [1, 1], MIN: [0, 1000], MAX: [0, 1000], ROUND: [1, 2], SUM: [0, 1000], AVERAGE: [1, 1000], IF: [3, 3] };
const precedence = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '+': 2, '-': 2, '*': 3, '/': 3, '^': 4 };

export class ExpressionError extends HttpError {
  constructor(code, message) { super(400, code, message); this.name = 'ExpressionError'; }
}

function fail(code, message) { throw new ExpressionError(code, message); }

function tokenize(expression) {
  if (typeof expression !== 'string' || !expression.trim() || expression.length > 16_000) {
    fail('expression_syntax', 'A formula of at most 16,000 characters is required.');
  }
  const tokens = [];
  const pattern = /\s+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|<=|>=|<>|[+\-*/^%(),=<>]|"(?:[^"]|"")*"/gy;
  let position = 0;
  while (position < expression.length) {
    pattern.lastIndex = position;
    const match = pattern.exec(expression);
    if (!match) fail('expression_syntax', `Unexpected character at position ${position + 1}.`);
    position = pattern.lastIndex;
    if (!/^\s/.test(match[0])) tokens.push(match[0]);
    if (tokens.length > MAX_NODES * 3) fail('expression_limit', 'Formula is too complex.');
  }
  return tokens;
}

// resolveReference maps a source alias to a stable field ID and an explicit occurrence scope.
// The returned flat nodes are ready for typed relational storage; labels are not identity.
export function parseExpression(expression, resolveReference) {
  const tokens = tokenize(expression);
  let position = 0;
  let count = 0;
  const current = () => tokens[position];
  function take(expected) {
    const value = tokens[position++];
    if (expected && value !== expected) fail('expression_syntax', `Expected '${expected}'.`);
    return value;
  }
  function node(kind, properties, children = []) {
    count += 1;
    if (count > MAX_NODES) fail('expression_limit', 'Formula is too complex.');
    return { kind, ...properties, children };
  }
  function primary(depth) {
    if (depth > MAX_DEPTH) fail('expression_limit', 'Formula nesting is too deep.');
    const token = take();
    if (token === undefined) fail('expression_syntax', 'Formula ends unexpectedly.');
    let result;
    if (token === '+' || token === '-') {
      // Exponentiation binds before the unary sign, as in the source parser.
      result = node('unary', { operator: token }, [expressionAt(4, depth + 1)]);
    } else if (token === '(') {
      result = expressionAt(1, depth + 1);
      take(')');
    } else if (/^(?:\d|\.\d)/.test(token)) {
      if (!Number.isFinite(Number(token))) fail('expression_overflow', 'Formula literal is outside the supported numeric range.');
      result = node('number', { number: token });
    } else if (token.startsWith('"')) {
      result = node('text', { text: token.slice(1, -1).replaceAll('""', '"') });
    } else if (/^[A-Za-z_]/.test(token)) {
      const name = token.toUpperCase();
      if (current() === '(') {
        if (!Object.hasOwn(calls, name)) fail('expression_function', `Formula function '${token}' is not supported.`);
        take('(');
        const args = [];
        if (current() !== ')') {
          args.push(expressionAt(1, depth + 1));
          while (current() === ',') { take(','); args.push(expressionAt(1, depth + 1)); }
        }
        take(')');
        const [min, max] = calls[name];
        if (args.length < min || args.length > max) fail('expression_arguments', `${name} received an invalid number of arguments.`);
        result = node('call', { functionName: name }, args);
      } else if (name === 'TRUE' || name === 'FALSE') {
        result = node('boolean', { boolean: name === 'TRUE' });
      } else {
        const reference = resolveReference(token);
        if (!reference?.fieldId || !['current', 'ancestor', 'descendants'].includes(reference.scope)) {
          fail('expression_reference', `Formula reference '${token}' is missing or ambiguous.`);
        }
        result = node('field', { fieldId: reference.fieldId, scope: reference.scope });
      }
    } else fail('expression_syntax', `Unexpected token '${token}'.`);
    while (current() === '%') { take('%'); result = node('unary', { operator: '%' }, [result]); }
    return result;
  }
  function expressionAt(minimum, depth) {
    let left = primary(depth);
    while (Object.hasOwn(precedence, current()) && precedence[current()] >= minimum) {
      const operator = take();
      // The source uses left-associative exponentiation (2^3^2 = 64).
      left = node('binary', { operator }, [left, expressionAt(precedence[operator] + 1, depth + 1)]);
    }
    return left;
  }
  const root = expressionAt(1, 0);
  if (position !== tokens.length) fail('expression_syntax', `Unexpected token '${current()}'.`);
  const rows = [];
  function flatten(value, parentIndex = null, operandOrder = 0, depth = 0) {
    if (depth > MAX_DEPTH) fail('expression_limit', 'Formula nesting is too deep.');
    const { children, ...properties } = value;
    const index = rows.length;
    rows.push({ index, parentIndex, operandOrder, ...properties });
    children.forEach((child, order) => flatten(child, index, order, depth + 1));
  }
  flatten(root);
  return rows;
}

export function compileExpression(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_NODES) fail('expression_limit', 'Invalid expression size.');
  const nodes = new Map();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.index) || row.index < 0 || row.index >= MAX_NODES || nodes.has(row.index)) fail('expression_structure', 'Duplicate or invalid expression node.');
    nodes.set(row.index, { ...row, children: [] });
  }
  let root;
  for (const value of nodes.values()) {
    if (value.parentIndex == null) {
      if (root) fail('expression_structure', 'Expression must have exactly one root.');
      root = value;
    } else {
      const parent = nodes.get(value.parentIndex);
      if (!parent || !Number.isSafeInteger(value.operandOrder) || value.operandOrder < 0 || value.operandOrder >= MAX_NODES || parent.children[value.operandOrder]) fail('expression_structure', 'Invalid expression parent or operand.');
      parent.children[value.operandOrder] = value;
    }
  }
  const visited = new Set();
  function validate(value, depth) {
    if (!value || visited.has(value.index) || depth > MAX_DEPTH) fail('expression_structure', 'Expression contains a cycle, gap or excessive nesting.');
    visited.add(value.index);
    const length = value.children.length;
    if (['number', 'text', 'boolean', 'field'].includes(value.kind)) {
      if (length) fail('expression_structure', 'A literal or reference cannot have operands.');
      if (value.kind === 'number' && (typeof value.number !== 'string' || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.number) || !Number.isFinite(Number(value.number)))) fail('expression_overflow', 'Invalid numeric literal.');
      if (value.kind === 'text' && typeof value.text !== 'string') fail('expression_structure', 'Invalid text literal.');
      if (value.kind === 'boolean' && typeof value.boolean !== 'boolean') fail('expression_structure', 'Invalid boolean literal.');
      if (value.kind === 'field' && (!value.fieldId || !['current', 'ancestor', 'descendants'].includes(value.scope))) fail('expression_reference', 'Invalid field reference.');
    } else if (value.kind === 'unary') {
      if (length !== 1 || !['+', '-', '%'].includes(value.operator)) fail('expression_structure', 'Invalid unary operator.');
    } else if (value.kind === 'binary') {
      if (length !== 2 || !Object.hasOwn(precedence, value.operator)) fail('expression_structure', 'Invalid binary operator.');
    } else if (value.kind === 'call') {
      const bounds = Object.hasOwn(calls, value.functionName) ? calls[value.functionName] : null;
      if (!bounds || length < bounds[0] || length > bounds[1]) fail('expression_function', 'Invalid formula function.');
    } else fail('expression_structure', 'Unknown expression node kind.');
    for (let index = 0; index < length; index += 1) validate(value.children[index], depth + 1);
  }
  validate(root, 0);
  if (visited.size !== nodes.size) fail('expression_structure', 'Expression contains disconnected nodes.');
  return root;
}

function numeric(value) {
  if (Array.isArray(value)) {
    if (value.length !== 1) fail('expression_value', 'A scalar expression received multiple values.');
    return numeric(value[0]);
  }
  if (value === null || value === undefined || value === '') fail('expression_missing', 'A formula input has no value.');
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) fail('expression_value', 'A formula input is not numeric.');
  return parsed;
}

export function evaluateExpression(root, resolveValue) {
  function evaluate(node) {
    const result = evaluateNode(node);
    if (typeof result === 'number' && !Number.isFinite(result)) fail('expression_overflow', 'Formula result is outside the supported numeric range.');
    return result;
  }
  function strictNumber(value) {
    if (Number.isNaN(Number(value))) fail('expression_value', 'A formula input is not numeric.');
    return numeric(value);
  }
  function evaluateNode(node) {
    if (node.kind === 'number') return Number(node.number);
    if (node.kind === 'text') return node.text;
    if (node.kind === 'boolean') return node.boolean;
    if (node.kind === 'field') return resolveValue(node.fieldId, node.scope);
    const args = node.children.map(evaluate); // Source IF evaluates both branches.
    if (node.kind === 'unary') {
      const value = numeric(args[0]);
      return node.operator === '-' ? -value : node.operator === '%' ? value / 100 : value;
    }
    if (node.kind === 'binary') {
      // Source comparisons retain types ("2" = 2 is false) and compare text directly.
      // Arithmetic has its own source parseFloat coercion and rejects booleans.
      if (['=', '<>', '<', '>', '<=', '>='].includes(node.operator)) {
        const [left, right] = args;
        if (left == null || right == null) fail('expression_missing', 'A formula input has no value.');
        switch (node.operator) {
          case '=': return left === right;
          case '<>': return left !== right;
          case '<': return left < right;
          case '>': return left > right;
          case '<=': return left <= right;
          case '>=': return left >= right;
        }
      }
      const left = numeric(args[0]);
      const right = numeric(args[1]);
      switch (node.operator) {
        case '+': return left + right;
        case '-': return left - right;
        case '*': return left * right;
        case '/': if (right === 0) fail('expression_divide_by_zero', 'Formula attempted to divide by zero.'); return left / right;
        case '^': return left ** right;
        default: fail('expression_structure', 'Unknown operator.');
      }
    }
    if (node.functionName === 'IF') {
      if (args[0] == null) fail('expression_missing', 'A formula input has no value.');
      return args[0] ? args[1] : args[2];
    }
    if (node.functionName === 'ROUND') {
      const digits = args.length === 2 ? strictNumber(args[1]) : 0;
      const factor = 10 ** digits;
      return Math.round(strictNumber(args[0]) * factor) / factor;
    }
    if (node.functionName === 'ABS') return Math.abs(strictNumber(args[0]));
    // Source SUM accepts numeric text; MIN/MAX/AVERAGE include numeric values only.
    // Bound expanded operands as well as AST size, and avoid spreading large arrays.
    const values = [];
    let operandCount = 0;
    for (const argument of args) for (const value of Array.isArray(argument) ? argument : [argument]) {
      operandCount += 1;
      if (operandCount > 100_000) fail('expression_limit', 'Formula expands to too many values.');
      const parsed = node.functionName === 'SUM' && typeof value === 'string' ? Number.parseFloat(value) : value;
      if (typeof parsed === 'number' && !Number.isNaN(parsed) && !Number.isFinite(parsed)) fail('expression_overflow', 'A formula input is outside the supported numeric range.');
      if (typeof parsed === 'number' && Number.isFinite(parsed)) values.push(parsed);
    }
    switch (node.functionName) {
      case 'MIN': return values.length ? values.reduce((minimum, value) => Math.min(minimum, value), values[0]) : 0;
      case 'MAX': return values.length ? values.reduce((maximum, value) => Math.max(maximum, value), values[0]) : 0;
      case 'SUM': return values.reduce((sum, value) => sum + value, 0);
      case 'AVERAGE': if (!values.length) fail('expression_divide_by_zero', 'Cannot average an empty group.'); return values.reduce((sum, value) => sum + value, 0) / values.length;
      default: fail('expression_function', 'Unknown function.');
    }
  }
  return evaluate(root);
}

export function expressionText(root, referenceLabel) {
  if (root.kind === 'number') return root.number;
  if (root.kind === 'text') return `"${root.text.replaceAll('"', '""')}"`;
  if (root.kind === 'boolean') return root.boolean ? 'TRUE' : 'FALSE';
  if (root.kind === 'field') return referenceLabel(root.fieldId, root.scope);
  const values = root.children.map((node) => expressionText(node, referenceLabel));
  if (root.kind === 'unary') return root.operator === '%' ? `(${values[0]})%` : `${root.operator}(${values[0]})`;
  if (root.kind === 'binary') return `(${values[0]} ${root.operator} ${values[1]})`;
  return `${root.functionName}(${values.join(', ')})`;
}

export function formulaOrder(expressions) {
  const incoming = new Map();
  const dependents = new Map();
  for (const fieldId of expressions.keys()) incoming.set(fieldId, 0);
  for (const [fieldId, rows] of expressions) {
    const references = new Set(rows.filter((node) => node.kind === 'field').map((node) => node.fieldId));
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
