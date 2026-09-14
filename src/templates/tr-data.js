import { widgetDateDisplay } from './widget-dates.js';

const own = (record, key) => record && Object.hasOwn(record, key) ? record[key] : undefined;
const hasId = (value) => value && value !== -1 && value !== '-1';
const name = (record) => hasId(record?.id) ? own(record, 'name') || '' : '';
const userName = (context, id) => id ? own(context.usersById, id) || '' : '';

export function trDataText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

// The context is assembled from typed domain records by the server. Request
// identity and scientific precedence are resolved before formatting any key.
export function trDataValue(key, context, formatDateTime) {
  if (!key || !context?.request) return '';
  const request = context.request;
  const date = formatDateTime ?? ((value) => widgetDateDisplay(value, 'datetime', context.dateSettings));
  switch (key) {
    case 'analyst':
    case 'allocated_to': return userName(context, own(request, 'assignee_id'));
    case 'approver': return ['reviewed', 'approved'].includes(own(request, 'current_state')) ? userName(context, own(request, 'approver_id')) : '';
    case 'final_approver': return own(request, 'current_state') === 'approved' ? userName(context, own(request, 'final_approver_id')) : '';
    case 'allocated_by': return userName(context, own(request, 'allocated_by') || own(request, 'final_approver_id'));
    case 'moa': return name(context.method);
    case 'moa_id': return name(context.method) || own(context.method, 'id') || '';
    case 'param': return name(context.parameter);
    case 'param_id': return name(context.parameter) || own(context.parameter, 'id') || '';
    case 'product': return name(context.product);
    case 'product_id': return name(context.product) || own(context.product, 'id') || '';
    case 'allocation_date': return date(own(request, 'allocation_date'));
    case 'approval_date': return date(own(request, 'reviewed_at') || own(request, 'approval_date'));
    case 'final_approval_date': return date(own(request, 'final_approval_date'));
    case 'submission_date': return date(own(request, 'submission_date'));
    default: return own(request, key) ?? '';
  }
}

// Preserve the caller's recorded request order and duplicate labels. This
// function never chooses an order for an unsorted historical source cursor.
export function trDataUuid(requests, { productLineId, reportType, parameterId } = {}) {
  if (!productLineId) return '';
  const matching = requests.filter((request) => own(request, 'product_unique_id') === productLineId);
  let selected = reportType === 'parameter_wise' ? matching.filter((request) => own(request, 'param_id') === parameterId)
    : matching.filter((request) => own(request, 'is_job') === true);
  if (!selected.length && reportType !== 'parameter_wise') selected = matching.filter((request) => own(request, 'is_job') !== true);
  return selected.map((request) => own(request, 'uuid')).filter(Boolean).join(', ');
}
