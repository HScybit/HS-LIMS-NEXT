'use client';

import { useEffect, useRef, useState } from 'react';
import Modal from '../ui/Modal.jsx';
import FormElement from '../ui/FormElement.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import StatusPill from '../ui/StatusPill.jsx';
import AppIcon from '../ui/AppIcon.jsx';

// Source: Meteor TestRequestShow method selector and dialogs.
export function AddMethodModal({
  open,
  requestId,
  draftValue,
  methodOptions,
  error,
  busy = false,
  disabled = false,
  onDraftChange,
  onCancel,
  onSubmit,
}) {
  if (!open) {
    return null;
  }

  return (
    <Modal
      open={open}
      title="Add Method"
      titleId="add-method-modal-title"
      titleIcon="plus"
      onClose={onCancel}
      size="md"
      bodyClassName="add-method-modal__body"
      actionsClassName="add-method-modal__actions"
      actions={(
        <>
          <SecondaryButton leftIcon="close" size="large" className="add-method-modal__cancel" onClick={onCancel} disabled={busy}>
            Cancel
          </SecondaryButton>
          <PrimaryButton type="submit" form="add-method-form" leftIcon="plus" disabled={busy || disabled || !draftValue}>
            Add
          </PrimaryButton>
        </>
      )}
    >
      <form
        id="add-method-form"
        className="add-method-modal__form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="add-method-modal__request-id">
          <span className="add-method-modal__request-id-label">Test Request ID:</span>
          <span className="add-method-modal__request-id-value">{requestId}</span>
        </div>

        <FormElement
          type="dropdown"
          mandatory
          label="Method"
          message={error}
          messageTone="error"
          inputProps={{
            value: draftValue,
            placeholder: methodOptions.length ? 'Select New Method' : 'No methods available',
            options: methodOptions,
            state: methodOptions.length && !busy ? 'default' : 'disabled',
            onChange: (event) => onDraftChange(event.target.value),
          }}
        />
      </form>
    </Modal>
  );
}

function getMethodSwitcherLabel(method) {
  if (!method) return 'Select method';
  return [method.label, method.methodName].filter(Boolean).join(': ');
}

export function MethodSwitcher({ methods, selectedMethodId, canDeleteMethod = false, onSelectMethod, onDeleteMethod }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const selectedMethod = methods.find((method) => method.id === selectedMethodId) || methods[0] || null;

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handlePointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  return (
    <div className="smplfy-tr-details-method-switcher">
      <label className="form-label mb-0" htmlFor="tr-method-selector">
        Select method:
      </label>

      <div ref={rootRef} className={`smplfy-dropdown dropdown${open ? ' show' : ''}`}>
        <button
          id="tr-method-selector"
          type="button"
          className={`smplfy-btn btn dropdown-toggle w-100 d-flex align-items-center justify-content-between${open ? ' show' : ''}`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="text-truncate">{getMethodSwitcherLabel(selectedMethod)}</span>
          <span className="d-inline-flex align-items-center gap-2 flex-shrink-0">
            {selectedMethod?.hasNabl ? (
              <StatusPill color="green" styleType="neutral" className="smplfy-tr-details-method-nabl">
                NABL
              </StatusPill>
            ) : null}
            <AppIcon name="chevron-down" />
          </span>
        </button>

        {open ? (
          <div className="smplfy-dropdown-menu dropdown-menu show w-100" role="menu" aria-label="Select method">
            {methods.map((method) => (
              <button
                key={method.id}
                type="button"
                role="menuitemradio"
                aria-checked={method.id === selectedMethod?.id}
                className={`smplfy-dropdown-item dropdown-item d-flex align-items-center gap-2${method.id === selectedMethod?.id ? ' active' : ''}`}
                onClick={() => {
                  setOpen(false);
                  onSelectMethod(method.id);
                }}
              >
                <span className="text-truncate">{getMethodSwitcherLabel(method)}</span>
                {method.hasNabl ? (
                  <StatusPill color="green" styleType="neutral" className="smplfy-tr-details-method-nabl ms-auto flex-shrink-0">
                    NABL
                  </StatusPill>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {canDeleteMethod ? (
        <SecondaryButton
          tone="danger"
          leftIcon="trash"
          className="smplfy-tr-details-delete-method-btn flex-shrink-0 px-0"
          aria-label="Delete method"
          onClick={onDeleteMethod}
        />
      ) : null}
    </div>
  );
}

export function DeleteMethodModal({ open, method, deleting = false, disabled = false, error, onCancel, onSubmit }) {
  if (!open || !method) {
    return null;
  }

  return (
    <Modal
      open={open}
      title="Delete method"
      titleId="delete-method-modal-title"
      titleIcon="trash"
      onClose={onCancel}
      size="md"
      cardClassName="smplfy-delete-method-modal"
      actionsClassName="justify-content-between"
      actions={(
        <>
          <SecondaryButton leftIcon="close" size="large" onClick={onCancel} disabled={deleting}>
            Cancel
          </SecondaryButton>
          <PrimaryButton leftIcon="trash" styleVariant="destructive" onClick={onSubmit} disabled={deleting || disabled}>
            {deleting ? 'Deleting...' : 'Delete'}
          </PrimaryButton>
        </>
      )}
    >
      <div className="d-grid gap-3">
        {error ? <div className="alert alert-danger mb-0" role="alert">{error}</div> : null}
        <div>
          <p className="mb-2">Are you sure you want to delete this method?</p>
          <p className="text-secondary mb-0">
            This method will be removed from the test request. Its datasheet history will be retained.
          </p>
        </div>

        <div className="smplfy-tr-delete-method-details border rounded-3 p-3 d-flex align-items-center justify-content-between gap-3">
          <span className="text-truncate">{getMethodSwitcherLabel(method)}</span>
          {method.hasNabl ? (
            <StatusPill color="green" styleType="neutral" className="smplfy-tr-details-method-nabl flex-shrink-0">
              NABL
            </StatusPill>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
