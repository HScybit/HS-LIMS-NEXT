'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import PageHeader from '../layout/PageHeader.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import MoreActionButton from '../ui/MoreActionButton.jsx';
import StatusPill from '../ui/StatusPill.jsx';
import { WorkflowDetailsRail } from '../ui/WorkflowRail.jsx';
import { AppLoader } from '../ui/AppLoader.jsx';
import { apiRequest } from '../../lib/api-client.js';
import '../../styles/sample-details-page.scss';

const display = (value) => value == null || value === '' ? '-' : String(value);
const dateLabel = (value) => value ? value.slice(0, 10).split('-').reverse().join('-') : '-';
function DetailGrid({ items, columns = 4 }) {
  return <dl className={`smplfy-sample-details-fields row row-cols-${columns} g-0 mb-0`}>{items.map(([label, value, multiline]) => <div key={label} className="col p-2">
    <dt className="text-secondary fw-normal mb-1 text-wrap">{label}</dt><dd className={`fw-medium mb-0 ${multiline ? 'text-wrap' : 'text-truncate'}`}>{display(value)}</dd>
  </div>)}</dl>;
}
function SectionHeader({ children }) { return <div className="card-header"><h2 className="card-title mb-0">{children}</h2></div>; }

export default function SampleDetails({ sampleId }) {
  const router = useRouter(); const [sample, setSample] = useState(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0); const [generating, setGenerating] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const result = await apiRequest(`/api/samples/${sampleId}`, { signal: controller.signal });
        if (!controller.signal.aborted) { setSample(result); setError(''); }
      } catch (failure) { if (!controller.signal.aborted) setError(failure.message); }
    }
    void load(); return () => controller.abort();
  }, [sampleId, reload]);
  async function generateRequests() {
    if (generating) return; setGenerating(true); setError('');
    try { await apiRequest(`/api/samples/${sampleId}/test-requests`, { method: 'POST', body: {} }); router.push(`/samples/${sampleId}/test_requests`); }
    catch (failure) { setError(failure.message); setGenerating(false); }
  }
  if (!sample) return error ? <div className="alert alert-danger m-4" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload((value) => value + 1)}>Retry</button></div> : <AppLoader message="Loading sample..." />;
  const created = new Date(sample.registeredAt);
  const kind = sample.sampleType === 'quality_control' ? sample.iqcType === 'int_lab' ? 'Intralab' : 'IQC'
    : sample.sampleType === 'interlaboratory' ? sample.ilcMode === 'organizer' ? 'ILC Sample' : 'ILC participation Sample'
      : ({ customer: 'Base', internal: 'Internal', proficiency: 'PT Sample', amendment: 'Amendment', complaint: 'Complaint' })[sample.sampleType];
  const details = [['Sample Type', kind], ['Receiving Date', dateLabel(sample.receivedAt)], ['Customer', sample.customerName],
    ['Customer Quotation', sample.quotationNumber], ['Customer Address', sample.customerAddress, true],
    ...(sample.iqcType ? [['IQC Type', sample.iqcType]] : []), ...(sample.participantCount ? [['No. of Participants', sample.participantCount]] : []),
    ...(sample.ilcMode === 'organizer' ? [['ILC Labs', sample.participatingLabs.map((lab) => lab.laboratoryName).join(', '), true]] : [])];
  const additional = [['Mode of Sample Receipt', sample.modeOfReceipt], ['Tentative Reporting Date', dateLabel(sample.dueAt)],
    ['Amount (Inc. of all taxes)', sample.totalAmount], ['Received By', sample.receivedByName], ['Sample Collection Details', sample.collectionDetails, true],
    ...(sample.sampleType === 'amendment' ? [['Amendment Remarks', sample.amendmentRemarks, true]] : []),
    ...(sample.sampleType === 'complaint' ? [['Complaint Remarks', sample.complaintRemarks, true]] : [])];
  const actions = sample.canGenerateRequests && sample.products.some((product) => product.tests.some((test) => test.status === 'planned'))
    ? [{ key: 'generate-tr', label: generating ? 'Generating Test Requests...' : 'Generate Test Requests', leftIcon: 'clipboard-text', disabled: generating, onClick: generateRequests }] : [];
  return <>
    <PageHeader><section className="smplfy-sample-details-header bg-white border-bottom"><div className="d-flex align-items-center justify-content-between gap-3 flex-wrap">
      <div className="d-flex align-items-start gap-3"><SecondaryButton size="medium" leftIcon="chevron-left" className="px-0 flex-shrink-0" aria-label="Go back" href="/samples" />
        <div className="d-flex flex-column"><div className="d-flex align-items-center gap-2"><h1 className="h5 mb-0 fw-semibold text-dark">{sample.sampleNumber}</h1><StatusPill color={sample.stateColor || 'blue'}>{sample.stateName || sample.status}</StatusPill></div>
          <div className="d-inline-flex gap-2 text-secondary fw-medium mt-2"><span>{created.toLocaleDateString('en-GB')}</span><span>{created.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
        </div></div><div className="d-flex align-items-center gap-2 flex-wrap">
        <SecondaryButton leftIcon="clipboard-text" size="large" className="btn-primary text-white border-primary" href={`/samples/${sampleId}/test_requests`}>Test Requests/Jobs</SecondaryButton>
        {actions.length ? <MoreActionButton items={actions} /> : null}
      </div>
    </div></section></PageHeader>
    <main className="smplfy-sample-details-page bg-body-tertiary p-4 min-vh-100">
      {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}
      <div className="smplfy-sample-details-layout d-grid"><div className="smplfy-sample-details-main-panel"><div className="card smplfy-card shadow-none overflow-hidden smplfy-sample-details-shell">
        <section className="smplfy-sample-details-basic"><SectionHeader>Sample Creation Details</SectionHeader><div className="card-body p-0"><DetailGrid items={details} /></div></section>
        <section className="smplfy-sample-details-products-section"><SectionHeader>Product-wise Details</SectionHeader><div className="card-body p-0"><div className="smplfy-sample-details-products vstack gap-3">
          {sample.products.map((product, index) => <article className="card smplfy-card overflow-hidden smplfy-sample-details-product-card" key={product.id}>
            <div className="card-header"><h3 className="card-title mb-0"><span className="product_sr_no">{index + 1}.</span> {product.productName}</h3></div>
            <div className="card-body p-0"><DetailGrid columns={3} items={[
              ['Category', product.categoryName], ['Product', product.productName], ['Description', product.description, true], ['Quantity', product.quantity],
              ['Sample Size', [product.sampleSize, product.unitSymbol].filter(Boolean).join(' ')], ['Quality', product.quality], ['Identification Mark', product.identificationMark], ['Condition', product.receivedCondition],
            ]} /><div className="px-4 pb-3 pt-2"><div className="smplfy-sample-parameter-table-wrap"><table className="smplfy-table table table-bordered table-sm smplfy-sample-parameter-table">
              <thead><tr><th scope="col">Sr.</th>{sample.sampleType === 'complaint' ? <th scope="col">Retest</th> : null}<th className="smplfy-sample-parameter-col" scope="col">Parameter</th><th scope="col">Test Method</th><th scope="col">Req. Size</th><th scope="col">Charges</th><th scope="col">Est. Time</th></tr></thead>
              <tbody>{product.tests.map((test, testIndex) => <tr key={test.id}><td>{testIndex + 1}</td>{sample.sampleType === 'complaint' ? <td>{test.isRetest ? 'Yes' : 'No'}</td> : null}<td>{test.parameterName}</td><td>{test.methodName}</td><td>{display(test.requestedSize)}</td><td className="text-end">{display(test.rate)}</td><td>{test.estimatedDurationMinutes == null ? '-' : test.estimatedDurationMinutes / 480}</td></tr>)}</tbody>
            </table></div></div></div>
          </article>)}
        </div></div></section>
        <section className="smplfy-sample-details-additional"><SectionHeader>Additional Details</SectionHeader><div className="card-body p-0"><DetailGrid items={additional} /></div></section>
      </div></div><WorkflowDetailsRail ariaLabel="Sample actions and activity" emptyActionMessage="No pending approval request for this sample."
        activityItems={sample.activity.map((item) => ({ key: item.id, date: item.occurredAt, title: item.description, user: item.actorName, tone: 'info' }))} />
      </div>
    </main>
  </>;
}
