import { HttpError } from '../auth/errors.js';
import { uuid } from '../templates/input.js';

// "result_summary" (Job Template) is deliberately excluded: it already exists as its own dedicated
// resultSummaryTemplateId column with its own Jobs/Test Requests consumers, predating this table.
export const templateDefaultPurposes = ['acknowledgement', 'result_page', 'ilc_report', 'comparative_report', 'intralab_report'];
export const documentTypes = ['proforma_invoice', 'quotation', 'label', 'sample_receipt', 'sample_request'];

function optionalUuid(value, label) {
  return value === null || value === undefined ? null : uuid(value, label).toLowerCase();
}

export function templateDefaultsInput(input) {
  if (!Object.hasOwn(input, 'templateDefaults')) return undefined;
  const value = input.templateDefaults;
  if (!Array.isArray(value) || value.length > templateDefaultPurposes.length) throw new HttpError(400, 'invalid_template_defaults', 'Provide a valid set of template defaults.');
  const seen = new Set();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || !templateDefaultPurposes.includes(item.purpose)) throw new HttpError(400, 'invalid_template_defaults', 'An unsupported template purpose was provided.');
    if (seen.has(item.purpose)) throw new HttpError(400, 'invalid_template_defaults', 'Each template purpose can be set at most once.');
    seen.add(item.purpose);
    return { purpose: item.purpose, templateId: uuid(item.templateId, `${item.purpose} template`).toLowerCase() };
  });
}

export function documentSettingsInput(input) {
  if (!Object.hasOwn(input, 'documentSettings')) return undefined;
  const value = input.documentSettings;
  const validTypes = [...documentTypes, 'acknowledgement'];
  if (!Array.isArray(value) || value.length > validTypes.length) throw new HttpError(400, 'invalid_document_settings', 'Provide a valid set of document settings.');
  const seen = new Set();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || !validTypes.includes(item.documentType)) throw new HttpError(400, 'invalid_document_settings', 'An unsupported document type was provided.');
    if (seen.has(item.documentType)) throw new HttpError(400, 'invalid_document_settings', 'Each document type can be set at most once.');
    seen.add(item.documentType);
    const numberScheme = item.numberScheme === null || item.numberScheme === undefined ? null : String(item.numberScheme).trim();
    if (numberScheme !== null && numberScheme.length > 200) throw new HttpError(400, 'invalid_document_settings', 'A document number scheme must be at most 200 characters.');
    const numberPadding = item.numberPadding === null || item.numberPadding === undefined ? null : item.numberPadding;
    if (numberPadding !== null && (!Number.isSafeInteger(numberPadding) || numberPadding < 1 || numberPadding > 20)) {
      throw new HttpError(400, 'invalid_document_settings', 'Document number padding must be between 1 and 20.');
    }
    const headerHeightMm = item.headerHeightMm === null || item.headerHeightMm === undefined ? null : item.headerHeightMm;
    if (headerHeightMm !== null && (!Number.isSafeInteger(headerHeightMm) || headerHeightMm <= 0)) {
      throw new HttpError(400, 'invalid_document_settings', 'Document header height must be a positive whole number of millimeters.');
    }
    return { documentType: item.documentType, numberScheme, numberPadding, headerTemplateId: optionalUuid(item.headerTemplateId, `${item.documentType} header template`), headerHeightMm };
  });
}

export async function loadDocumentDefaults(client, identity) {
  const [templates, documents] = await Promise.all([
    client.query('SELECT purpose, template_id AS "templateId" FROM organization_template_defaults WHERE organization_id=$1 ORDER BY purpose', [identity.organization_id]),
    client.query(`SELECT document_type AS "documentType", number_scheme AS "numberScheme", number_padding AS "numberPadding",
        header_template_id AS "headerTemplateId", header_height_mm AS "headerHeightMm"
      FROM organization_document_settings WHERE organization_id=$1 ORDER BY document_type`, [identity.organization_id]),
  ]);
  return { templateDefaults: templates.rows, documentSettings: documents.rows };
}

export async function saveDocumentDefaults(client, identity, { templateDefaults, documentSettings }) {
  if (templateDefaults !== undefined) {
    await client.query('DELETE FROM organization_template_defaults WHERE organization_id=$1', [identity.organization_id]);
    for (const item of templateDefaults) {
      const inserted = await client.query(
        `INSERT INTO organization_template_defaults(organization_id,purpose,template_id)
         SELECT $1,$2,template.id FROM templates template WHERE template.organization_id=$1 AND template.id=$3 AND template.active`,
        [identity.organization_id, item.purpose, item.templateId]);
      if (!inserted.rowCount) throw new HttpError(422, 'invalid_template_default', `Select an active template for ${item.purpose.replaceAll('_', ' ')}.`);
    }
  }
  if (documentSettings !== undefined) {
    await client.query('DELETE FROM organization_document_settings WHERE organization_id=$1', [identity.organization_id]);
    for (const item of documentSettings) {
      if (item.headerTemplateId) {
        const template = await client.query('SELECT 1 FROM templates WHERE organization_id=$1 AND id=$2 AND active', [identity.organization_id, item.headerTemplateId]);
        if (!template.rowCount) throw new HttpError(422, 'invalid_document_header_template', `Select an active header template for ${item.documentType.replaceAll('_', ' ')}.`);
      }
      await client.query(
        `INSERT INTO organization_document_settings(organization_id,document_type,number_scheme,number_padding,header_template_id,header_height_mm)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [identity.organization_id, item.documentType, item.numberScheme, item.numberPadding, item.headerTemplateId, item.headerHeightMm]);
    }
  }
}
