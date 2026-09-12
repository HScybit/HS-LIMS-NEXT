'use client';

import { useId } from 'react';
import SearchableSelect from '../ui/SearchableSelect.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';

function InlineSelect({ label, placeholder, value, onChange, options, error, disabled }) {
  const id = useId();
  return <div className="d-flex flex-column gap-1"><div className="d-flex align-items-center gap-2">
    <label htmlFor={id} className="form-label mb-0 text-secondary fw-medium text-nowrap">{label}:</label>
    <SearchableSelect inputId={id} value={value} onChange={onChange} options={options} placeholder={placeholder}
      clearable invalid={Boolean(error)} disabled={disabled} aria-describedby={error ? `${id}-error` : undefined} className="min-w-0" />
  </div>{error ? <div id={`${id}-error`} className="invalid-feedback d-block mb-0">{error}</div> : null}</div>;
}

// Structure and controls from Meteor TestRequestsListingParts.RequestsCardSelection.
export default function JobSelectionControls({ users, assignee, reviewer, reviewerRequired, onAssigneeChange, onReviewerChange,
  assigneeError, reviewerError, busy, onCancel, onSubmit }) {
  const options = users.map((user) => ({ value: user.id, label: user.name }));
  return <div className="d-flex align-items-center justify-content-between gap-3 border-bottom">
    <div className="d-flex align-items-center gap-3 flex-wrap">
      <InlineSelect label="Assignee" placeholder="Select assignee" value={assignee} onChange={onAssigneeChange}
        options={options} error={assigneeError} disabled={busy} />
      {reviewerRequired ? <InlineSelect label="Reviewer" placeholder="Select reviewer" value={reviewer} onChange={onReviewerChange}
        options={options} error={reviewerError} disabled={busy} /> : null}
    </div>
    <div className="d-flex align-items-center gap-2 flex-wrap">
      <SecondaryButton leftIcon="close" size="large" onClick={onCancel} disabled={busy}>Cancel</SecondaryButton>
      <PrimaryButton leftIcon="plus" onClick={onSubmit} disabled={busy}>{busy ? 'Creating Job...' : 'Create Job'}</PrimaryButton>
    </div>
  </div>;
}
