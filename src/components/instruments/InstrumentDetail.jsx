'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import QRCode from 'qrcode';
import PageHeader from '../layout/PageHeader.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import DataTable from '../ui/DataTable.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import { printQrCode } from '../../materials/qr-print.js';
import { isBreakdownService } from '../../instruments/form.js';
import '../../styles/instrument-details-page.scss';

export default function InstrumentDetail({ instrument, serviceTypes, canManage }) {
  const router = useRouter(); const search = useSearchParams(); const [qr, setQr] = useState(null); const [error, setError] = useState('');
  const [selected, setSelected] = useState(serviceTypes[0]?.id ?? '');
  const from = search.get('from'); const returnPath = from && /^\/equipments(?:\?[^#]*)?$/.test(from) ? from : '/equipments';
  useEffect(() => {
    let active = true; const url = window.location.origin + '/equipments/' + instrument.id;
    QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 4, width: 240 }).then(data => { if (active) { setQr({ id: instrument.id, url, data }); setError(''); } })
      .catch(() => { if (active) setError('Could not generate the QR code.'); });
    return () => { active = false; };
  }, [instrument.id]);
  function print() {
    if (qr?.id !== instrument.id) return;
    setError(printQrCode({ materialName: instrument.name, uniqueKey: instrument.code, link: qr.url, qrDataUrl: qr.data }) ? '' : 'Allow the print window to open and try again.');
  }
  const service = serviceTypes.find(type => type.id === selected) ?? serviceTypes[0];
  const breakdown = isBreakdownService(service?.serviceCode);
  return <>
    <PageHeader><div className="page-header"><div className="container-fluid h-100"><div className="row h-100 align-items-center justify-content-between page-header__row">
      <div className="col page-header__start d-flex align-items-center gap-3"><Link href={returnPath} className="btn btn-outline-secondary" aria-label="Go back"><AppIcon name="chevron-left" /></Link><h1 className="page-title mb-0">{instrument.name}</h1></div>
      <div className="col-auto page-header__actions d-flex gap-2"><SecondaryButton leftIcon="printer" disabled={qr?.id !== instrument.id} onClick={print}>Print QR</SecondaryButton>
        {canManage ? <SecondaryButton leftIcon="edit" onClick={() => router.push(`/equipments/${instrument.id}/edit?from=${encodeURIComponent(returnPath)}`)}>Edit Instrument</SecondaryButton> : null}</div>
    </div></div></div></PageHeader>
    <main className="smplfy-instrument-details-page bg-body-tertiary p-4"><div className="container-fluid px-0 d-flex flex-column gap-3">
      {error ? <div className="alert alert-warning" role="alert">{error}</div> : null}
      <div className="row g-3 align-items-stretch"><div className="col-12 col-xl"><div className="smplfy-card card h-100"><div className="card-body row g-4 align-items-center">
        <div className="col-12 col-lg-7"><h2 className="fs-2 fw-normal lh-sm mb-2 text-dark">{instrument.name}</h2><p className="mb-0 text-secondary" style={{ whiteSpace: 'pre-wrap' }}>{instrument.description || '-'}</p></div>
        <div className="col-12 col-lg-5 d-flex flex-column gap-2">{[['Make', instrument.make], ['Unique Key', instrument.code], ['Model No', instrument.modelName], ['Serial No', instrument.serialNumber],
          ['Date of installation', instrument.dateOfInstallation?.split('-').reverse().join('/')]].map(([label, value]) => <div className="d-flex align-items-center gap-2" key={label}>
          <span className="text-secondary">{label}:</span><span className="fw-bold text-secondary text-break">{value || '-'}</span></div>)}</div>
      </div><div className="smplfy-instrument-details-access px-4 py-3 border-top"><span className="text-secondary">People with access: </span><span className="fw-bold text-secondary">{instrument.allowedUsers.map(user => user.name).join(', ') || '-'}</span></div></div></div>
        <div className="col-12 col-xl-auto"><div className="smplfy-card card h-100"><div className="card-body d-flex align-items-center justify-content-center"><div className="smplfy-instrument-qr">
          {qr?.id === instrument.id ? <><img className="smplfy-instrument-qr__image" src={qr.data} alt={`QR code for ${instrument.name}`} /><div className="smplfy-instrument-qr__link">{qr.url}</div></> : <AppIcon name="qrcode" size={120} aria-label="QR Code" />}
        </div></div></div></div>
      </div>
      {service ? <div className="smplfy-card card overflow-hidden"><div className="card-header bg-transparent p-0"><div className="nav nav-tabs px-4 border-0" role="tablist" aria-label="Instrument services">
        {serviceTypes.map(type => <button type="button" key={type.id} className={`nav-link ${type.id === service.id ? 'active' : ''}`} role="tab" aria-selected={type.id === service.id}
          id={'instrument-tab-' + type.id} aria-controls="instrument-service-records" onClick={() => setSelected(type.id)}>{type.label}</button>)}</div></div>
        <div className="card-body" role="tabpanel" id="instrument-service-records" aria-labelledby={'instrument-tab-' + service.id}><div className="fw-medium text-dark mb-3">0 Records</div>
          <DataTable><thead><tr><th>{breakdown ? 'Breakdown date' : 'Service date'}</th><th>{breakdown ? 'Resolved on' : 'Next service date'}</th>{!breakdown ? <th>Status</th> : null}<th>Details</th><th>Action</th></tr></thead>
            <tbody><tr><td colSpan={breakdown ? 4 : 5} className="text-center text-secondary py-4">No records found.</td></tr></tbody></DataTable>
        </div></div> : null}
    </div></main>
  </>;
}
