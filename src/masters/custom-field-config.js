export const customFieldTypes = [
  ['text', 'Text'], ['number', 'Number'], ['date', 'Date'], ['select', 'Dropdown/Select'],
  ['lookup', 'Lookup'], ['longtext', 'Long Text'], ['attachment', 'Attachment'],
  ['multi_user_select', 'Multi User Select'], ['date_time', 'Date Time'], ['checkbox', 'Checkbox'], ['email', 'Email'],
].map(([value, label]) => ({ value, label }));

// Associations from the source editor that belong to included modules.
export const customFieldAssociations = [
  ['customer', 'Customer'], ['decision_rule', 'Decision Rule'], ['equipment_log', 'Equipment Log'],
  ['equipment_service_log', 'Equipment Service Log'], ['instrument', 'Instrument'], ['moa_parameter', 'MOA for Parameter'],
  ['parameter', 'Parameter'], ['product', 'Product'], ['sample', 'Sample'], ['sample_parameter', 'Sample-Parameter'],
  ['sample_product', 'Sample-Product'], ['users', 'Users'], ['vendor', 'Vendor'],
].map(([value, label]) => ({ value, label }));

// Existing included consumers also read these associations; they were absent from the editor choices.
export const customFieldLegacyAssociations = [
  { value: 'method_of_analysis', label: 'Method of Analysis' }, { value: 'equipment', label: 'Equipment' },
];

export const customFieldDateFormats = [
  ['DD/MM/YYYY', '01/01/2026'], ['MM/DD/YYYY', '12/31/2026'], ['YYYY-MM-DD', '2026-12-31'],
  ['DD-MM-YYYY', '31-12-2026'], ['MM-DD-YYYY', '12-31-2026'], ['YYYY/MM/DD', '2026/12/31'],
  ['DD.MM.YYYY', '31.12.2026'], ['MM.DD.YYYY', '12.31.2026'], ['DD MMM YYYY', '31 Dec 2026'],
  ['MMM DD, YYYY', 'Dec 31, 2026'], ['DD MMMM YYYY', '31 December 2026'], ['MMMM DD, YYYY', 'December 31, 2026'],
  ['MMMM Do YYYY', 'December 31st 2026'], ['D MMM YYYY', '31 Dec 2026'], ['Do MMMM YYYY', '31st December 2026'],
].map(([value, example]) => ({ value, label: `${example} (${value})` }));

export const customFieldDateTimeFormats = [
  ['DD/MM/YYYY HH:mm:ss', '01/01/2026 12:00:00'], ['DD/MM/YYYY HH:mm', '31/12/2026 23:30'],
  ['DD/MM/YYYY, HH:mm', '31/12/2026, 23:30'], ['DD/MM/YYYY hh:mm A', '31/12/2026 11:30 PM'],
  ['DD/MM/YYYY, hh:mm A', '31/12/2026, 11:30 PM'], ['MM/DD/YYYY HH:mm', '12/31/2026 23:30'],
  ['MM/DD/YYYY hh:mm A', '12/31/2026 11:30 PM'], ['YYYY-MM-DD HH:mm', '2026-12-31 23:30'],
  ['YYYY-MM-DD hh:mm A', '2026-12-31 11:30 PM'], ['DD-MM-YYYY HH:mm', '31-12-2026 23:30'],
  ['DD-MM-YYYY hh:mm A', '31-12-2026 11:30 PM'], ['DD MMM YYYY HH:mm', '31 Dec 2026 23:30'],
  ['DD MMM YYYY hh:mm A', '31 Dec 2026 11:30 PM'], ['MMM DD, YYYY HH:mm', 'Dec 31, 2026 23:30'],
  ['MMM DD, YYYY hh:mm A', 'Dec 31, 2026 11:30 PM'], ['DD MMMM YYYY HH:mm', '31 December 2026 23:30'],
  ['DD MMMM YYYY hh:mm A', '31 December 2026 11:30 PM'], ['MMMM DD, YYYY HH:mm', 'December 31, 2026 23:30'],
  ['MMMM DD, YYYY hh:mm A', 'December 31, 2026 11:30 PM'], ['MMMM Do YYYY | HH:mm', 'December 31st 2026 | 23:30'],
  ['MMMM Do YYYY | hh:mm A', 'December 31st 2026 | 11:30 PM'], ['YYYY-MM-DD HH:mm:ss', '2026-12-31 23:30:45'],
].map(([value, example]) => ({ value, label: `${example} (${value})` }));

export const customFieldGenerationTimes = [
  ['on_demand', 'On Demand - User will get a button to generate it'],
  ['on_init', 'On Init - When the entity is created'],
  ['on_submit', 'On First Save - When entity is saved for the first time'],
  ['on_transition', 'On First Transition - When state transition is requested for the first time'],
  ['on_transition_success', 'On First Successful Transition - When the first state transition requested is accepted'],
].map(([value, label]) => ({ value, label }));
