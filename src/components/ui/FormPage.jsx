'use client';

import PageHeader from '../layout/PageHeader.jsx';
import PrimaryButton from './PrimaryButton.jsx';
import SecondaryButton from './SecondaryButton.jsx';
import AppIcon from './AppIcon.jsx';

/**
 * The shell every authoring form is laid out in: the title and Save button live
 * in the page header, the fields sit in one bordered card of a fixed width, and
 * related fields are grouped under a heading in a twelve-column grid.
 */
export default function FormPage({
  title, backTo, backLabel = 'Back', formId, onSubmit, saving = false, disabled = false,
  submitLabel = 'Save', savingLabel = 'Saving...', error = null, actions = null, children, footer = null,
}) {
  return <>
    <PageHeader><div className="page-header"><div className="container-fluid h-100"><div className="row h-100 align-items-center justify-content-between page-header__row">
      <div className="col page-header__start d-flex align-items-center gap-2">
        {backTo ? <SecondaryButton className="smplfy-form-back" href={backTo} aria-label={backLabel}><AppIcon name="chevron-left" /></SecondaryButton> : null}
        <h1 className="page-title mb-0">{title}</h1>
      </div>
      <div className="col-auto page-header__actions d-flex gap-2">
        {actions}
        <PrimaryButton type="submit" form={formId} leftIcon="fa-floppy-disk" disabled={disabled || saving}>
          {saving ? savingLabel : submitLabel}
        </PrimaryButton>
      </div>
    </div></div></div></PageHeader>
    <main className="container-fluid px-0 p-4">
      <form id={formId} className="smplfy-form-page" onSubmit={onSubmit} noValidate>
        <section className="smplfy-form-card">
          {children}
          {error ? <div className="alert alert-danger mt-4 mb-0" role="alert">{error}</div> : null}
        </section>
      </form>
      {footer}
    </main>
  </>;
}

/** A group of related fields under its own heading. */
export function FormSection({ title, children, last = false }) {
  return <>
    {title ? <div className="smplfy-form-heading">{title}</div> : null}
    <div className={`row g-3${last ? '' : ' mb-4'}`}>{children}</div>
  </>;
}

/** One field's cell in the grid. Half width by default, as most fields pair. */
export function FormField({ span = 6, children }) {
  return <div className={span >= 12 ? 'col-12' : `col-md-${span}`}>{children}</div>;
}
