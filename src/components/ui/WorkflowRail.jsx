import React from 'react';
import cx from 'classnames';
import AppIcon from './AppIcon.jsx';
import FormElement from './FormElement.jsx';
import Modal from './Modal.jsx';
import PrimaryButton from './PrimaryButton.jsx';
import SecondaryButton from './SecondaryButton.jsx';
import './workflow-rail.scss';


function isBlankValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

function valueOrDash(value) {
  return isBlankValue(value) ? '-' : value;
}

function pickFirst(...values) {
  return values.find((value) => !isBlankValue(value));
}

function getMapValue(valuesById, id) {
  if (!valuesById || !id) return null;
  if (typeof valuesById.get === 'function') return valuesById.get(id);
  return valuesById[id] || null;
}

function getUserLabel(user) {
  if (!user) return '';
  return (
    user.profile?.name ||
    user.profile?.full_name ||
    user.profile?.email ||
    user.emails?.[0]?.address ||
    user.username ||
    user._id ||
    ''
  );
}

function getActivityDateParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { time: '-', date: '-' };
  }

  const time = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = String(date.getFullYear()).slice(-2);

  return { time, date: `${day}/${month}/${year}` };
}

function formatDisplayDateTime(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '');

  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getDaysPendingLabel(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.max(0, Math.floor((today.getTime() - start.getTime()) / 86400000));

  if (days <= 0) return '(<1 day)';
  return `(${days} ${days === 1 ? 'day' : 'days'})`;
}

function ActionDetail({ label, value }) {
  const displayValue = valueOrDash(value);

  return (
    <div>
      <dt>{label}</dt>
      <dd title={displayValue}>{displayValue}</dd>
    </div>
  );
}

export function WorkflowActionPanel({
  approvalRequest,
  canRespond = false,
  emptyActionDisabled = false,
  emptyActionIcon,
  emptyActionLabel,
  emptyMessage = 'No pending approval request.',
  submitting = false,
  usersById,
  onEmptyAction,
  onOpenDetails,
}) {
  const isOpen = Boolean(approvalRequest && ![true, 'true'].includes(approvalRequest.closed));
  const hasEmptyAction = Boolean(emptyActionLabel && onEmptyAction);
  const isActionRequired = isOpen || hasEmptyAction;
  const requesterId = approvalRequest?.requestor_id || approvalRequest?.created_by || approvalRequest?.user_id;
  const requestedBy = pickFirst(
    approvalRequest?.requestor_name,
    approvalRequest?.requestorName,
    getUserLabel(getMapValue(usersById, requesterId)),
    requesterId,
  );
  const requestedOn = formatDisplayDateTime(
    approvalRequest?.requestedOn || approvalRequest?.createdOn || approvalRequest?.created_at,
  );
  const comments = pickFirst(approvalRequest?.remarks, approvalRequest?.comments?.[0]?.message);
  const pendingAge = getDaysPendingLabel(approvalRequest?.created_at);
  const actionLabel = canRespond ? 'Take action' : 'View details';

  return (
    <section aria-label="Action required">
      <div className={cx(
        'card smplfy-card shadow-none overflow-hidden smplfy-sample-details-action',
        isActionRequired ? '' : 'is-resolved',
      )}>
        <div className="card-header d-flex align-items-center gap-3">
          <AppIcon name={isActionRequired ? 'alert-circle' : 'check'} size={24} stroke={2} />
          <span>{isActionRequired ? 'Action Required' : 'No pending actions'}</span>
          {isOpen && pendingAge ? <strong>{pendingAge}</strong> : null}
        </div>

        <div className="card-body">
          {isOpen ? (
            <>
              <dl className="mb-0">
                <ActionDetail label="Requested by" value={requestedBy} />
                <ActionDetail label="Requested on" value={requestedOn} />
                <ActionDetail label="Comments" value={comments} />
              </dl>
              {onOpenDetails ? (
                <PrimaryButton
                  className="w-100"
                  leftIcon="external-link"
                  size="default"
                  disabled={submitting}
                  onClick={onOpenDetails}
                >
                  {actionLabel}
                </PrimaryButton>
              ) : null}
            </>
          ) : (
            <>
              <p className="mb-0">{emptyMessage}</p>
              {hasEmptyAction ? (
                <PrimaryButton
                  className="w-100"
                  leftIcon={emptyActionIcon}
                  size="default"
                  disabled={emptyActionDisabled || submitting}
                  onClick={onEmptyAction}
                >
                  {emptyActionLabel}
                </PrimaryButton>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

export function WorkflowActivityRail({
  emptyMessage = 'No workflow activity recorded yet.',
  flushTop = false,
  items = [],
  onOpenDetails,
}) {
  return (
    <section className={cx('smplfy-sample-details-activity', flushTop ? 'mt-0' : '')}>
      <div className="d-flex align-items-center justify-content-between">
        <h2>Activity</h2>
        {onOpenDetails ? (
          <button type="button" className="smplfy-btn btn btn-link p-0 border-0 text-decoration-underline" onClick={onOpenDetails}>
            See all
          </button>
        ) : null}
      </div>

      {items.length ? (
        <ol className="smplfy-sample-details-timeline list-unstyled mb-0">
          {items.map((item) => {
            const dateParts = getActivityDateParts(item.date);
            return (
              <li key={item.key} className={`is-${item.tone || 'info'}`}>
                <span />
                <div>
                  <div title={[item.title, item.detail].filter(Boolean).join(' - ')}>{item.title}</div>
                  <div>
                    <span>{dateParts.time}</span>
                    <span>{dateParts.date}</span>
                    {item.user ? <span title={item.user}>{item.user}</span> : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="alert alert-secondary mb-0">{emptyMessage}</div>
      )}
    </section>
  );
}

export function WorkflowDetailsRail({
  activityItems = [],
  activityEmptyMessage,
  approvalRequest,
  ariaLabel = 'Workflow actions and activity',
  canRespond = false,
  emptyActionDisabled = false,
  emptyActionIcon,
  emptyActionLabel,
  emptyActionMessage,
  submitting = false,
  usersById,
  onEmptyAction,
  onOpenDetails,
}) {
  return (
    <aside className="smplfy-sample-details-rail" aria-label={ariaLabel}>
      <WorkflowActionPanel
        approvalRequest={approvalRequest}
        usersById={usersById}
        canRespond={canRespond}
        emptyActionDisabled={emptyActionDisabled}
        emptyActionIcon={emptyActionIcon}
        emptyActionLabel={emptyActionLabel}
        emptyMessage={emptyActionMessage}
        submitting={submitting}
        onEmptyAction={onEmptyAction}
        onOpenDetails={onOpenDetails}
      />
      <WorkflowActivityRail
        items={activityItems}
        emptyMessage={activityEmptyMessage}
        onOpenDetails={onOpenDetails}
      />
    </aside>
  );
}

export function WorkflowTransitionRequestModal({
  comments,
  currentState,
  open,
  selectedState,
  stateOptions,
  submitting = false,
  title = 'Request Approval',
  commentsRequired = false,
  children,
  onCancel,
  onCommentsChange,
  onStateChange,
  onSubmit,
}) {
  return (
    <Modal
      open={open}
      title={title}
      titleId="workflow-transition-request-title"
      titleIcon="user"
      onClose={submitting ? undefined : onCancel}
      size="md"
      actions={
        <>
          <SecondaryButton leftIcon="close" size="large" onClick={onCancel} disabled={submitting}>
            Cancel
          </SecondaryButton>
          <PrimaryButton leftIcon="send" onClick={onSubmit} disabled={submitting}>
            {submitting ? 'Sending...' : 'Send Request'}
          </PrimaryButton>
        </>
      }
    >
      <div className="d-flex flex-column gap-4">
        <div className="row g-3">
          <div className="col-12 col-md-6">
            <FormElement
              type="text"
              label="Current state"
              inputProps={{
                state: 'disabled',
                value: currentState,
              }}
            />
          </div>

          <div className="col-12 col-md-6">
            <FormElement
              type="dropdown"
              mandatory
              label="Possible States"
              inputProps={{
                value: selectedState,
                placeholder: 'Select state',
                options: stateOptions,
                disabled: submitting,
                onChange: (event) => onStateChange(event.target.value),
              }}
            />
          </div>
        </div>

        <div>
          <FormElement
            type="text"
            label="Comments"
            mandatory={commentsRequired}
            inputProps={{
              value: comments,
              placeholder: 'eg.',
              disabled: submitting,
              maxLength: 5000,
              onChange: (event) => onCommentsChange(event.target.value),
            }}
          />
        </div>
        {children}
      </div>
    </Modal>
  );
}
