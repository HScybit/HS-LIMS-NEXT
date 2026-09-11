import { valueKey, valuePayload } from '../templates/calculations.js';

const keyFor = (input) => valueKey(input.fieldId, input.occurrenceId);
const matches = (left, right) => left?.state === right.state && (left?.value ?? null) === (right.value ?? null);
const asInput = (value) => ({ fieldId: value.fieldId, occurrenceId: value.occurrenceId, state: value.state,
  ...(value.state === 'present' ? { value: valuePayload(value) } : {}) });

// Preserve the source blur/change save boundary and serialize revisioned writes.
// Unlike the source queue, flush retains earlier failures even if another field saves.
export function createCaptureAutosave(saveValues, onSaved = () => {}) {
  let current;
  function reset(instanceId, revision, values) {
    if (!instanceId || !Number.isSafeInteger(revision) || revision < 1) throw new Error('The datasheet is not ready to save.');
    current = { instanceId, revision, sequence: 0, persisted: new Map(values.map((value) => [keyFor(value), asInput(value)])),
      pending: new Map(), failures: new Map(), queue: Promise.resolve() };
  }
  function commit(value) {
    const target = current;
    if (!target) return Promise.reject(new Error('The datasheet is not ready to save.'));
    const input = { ...value };
    const key = keyFor(input);
    const sequence = ++target.sequence;
    target.pending.set(key, { input, sequence });
    const saved = target.queue.then(async () => {
      if (matches(target.persisted.get(key), input)) {
        target.failures.delete(key);
        if (target.pending.get(key)?.sequence === sequence) target.pending.delete(key);
        return false;
      }
      let result;
      try {
        result = await saveValues(target.instanceId, { revision: target.revision, values: [input] });
      } catch (error) {
        target.failures.set(key, error);
        throw error;
      }
      target.revision = result.revision;
      for (const value of result.values) target.persisted.set(keyFor(value), asInput(value));
      target.failures.delete(key);
      if (target.pending.get(key)?.sequence === sequence) target.pending.delete(key);
      if (current === target) onSaved(result, [...target.pending.values()].map(({ input }) => input));
      return result;
    });
    target.queue = saved.catch(() => undefined);
    return saved;
  }
  async function flush() {
    const target = current;
    if (!target) return;
    let queue;
    do { queue = target.queue; await queue; } while (queue !== target.queue);
    if (target.failures.size) throw target.failures.values().next().value;
  }
  async function retry() {
    const target = current;
    if (!target) return;
    await target.queue;
    if (current !== target) return;
    const inputs = [...target.pending.values()].map(({ input }) => input);
    await Promise.allSettled(inputs.map(commit));
    await flush();
  }
  function snapshot() {
    return current ? { instanceId: current.instanceId, revision: current.revision,
      pending: [...current.pending.values()].map(({ input }) => ({ ...input })) } : null;
  }
  return { reset, commit, flush, retry, snapshot };
}
