import Link from 'next/link';
import DataTable from '../ui/DataTable.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import StatusPill from '../ui/StatusPill.jsx';

// The source listing presents jobs separately from individual root requests.
export default function JobsCard({ rows, sampleId, states, onAllocate }) {
  return <section className="smplfy-card smplfy-tr-jobs-card card border-0">
    <div className="card-header bg-transparent d-flex align-items-center"><div className="fw-medium">{rows.length} Jobs</div></div>
    <div className="card-body"><DataTable><thead><tr>
      {['Test Request ID', 'Status', 'Product', 'Age', 'Target Reporting Date', 'Action'].map((label, index) =>
        <th scope="col" className={`smplfy-tr-job-col-${['id', 'status', 'product', 'age', 'reporting', 'action'][index]}`} key={label}>{label}</th>)}
    </tr></thead><tbody>{rows.map((row) => <tr key={row.id}>
      <td className="text-nowrap smplfy-tr-job-col-id"><Link className="smplfy-link link-primary p-0" href={`/samples/${sampleId}/test_requests/${row.id}`}>{row.requestNumber}</Link></td>
      <td className="text-nowrap smplfy-tr-job-col-status"><StatusPill color={states[row.status]?.[1] ?? 'gray'}>{row.stateName || states[row.status]?.[0] || row.status}</StatusPill></td>
      <td className="text-nowrap smplfy-tr-job-col-product">{row.productName}</td><td className="text-nowrap smplfy-tr-job-col-age">{row.ageDays} days</td>
      <td className="text-nowrap smplfy-tr-job-col-reporting">{row.dueAt ? row.dueAt.slice(0, 10) : '—'}</td>
      <td className="text-nowrap smplfy-tr-job-col-action"><div className="d-flex align-items-center gap-2 flex-nowrap">
        {row.canAllocate ? <SecondaryButton leftIcon="user-plus" onClick={() => onAllocate(row)}>Allocate</SecondaryButton> : null}
        <SecondaryButton href={`/samples/${sampleId}/test_requests/${row.id}`}>View</SecondaryButton>
      </div></td>
    </tr>)}</tbody></DataTable></div>
  </section>;
}
