import { randomUUID } from 'node:crypto';
import { createTemplate, copyDefinition } from '../../src/templates/authoring.js';
import { database } from '../../src/db/pool.js';

// Synthetic data in the source COA heading/details/parameter-loop structure.
export function reportRecords() {
  const records = { sections: [], rows: [], columns: [], fields: [], groups: [], expressions: [], options: [] };
  function section(name, flags = {}) {
    const row = { id: randomUUID(), name, position: records.sections.length, parentColumnId: null, cssClass: 'border', ...flags };
    records.sections.push(row);
    return row;
  }
  function row(section, fields) {
    const layout = { id: randomUUID(), sectionId: section.id, position: records.rows.filter((item) => item.sectionId === section.id).length };
    records.rows.push(layout);
    for (const field of fields) {
      const column = { id: randomUUID(), rowId: layout.id, position: records.columns.filter((item) => item.rowId === layout.id).length, span: field.span ?? 6, cssClass: `col-${field.span ?? 6} border px-2 py-1` };
      records.columns.push(column);
      const { span: _span, ...data } = field;
      records.fields.push({ id: randomUUID(), columnId: column.id, repeatGroupId: null, valueType: 'text', required: false, editable: false, ...data });
    }
  }
  row(section('Certificate Heading'), [{ widget: 'text_widget', label: 'CERTIFICATE OF ANALYSIS', alias: '', span: 12 }]);
  row(section('Certificate Details'), [
    { widget: 'text_widget', label: 'Sample Number', alias: '' },
    { widget: 'sample_details_widget_v2', alias: 'sample_number', sourceField: 'sampleNumber' },
  ]);
  row(section('Test Results Heading', { isParameterLoopHeader: true }), [
    { widget: 'text_widget', label: 'S. No.', alias: '', span: 2 },
    { widget: 'text_widget', label: 'Test Parameter', alias: '', span: 5 },
    { widget: 'text_widget', label: 'Result', alias: '', span: 5 },
  ]);
  const results = section('Test Results', { isParameterLoop: true });
  row(results, [
    { widget: 'sno_widget', alias: 'coa_sno', serialPadding: 2, span: 2 },
    { widget: 'tr_data_widget', alias: 'param', sourceField: 'parameterName', span: 5 },
    { widget: 'tr_result_widget', alias: 'coa_result', span: 5 },
  ]);
  row(results, [
    { widget: 'tr_data_widget', alias: 'moa', sourceField: 'methodName' },
    { widget: 'decision_rule_widget', alias: 'coa_specification', sourceField: 'specification' },
  ]);
  return records;
}

export async function createReportTemplate(client, identity) {
  const template = await createTemplate(client, identity, { name: 'Synthetic certificate', kind: 'report', templateType: 'sample_coa' });
  const records = reportRecords();
  await copyDefinition(database(client), records, identity.organization_id, template.versionId);
  return { ...template, records };
}
