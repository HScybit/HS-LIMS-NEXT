import TemplateCanvas from '../templates/TemplateCanvas.jsx';
import '../../../public/ckeditor/ckeditor5-content.css';

export default function ReportContent({ report, className = '' }) {
  const bodyClass = ['coa-print-body', className, report.printConfig.printWithoutSignature ? 'coa-print-body--without-signature' : '',
    report.printConfig.printWithoutImage ? 'coa-print-body--without-image' : ''].filter(Boolean).join(' ');
  const header = report.report.isNabl ? (report.assets?.nablHeader ?? report.assets?.header) : report.assets?.header;
  const footer = report.report.isNabl ? (report.assets?.nablFooter ?? report.assets?.footer) : report.assets?.footer;
  return <div className={bodyClass} data-coa-report-body>
    {header ? <div className="ck-content coa-report-header" data-is-header="true" dangerouslySetInnerHTML={{ __html: header.html }} /> : null}
    <TemplateCanvas model={report.model} mode="view" report={report} coaMode printMode variant={report.report.isNabl ? 'nabl' : 'non_nabl'} />
    {footer ? <div className="ck-content coa-report-footer" data-is-footer="true" dangerouslySetInnerHTML={{ __html: footer.html }} /> : null}
  </div>;
}
