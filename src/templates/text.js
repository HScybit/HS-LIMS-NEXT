export function textWidgetTitle(field, value) {
  return value?.state === 'present' ? value.textValue : field.label;
}

// The source title editor trims on commit and leaves blank or unchanged
// titles alone. Null means restore the previous draft without a write.
export function editedTextTitle(title, draft) {
  const next = draft.trim();
  return next && next !== title ? next : null;
}
