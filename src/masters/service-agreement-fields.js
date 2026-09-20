export const serviceAgreementServices = Object.freeze([
  Object.freeze({ value: 'calibration', label: 'Calibration' }),
  Object.freeze({ value: 'preventivemaintenance', label: 'Preventive Maintenance' }),
  Object.freeze({ value: 'breakdown', label: 'Breakdown' }),
]);

export const serviceAgreementDateDisplay = value => value ? value.split('-').reverse().join('/') : '';
