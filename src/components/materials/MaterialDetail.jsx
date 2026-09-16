'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import QRCode from 'qrcode';
import PageHeader from '../layout/PageHeader.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import MaterialTransactionModal from './MaterialTransactionModal.jsx';
import { apiRequest } from '../../lib/api-client.js';
import { printQrCode } from '../../materials/qr-print.js';
import '../../styles/material-details-page.scss';

const tabs = [['all', 'All Transactions'], ['in', 'IN'], ['out', 'OUT'], ['out_damaged', 'Out - Damaged']];
const date = value => value ? (/^\d{4}-\d{2}-\d{2}$/.test(value) ? value.split('-').reverse().join('/') : new Date(value).toLocaleDateString('en-GB')) : '-';
function StatBlock({ value, unit, label }) {
  return <div className="text-center"><div className="display-5 fw-semibold text-dark lh-1" title={value}>{Number(value).toLocaleString('en-IN', { maximumFractionDigits: 3 })}</div>
    <div className="text-secondary small mt-2">{unit}</div><div className="text-secondary mt-2">{label}</div></div>;
}
export default function MaterialDetail({ materialId, canManage }) {
  const [type, setType] = useState('all'); const [page, setPage] = useState(1); const [reload, setReload] = useState(0);
  const [state, setState] = useState(null); const [error, setError] = useState(''); const [transaction, setTransaction] = useState(false);
  const [qr, setQr] = useState(null); const [printError, setPrintError] = useState(''); const key = `${materialId}:${type}:${page}`;
  useEffect(() => {
    const controller = new AbortController();
    apiRequest(`/api/materials/${materialId}?${new URLSearchParams({ type, page: String(page) })}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) { setState({ ...value, key }); setError(''); } })
      .catch(failure => { if (!controller.signal.aborted) { setError(failure.message); if (failure.code === 'material_not_found') setState(null); } });
    return () => controller.abort();
  }, [materialId, type, page, reload, key]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== 'hidden') setReload(value => value + 1); };
    const interval = window.setInterval(refresh, 10000); window.addEventListener('focus', refresh);
    return () => { window.clearInterval(interval); window.removeEventListener('focus', refresh); };
  }, []);
  useEffect(() => {
    let active = true; const url = new URL(`/materials/${materialId}`, window.location.origin).href;
    QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 4, width: 240 }).then(data => { if (active) setQr({ materialId, url, data }); }).catch(() => { if (active) setPrintError('Could not generate the QR code.'); });
    return () => { active = false; };
  }, [materialId]);
  const material = state?.material.id === materialId ? state.material : null;
  function print() {
    if (!material || qr?.materialId !== materialId) return;
    setPrintError(printQrCode({ materialName: material.name, uniqueKey: material.code, link: qr.url, qrDataUrl: qr.data }) ? '' : 'Allow the print window to open and try again.');
  }
  return <>
    <PageHeader><div className="page-header"><div className="container-fluid h-100"><div className="row h-100 align-items-center justify-content-between page-header__row">
      <div className="col page-header__start d-flex align-items-center gap-3"><Link href="/materials" className="btn btn-outline-secondary" aria-label="Go back"><AppIcon name="chevron-left" /></Link><h1 className="page-title mb-0">{material?.name ?? 'Material'}</h1></div>
      <div className="col-auto page-header__actions"><SecondaryButton leftIcon="printer" onClick={print} disabled={!material || qr?.materialId !== materialId}>Print QR</SecondaryButton>
        {canManage ? <PrimaryButton leftIcon="plus" disabled={!material} onClick={() => setTransaction(true)}>New Transaction</PrimaryButton> : null}</div>
    </div></div></div></PageHeader>
    <main className="smplfy-material-details-page bg-body-tertiary p-4 min-vh-100"><div className="container-fluid px-0 d-flex flex-column gap-3">
      {error ? <div className="alert alert-warning" role="alert">{error}<button type="button" className="btn btn-link" onClick={() => setReload(value => value + 1)}>Retry</button></div> : null}
      {printError ? <div className="alert alert-warning" role="alert">{printError}</div> : null}
      {!material ? error ? null : <div role="status">Loading material...</div> : <>
        <div className="row g-2 align-items-stretch"><div className="col-12 col-xl"><div className="smplfy-card card h-100"><div className="card-body row g-0 align-items-center">
          <div className="col-12 col-lg-6 px-3"><h2 className="fs-2 fw-normal lh-sm mb-2 text-dark">{material.name}</h2><div className="d-flex align-items-center gap-2 mb-2"><span className="text-secondary">Unique Key:</span><span className="fw-bold text-secondary">{material.code}</span></div>
            <div className="d-flex align-items-center gap-2 mb-2"><span className="text-secondary">Category:</span><span className="fw-bold text-secondary">{material.categoryName}</span></div><p className="mb-0 text-secondary">{material.description || '-'}</p></div>
          <div className="col-12 col-lg-6 d-flex align-items-center justify-content-around gap-3 flex-wrap"><StatBlock value={material.currentQuantity} unit={material.unitName} label="Current Quantity" /><StatBlock value={material.minimumQuantity} unit={material.unitName} label="Min Quantity" /></div>
        </div></div></div><div className="col-12 col-xl-auto"><div className="smplfy-card card h-100"><div className="card-body d-flex align-items-center justify-content-center">
          {qr?.materialId === materialId ? <Image unoptimized src={qr.data} alt={`QR code linking to ${material.name}`} className="smplfy-material-qr__image" width={120} height={120} /> : <AppIcon name="qrcode" size={120} />}
        </div></div></div></div>
        <div className="smplfy-card card overflow-hidden"><div className="card-header bg-transparent p-0"><div className="nav nav-tabs px-4 border-0" role="tablist" aria-label="Transactions">
          {tabs.map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={type === value} className={`smplfy-nav-link nav-link${type === value ? ' active' : ''}`} onClick={() => { setType(value); setPage(1); }}><span className="d-inline-flex align-items-center">{label}</span></button>)}
        </div></div><div className="card-body">{state.key !== key ? <div role="status">Loading transactions...</div> : <>
          <div className="fw-medium text-dark mb-3">{state.transactions.totalCount} Transactions</div><div className="table-responsive"><table className="smplfy-table table table-hover align-middle mb-0"><thead><tr>
            {['Sr.', 'Type', 'Quantity', 'Supplier/Batch', 'Transaction Date', 'Expiry Date', 'Cost(s)', 'By'].map(label => <th key={label}>{label}</th>)}
          </tr></thead><tbody>{state.transactions.items.map((row, index) => <tr key={row.id}><td>{(page - 1) * 10 + index + 1}</td><td>{row.type === 'out_damaged' ? 'OUT - Damaged' : row.type.toUpperCase()}</td>
            <td>{row.quantity} {material.unitName}</td><td>{[row.supplier, row.batchSerialNumber].filter(Boolean).join(' - ') || '-'}</td><td>{date(row.createdAt)}</td><td>{row.type === 'in' ? date(row.expiryDate) : ''}</td><td>{row.cost ?? '-'}</td><td>{row.createdByName || '-'}</td></tr>)}
            {!state.transactions.items.length ? <tr><td colSpan={8} className="text-center text-secondary py-4">No transactions found.</td></tr> : null}
          </tbody></table></div><div className="d-flex align-items-center justify-content-end gap-3 mt-3"><SecondaryButton disabled={page === 1} onClick={() => setPage(value => value - 1)}>Previous</SecondaryButton>
            <span>Page {page}</span><SecondaryButton disabled={page * 10 >= state.transactions.totalCount} onClick={() => setPage(value => value + 1)}>Next</SecondaryButton></div>
        </>}</div></div>
      </>}
    </div></main>
    {transaction && material ? <MaterialTransactionModal key={material.id} material={material} onClose={() => setTransaction(false)} onSaved={() => { setTransaction(false); setReload(value => value + 1); }} /> : null}
  </>;
}
