'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import Modal from '../ui/Modal.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import { Skeleton } from '../ui/Skeleton.jsx';
import { showToast } from '../ui/toast.jsx';
import { apiRequest } from '../../lib/api-client.js';

const formatCount = (value) => new Intl.NumberFormat().format(Number(value) || 0);
const formatWhen = (value) => (value ? new Date(value).toLocaleString() : '—');

function DomainGroup({ group, domains }) {
  return <div className="seed-domain-group">
    <div className="seed-domain-group__head">
      <div className="seed-domain-group__title">{group.label}</div>
      <div className="seed-domain-group__hint">{group.description}</div>
    </div>
    <div className="seed-domain-group__items">
      {domains.map((domain) => <div className="seed-domain seed-domain--static" key={domain.key}>
        <AppIcon name="check" className="seed-domain__tick" aria-hidden />
        <span className="seed-domain__body">
          <span className="seed-domain__label">{domain.label}</span>
          <span className="seed-domain__meta">{domain.owns.join(', ')}</span>
          {domain.note ? <span className="seed-domain__note">{domain.note}</span> : null}
        </span>
      </div>)}
    </div>
  </div>;
}

function IndustryGroup({ industries, selected, onToggle, disabled }) {
  return <div className="seed-domain-group seed-domain-group--industry">
    <div className="seed-domain-group__head">
      <div className="seed-domain-group__title">Laboratory Industry</div>
      <div className="seed-domain-group__hint">
        Decides the products, parameters, methods, instruments and acceptance limits that are generated.
        Select every industry this laboratory tests for.
      </div>
    </div>
    <div className="seed-domain-group__items seed-domain-group__items--inline">
      {industries.map((industry) => <label className="seed-domain" key={industry.key}>
        <input type="checkbox" className="smplfy-checkbox smplfy-form-check-input form-check-input seed-domain__check"
          checked={selected.includes(industry.key)} disabled={disabled}
          onChange={() => onToggle(industry.key)} aria-label={industry.label} />
        <span className="seed-domain__body">
          <span className="seed-domain__label">{industry.label}</span>
          <span className="seed-domain__meta">{industry.description}</span>
          <span className="seed-domain__note">
            {formatCount(industry.estimatedCounts.products)} products · {formatCount(industry.estimatedCounts.testParameters)} parameters
            · {formatCount(industry.estimatedCounts.instruments)} instruments · {formatCount(industry.estimatedCounts.samples)} samples
          </span>
        </span>
      </label>)}
    </div>
  </div>;
}

function PlanSummary({ plan, selected }) {
  const names = selected.map((key) => plan.industries.find((industry) => industry.key === key)?.label ?? key);
  const totals = selected.reduce((running, key) => {
    const counts = plan.industries.find((industry) => industry.key === key)?.estimatedCounts ?? {};
    for (const [field, value] of Object.entries(counts)) running[field] = (running[field] ?? 0) + value;
    return running;
  }, {});
  return <div className="seed-plan">
    <div className="seed-plan__row">
      <span className="seed-plan__label">Industries</span>
      <span className="seed-plan__value">{names.length ? names.join(', ') : 'None selected'}</span>
    </div>
    <div className="seed-plan__row">
      <span className="seed-plan__label">Will generate</span>
      <span className="seed-plan__value">
        {formatCount(totals.products)} products, {formatCount(totals.testParameters)} test parameters, {formatCount(totals.methods)} methods,
        {' '}{formatCount(totals.instruments)} instruments, {formatCount(totals.decisionRules)} decision rules and {formatCount(totals.samples)} samples
      </span>
    </div>
    <div className="seed-plan__row">
      <span className="seed-plan__label">Generation order</span>
      <span className="seed-plan__value">{plan.generationOrder.map((domain) => domain.label).join(' → ')}</span>
    </div>
    <div className="seed-plan__row">
      <span className="seed-plan__label">Existing data in this organization</span>
      <span className="seed-plan__value">
        {formatCount(plan.existingData.samples)} samples, {formatCount(plan.existingData.products)} products,
        {' '}{formatCount(plan.existingData.testParameters)} test parameters, {formatCount(plan.existingData.instruments)} instruments,
        {' '}{formatCount(plan.existingData.members)} users
      </span>
    </div>
  </div>;
}

function SeedProgress({ progress }) {
  const percent = Math.max(0, Math.min(100, progress?.percent ?? 0));
  const completed = progress?.completedSteps ?? 0;
  const total = progress?.totalSteps ?? 0;
  const stage = progress?.currentDomain
    ?? (progress?.status === 'pending' ? 'Starting' : 'Finishing');
  return (
    <div className="seed-progress" role="status" aria-live="polite">
      <div className="seed-progress__head">
        <span className="seed-progress__stage">{stage}…</span>
        <span className="seed-progress__percent">{percent}%</span>
      </div>
      <div className="seed-progress__track" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}
        aria-label="Seeding progress">
        <div className="seed-progress__bar" style={{ width: `${percent}%` }} />
      </div>
      <div className="seed-progress__count">
        {total ? `${completed} of ${total} steps complete` : 'Preparing the organization'}
      </div>
    </div>
  );
}

function SeedResult({ result, onClose }) {
  return <div className="seed-result">
    <p className="seed-result__lead">
      Seeded {result.industries.join(', ')} in {result.mode === 'reseed' ? 'rebuild' : 'first-run'} mode —
      {' '}{result.steps.length} steps completed, {formatCount(result.samples)} samples and {formatCount(result.testRequests)} test requests created.
    </p>
    {result.incomplete?.length ? <div className="alert alert-warning mb-0" role="alert">
      {result.incomplete.length} scenario{result.incomplete.length === 1 ? '' : 's'} registered without test requests:
      {' '}{result.incomplete.map((entry) => entry.scenario).join(', ')}.
    </div> : null}
    {result.credentials?.length ? <div className="seed-result__block">
      <div className="seed-result__block-title">One-time demonstration credentials</div>
      <p className="seed-result__hint">Save these now. Each user must change the temporary password after signing in.</p>
      <div className="seed-credentials table-responsive">
        <table className="smplfy-table table table-hover align-middle mb-0">
          <thead><tr><th>User</th><th>Username</th><th>Email</th><th>Temporary password</th></tr></thead>
          <tbody>{result.credentials.map((credential) => <tr key={credential.username}>
            <td>{credential.displayName}</td><td><code>{credential.username}</code></td>
            <td>{credential.email}</td><td><code>{credential.password}</code></td>
          </tr>)}</tbody>
        </table>
      </div>
    </div> : <p className="seed-result__hint">No new user credentials were generated by this run.</p>}
    <div className="seed-master-data__actions"><SecondaryButton onClick={onClose}>Seed again</SecondaryButton></div>
  </div>;
}

export default function OrganizationSeedPanel({ organizationId }) {
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);

  const loadPlan = useCallback(async (signal) => {
    try {
      const loaded = await apiRequest(`/api/administration/organizations/${organizationId}/seed-plan`, { signal });
      if (signal?.aborted) return;
      setPlan(loaded);
      setSelected((current) => (current.length ? current : [...loaded.defaultIndustries]));
      setError('');
    } catch (failure) { if (!signal?.aborted) setError(failure.message); }
  }, [organizationId]);

  useEffect(() => {
    const controller = new AbortController();
    // The plan is fetched, not derived: the state it sets lands after the
    // request resolves, and the abort signal discards a stale response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadPlan(controller.signal);
    return () => controller.abort();
  }, [loadPlan]);

  const groupedDomains = useMemo(() => Object.fromEntries(
    (plan?.domainGroups ?? []).map((group) => [group.key, plan.generationOrder.filter((domain) => domain.group === group.key)]),
  ), [plan]);

  function toggleIndustry(key) {
    setSelected((current) => (current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]));
  }

  async function run() {
    if (running) return;
    // The run identifier is chosen here so its progress can be followed from
    // the moment the request is sent, rather than only once it comes back.
    const runId = crypto.randomUUID();
    setRunning(true); setError('');
    setProgress({ percent: 0, completedSteps: 0, totalSteps: plan.generationOrder.length, currentDomain: null, status: 'pending' });
    let watching = true;
    const follow = async () => {
      while (watching) {
        await new Promise((resolve) => { window.setTimeout(resolve, 1000); });
        if (!watching) return;
        try {
          const seen = await apiRequest(`/api/administration/organizations/${organizationId}/seed-runs/${runId}`);
          if (watching) setProgress(seen);
        } catch { /* A poll that misses is retried on the next tick. */ }
      }
    };
    follow();
    try {
      const body = { runId, industries: selected, ...(plan.hasExistingData ? { confirmation } : {}) };
      const outcome = await apiRequest(`/api/administration/organizations/${organizationId}/seed-runs`, { method: 'POST', body });
      setConfirmOpen(false); setConfirmation(''); setResult(outcome);
      showToast('Seeding complete.');
      await loadPlan();
    } catch (failure) { setError(failure.message); }
    finally { watching = false; setRunning(false); setProgress(null); }
  }

  if (!plan && !error) return <section className="seed-master-data" role="status" aria-label="Loading seed plan"><Skeleton width="100%" height={72} /></section>;
  if (result) return <SeedResult result={result} onClose={() => setResult(null)} />;

  return <section className="seed-master-data">
    {error ? <div className="alert alert-danger mb-0" role="alert">{error}</div> : null}
    {plan ? <>
      <div className="seed-master-data__intro">
        <p>{plan.behavior}</p>
        {plan.lastRun ? <p className="seed-master-data__last-run">
          Last run: {formatWhen(plan.lastRun.startedAt)} — {plan.lastRun.status} ({plan.lastRun.mode})
          {plan.lastRun.failureMessage ? <span className="d-block text-danger small">{plan.lastRun.failureMessage}</span> : null}
        </p> : <p className="seed-master-data__last-run">This organization has not been seeded yet.</p>}
      </div>

      <IndustryGroup industries={plan.industries} selected={selected} onToggle={toggleIndustry} disabled={running} />

      <div className="seed-master-data__groups">
        {plan.domainGroups.map((group) => <DomainGroup key={group.key} group={group} domains={groupedDomains[group.key] ?? []} />)}
      </div>

      {plan.hasExistingData ? <div className="alert alert-warning d-flex gap-2 mb-0" role="alert">
        <AppIcon name="fa-exclamation-triangle" aria-hidden />
        <span>This organization already holds data. Seeding again permanently deletes it and rebuilds the organization from the selected industries.</span>
      </div> : null}

      <div className="seed-master-data__actions">
        <PrimaryButton leftIcon="fa-database" disabled={running || !selected.length}
          onClick={() => (plan.hasExistingData ? setConfirmOpen(true) : run())}>
          {running ? 'Generating…' : 'Review and generate'}
        </PrimaryButton>
      </div>
      {running && !confirmOpen ? <SeedProgress progress={progress} /> : null}
      {!selected.length ? <p className="seed-plan__empty">Select at least one laboratory industry to continue.</p> : null}

      <PlanSummary plan={plan} selected={selected} />
    </> : null}

    {confirmOpen ? <Modal open title="Re-seed this organization?" titleIcon="fa-exclamation-triangle" size="lg"
      subtitle={`Seed version ${plan.seedVersion}`}
      onClose={running ? () => {} : () => setConfirmOpen(false)}
      actions={<div className="d-flex gap-2 justify-content-end">
        <SecondaryButton onClick={() => setConfirmOpen(false)} disabled={running}>Cancel</SecondaryButton>
        <PrimaryButton onClick={run} disabled={running || !selected.length || confirmation.trim() !== plan.organization.name}>
          {running ? 'Generating…' : 'Delete and generate'}
        </PrimaryButton>
      </div>}>
      <div className="seed-confirm">
        {running ? <SeedProgress progress={progress} /> : null}
        <div className="seed-confirm__warning">
          This permanently deletes all existing data in <strong>{plan.organization.name}</strong> and cannot be undone.
          Its System Administrator accounts and seeding history are preserved, and every other organization is
          unaffected.
        </div>
        <PlanSummary plan={plan} selected={selected} />
        <div className="smplfy-form-field">
          <div className="smplfy-form-label-row">
            <label className="smplfy-form-label form-label" htmlFor="seed-confirmation">Type &quot;{plan.organization.name}&quot; to confirm</label>
            <span className="smplfy-form-required">*</span>
          </div>
          <input id="seed-confirmation" className="smplfy-form-control form-control" value={confirmation} disabled={running}
            autoComplete="off" placeholder={plan.organization.name} onChange={(event) => setConfirmation(event.target.value)} />
        </div>
      </div>
    </Modal> : null}
  </section>;
}
