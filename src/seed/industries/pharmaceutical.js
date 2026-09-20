/**
 * Pharmaceutical QC laboratory.
 *
 * Refs are prefixed `ph_` so several industries can be seeded into one
 * organization without colliding.
 */

const pharmaceutical = {
  key: 'pharmaceutical',

  labs: [
    { ref: 'ph_lab_ad', name: 'Analytical Development Laboratory', abbreviation: 'AD' },
  ],

  categories: [
    { ref: 'ph_cat_rm', name: 'Raw Material', abbr: 'RM', retention_days: 180, estimated_time_in_days: 5, description: 'Incoming active ingredients and excipients.' },
    { ref: 'ph_cat_fp', name: 'Finished Product', abbr: 'FP', retention_days: 730, estimated_time_in_days: 7, description: 'Released dosage forms ready for dispatch.' },
    { ref: 'ph_cat_st', name: 'Stability Sample', abbr: 'ST', retention_days: 1095, estimated_time_in_days: 10, description: 'Samples held under ICH stability conditions.' },
    { ref: 'ph_cat_ip', name: 'In-Process Sample', abbr: 'IP', retention_days: 90, estimated_time_in_days: 3, description: 'Samples drawn during manufacturing stages.' },
    { ref: 'ph_cat_pm', name: 'Packaging Material', abbr: 'PM', retention_days: 365, estimated_time_in_days: 4, description: 'Primary and secondary packaging components.' },
  ],

  products: [
    { ref: 'ph_p_para', name: 'Paracetamol Tablets 500 mg', key: 'PH-PARA500', abbr: 'PARA', description: 'Film coated analgesic and antipyretic tablets.' },
    { ref: 'ph_p_ibu', name: 'Ibuprofen Tablets 200 mg', key: 'PH-IBU200', abbr: 'IBU', description: 'Non-steroidal anti-inflammatory tablets.' },
    { ref: 'ph_p_amox', name: 'Amoxicillin Capsules 500 mg', key: 'PH-AMOX500', abbr: 'AMOX', description: 'Broad spectrum antibiotic hard gelatin capsules.' },
    { ref: 'ph_p_nacl', name: 'Sodium Chloride Injection IP 0.9% w/v', key: 'PH-NACL09', abbr: 'NACL', description: 'Sterile isotonic intravenous infusion.' },
    { ref: 'ph_p_met', name: 'Metformin Hydrochloride Tablets 500 mg', key: 'PH-MET500', abbr: 'MET', description: 'Extended release antidiabetic tablets.' },
    { ref: 'ph_p_azi', name: 'Azithromycin Tablets 250 mg', key: 'PH-AZI250', abbr: 'AZI', description: 'Macrolide antibiotic film coated tablets.' },
    { ref: 'ph_p_cet', name: 'Cetirizine Hydrochloride Tablets 10 mg', key: 'PH-CET10', abbr: 'CET', description: 'Second generation antihistamine tablets.' },
    { ref: 'ph_p_pan', name: 'Pantoprazole Sodium Injection 40 mg', key: 'PH-PAN40', abbr: 'PAN', description: 'Lyophilised proton pump inhibitor for injection.' },
    { ref: 'ph_p_asc', name: 'Ascorbic Acid Tablets 500 mg', key: 'PH-ASC500', abbr: 'ASC', description: 'Vitamin C chewable tablets.' },
    { ref: 'ph_p_lact', name: 'Lactose Monohydrate IP', key: 'PH-LACT', abbr: 'LACT', description: 'Directly compressible excipient grade lactose.' },
  ],

  parameters: [
    { ref: 'ph_t_desc', name: 'Description', key: 'PH-DESC', scheme_abbr: 'PDS', order: 10, lab: 'lab_chem', description: 'Appearance, colour and physical form.' },
    { ref: 'ph_t_ident', name: 'Identification', key: 'PH-IDENT', scheme_abbr: 'PID', order: 20, lab: 'ph_lab_ad', description: 'Confirmation of identity against reference standard.' },
    { ref: 'ph_t_assay', name: 'Assay', key: 'PH-ASSAY', scheme_abbr: 'PAS', order: 30, lab: 'lab_chem', description: 'Content of active pharmaceutical ingredient.' },
    { ref: 'ph_t_dissolution', name: 'Dissolution', key: 'PH-DISS', scheme_abbr: 'PDI', order: 40, lab: 'lab_chem', description: 'Drug release profile in the specified medium.' },
    { ref: 'ph_t_related', name: 'Related Substances', key: 'PH-RELSUB', scheme_abbr: 'PRS', order: 50, lab: 'ph_lab_ad', description: 'Known and unknown impurity content.' },
    { ref: 'ph_t_weight', name: 'Uniformity of Weight', key: 'PH-UOW', scheme_abbr: 'PUW', order: 60, lab: 'lab_phys', description: 'Average weight and deviation across units.' },
    { ref: 'ph_t_lod', name: 'Loss on Drying', key: 'PH-LOD', scheme_abbr: 'PLD', order: 70, lab: 'lab_chem', description: 'Volatile matter lost on drying.' },
    { ref: 'ph_t_water', name: 'Water Content', key: 'PH-WATER', scheme_abbr: 'PWC', order: 80, lab: 'ph_lab_ad', description: 'Moisture content by Karl Fischer titration.' },
    { ref: 'ph_t_hardness', name: 'Hardness', key: 'PH-HARD', scheme_abbr: 'PHD', order: 90, lab: 'lab_phys', description: 'Crushing strength of the dosage unit.' },
    { ref: 'ph_t_friability', name: 'Friability', key: 'PH-FRIA', scheme_abbr: 'PFR', order: 100, lab: 'lab_phys', description: 'Weight loss on mechanical abrasion.' },
    { ref: 'ph_t_disint', name: 'Disintegration Time', key: 'PH-DISINT', scheme_abbr: 'PDT', order: 110, lab: 'lab_phys', description: 'Time to disintegrate in the specified medium.' },
    { ref: 'ph_t_ph', name: 'pH', key: 'PH-PH', scheme_abbr: 'PPH', order: 120, lab: 'lab_chem', description: 'Hydrogen ion concentration of the solution.' },
    { ref: 'ph_t_particulate', name: 'Particulate Matter', key: 'PH-PMAT', scheme_abbr: 'PPM', order: 130, lab: 'lab_instr', description: 'Sub visible particle count per container.' },
    { ref: 'ph_t_endotoxin', name: 'Bacterial Endotoxins', key: 'PH-ENDO', scheme_abbr: 'PEN', order: 140, lab: 'lab_micro', description: 'Endotoxin content by the LAL method.' },
    { ref: 'ph_t_sterility', name: 'Sterility', key: 'PH-STER', scheme_abbr: 'PST', order: 150, lab: 'lab_micro', description: 'Absence of viable micro organisms.' },
    { ref: 'ph_t_tamc', name: 'Total Aerobic Microbial Count', key: 'PH-TAMC', scheme_abbr: 'PTA', order: 160, lab: 'lab_micro', description: 'Aerobic bacterial count per unit.' },
  ],

  methods: [
    { ref: 'ph_m_hplc', name: 'Assay by HPLC', uuid: 'PH/MOA/HPLC/001', description: 'Reverse phase HPLC assay, revision 2.0.', decimal_places: 2, parse_num: true, lab: 'lab_chem' },
    { ref: 'ph_m_uv', name: 'Assay by UV Spectrophotometry', uuid: 'PH/MOA/UV/002', description: 'UV absorbance assay at the specified wavelength, revision 1.3.', decimal_places: 2, parse_num: true, lab: 'lab_chem' },
    { ref: 'ph_m_dis', name: 'Dissolution - USP Apparatus II', uuid: 'PH/MOA/DIS/003', description: 'Paddle apparatus, 900 mL medium, 50 rpm, revision 1.1.', decimal_places: 1, parse_num: true, lab: 'lab_chem' },
    { ref: 'ph_m_rs', name: 'Related Substances by HPLC', uuid: 'PH/MOA/RS/004', description: 'Gradient HPLC impurity profiling, revision 2.1.', decimal_places: 3, parse_num: true, lab: 'ph_lab_ad' },
    { ref: 'ph_m_ir', name: 'Identification by Infrared Spectroscopy', uuid: 'PH/MOA/IR/005', description: 'FTIR comparison against the reference standard, revision 1.0.', decimal_places: 0, parse_num: false, lab: 'ph_lab_ad' },
    { ref: 'ph_m_kf', name: 'Water Content by Karl Fischer', uuid: 'PH/MOA/KF/006', description: 'Coulometric Karl Fischer titration, revision 1.2.', decimal_places: 2, parse_num: true, lab: 'ph_lab_ad' },
    { ref: 'ph_m_lod', name: 'Loss on Drying - Gravimetric', uuid: 'PH/MOA/LOD/007', description: 'Gravimetric determination at 105 degC, revision 1.0.', decimal_places: 2, parse_num: true, lab: 'lab_chem' },
    { ref: 'ph_m_ph', name: 'pH by Potentiometry', uuid: 'PH/MOA/PH/008', description: 'Calibrated potentiometric pH determination, revision 1.0.', decimal_places: 2, parse_num: true, lab: 'lab_chem' },
    { ref: 'ph_m_mb', name: 'Microbial Enumeration by Plate Count', uuid: 'PH/MOA/MB/009', description: 'Pour plate microbial enumeration, revision 1.4.', decimal_places: 0, parse_num: true, lab: 'lab_micro' },
    { ref: 'ph_m_ster', name: 'Sterility by Membrane Filtration', uuid: 'PH/MOA/ST/010', description: 'Membrane filtration sterility test, revision 2.0.', decimal_places: 0, parse_num: false, lab: 'lab_micro' },
    { ref: 'ph_m_phys', name: 'Physical Testing of Dosage Units', uuid: 'PH/MOA/PHY/011', description: 'Weight, hardness, friability and disintegration, revision 1.0.', decimal_places: 2, parse_num: true, lab: 'lab_phys' },
    { ref: 'ph_m_visual', name: 'Description by Visual Inspection', uuid: 'PH/MOA/VIS/012', description: 'Visual and organoleptic examination, revision 1.0.', decimal_places: 0, parse_num: false, lab: 'lab_chem' },
  ],

  equipment: [
    { ref: 'ph_e_hplc', name: 'HPLC System', key: 'PH-EQP-HPLC-01', make: 'Shimadzu', model_name: 'LC-2030C Plus', serial_number: 'SHZ-LC-4471', lab: 'lab_chem', calibration_agency: 'Precision Calibration Services' },
    { ref: 'ph_e_hplc2', name: 'HPLC System - Impurity Profiling', key: 'PH-EQP-HPLC-02', make: 'Agilent', model_name: '1260 Infinity II', serial_number: 'AGL-1260-8823', lab: 'ph_lab_ad', calibration_agency: 'Precision Calibration Services' },
    { ref: 'ph_e_uv', name: 'UV-Visible Spectrophotometer', key: 'PH-EQP-UV-01', make: 'Shimadzu', model_name: 'UV-1900i', serial_number: 'SHZ-UV-2210', lab: 'lab_chem', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'ph_e_balance', name: 'Analytical Balance', key: 'PH-EQP-BAL-01', make: 'Mettler Toledo', model_name: 'XPR205', serial_number: 'MT-XPR-9014', lab: 'lab_chem', calibration_agency: 'National Weights and Measures' },
    { ref: 'ph_e_dissolution', name: 'Dissolution Tester', key: 'PH-EQP-DIS-01', make: 'Electrolab', model_name: 'TDT-08L', serial_number: 'EL-TDT-3376', lab: 'lab_chem', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'ph_e_ph', name: 'pH Meter', key: 'PH-EQP-PH-01', make: 'Mettler Toledo', model_name: 'SevenExcellence', serial_number: 'MT-PH-5520', lab: 'lab_chem', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'ph_e_kf', name: 'Karl Fischer Titrator', key: 'PH-EQP-KF-01', make: 'Metrohm', model_name: '917 Coulometer', serial_number: 'MH-917-7742', lab: 'ph_lab_ad', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'ph_e_oven', name: 'Hot Air Oven', key: 'PH-EQP-OVN-01', make: 'Thermolab', model_name: 'TL-HAO-200', serial_number: 'TL-HAO-6650', lab: 'lab_chem', calibration_agency: 'Thermal Validation Services' },
    { ref: 'ph_e_autoclave', name: 'Autoclave', key: 'PH-EQP-ACL-01', make: 'Equitron', model_name: 'Medica 7431', serial_number: 'EQ-ACL-1027', lab: 'lab_micro', calibration_agency: 'Thermal Validation Services' },
    { ref: 'ph_e_laf', name: 'Laminar Air Flow Unit', key: 'PH-EQP-LAF-01', make: 'Klenzaids', model_name: 'KA-LAF-4', serial_number: 'KZ-LAF-3391', lab: 'lab_micro', calibration_agency: 'Cleanroom Compliance Services' },
    { ref: 'ph_e_hardness', name: 'Tablet Hardness Tester', key: 'PH-EQP-HRD-01', make: 'Electrolab', model_name: 'EH-01P', serial_number: 'EL-EH-8842', lab: 'lab_phys', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'ph_e_friability', name: 'Friability Test Apparatus', key: 'PH-EQP-FRB-01', make: 'Electrolab', model_name: 'EF-2 DR', serial_number: 'EL-EF-5514', lab: 'lab_phys', calibration_agency: 'Metro Instruments Lab' },
  ],

  limits: {
    ph_t_desc: { min: '', max: '', uom: '', text: 'White to off-white film coated tablets', result: 'White to off-white film coated tablets' },
    ph_t_ident: { min: '', max: '', uom: '', text: 'Complies with the reference spectrum', result: 'Complies' },
    ph_t_assay: { min: '95.0', max: '105.0', uom: '%', result: '99.4' },
    ph_t_dissolution: { min: '80.0', max: '', uom: '%', result: '92.6' },
    ph_t_related: { min: '', max: '0.500', uom: '%', result: '0.128' },
    ph_t_weight: { min: '92.5', max: '107.5', uom: '%', result: '100.8' },
    ph_t_lod: { min: '', max: '5.00', uom: '% w/w', result: '1.24' },
    ph_t_water: { min: '', max: '5.00', uom: '% w/w', result: '2.11' },
    ph_t_hardness: { min: '40', max: '120', uom: 'N', result: '78' },
    ph_t_friability: { min: '', max: '1.00', uom: '% w/w', result: '0.28' },
    ph_t_disint: { min: '', max: '15', uom: 'minutes', result: '6' },
    ph_t_ph: { min: '4.50', max: '7.00', uom: '', result: '5.82' },
    ph_t_particulate: { min: '', max: '6000', uom: 'count/container', result: '1240' },
    ph_t_endotoxin: { min: '', max: '0.50', uom: 'EU/mg', result: '0.11' },
    ph_t_sterility: { min: '', max: '', uom: '', text: 'Sterile', result: 'Sterile' },
    ph_t_tamc: { min: '', max: '100', uom: 'CFU/g', result: '18' },
  },

  decisionRules: [
    {
      product: 'ph_p_para',
      category: 'ph_cat_fp',
      rows: [
        { parameter: 'ph_t_desc', moa: 'ph_m_visual', days: 1, charges: 250, instruments: [] },
        { parameter: 'ph_t_ident', moa: 'ph_m_ir', days: 2, charges: 900, instruments: ['ph_e_hplc2'] },
        { parameter: 'ph_t_assay', moa: 'ph_m_hplc', days: 3, charges: 1800, instruments: ['ph_e_hplc', 'ph_e_balance'] },
        { parameter: 'ph_t_dissolution', moa: 'ph_m_dis', days: 3, charges: 1500, instruments: ['ph_e_dissolution'] },
        { parameter: 'ph_t_weight', moa: 'ph_m_phys', days: 1, charges: 400, instruments: ['ph_e_balance'] },
        { parameter: 'ph_t_related', moa: 'ph_m_rs', days: 4, charges: 2600, instruments: ['ph_e_hplc2'] },
      ],
    },
    {
      product: 'ph_p_ibu',
      category: 'ph_cat_fp',
      rows: [
        { parameter: 'ph_t_desc', moa: 'ph_m_visual', days: 1, charges: 250, instruments: [] },
        { parameter: 'ph_t_assay', moa: 'ph_m_uv', days: 2, charges: 1200, instruments: ['ph_e_uv', 'ph_e_balance'] },
        { parameter: 'ph_t_dissolution', moa: 'ph_m_dis', days: 3, charges: 1500, instruments: ['ph_e_dissolution'] },
        { parameter: 'ph_t_hardness', moa: 'ph_m_phys', days: 1, charges: 350, instruments: ['ph_e_hardness'] },
        { parameter: 'ph_t_friability', moa: 'ph_m_phys', days: 1, charges: 350, instruments: ['ph_e_friability'] },
        { parameter: 'ph_t_disint', moa: 'ph_m_phys', days: 1, charges: 400, instruments: [] },
      ],
    },
    {
      product: 'ph_p_amox',
      category: 'ph_cat_rm',
      rows: [
        { parameter: 'ph_t_desc', moa: 'ph_m_visual', days: 1, charges: 250, instruments: [] },
        { parameter: 'ph_t_ident', moa: 'ph_m_ir', days: 2, charges: 900, instruments: [] },
        { parameter: 'ph_t_assay', moa: 'ph_m_hplc', days: 3, charges: 1900, instruments: ['ph_e_hplc', 'ph_e_balance'] },
        { parameter: 'ph_t_water', moa: 'ph_m_kf', days: 2, charges: 1100, instruments: ['ph_e_kf'] },
        { parameter: 'ph_t_lod', moa: 'ph_m_lod', days: 2, charges: 600, instruments: ['ph_e_oven', 'ph_e_balance'] },
        { parameter: 'ph_t_tamc', moa: 'ph_m_mb', days: 5, charges: 1400, instruments: ['ph_e_autoclave', 'ph_e_laf'] },
      ],
    },
    {
      product: 'ph_p_nacl',
      category: 'ph_cat_fp',
      rows: [
        { parameter: 'ph_t_desc', moa: 'ph_m_visual', days: 1, charges: 250, instruments: [] },
        { parameter: 'ph_t_assay', moa: 'ph_m_hplc', days: 3, charges: 1700, instruments: ['ph_e_hplc'] },
        { parameter: 'ph_t_ph', moa: 'ph_m_ph', days: 1, charges: 450, instruments: ['ph_e_ph'] },
        { parameter: 'ph_t_particulate', moa: 'ph_m_visual', days: 2, charges: 950, instruments: [] },
        { parameter: 'ph_t_endotoxin', moa: 'ph_m_mb', days: 3, charges: 2100, instruments: ['ph_e_laf'] },
        { parameter: 'ph_t_sterility', moa: 'ph_m_ster', days: 14, charges: 3200, instruments: ['ph_e_autoclave', 'ph_e_laf'] },
      ],
    },
    {
      product: 'ph_p_lact',
      category: 'ph_cat_rm',
      rows: [
        { parameter: 'ph_t_desc', moa: 'ph_m_visual', days: 1, charges: 200, instruments: [] },
        { parameter: 'ph_t_ident', moa: 'ph_m_ir', days: 2, charges: 850, instruments: [] },
        { parameter: 'ph_t_water', moa: 'ph_m_kf', days: 2, charges: 1000, instruments: ['ph_e_kf'] },
        { parameter: 'ph_t_lod', moa: 'ph_m_lod', days: 2, charges: 550, instruments: ['ph_e_oven'] },
        { parameter: 'ph_t_tamc', moa: 'ph_m_mb', days: 5, charges: 1300, instruments: ['ph_e_autoclave', 'ph_e_laf'] },
      ],
    },
  ],

  customers: [
    { ref: 'ph_c_zenith', name: 'Zenith Healthcare Limited', abbr: 'ZHL', city: 'Ahmedabad', state: 'Gujarat' },
    { ref: 'ph_c_nimbus', name: 'Nimbus Life Sciences Pvt Ltd', abbr: 'NLS', city: 'Pune', state: 'Maharashtra' },
    { ref: 'ph_c_crescent', name: 'Crescent Formulations Limited', abbr: 'CFL', city: 'Hyderabad', state: 'Telangana' },
    { ref: 'ph_c_vertex', name: 'Vertex Biotech Pvt Ltd', abbr: 'VBT', city: 'Bengaluru', state: 'Karnataka' },
  ],

  batchSizes: ['100000 tablets', '250000 tablets', '50000 capsules', '20000 vials'],
  manufacturers: ['Apex Pharma Laboratories - Unit I', 'Apex Pharma Laboratories - Unit II'],

  /**
   * What each method consumes per test, keyed by method ref. Written to the
   * method's `moa_line_items`, which is what the allocation modal reports as
   * required quantity and what `deductMaterials` issues on datasheet creation.
   * Methods absent from this map consume nothing.
   */
  methodMaterials: {
    ph_m_hplc: [
      { material: 'ph_mat_acn', quantity: '0.6' },
      { material: 'ph_mat_kh2po4', quantity: '3' },
      { material: 'ph_mat_vial', quantity: '0.05' },
    ],
    ph_m_rs: [
      { material: 'ph_mat_acn', quantity: '0.9' },
      { material: 'ph_mat_filter', quantity: '0.1' },
    ],
    ph_m_uv: [
      { material: 'ph_mat_meoh', quantity: '0.25' },
      { material: 'ph_mat_std_para', quantity: '0.1' },
    ],
    ph_m_dis: [
      { material: 'ph_mat_kh2po4', quantity: '9' },
      { material: 'ph_mat_filter', quantity: '0.2' },
    ],
    ph_m_ir: [{ material: 'ph_mat_std_ibu', quantity: '0.05' }],
    ph_m_kf: [{ material: 'ph_mat_meoh', quantity: '0.1' }],
    ph_m_mb: [{ material: 'ph_mat_scdm', quantity: '35' }],
    ph_m_ster: [{ material: 'ph_mat_scdm', quantity: '50' }],
  },

  materials: [
    { ref: 'ph_mat_acn', name: 'Acetonitrile HPLC Grade', key: 'PH-ACN', category: 'mc_reagent', unit: 'Litres', initial_qty: '40', min_qty: '10' },
    { ref: 'ph_mat_meoh', name: 'Methanol HPLC Grade', key: 'PH-MEOH', category: 'mc_reagent', unit: 'Litres', initial_qty: '35', min_qty: '10' },
    { ref: 'ph_mat_kh2po4', name: 'Potassium Dihydrogen Phosphate AR', key: 'PH-KH2PO4', category: 'mc_reagent', unit: 'Grams', initial_qty: '2000', min_qty: '500' },
    { ref: 'ph_mat_std_para', name: 'Paracetamol Working Standard', key: 'PH-WS-PARA', category: 'mc_standard', unit: 'Grams', initial_qty: '25', min_qty: '5' },
    { ref: 'ph_mat_std_ibu', name: 'Ibuprofen Working Standard', key: 'PH-WS-IBU', category: 'mc_standard', unit: 'Grams', initial_qty: '20', min_qty: '5' },
    { ref: 'ph_mat_scdm', name: 'Soyabean Casein Digest Medium', key: 'PH-SCDM', category: 'mc_media', unit: 'Grams', initial_qty: '2500', min_qty: '600' },
    { ref: 'ph_mat_filter', name: 'PVDF Syringe Filter 0.45 um', key: 'PH-FLT-045', category: 'mc_consumable', unit: 'Packets', initial_qty: '30', min_qty: '8' },
    { ref: 'ph_mat_vial', name: 'HPLC Vial 2 mL With Septa', key: 'PH-VIAL-2', category: 'mc_consumable', unit: 'Boxes', initial_qty: '18', min_qty: '4' },
    { ref: 'ph_mat_volflask', name: 'Volumetric Flask 100 mL Class A', key: 'PH-VF-100', category: 'mc_glassware', unit: 'Units', initial_qty: '60', min_qty: '15' },
  ],

  scenarios: [
    { ref: 'ph_s1', product: 'ph_p_para', category: 'ph_cat_fp', customer: 'ph_c_zenith', batch: 'PT-2401', parameters: ['ph_t_desc', 'ph_t_ident', 'ph_t_assay', 'ph_t_dissolution', 'ph_t_weight', 'ph_t_related'], allocation: 'job', flow: 'coa' },
    { ref: 'ph_s2', product: 'ph_p_ibu', category: 'ph_cat_fp', customer: 'ph_c_nimbus', batch: 'IB-2402', parameters: ['ph_t_desc', 'ph_t_assay', 'ph_t_dissolution', 'ph_t_hardness', 'ph_t_friability', 'ph_t_disint'], allocation: 'job', flow: 'coa' },
    { ref: 'ph_s3', product: 'ph_p_amox', category: 'ph_cat_rm', customer: 'ph_c_crescent', batch: 'AM-2403', parameters: ['ph_t_desc', 'ph_t_ident', 'ph_t_assay', 'ph_t_water', 'ph_t_lod', 'ph_t_tamc'], allocation: 'individual', flow: 'approved' },
    { ref: 'ph_s4', product: 'ph_p_nacl', category: 'ph_cat_fp', customer: 'ph_c_vertex', batch: 'NC-2404', parameters: ['ph_t_desc', 'ph_t_assay', 'ph_t_ph', 'ph_t_particulate', 'ph_t_endotoxin', 'ph_t_sterility'], allocation: 'job', flow: 'pending_approval' },
    { ref: 'ph_s5', product: 'ph_p_lact', category: 'ph_cat_rm', customer: 'ph_c_crescent', batch: 'LC-2405', parameters: ['ph_t_desc', 'ph_t_ident', 'ph_t_water', 'ph_t_lod', 'ph_t_tamc'], allocation: 'individual', flow: 'submitted', delayedByDays: 4 },
    { ref: 'ph_s6', product: 'ph_p_para', category: 'ph_cat_st', customer: 'ph_c_zenith', batch: 'PT-2312', parameters: ['ph_t_assay', 'ph_t_dissolution', 'ph_t_related'], allocation: 'job', flow: 'approved' },
    { ref: 'ph_s7', product: 'ph_p_ibu', category: 'ph_cat_ip', customer: 'ph_c_nimbus', batch: 'IB-2402-IP', parameters: ['ph_t_hardness', 'ph_t_friability', 'ph_t_disint'], allocation: 'individual', flow: 'results' },
    { ref: 'ph_s8', product: 'ph_p_nacl', category: 'ph_cat_fp', customer: 'ph_c_vertex', batch: 'NC-2407', parameters: ['ph_t_desc', 'ph_t_ph', 'ph_t_endotoxin'], allocation: 'job', flow: 'allocated', delayedByDays: 2 },
    { ref: 'ph_s9', product: 'ph_p_amox', category: 'ph_cat_rm', customer: 'ph_c_crescent', batch: 'AM-2411', parameters: ['ph_t_desc', 'ph_t_assay', 'ph_t_water'], allocation: 'individual', flow: 'generated' },
    { ref: 'ph_s10', product: 'ph_p_para', category: 'ph_cat_pm', customer: 'ph_c_zenith', batch: 'PT-2412', parameters: ['ph_t_desc', 'ph_t_weight'], allocation: 'individual', flow: 'registered' },
  ],

  multiProductScenario: {
    ref: 'ph_s11',
    category: 'ph_cat_fp',
    customer: 'ph_c_zenith',
    batch: 'MP-2413',
    allocation: 'job',
    flow: 'coa',
    reportType: 'product_wise',
    lines: [
      { product: 'ph_p_para', parameters: ['ph_t_desc', 'ph_t_assay', 'ph_t_dissolution'] },
      { product: 'ph_p_ibu', parameters: ['ph_t_desc', 'ph_t_assay', 'ph_t_hardness'] },
    ],
  },
};

export default pharmaceutical;
