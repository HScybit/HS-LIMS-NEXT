'use client';

import { useEffect, useRef, useState } from 'react';
import AppIcon from '../ui/AppIcon.jsx';
import Modal from '../ui/Modal.jsx';
import Pagination from '../ui/Pagination.jsx';
import PrimaryButton from '../ui/PrimaryButton.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import ToastNotification from '../ui/ToastNotification.jsx';
import { AppLoader } from '../ui/AppLoader.jsx';
import { apiRequest } from '../../lib/api-client.js';
import HeaderFooterEditor from './HeaderFooterEditor.jsx';
import { loadStylesheet } from './RichTextEditor.jsx';
import '../../styles/datatable.scss';
import './header-footer-template-management.scss';

const formId = 'hf-template-form';
const blankDraft = () => ({ name: '', template_code: '', is_default_header: false });
const closedModal = { open: false, mode: 'create', document: null, documentId: null };
const formatDate = (value) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

export default function HeaderFooterManagement({ type }) {
  const isHeader = type === 'header'; const entityLabel = isHeader ? 'Header' : 'Footer';
  const editorRef = useRef(null); const saveRequest = useRef(null); const deleteRequests = useRef(new Map()); const toastTimer = useRef(null);
  const [query, setQuery] = useState(''); const [appliedQuery, setAppliedQuery] = useState('');
  const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(10); const [reload, setReload] = useState(0);
  const [data, setData] = useState(null); const [loadError, setLoadError] = useState('');
  const [modal, setModal] = useState(closedModal); const [draft, setDraft] = useState(blankDraft);
  const [formError, setFormError] = useState(''); const [saving, setSaving] = useState(false); const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState(''); const [toast, setToast] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    const search = new URLSearchParams({ type, query: appliedQuery, page: String(page), pageSize: String(pageSize) });
    apiRequest(`/api/report-assets/documents?${search}`, { signal: controller.signal }).then((result) => {
      setData(result); setLoadError('');
    }).catch((error) => { if (!controller.signal.aborted) setLoadError(error.message); });
    return () => controller.abort();
  }, [type, appliedQuery, page, pageSize, reload]);

  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== 'hidden') setReload((value) => value + 1); };
    const interval = window.setInterval(refresh, 10_000);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(interval); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);
  useEffect(() => { loadStylesheet('/ckeditor/ckeditor5-content.css'); }, []);

  function showToast(tone, message) {
    window.clearTimeout(toastTimer.current); setToast({ tone, message });
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  }
  function openEditor(document = null) {
    saveRequest.current = null; setFormError(''); setUploading(false);
    setDraft(document ? { name: document.name, template_code: document.templateHtml, is_default_header: document.isDefault } : blankDraft());
    setModal({ open: true, mode: document ? 'edit' : 'create', document, documentId: document?.id ?? crypto.randomUUID() });
  }
  function closeModal() {
    if (saving) return;
    setModal(closedModal); setFormError(''); setUploading(false);
  }
  async function save(event) {
    event.preventDefault();
    if (saving) return;
    if (!draft.name.trim()) { setFormError(`${entityLabel} name is required.`); return; }
    if (uploading || editorRef.current?.hasPendingActions()) { setFormError('Wait for image uploads to finish before saving.'); return; }
    const body = { documentId: modal.documentId, revision: modal.document?.revision ?? 0, type, name: draft.name.trim(),
      templateHtml: editorRef.current?.getData() ?? draft.template_code, isDefault: draft.is_default_header };
    const key = JSON.stringify(body);
    if (saveRequest.current?.key !== key) saveRequest.current = { key, requestId: crypto.randomUUID() };
    setSaving(true); setFormError('');
    try {
      await apiRequest('/api/report-assets/documents', { method: 'POST', body: { ...body, requestId: saveRequest.current.requestId } });
      setModal(closedModal); setReload((value) => value + 1); showToast('success', `${entityLabel} template saved.`);
    } catch (error) { setFormError(error.message); }
    finally { setSaving(false); }
  }
  async function remove(document) {
    if (!window.confirm(`Delete ${entityLabel.toLowerCase()} template "${document.name}"?`)) return;
    let request = deleteRequests.current.get(document.id);
    if (request?.revision !== document.revision) {
      request = { requestId: crypto.randomUUID(), revision: document.revision }; deleteRequests.current.set(document.id, request);
    }
    setDeletingId(document.id);
    try {
      await apiRequest(`/api/report-assets/documents/${document.id}`, { method: 'DELETE', body: request });
      setReload((value) => value + 1); showToast('success', `${entityLabel} template deleted.`);
    } catch (error) { showToast('error', error.message); }
    finally { setDeletingId(''); }
  }

  if (!data && !loadError) return <AppLoader />;
  if (!data) return <div className="alert alert-danger" role="alert">{loadError}</div>;
  return <section className="dt-page hf-template-page">
    {toast ? <ToastNotification tone={toast.tone} message={toast.message} className="hf-template-page__toast" onClose={() => setToast(null)} /> : null}
    {loadError ? <div className="alert alert-danger" role="alert">{loadError}</div> : null}
    <div className="dt-toolbar hf-template-toolbar">
      <div className="hf-template-toolbar__search-group">
        <form className="dt-search-shell hf-template-search" onSubmit={(event) => { event.preventDefault(); setAppliedQuery(query.trim()); setQuery(query.trim()); setPage(1); }}>
          <AppIcon name="search" size={18} /><input type="search" className="dt-search" value={query} placeholder="Search templates" onChange={(event) => setQuery(event.currentTarget.value)} />
        </form>
        {appliedQuery ? <button type="button" className="dt-clear-button" onClick={() => { setQuery(''); setAppliedQuery(''); setPage(1); }}>Clear</button> : null}
      </div>
      <span className="hf-template-count" aria-label={`${entityLabel} template count`}>{data.filteredTotal} of {data.total}</span>
      {isHeader && data.defaultHeader ? <span className="hf-template-default-summary">Default: {data.defaultHeader.name}</span> : null}
      <div className="hf-template-toolbar-spacer" />
      {data.canManage ? <PrimaryButton leftIcon="plus" onClick={() => openEditor()}>New {entityLabel}</PrimaryButton> : null}
    </div>
    <section className="dt-table-card hf-template-table-card"><div className="dt-table-wrap hf-template-table-wrap"><div className="dt-table-wrapper">
      <table className="dt-table hf-template-table"><thead><tr><th>Name</th>{isHeader ? <th>Default</th> : null}<th>Preview</th><th>Updated</th><th aria-label="Actions" /></tr></thead>
        <tbody>{data.items.length ? data.items.map((document) => <tr key={document.id}>
          <td><div className="hf-template-name">{document.name}</div></td>
          {isHeader ? <td>{document.isDefault ? <span className="hf-template-badge hf-template-badge--success">Default</span> : <span className="hf-template-badge">Optional</span>}</td> : null}
          <td><div className="hf-template-preview"><div className="hf-template-preview__body ck-content" dangerouslySetInnerHTML={{ __html: document.templateHtml }} /></div></td>
          <td>{formatDate(document.savedAt)}</td>
          <td>{data.canManage ? <div className="hf-template-row-actions">
            <button type="button" className="hf-template-icon-button" aria-label={`Edit ${document.name}`} title="Edit" onClick={() => openEditor(document)}><AppIcon name="edit" size={18} /></button>
            <button type="button" className="hf-template-icon-button hf-template-icon-button--danger" aria-label={`Delete ${document.name}`} title="Delete" disabled={deletingId === document.id} onClick={() => remove(document)}><AppIcon name="trash" size={18} /></button>
          </div> : null}</td>
        </tr>) : <tr><td colSpan={isHeader ? 5 : 4} className="dt-empty">{appliedQuery ? 'No templates match your search.' : `No ${type} templates found.`}</td></tr>}</tbody>
      </table>
    </div><Pagination currentPage={data.page} pageSize={pageSize} totalItems={data.filteredTotal} itemLabel="templates" onPageChange={setPage}
      onPageSizeChange={(size) => { setPageSize(size); setPage(1); }} /></div></section>
    <Modal open={modal.open} title={`${modal.mode === 'edit' ? 'Edit' : 'New'} ${entityLabel} Template`} titleIcon="file-text" size="xl" className="hf-template-modal"
      onClose={closeModal} bodyClassName="hf-template-modal__body" actions={<>
        <SecondaryButton size="medium" onClick={closeModal} disabled={saving}>Cancel</SecondaryButton>
        <PrimaryButton type="submit" form={formId} leftIcon="save" disabled={saving || uploading}>{saving ? 'Saving' : 'Save Template'}</PrimaryButton>
      </>}>
      {modal.open ? <form id={formId} className="hf-template-form" onSubmit={save}>
        {formError ? <div className="alert alert-danger" role="alert">{formError}</div> : null}
        <HeaderFooterEditor key={modal.documentId} draft={draft} editorRef={editorRef} entityLabel={entityLabel}
          editorPlaceholder={`Build the printable report ${type}`} isHeader={isHeader} onDraftChange={setDraft} disabled={saving} onPendingChange={setUploading} />
      </form> : null}
    </Modal>
  </section>;
}
