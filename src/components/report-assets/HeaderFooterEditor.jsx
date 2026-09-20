import React, { useCallback } from "react";
import RichTextEditor from './RichTextEditor.jsx';
import "./template-builder.scss";

export default function HeaderFooterEditor({
  draft,
  editorRef,
  entityLabel,
  editorPlaceholder,
  isHeader = false,
  onDraftChange,
  disabled = false,
  onPendingChange,
}) {
  const updateDraft = useCallback(
    (patch) => {
      onDraftChange?.((current) => ({
        ...current,
        ...patch,
      }));
    },
    [onDraftChange],
  );

  return (
    <div className="template-builder-shell template-builder-shell--header-footer">
      <section className="template-builder-panel template-builder-settings-panel" aria-label={`${entityLabel} template settings`}>
        <div className="template-builder-panel__header">
          <h3>Settings</h3>
        </div>

        <div className="template-builder-settings-grid">
          <label className="template-builder-field">
            <span>Name</span>
            <input
              type="text"
              className="form-control"
              value={draft.name}
              disabled={disabled}
              maxLength={200}
              autoFocus
              onChange={(event) => updateDraft({ name: event.currentTarget.value })}
            />
          </label>

          {isHeader ? (
            <label className="template-builder-toggle">
              <input
                type="checkbox"
                checked={draft.is_default_header}
                disabled={disabled}
                onChange={(event) => updateDraft({ is_default_header: event.currentTarget.checked })}
              />
              <span>
                <strong>Default header</strong>
                <small>Use this when a report does not choose a specific header.</small>
              </span>
            </label>
          ) : null}
        </div>
      </section>

      <div className="template-builder-shell__main">
        <div className="template-builder-section-heading">
          <div>
            <h3>{entityLabel} Content</h3>
            <p>Design the printable area using the same HTML that existing templates store today.</p>
          </div>
        </div>

        <RichTextEditor
          ref={editorRef}
          value={draft.template_code}
          disabled={disabled}
          onPendingChange={onPendingChange}
          placeholder={editorPlaceholder}
          minHeight={560}
          variant="document"
          onChange={(html) => updateDraft({ template_code: html })}
        />
      </div>
    </div>
  );
}
