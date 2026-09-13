// Source Role Master controls for included modules. These flags are separate
// from API permission codes; selecting a flag never grants unrelated APIs.
export const roleCapabilityDefinitions = Object.freeze([
  { key: 'can_admin', label: 'Is Admin?', badgeLabel: 'CAN ADMIN' },
  { key: 'is_creator', label: 'Is Creator?' },
  { key: 'can_access_all_ds', label: 'Access all Datasheets?', badgeLabel: 'CAN ACCESS ALL DS' },
  { key: 'can_access_sample_listing', label: 'Access Samples Listing?', badgeLabel: 'CAN ACCESS SAMPLE LISTING' },
  { key: 'show_in_ds_allocation', label: 'Show for DS Allocation?', badgeLabel: 'SHOW IN DS ALLOCATION' },
  { key: 'can_self_allocate', label: 'Can Self Allocate?', badgeLabel: 'CAN SELF ALLOCATE', settingKey: 'selfAllocationEnabled' },
  { key: 'show_sample_id_in_tr_listing', label: 'Show Sample ID in TR Listing?', badgeLabel: 'SHOW SAMPLE ID IN TR LISTING' },
  { key: 'can_config_datasheets', label: 'Can Config Datasheets?', badgeLabel: 'CAN CONFIG DATASHEETS' },
  { key: 'show_pf_data', label: 'Show Pf Data?', badgeLabel: 'SHOW PF DATA' },
  { key: 'can_view_customer_details', label: 'Can view Customer Details?', badgeLabel: 'CAN VIEW CUSTOMER DETAILS' },
  { key: 'can_create_amendment', label: 'Can Create Amendment?', badgeLabel: 'CAN CREATE AMENDMENT' },
  { key: 'can_create_complaint', label: 'Can Create Complaint?', badgeLabel: 'CAN CREATE COMPLAINT' },
  { key: 'can_print_acknowledgement', label: 'Can Print Acknowledgement?', badgeLabel: 'CAN PRINT ACKNOWLEDGEMENT' },
  { key: 'can_generate_adhoc_test_req', label: 'Can generate Adhoc TR?', badgeLabel: 'CAN GENERATE ADHOC TEST REQ' },
  { key: 'can_dispose_samples', label: 'Can Dispose Samples?', badgeLabel: 'CAN DISPOSE SAMPLES' },
  { key: 'can_access_instruments_all', label: 'Can Access All Instruments (Irrespective of labs)?', badgeLabel: 'CAN ACCESS ALL INSTRUMENTS' },
  { key: 'can_access_instruments_my_lab', label: 'Can Access Instruments of my Lab Only?', badgeLabel: 'CAN ACCESS MY LAB INSTRUMENTS' },
  { key: 'can_create_sample', label: 'Can Create Sample?', badgeLabel: 'CAN CREATE SAMPLE' },
].map(Object.freeze));

export const roleCapabilityKeys = Object.freeze(roleCapabilityDefinitions.map((definition) => definition.key));
export const roleCapabilityByKey = Object.freeze(Object.fromEntries(roleCapabilityDefinitions.map((definition) => [definition.key, definition])));

// Meteor's badge order differs from the form field order.
export const roleBadgeKeys = Object.freeze(['can_admin', 'can_create_sample', 'can_access_all_ds', 'can_access_sample_listing',
  'show_in_ds_allocation', 'can_self_allocate', 'show_sample_id_in_tr_listing', 'can_create_amendment', 'can_create_complaint',
  'can_view_customer_details', 'can_print_acknowledgement', 'can_generate_adhoc_test_req', 'can_config_datasheets', 'show_pf_data',
  'can_dispose_samples', 'can_access_instruments_all', 'can_access_instruments_my_lab']);

export function visibleRoleCapabilities(settings) {
  return roleCapabilityDefinitions.filter((definition) => !definition.settingKey || settings?.[definition.settingKey]);
}

export function roleBadges(capabilityKeys = [], settings) {
  const selected = new Set(capabilityKeys);
  return roleBadgeKeys.map((key) => roleCapabilityByKey[key])
    .filter((definition) => selected.has(definition.key) && (!definition.settingKey || settings?.[definition.settingKey]));
}
