import { eq, and } from 'drizzle-orm';
import { HttpError } from '../auth/errors.js';
import { database } from '../db/pool.js';
import { templates } from '../db/template-schema.js';
import { bool, decimal, fieldsOnly, uuid } from './input.js';

export const defaultTemplatePrintConfig = Object.freeze({
  pageSize: 'A4', scale: 1, xMargin: 0, isLandscape: false,
  printHeader: true, printFooter: true, headerAlignment: 'center', footerAlignment: 'center',
  nonNablTopMargin: 0, nonNablBottomMargin: 0, nablTopMargin: 0, nablBottomMargin: 0,
  useCustomTopNonNabl: false, useCustomBottomNonNabl: false, useCustomTopNabl: false, useCustomBottomNabl: false,
});

export function templatePrintConfig(row) {
  if (!row) return { ...defaultTemplatePrintConfig };
  return {
    pageSize: row.printPageSize, scale: Number(row.printScale), xMargin: Number(row.printXMargin),
    isLandscape: row.printLandscape, printHeader: row.printHeader, printFooter: row.printFooter,
    headerAlignment: row.printHeaderAlignment, footerAlignment: row.printFooterAlignment,
    nonNablTopMargin: Number(row.printNonNablTopMargin), nonNablBottomMargin: Number(row.printNonNablBottomMargin),
    nablTopMargin: Number(row.printNablTopMargin), nablBottomMargin: Number(row.printNablBottomMargin),
    useCustomTopNonNabl: row.printCustomTopNonNabl, useCustomBottomNonNabl: row.printCustomBottomNonNabl,
    useCustomTopNabl: row.printCustomTopNabl, useCustomBottomNabl: row.printCustomBottomNabl,
  };
}

export function templatePrintConfigInput(input = {}) {
  fieldsOnly(input, Object.keys(defaultTemplatePrintConfig));
  const value = { ...defaultTemplatePrintConfig, ...input };
  if (!['A3', 'A4', 'A5', 'Letter', 'Legal'].includes(value.pageSize)) throw new HttpError(400, 'invalid_page_size', 'Select a supported page size.');
  if (!['left', 'center', 'right'].includes(value.headerAlignment) || !['left', 'center', 'right'].includes(value.footerAlignment)) {
    throw new HttpError(400, 'invalid_print_alignment', 'Select a supported header and footer alignment.');
  }
  for (const key of ['isLandscape', 'printHeader', 'printFooter', 'useCustomTopNonNabl', 'useCustomBottomNonNabl', 'useCustomTopNabl', 'useCustomBottomNabl']) value[key] = bool(value[key], key);
  for (const key of ['scale', 'xMargin', 'nonNablTopMargin', 'nonNablBottomMargin', 'nablTopMargin', 'nablBottomMargin']) {
    const number = Number(decimal(value[key], key));
    const minimum = key === 'scale' ? 0.1 : 0;
    const maximum = key === 'scale' ? 1 : key === 'xMargin' ? 500 : 2000;
    if (number < minimum || number > maximum) throw new HttpError(400, 'invalid_print_setting', `${key} must be between ${minimum} and ${maximum}.`);
    value[key] = number;
  }
  return value;
}

export async function saveTemplatePrintConfig(client, organizationId, templateId, input) {
  uuid(templateId, 'Template');
  const value = templatePrintConfigInput(input);
  const db = database(client);
  const result = await db.update(templates).set({
    printPageSize: value.pageSize, printScale: String(value.scale), printXMargin: String(value.xMargin), printLandscape: value.isLandscape,
    printHeader: value.printHeader, printFooter: value.printFooter, printHeaderAlignment: value.headerAlignment, printFooterAlignment: value.footerAlignment,
    printNonNablTopMargin: String(value.nonNablTopMargin), printNonNablBottomMargin: String(value.nonNablBottomMargin),
    printNablTopMargin: String(value.nablTopMargin), printNablBottomMargin: String(value.nablBottomMargin),
    printCustomTopNonNabl: value.useCustomTopNonNabl, printCustomBottomNonNabl: value.useCustomBottomNonNabl,
    printCustomTopNabl: value.useCustomTopNabl, printCustomBottomNabl: value.useCustomBottomNabl,
  }).where(and(eq(templates.organizationId, organizationId), eq(templates.id, templateId))).returning();
  if (!result.length) throw new HttpError(404, 'template_not_found', 'Template was not found.');
  return templatePrintConfig(result[0]);
}

export function templatePreviewPdfInput(input) {
  fieldsOnly(input, ['html', 'title', 'variant', 'printConfig']);
  if (typeof input.html !== 'string' || !input.html.trim() || input.html.length > 950_000) throw new HttpError(400, 'invalid_preview_html', 'Preview HTML is required and must not exceed 950,000 characters.');
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 250) throw new HttpError(400, 'invalid_preview_title', 'Preview title is required and must not exceed 250 characters.');
  if (!['non_nabl', 'nabl'].includes(input.variant)) throw new HttpError(400, 'invalid_preview_variant', 'Select a supported preview variant.');
  return { html: input.html.trim(), title: input.title.trim(), variant: input.variant, printConfig: templatePrintConfigInput(input.printConfig) };
}

export function reportPrintConfig(value, variant) {
  const nabl = variant === 'nabl';
  return {
    pageSize: value.pageSize, scale: String(value.scale), xMargin: String(value.xMargin), isLandscape: value.isLandscape,
    printHeader: value.printHeader, printFooter: value.printFooter, printWithoutSignature: false, printWithoutImage: false,
    useCustomTopMargin: nabl ? value.useCustomTopNabl : value.useCustomTopNonNabl,
    topMargin: String(nabl ? value.nablTopMargin : value.nonNablTopMargin),
    useCustomBottomMargin: nabl ? value.useCustomBottomNabl : value.useCustomBottomNonNabl,
    bottomMargin: String(nabl ? value.nablBottomMargin : value.nonNablBottomMargin),
  };
}
