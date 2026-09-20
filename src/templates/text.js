import { HttpError } from '../auth/errors.js';
import { reportContentHtml } from '../report-assets/markup.js';
import { resolveParameterTitle } from './parameter-title.js';

// Null preserves the existing literal display. Inline images require their own
// immutable history bindings before this widget can render them as markup.
export function formattedTextTitle(title) {
  if (typeof title !== 'string' || !/[<&]/.test(title)) return null;
  try {
    const { html, imageIds } = reportContentHtml(title);
    return imageIds.length ? null : html;
  } catch (error) {
    if (error instanceof HttpError) return null;
    throw error;
  }
}

export function textWidgetTitle(field, value, parameter) {
  // Source Text displays Title independently of initialized key defaults.
  // Explicit runtime title edits use entered history on an editable field.
  const title = field.editable && value?.state === 'present' && value.origin === 'entered' ? value.textValue : field.label;
  return resolveParameterTitle(title, parameter);
}

// The source title editor trims on commit and leaves blank or unchanged
// titles alone. Null means restore the previous draft without a write.
export function editedTextTitle(title, draft) {
  const next = draft.trim();
  return next && next !== title ? next : null;
}
