'use client';

import { useEffect, useState } from 'react';
import { apiRequest } from '../../lib/api-client.js';
import TemplateCanvas from './TemplateCanvas.jsx';
import { AppLoader } from '../ui/AppLoader.jsx';
import '../../styles/template-preview.scss';

export default function TemplatePreview({ templateId, versionId }) {
  const [model, setModel] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const query = versionId ? `?version=${encodeURIComponent(versionId)}` : '';
    apiRequest(`/api/templates/${templateId}${query}`, { signal: controller.signal }).then((result) => setModel(result.model))
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [templateId, versionId]);
  if (error) return <main className="template-print-preview template-print-preview--empty"><section className="template-print-preview__empty"><h1>Preview unavailable</h1><p>{error}</p><button type="button" onClick={() => window.close()}>Close</button></section></main>;
  if (!model) return <AppLoader message="Loading template preview..." fullPage />;
  return <main className="template-print-preview"><header className="template-print-preview__toolbar"><div className="template-print-preview__title"><p>Template Preview</p><h1>{model.version.name}</h1></div><div className="template-print-preview__controls"><div className="template-print-preview__segmented" role="group" aria-label="Preview mode"><button type="button" className="is-active">HTML</button></div><button type="button" onClick={() => window.close()}>Close</button></div></header>
    <section className="template-print-preview__workspace"><div className="template-print-preview__html is-active"><article className="template-preview-document"><div className="template-preview-document__body"><TemplateCanvas model={model} mode="view" /></div></article></div></section>
  </main>;
}
