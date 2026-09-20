'use client';

import React, { useState } from 'react';
import cx from 'classnames';
import AppIcon from '../ui/AppIcon.jsx';
import Checkbox from '../ui/Checkbox.jsx';
import Modal from '../ui/Modal.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import './request-details-modal.scss';


const neutralStatusClassByColor = {
  gray: 'text-secondary bg-secondary-subtle border border-secondary-subtle',
  blue: 'text-primary bg-primary-subtle border border-primary-subtle',
  red: 'text-danger bg-danger-subtle border border-danger-subtle',
  orange: 'text-warning bg-warning-subtle border border-warning',
  green: 'text-success bg-success-subtle border border-success-subtle',
  yellow: 'text-warning-emphasis bg-warning-subtle border border-warning-subtle',
};

const strongStatusClassByColor = {
  gray: 'text-bg-secondary',
  blue: 'text-bg-primary',
  red: 'text-bg-danger',
  orange: 'text-bg-warning border border-warning',
  green: 'text-bg-success',
  yellow: 'text-bg-warning border border-warning-subtle',
};

function getStatusBadgeClassName(presentation) {
  const color = presentation.color ?? 'gray';
  const isStrong = presentation.styleType === 'strong' || presentation.styleType === 'solid';
  const variantClass = isStrong
    ? strongStatusClassByColor[color] ?? strongStatusClassByColor.gray
    : neutralStatusClassByColor[color] ?? neutralStatusClassByColor.gray;

  return cx('smplfy-badge', 'badge', variantClass);
}

export function StatusBadge({ presentation }) {
  return (
    <span className={getStatusBadgeClassName(presentation)}>
      {presentation.label || '-'}
    </span>
  );
}

function ApprovalRowsTable({ request }) {
  return (
    <div className="table-responsive">
      <table className="smplfy-table table table-bordered mb-0 align-middle">
        <thead>
          <tr>
            <th scope="col">Sr.</th>
            <th scope="col">Approver Name</th>
            <th scope="col">Status</th>
            <th scope="col">Days taken</th>
            <th scope="col">Decision on</th>
            <th scope="col">Comments</th>
          </tr>
        </thead>
        <tbody>
          {request.approvalRows.length > 0 ? (
            request.approvalRows.map((row) => (
              <tr key={`${request.id}-${row.sr}`}>
                <td>{row.sr}</td>
                <td>{row.approverName}</td>
                <td>{row.status}</td>
                <td>{row.daysTaken}</td>
                <td>{row.decisionOn}</td>
                <td>{row.comments}{row.checklistItems?.length ? <details className="mt-2"><summary>Checklist</summary>
                  <ul className="ps-3 mb-0">{row.checklistItems.map((item) => <li key={item.id}>{item.label}: {item.isChecked === null ? 'Not recorded' : item.isChecked ? 'Checked' : 'Not checked'}</li>)}</ul>
                </details> : null}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan="6" className="text-center text-secondary">No approver activity yet.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function ApprovalChecklist({ items, checkedItems, error, onSelectAll, onToggle, disabled = false }) {
  if (!items.length) return null;

  const allChecked = items.every((item) => checkedItems[item.id]);

  return (
    <div className="d-flex flex-column gap-2">
      <SecondaryButton
        size="small"
        leftIcon="checks"
        className="align-self-start"
        disabled={disabled || allChecked}
        aria-label="Select all checklist items"
        title="Select all"
        onClick={onSelectAll}
      />
      {items.map((item) => {
        const checked = Boolean(checkedItems[item.id]);
        const invalid = Boolean(error && item.isRequired && !checked);

        return (
          <label
            key={item.id}
            className="smplfy-request-checklist-item d-flex align-items-center gap-2"
          >
            <Checkbox
              checked={checked}
              disabled={disabled}
              invalid={invalid}
              aria-required={item.isRequired || undefined}
              onChange={(nextChecked) => onToggle(item.id, nextChecked)}
              ariaLabel={item.label}
            />
            <span>{item.label}{item.isRequired ? <span className="text-danger"> *</span> : null}</span>
          </label>
        );
      })}
      {error ? <div className="smplfy-form-feedback invalid-feedback d-block">{error}</div> : null}
    </div>
  );
}

export function RequestDetailsModal({
  request,
  relatedRequests = [],
  submitting,
  canRespond = true,
  canReject = false,
  error,
  onClose,
  onSubmit,
}) {
  const [comment, setComment] = useState('');
  const [commentError, setCommentError] = useState('');
  const [checkedChecklistItems, setCheckedChecklistItems] = useState({});
  const [checklistError, setChecklistError] = useState('');



  if (!request) {
    return null;
  }

  const sourceState = request.sourcePresentation;
  const targetState = request.targetPresentation;
  const requestsToShow = relatedRequests.length ? relatedRequests : [request];
  const checklistItems = Array.isArray(request.checklistItems) ? request.checklistItems : [];
  const isChecklistComplete = checklistItems.every((item) => !item.isRequired || checkedChecklistItems[item.id]);

  const handleChecklistToggle = (itemId, checked) => {
    setCheckedChecklistItems((current) => ({
      ...current,
      [itemId]: checked,
    }));
    if (checked) setChecklistError('');
  };

  const handleSelectAllChecklistItems = () => {
    setCheckedChecklistItems(checklistItems.reduce((nextItems, item) => {
      nextItems[item.id] = true;
      return nextItems;
    }, {}));
    setChecklistError('');
  };

  const handleAction = (action) => {
    if (!canRespond || submitting || action === 'reject' && !canReject) return;
    let hasError = false;

    if (!comment.trim()) {
      setCommentError('Please add a comment to respond.');
      hasError = true;
    } else {
      setCommentError('');
    }

    if (action === 'approve' && checklistItems.length > 0 && !isChecklistComplete) {
      setChecklistError('Complete all required checks before approving this request.');
      hasError = true;
    } else {
      setChecklistError('');
    }

    if (hasError) return;

    onSubmit(action, comment, checklistItems.filter((item) => checkedChecklistItems[item.id]).map((item) => item.id));
  };

  return (
    <Modal
      open={Boolean(request)}
      title={request.title}
      titleId="request-details-title"
      size="xl"
      onClose={submitting ? undefined : onClose}
      cardClassName="smplfy-request-modal"
      bodyClassName="p-0 d-flex overflow-hidden"
      titleExtra={
        <div className="smplfy-state-transition">
          <StatusBadge presentation={sourceState} />
          <AppIcon name="arrow-right" />
          <StatusBadge presentation={targetState} />
        </div>
      }
    >
      <section className={cx(
        'd-flex flex-column flex-grow-1 overflow-hidden',
        canRespond ? 'border-end' : '',
      )}>
        {error ? <div className="alert alert-danger m-3" role="alert">{error}</div> : null}
        <dl className="m-0 d-flex flex-column gap-3 border-bottom flex-shrink-0">
          <div className="row g-0 align-items-center">
            <dt className="col-auto mb-0">Request by</dt>
            <dd className="col mb-0">{request.requestedByName}</dd>
          </div>
          <div className="row g-0 align-items-center">
            <dt className="col-auto mb-0">Requested on</dt>
            <dd className="col mb-0">{request.requestedOn}</dd>
          </div>
          <div className="row g-0 align-items-center">
            <dt className="col-auto mb-0">Comment</dt>
            <dd className="col mb-0">{request.comments}</dd>
          </div>
        </dl>

        <div className="flex-grow-1 overflow-auto">
          {requestsToShow.map((row, index) => (
            <div
              key={row.id}
              className={cx(
                'smplfy-request-modal-request-block',
                row.id === request.id ? 'is-current' : '',
              )}
            >
              <div className="d-flex align-items-center gap-3 flex-wrap pb-3">
                <div className="smplfy-nav-link nav-link active">
                  {requestsToShow.length > 1 ? `Approver details ${index + 1}` : 'Approver details'}
                </div>
                <div className="fw-medium">{row.approverProgress}</div>
                <div className="smplfy-state-transition ms-auto">
                  <StatusBadge presentation={row.sourcePresentation} />
                  <AppIcon name="arrow-right" />
                  <StatusBadge presentation={row.targetPresentation} />
                </div>
              </div>

              {requestsToShow.length > 1 ? (
                <div className="smplfy-request-modal-request-meta">
                  <span>Requested by {row.requestedByName}</span>
                  <span>{row.requestedOn}</span>
                  <span>{row.comments}</span>
                </div>
              ) : null}

              <ApprovalRowsTable request={row} />
            </div>
          ))}
        </div>
      </section>

      {canRespond ? (
        <aside className="d-flex flex-column justify-content-between flex-shrink-0 overflow-hidden">
          <div className="d-flex flex-column gap-4">
            <div className="d-flex flex-column gap-2">
              <label className="smplfy-form-label form-label mb-0" htmlFor="request-comment">
                Comment <span className="text-danger" aria-hidden="true">*</span>
              </label>
              <input
                id="request-comment"
                aria-required="true"
                aria-invalid={commentError ? 'true' : undefined}
                aria-describedby={commentError ? 'request-comment-error' : undefined}
                className={cx('smplfy-form-control', 'form-control', commentError ? 'is-invalid' : '')}
                value={comment}
                disabled={submitting}
                maxLength={5000}
                placeholder="Add a comment to respond"
                onChange={(event) => {
                  setComment(event.target.value);
                  if (event.target.value.trim()) setCommentError('');
                }}
                autoFocus
              />
              {commentError ? <div id="request-comment-error" className="smplfy-form-feedback invalid-feedback d-block">{commentError}</div> : null}
            </div>

            <ApprovalChecklist
              items={checklistItems}
              checkedItems={checkedChecklistItems}
              error={checklistError}
              onSelectAll={handleSelectAllChecklistItems}
              onToggle={handleChecklistToggle}
              disabled={submitting}
            />
          </div>
          <div className="modal-footer border-top d-flex align-items-center justify-content-between">
            {canReject ? <PrimaryButton
              styleVariant="destructive"
              size="large"
              disabled={submitting}
              onClick={() => handleAction('reject')}
              leftIcon="close"
            >
              Reject
            </PrimaryButton> : null}
            <PrimaryButton
              styleVariant="positive"
              size="large"
              disabled={submitting}
              onClick={() => handleAction('approve')}
              leftIcon="check"
            >
              {request.positiveActionLabel}
            </PrimaryButton>
          </div>
        </aside>
      ) : null}
    </Modal>
  );
}

export default RequestDetailsModal;
