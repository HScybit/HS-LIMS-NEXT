import { createHash } from 'node:crypto';
import { HttpError } from '../auth/errors.js';
import { fieldsOnly, uuid, revision } from '../templates/input.js';

export const workflowCommandMaxBytes = 4 * 1024 * 1024;
export const workflowEditorOperations = Object.freeze(['create_state', 'patch_state', 'delete_state', 'create_transition', 'patch_transition', 'delete_transition', 'publish', 'save_flow']);

const invalid = () => new HttpError(400, 'invalid_workflow_command', 'The workflow command is invalid.');

function canonicalValue(input) {
  const active = new Set(); let nodes = 0;
  function visit(value, depth) {
    if (++nodes > 100_000 || depth > 16) throw invalid();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') { if (!Number.isFinite(value)) throw invalid(); return value; }
    if (typeof value === 'string') {
      if (!value.isWellFormed() || value.includes('\0')) throw invalid();
      return value;
    }
    if (!value || typeof value !== 'object' || active.has(value)) throw invalid();
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
    active.add(value);
    const result = Array.isArray(value) ? Array.from(value, (item) => visit(item, depth + 1))
      : Object.fromEntries(Object.keys(value).sort().map((key) => {
        if (!key.isWellFormed() || key.includes('\0')) throw invalid();
        return [key, visit(value[key], depth + 1)];
      }));
    active.delete(value); return result;
  }
  return visit(input, 0);
}

export function workflowEditorCommandInput(workflowId, input) {
  fieldsOnly(input, ['requestId', 'versionId', 'revision', 'operation', 'elementId', 'input']);
  if (['requestId', 'versionId', 'revision', 'operation'].some((key) => !Object.hasOwn(input, key))) throw invalid();
  if (!workflowEditorOperations.includes(input.operation)) throw invalid();
  const elementRequired = input.operation.startsWith('patch_') || input.operation.startsWith('delete_');
  const hasInput = !input.operation.startsWith('delete_');
  if (Object.hasOwn(input, 'elementId') !== elementRequired || Object.hasOwn(input, 'input') !== hasInput) throw invalid();
  if (hasInput && (!input.input || typeof input.input !== 'object' || Array.isArray(input.input))) throw invalid();
  const command = canonicalValue({ workflowId: uuid(workflowId, 'Workflow').toLowerCase(),
    requestId: uuid(input.requestId, 'Save request').toLowerCase(), versionId: uuid(input.versionId, 'Workflow version').toLowerCase(),
    revision: revision(input.revision), operation: input.operation,
    ...(elementRequired ? { elementId: uuid(input.elementId, 'Workflow element').toLowerCase() } : {}),
    ...(hasInput ? { input: input.input } : {}) });
  const serialized = JSON.stringify(command);
  if (Buffer.byteLength(serialized) > workflowCommandMaxBytes) throw new HttpError(413, 'input_too_large', 'The workflow command is too large.');
  return { ...command, fingerprint: createHash('sha256').update(serialized).digest() };
}
