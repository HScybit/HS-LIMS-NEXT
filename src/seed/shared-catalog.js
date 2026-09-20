/**
 * Shared seed catalog.
 *
 * Everything here is industry independent: the organisation chart, the core
 * laboratories, and the sample level custom fields. Products, parameters,
 * methods, instruments, acceptance limits and sample scenarios are
 * industry specific and live in `industries/`.
 *
 * All identities are synthetic.
 */

export const ROLES = [
  {
    ref: 'lab_head',
    name: 'Lab Head',
    description: 'Heads a laboratory and signs off analytical work.',
    can_admin: false,
    is_creator: true,
    can_create_sample: true,
    can_access_sample_listing: true,
    can_access_all_ds: true,
    can_access_dms: true,
    can_config_datasheets: true,
    can_view_customer_details: true,
    can_print_acknowledgement: true,
    can_dispose_samples: true,
    can_access_instruments_all: true,
    show_in_ds_allocation: true,
    show_pf_data: true,
  },
  {
    ref: 'analyst',
    name: 'Analyst',
    description: 'Performs the analysis and records datasheet results.',
    can_access_sample_listing: true,
    show_in_ds_allocation: true,
    can_access_instruments_my_lab: true,
    show_sample_id_in_tr_listing: true,
  },
  {
    ref: 'reviewer',
    name: 'Reviewer',
    description: 'Reviews recorded results before quality approval.',
    can_access_sample_listing: true,
    can_access_all_ds: true,
    show_in_ds_allocation: true,
    can_access_instruments_my_lab: true,
    show_sample_id_in_tr_listing: true,
  },
  {
    ref: 'qa_approver',
    name: 'QA Approver',
    description: 'Grants the final quality approval and releases reports.',
    can_access_sample_listing: true,
    can_access_all_ds: true,
    can_view_customer_details: true,
    can_create_amendment: true,
    can_create_complaint: true,
    show_pf_data: true,
  },
  {
    ref: 'sample_manager',
    name: 'Sample Manager',
    description: 'Registers incoming samples and manages retention.',
    can_create_sample: true,
    can_access_sample_listing: true,
    can_view_customer_details: true,
    can_print_acknowledgement: true,
    can_dispose_samples: true,
    can_generate_adhoc_test_req: true,
  },
  {
    ref: 'lab_assistant',
    name: 'Lab Assistant',
    description: 'Supports sample preparation and instrument upkeep.',
    can_access_sample_listing: true,
    can_access_instruments_my_lab: true,
  },
];

/**
 * Present in every seeded organization. Industry catalogs reference these refs
 * and add their own speciality laboratories on top.
 */
export const SHARED_LABS = [
  { ref: 'lab_chem', name: 'Chemical Testing Laboratory', abbreviation: 'CHM' },
  { ref: 'lab_micro', name: 'Microbiology Laboratory', abbreviation: 'MB' },
  { ref: 'lab_instr', name: 'Instrumentation Laboratory', abbreviation: 'INS' },
  { ref: 'lab_phys', name: 'Physical Testing Laboratory', abbreviation: 'PHY' },
];

export const LAB_ENVIRONMENT = {
  min_temperature: '20',
  max_temperature: '25',
  min_humidity: '40',
  max_humidity: '60',
};

/** Head of department per shared lab. */
export const LAB_HEADS = {
  lab_chem: 'u_labhead_chem',
  lab_micro: 'u_labhead_micro',
  lab_instr: 'u_labhead_chem',
  lab_phys: 'u_labhead_chem',
};

/**
 * Seeded users are identified by the organization and the job they do, never by
 * a person's name. `suffix` is appended to the organization slug to form the
 * username, and `roleLabel` is appended to the organization name to form the
 * display name - so "Universal Laboratory" produces `ulanalyst` /
 * "Universal Laboratory Analyst".
 */
export const USERS = [
  { ref: 'u_labhead_chem', suffix: 'labhead', roleLabel: 'Lab Head', designation: 'Head - Chemical Testing', role: 'lab_head', lab: 'lab_chem', can_be_manager: true },
  { ref: 'u_labhead_micro', suffix: 'labhead2', roleLabel: 'Lab Head 2', designation: 'Head - Microbiology', role: 'lab_head', lab: 'lab_micro', can_be_manager: true },
  { ref: 'u_analyst1', suffix: 'analyst', roleLabel: 'Analyst', designation: 'Senior Analyst', role: 'analyst', lab: 'lab_chem', manager: 'u_labhead_chem' },
  { ref: 'u_analyst2', suffix: 'analyst2', roleLabel: 'Analyst 2', designation: 'Analyst', role: 'analyst', lab: 'lab_chem', manager: 'u_labhead_chem' },
  { ref: 'u_analyst3', suffix: 'analyst3', roleLabel: 'Analyst 3', designation: 'Instrumentation Analyst', role: 'analyst', lab: 'lab_instr', manager: 'u_labhead_chem' },
  { ref: 'u_analyst4', suffix: 'analyst4', roleLabel: 'Analyst 4', designation: 'Microbiologist', role: 'analyst', lab: 'lab_micro', manager: 'u_labhead_micro' },
  { ref: 'u_reviewer1', suffix: 'reviewer', roleLabel: 'Reviewer', designation: 'Senior Reviewer', role: 'reviewer', lab: 'lab_chem', manager: 'u_labhead_chem' },
  { ref: 'u_reviewer2', suffix: 'reviewer2', roleLabel: 'Reviewer 2', designation: 'Reviewer - Instrumentation', role: 'reviewer', lab: 'lab_instr', manager: 'u_labhead_chem' },
  { ref: 'u_reviewer3', suffix: 'reviewer3', roleLabel: 'Reviewer 3', designation: 'Reviewer - Microbiology', role: 'reviewer', lab: 'lab_micro', manager: 'u_labhead_micro' },
  { ref: 'u_approver', suffix: 'approver', roleLabel: 'Approver', designation: 'Manager - Quality Assurance', role: 'qa_approver', lab: 'lab_chem', can_be_manager: true },
  { ref: 'u_creator', suffix: 'creator', roleLabel: 'Creator', designation: 'Sample Custodian', role: 'sample_manager', lab: 'lab_chem', manager: 'u_approver' },
  { ref: 'u_assistant', suffix: 'assistant', roleLabel: 'Assistant', designation: 'Lab Assistant', role: 'lab_assistant', lab: 'lab_phys', manager: 'u_labhead_chem' },
];

/** The user who registers seeded samples. */
export const SAMPLE_RECEIVER_REF = 'u_creator';

/** Analysts a seeded sample can be allocated to, used round robin. */
export const ANALYST_REFS = ['u_analyst1', 'u_analyst2', 'u_analyst3', 'u_analyst4'];


const FALLBACK_EMAIL_TLD = 'example';

/**
 * Short, lowercase handle for an organization.
 *
 *   "Universal Laboratory"      -> "ul"
 *   "Apex Pharma Laboratories"  -> "apl"
 *   "Universal"                 -> "universal"
 */
export function buildOrganizationSlug(name) {
  const words = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return 'lab';
  if (words.length === 1) return words[0].slice(0, 12);

  return words.map((word) => word[0]).join('').slice(0, 6);
}

/**
 * Uses the organization's own domain when it can form a valid email address,
 * because `users.create` validates the address shape.
 */
export function buildUserEmailDomain(organization, slug) {
  const domain = String(organization?.domain || '').trim().toLowerCase();

  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain)) return domain;

  return `${slug}.${FALLBACK_EMAIL_TLD}`;
}

export const PROJECT_FIELDS = [
  {
    ref: 'pf_ar_number',
    name: 'AR Number',
    key: 'ar_number',
    data_type: 'text',
    associated_with: 'sample',
    generated_at: 'on_init',
    scheme: 'AR/{{current_year}}/{{samples_counter}}',
    show_in_list: true,
    show_in_report: true,
    order_index: 10,
  },
  {
    ref: 'pf_batch_number',
    name: 'Batch Number',
    key: 'batch_number',
    data_type: 'text',
    associated_with: 'sample',
    mandatory: true,
    show_in_list: true,
    show_in_filter: true,
    show_in_report: true,
    order_index: 20,
  },
  {
    ref: 'pf_mfg_date',
    name: 'Manufacturing Date',
    key: 'manufacturing_date',
    data_type: 'date',
    date_format: 'DD-MM-YYYY',
    associated_with: 'sample',
    show_in_report: true,
    order_index: 30,
  },
  {
    ref: 'pf_exp_date',
    name: 'Expiry Date',
    key: 'expiry_date',
    data_type: 'date',
    date_format: 'DD-MM-YYYY',
    associated_with: 'sample',
    show_in_report: true,
    order_index: 40,
  },
  {
    ref: 'pf_batch_size',
    name: 'Batch Size',
    key: 'batch_size',
    data_type: 'text',
    associated_with: 'sample_product',
    show_in_report: true,
    order_index: 50,
  },
  {
    ref: 'pf_manufacturer',
    name: 'Manufacturer',
    key: 'manufacturer',
    data_type: 'text',
    associated_with: 'sample_product',
    show_in_report: true,
    order_index: 60,
  },
  {
    // Decision rules hold min / max / uom separately, but a datasheet and a
    // certificate print one composed specification string. The decision rule
    // widget can read a decision-rule project field, so the composed text is
    // stored there rather than hard-coded into the template.
    ref: 'pf_specification',
    name: 'Specification',
    key: 'specification',
    data_type: 'text',
    associated_with: 'decision_rule',
    show_in_report: true,
    order_index: 70,
  },
  {
    // A `lookup` field draws its options from a Data Master. `data_master`
    // holds the catalog ref; `seedProjectFields` resolves it to the seeded id.
    // Note the lookup dropdown reads `DataMasterLine` rows and offers every
    // level flat - parent filtering only happens in the cascading widgets.
    ref: 'pf_storage_condition',
    name: 'Storage Condition',
    key: 'storage_condition',
    data_type: 'lookup',
    associated_with: 'sample',
    data_master: 'dm_storage_condition',
    show_in_list: true,
    show_in_filter: true,
    show_in_report: true,
    order_index: 80,
  },
];

/**
 * Data masters, including two with real depth.
 *
 * Items are declared with a `ref` and a `parent` ref; the seeder turns those
 * into the canonical embedded shape `{ value, name, parent_id, order }` where
 * `parent_id` points at the parent's generated `value`. Depth is just chain
 * length - nothing caps it.
 */
/**
 * Material categories are industry neutral - a reagent is a reagent - so they
 * live here rather than being repeated in every industry catalog. `expirable`
 * makes the transaction form demand an expiry date on receipts, and is what the
 * expiring-batch alert keys off.
 */
export const MATERIAL_CATEGORIES = [
  {
    ref: 'mc_reagent',
    name: 'Reagents and Chemicals',
    description: 'Analytical reagents, solvents and volumetric solutions.',
    reusable: false,
    expirable: true,
  },
  {
    ref: 'mc_standard',
    name: 'Reference Standards',
    description: 'Working and primary reference standards.',
    reusable: false,
    expirable: true,
  },
  {
    ref: 'mc_media',
    name: 'Culture Media',
    description: 'Prepared and dehydrated microbiological media.',
    reusable: false,
    expirable: true,
  },
  {
    ref: 'mc_consumable',
    name: 'Consumables',
    description: 'Filters, vials, columns and single-use labware.',
    reusable: false,
    expirable: false,
  },
  {
    ref: 'mc_glassware',
    name: 'Glassware',
    description: 'Volumetric and general laboratory glassware.',
    reusable: true,
    expirable: false,
  },
];

/** Suppliers named on material receipts, used round robin. */
export const MATERIAL_SUPPLIERS = [
  'Meridian Scientific Supplies',
  'Crestline Lab Chemicals',
  'Anchor Analytical Traders',
  'Provance Instruments and Consumables',
];

/**
 * Vendors that service instruments. Also industry neutral, and required by
 * `generate_vendor_list`: the New Service modal only offers a vendor that has a
 * service agreement covering the instrument and the service type.
 */
export const SERVICE_VENDORS = [
  {
    ref: 'sv_precision',
    name: 'Precision Calibration Services',
    services: ['calibration'],
    city: 'Pune',
  },
  {
    ref: 'sv_instrucare',
    name: 'InstruCare Maintenance',
    services: ['preventivemaintenance'],
    city: 'Ahmedabad',
  },
  {
    ref: 'sv_labtech',
    name: 'LabTech Total Support',
    services: ['calibration', 'preventivemaintenance'],
    city: 'Bengaluru',
  },
];

export const DATA_MASTERS = [
  {
    ref: 'dm_sampling_location',
    name: 'Sampling Location',
    description: 'Site, block and room a sample was drawn from.',
    items: [
      { ref: 'loc_north', name: 'North Plant' },
      { ref: 'loc_north_prod', name: 'Production Block', parent: 'loc_north' },
      { ref: 'loc_north_prod_gran', name: 'Granulation Room', parent: 'loc_north_prod' },
      { ref: 'loc_north_prod_comp', name: 'Compression Room', parent: 'loc_north_prod' },
      { ref: 'loc_north_ware', name: 'Warehouse Block', parent: 'loc_north' },
      { ref: 'loc_north_ware_raw', name: 'Raw Material Store', parent: 'loc_north_ware' },
      { ref: 'loc_north_ware_fin', name: 'Finished Goods Store', parent: 'loc_north_ware' },
      { ref: 'loc_south', name: 'South Plant' },
      { ref: 'loc_south_util', name: 'Utility Block', parent: 'loc_south' },
      { ref: 'loc_south_util_water', name: 'Purified Water Loop', parent: 'loc_south_util' },
      { ref: 'loc_south_util_air', name: 'Compressed Air Point', parent: 'loc_south_util' },
      { ref: 'loc_south_qc', name: 'Quality Control Block', parent: 'loc_south' },
      { ref: 'loc_south_qc_wet', name: 'Wet Chemistry Lab', parent: 'loc_south_qc' },
      { ref: 'loc_south_qc_instr', name: 'Instrumentation Lab', parent: 'loc_south_qc' },
    ],
  },
  {
    ref: 'dm_storage_condition',
    name: 'Storage Condition',
    description: 'Condition a sample is held under, grouped by regime.',
    items: [
      { ref: 'sc_ambient', name: 'Ambient' },
      { ref: 'sc_ambient_25', name: '25 C / 60% RH', parent: 'sc_ambient' },
      { ref: 'sc_ambient_30', name: '30 C / 65% RH', parent: 'sc_ambient' },
      { ref: 'sc_cold', name: 'Cold Chain' },
      { ref: 'sc_cold_2_8', name: '2 C to 8 C', parent: 'sc_cold' },
      { ref: 'sc_cold_frozen', name: 'Minus 20 C', parent: 'sc_cold' },
      { ref: 'sc_accel', name: 'Accelerated' },
      { ref: 'sc_accel_40', name: '40 C / 75% RH', parent: 'sc_accel' },
    ],
  },
  {
    ref: 'dm_sample_condition',
    name: 'Sample Condition On Receipt',
    description: 'Condition the sample was received in.',
    items: [
      { ref: 'cond_ok', name: 'Intact' },
      { ref: 'cond_ok_sealed', name: 'Seal Intact', parent: 'cond_ok' },
      { ref: 'cond_ok_labelled', name: 'Correctly Labelled', parent: 'cond_ok' },
      { ref: 'cond_issue', name: 'Discrepant' },
      { ref: 'cond_issue_seal', name: 'Seal Broken', parent: 'cond_issue' },
      { ref: 'cond_issue_label', name: 'Label Illegible', parent: 'cond_issue' },
      { ref: 'cond_issue_qty', name: 'Insufficient Quantity', parent: 'cond_issue' },
    ],
  },
];

/** Pharmacopoeial-style specification text for a parameter's limits. */
export function buildSpecificationText(limits = {}) {
  const unit = limits.uom ? ` ${limits.uom}` : '';

  if (limits.text) return limits.text;
  if (limits.min && limits.max) return `${limits.min} to ${limits.max}${unit}`;
  if (limits.max) return `Not more than ${limits.max}${unit}`;
  if (limits.min) return `Not less than ${limits.min}${unit}`;

  return 'Complies';
}
