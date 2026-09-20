'use client';

import { useRouter } from 'next/navigation';
import DataTable from '../ui/DataTable.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import { apiRequest } from '../../lib/api-client.js';
import PageHeader from '../layout/PageHeader.jsx';

const loadRows = ({ page, pageSize, search, filters, sort }) => apiRequest(`/api/templates?query=${encodeURIComponent(JSON.stringify({ page, pageSize, search, filters, sort }))}`);
const columns = [
  { key: 'name', header: 'Name', searchable: true }, { key: 'description', header: 'Description', searchable: true },
  { key: 'uuid', header: 'UUID', searchable: true }, { key: 'created_at', header: 'Created At', type: 'date' },
  { key: 'actions', header: 'Actions', render: (row) => <div className="d-flex flex-nowrap align-items-center gap-2"><SecondaryButton href={`/master_template_management/${row._id}`} leftIcon="edit" size="small" tone="primary">Edit Template</SecondaryButton></div> },
];

export default function TemplateList({ canManage }) {
  const router = useRouter();
  return <><PageHeader><div className="page-header"><div className="container-fluid h-100"><div className="row h-100 align-items-center justify-content-between page-header__row"><div className="col page-header__start"><h1 className="page-title mb-0">Master Templates</h1></div><div className="col-auto page-header__actions">{canManage ? <PrimaryButton leftIcon="plus" onClick={() => router.push('/master_template_management/new')}>New Master Template</PrimaryButton> : null}</div></div></div></div></PageHeader><DataTable columns={columns} loadRows={loadRows} /></>;
}
