'use client';

import PrimaryButton from '@/components/ui/PrimaryButton.jsx';

export default function ErrorPage({ reset }) {
  return <div className="auth-layout"><div className="auth-layout__content"><div className="auth-layout__panel"><div className="auth-layout__card"><div className="auth-layout__card-body">
    <h1 className="auth-layout__heading">Unable to load this page</h1>
    <p className="auth-layout__subheading mb-4">The request could not be completed. Please try again.</p>
    <PrimaryButton onClick={reset}>Try again</PrimaryButton>
  </div></div></div></div></div>;
}
