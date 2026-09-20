// Instrument service types are a fixed set, not an organization-configurable list.
// Breakdown events are tracked through their own instrument_breakdown_logs table/API
// (see equipment-logs/service.js) rather than through the generic service log, but
// "breakdown" is still one of the three schedulable per-instrument service definitions
// (instrument_version_services.service_code) surfaced on the Instrument form/detail page.
export const instrumentServiceTypeCatalog = Object.freeze([
  Object.freeze({ id: 'preventive_maintenance', serviceCode: 'preventive_maintenance', label: 'Preventive Maintenance' }),
  Object.freeze({ id: 'breakdown', serviceCode: 'breakdown', label: 'Breakdown' }),
  Object.freeze({ id: 'calibration', serviceCode: 'calibration', label: 'Calibration' }),
]);

export const loggableInstrumentServiceCodes = Object.freeze(
  instrumentServiceTypeCatalog.filter((type) => type.serviceCode !== 'breakdown').map((type) => type.serviceCode));
