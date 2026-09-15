import { HttpError } from '../auth/errors.js';
import { fieldsOnly, integer, uuid } from '../templates/input.js';

export const lookupSourceLineLimit = 10000;
export const lookupSourceByteLimit = 8 * 1024 * 1024;

function exactText(value, label, maximum, required = false) {
  if (typeof value !== 'string' || value.length > maximum || !value.isWellFormed() || value.includes('\0') || required && !value.trim()) {
    throw new HttpError(400, 'invalid_lookup_source', `${label} must be valid text${required ? ' with a value' : ''} of at most ${maximum} characters.`);
  }
  return value;
}

export function lookupSourceInput(input) {
  fieldsOnly(input, ['id', 'revision', 'requestId', 'sourceId', 'name', 'lines']);
  const result = { id: uuid(input.id, 'Lookup source').toLowerCase(), requestId: uuid(input.requestId, 'Observation request').toLowerCase(),
    revision: integer(input.revision, 'Revision', 0, 2_147_483_646), sourceId: exactText(input.sourceId, 'Original source identifier', 200, true),
    name: exactText(input.name, 'Source name', 16000) };
  if (!Array.isArray(input.lines) || input.lines.length > lookupSourceLineLimit) {
    throw new HttpError(400, 'invalid_lookup_source', `Provide at most ${lookupSourceLineLimit} observed lookup lines.`);
  }
  const ids = new Set();
  result.lines = Array.from(input.lines, line => {
    fieldsOnly(line, ['id', 'label']);
    const id = exactText(line.id, 'Original line identifier', 200, true);
    if (ids.has(id)) throw new HttpError(400, 'invalid_lookup_source', 'Each original line identifier must occur once in an observation.');
    ids.add(id);
    if (typeof line.label === 'string') exactText(line.label, 'Observed label', 16000);
    else if (typeof line.label !== 'boolean' && (typeof line.label !== 'number' || !Number.isFinite(line.label))) {
      throw new HttpError(400, 'invalid_lookup_source', 'An observed lookup label must be text, a finite number or a boolean.');
    }
    return { id, label: Object.is(line.label, -0) ? 0 : line.label };
  });
  if (Buffer.byteLength(JSON.stringify(result)) > lookupSourceByteLimit) {
    throw new HttpError(413, 'lookup_source_too_large', 'The lookup observation exceeds 8 MiB.');
  }
  return result;
}
