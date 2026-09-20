import { HyperFormula } from 'hyperformula';

// HyperFormula replaces Meteor's hot-formula-parser (same author lineage, a proper spreadsheet
// engine rather than a single-expression parser) as the calculation engine for Decision Rule
// formulas. GPL-3.0 terms apply to server-side use; see package.json/LICENSE decisions elsewhere
// for the project's licensing stance — this module only supplies the `licenseKey: 'gpl-v3'`
// HyperFormula itself requires to acknowledge that.
const hyperFormulaConfig = { licenseKey: 'gpl-v3', useColumnIndex: false, smartRounding: false };

const errorMessages = {
  DIV_BY_ZERO: 'The formula divided by zero.',
  NAME: 'The formula references an unknown variable or function.',
  VALUE: 'The formula received a value of the wrong type.',
  NUM: 'The formula produced a number that is out of range.',
  NA: 'The formula could not find a required value.',
  CYCLE: 'The formula has a circular reference.',
  REF: 'The formula has an invalid reference.',
  SPILL: 'The formula result could not be placed.',
  LIC: 'The formula engine license is invalid.',
  ERROR: 'The formula could not be evaluated.',
};

function asExpression(formula) {
  const trimmed = String(formula).trim();
  return trimmed.startsWith('=') ? trimmed : `=${trimmed}`;
}

// variables: { [name]: number } — keys are pre-validated identifiers (letters/digits/underscore,
// see formulaVariablesInput in decision-rules.js), values are the entered numeric readings.
// Returns { value, error, errorType }: exactly one of value/error is non-null on return.
export function evaluateDecisionRuleFormula(formula, variables = {}) {
  if (typeof formula !== 'string' || !formula.trim()) {
    return { value: null, error: 'The formula is empty.', errorType: null };
  }
  const expression = asExpression(formula);
  const hf = HyperFormula.buildEmpty(hyperFormulaConfig);
  try {
    const sheetName = hf.addSheet('Formula');
    const sheetId = hf.getSheetId(sheetName);
    for (const [name, value] of Object.entries(variables)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { value: null, error: `Variable '${name}' must be a finite number.`, errorType: 'VALUE' };
      }
      if (!hf.isItPossibleToAddNamedExpression(name, value, sheetId)) {
        return { value: null, error: `'${name}' is not a valid formula variable name.`, errorType: 'NAME' };
      }
      hf.addNamedExpression(name, value, sheetId);
    }
    if (!hf.validateFormula(expression)) {
      return { value: null, error: 'The formula syntax is invalid.', errorType: null };
    }
    const result = hf.calculateFormula(expression, sheetId);
    if (typeof result === 'number') {
      if (!Number.isFinite(result)) return { value: null, error: errorMessages.NUM, errorType: 'NUM' };
      return { value: result, error: null, errorType: null };
    }
    if (result && typeof result === 'object' && 'type' in result) {
      const errorType = result.type;
      return { value: null, error: result.message || errorMessages[errorType] || errorMessages.ERROR, errorType };
    }
    // Booleans, strings, dates, arrays: not a usable Decision Rule result.
    return { value: null, error: 'The formula must produce a single number.', errorType: 'VALUE' };
  } finally {
    hf.destroy();
  }
}
