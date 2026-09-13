export function textWidgetTitle(field, value) {
  // Source Text displays Title independently of initialized key defaults.
  // Explicit runtime title edits use entered history on an editable field.
  return field.editable && value?.state === 'present' && value.origin === 'entered' ? value.textValue : field.label;
}

// The source title editor trims on commit and leaves blank or unchanged
// titles alone. Null means restore the previous draft without a write.
export function editedTextTitle(title, draft) {
  const next = draft.trim();
  return next && next !== title ? next : null;
}
