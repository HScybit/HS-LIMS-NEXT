// Source COA widgets read explicit domain fields. These names select typed
// records, never arbitrary object paths, SQL identifiers, or stored scripts.
import { productDetailSelector } from './product-context.js';
import { sampleLineAttributes, sampleLineValue } from './sample-line.js';

export const contextWidgetFields = Object.freeze({
  product_detail_widget: [],
  sample_line_item_data_widget: sampleLineAttributes.map((attribute) => attribute.value),
  sample_details_widget_v2: ['sampleNumber', 'customerName', 'customerAddress', 'sampleCategoryName', 'productName', 'receivedAt', 'registeredAt', 'dueAt', 'description', 'customerReference'],
  tr_data_widget: ['requestNumber', 'parameterName', 'productName', 'methodName', 'analystName', 'submittedAt', 'completedAt'],
  decision_rule_widget: ['specification', 'measurementUnit', 'parameterName', 'productName', 'methodName', 'decisionOutcome'],
  tr_result_widget: [],
  sno_widget: [],
});

export const contextWidgetPreview = Object.freeze({
  product_detail_widget: 'Product detail widget preview',
  sample_details_widget_v2: 'Sample details widget preview',
  tr_data_widget: 'TR data widget preview',
  decision_rule_widget: 'Decision rule widget preview',
  tr_result_widget: 'TR result widget preview',
  sno_widget: '1',
});

const scalar = (value) => ['string', 'number', 'boolean'].includes(typeof value) ? String(value) : '';
const own = (record, key) => record && Object.hasOwn(record, key) ? record[key] : undefined;

export function isContextWidget(widget) {
  return Object.hasOwn(contextWidgetFields, widget);
}

export function contextWidgetValue(field, report, parameter, serialNumber = 0) {
  if (!isContextWidget(field.widget)) return '';
  if (field.widget === 'sno_widget') return String(serialNumber).padStart(Math.max(1, field.serialPadding ?? 0), '0');
  if (!report) return '';
  if (field.widget === 'sample_line_item_data_widget') return sampleLineValue(field, report.lineItem);
  if (field.widget === 'product_detail_widget') {
    const lineId = parameter?.sampleProductId ?? report.productLineId ?? report.primaryProductLineId;
    return own(own(report.productDetailsByLineId, lineId), productDetailSelector(field.alias)) ?? '';
  }
  if (field.widget === 'tr_result_widget') return scalar(own(parameter, 'finalResult'));
  if (!contextWidgetFields[field.widget].includes(field.sourceField)) return '';
  if (field.widget === 'sample_details_widget_v2' && field.sourceField !== 'productName') return scalar(own(report.sample, field.sourceField));
  const rows = parameter ? [parameter] : report.results ?? [];
  // Meteor's report widgets preserve zero/false and join distinct nonempty
  // values outside a parameter loop, in the selected test order.
  return [...new Set(rows.map((row) => scalar(own(row, field.sourceField))).filter((value) => value !== ''))].join(', ');
}
