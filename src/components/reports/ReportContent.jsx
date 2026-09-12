import TemplateCanvas from '../templates/TemplateCanvas.jsx';
import '../../../public/ckeditor/ckeditor5-content.css';

export default function ReportContent({ report, className = '' }) {
  const bodyClass = ['coa-print-body', className, report.printConfig.printWithoutSignature ? 'coa-print-body--without-signature' : '',
    report.printConfig.printWithoutImage ? 'coa-print-body--without-image' : ''].filter(Boolean).join(' ');
  return <div className={bodyClass} data-coa-report-body>
    {report.assets?.header ? <div className="ck-content coa-report-header" data-is-header="true" dangerouslySetInnerHTML={{ __html: report.assets.header.html }} /> : null}
    <TemplateCanvas model={report.model} mode="view" report={report} />
    {report.assets?.footer ? <div className="ck-content coa-report-footer" data-is-footer="true" dangerouslySetInnerHTML={{ __html: report.assets.footer.html }} /> : null}
  </div>;
}
