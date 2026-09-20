// Derived HTTP models only. Relational records remain the sole persisted definition.
// The version supplies tenant/version context; nullable columns and duplicate node encodings
// need not be repeated in every browser record.
function scopedRecord(record) {
  return Object.fromEntries(Object.entries(record).filter(([key, value]) => key !== 'organizationId' && key !== 'versionId' && value !== null));
}

export function templateView(model) {
  const map = (records, transform = scopedRecord) => Object.fromEntries(Object.entries(records).map(([id, record]) => [id, transform(record)]));
  return { ...model,
    sectionsById: map(model.sectionsById), rowsById: map(model.rowsById), columnsById: map(model.columnsById), groupsById: map(model.groupsById),
    fieldsById: map(model.fieldsById, (field) => ({ ...scopedRecord(field), numeric: field.numeric ? scopedRecord(field.numeric) : null,
      ...(field.image ? { image: scopedRecord(field.image) } : {}), options: field.options.map(scopedRecord) })),
    // compiled is already a plain, JSON-serializable structure (formula text, tokens and resolved
    // field references) — HyperFormula reconstructs the actual evaluation from it, not a tree.
    expressions: map(model.expressions, (expression) => ({ id: expression.id, fieldId: expression.fieldId, purpose: expression.purpose, compiled: expression.compiled })),
  };
}

export function captureView(capture) {
  const { pinnedValues: _pinnedValues, ...runtime } = capture;
  return { ...runtime, values: capture.values.map((value) => Object.fromEntries(Object.entries(value).filter(([, payload]) => payload !== null))) };
}
