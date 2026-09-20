/** Food, beverage and water testing laboratory. Refs are prefixed `fd_`. */

const foodBeverage = {
  key: 'food_beverage',

  labs: [
    { ref: 'fd_lab_food', name: 'Food Testing Laboratory', abbreviation: 'FOOD' },
  ],

  categories: [
    { ref: 'fd_cat_ri', name: 'Raw Ingredient', abbr: 'RIN', retention_days: 90, estimated_time_in_days: 4, description: 'Incoming ingredients and additives.' },
    { ref: 'fd_cat_ff', name: 'Finished Food Product', abbr: 'FFP', retention_days: 365, estimated_time_in_days: 6, description: 'Packed food ready for release.' },
    { ref: 'fd_cat_pb', name: 'Packaged Beverage', abbr: 'PBV', retention_days: 180, estimated_time_in_days: 5, description: 'Bottled and canned beverages.' },
    { ref: 'fd_cat_wtr', name: 'Water Sample', abbr: 'WTR', retention_days: 30, estimated_time_in_days: 3, description: 'Process and packaged drinking water.' },
    { ref: 'fd_cat_swb', name: 'Surface Swab', abbr: 'SWB', retention_days: 15, estimated_time_in_days: 3, description: 'Environmental monitoring swabs.' },
  ],

  products: [
    { ref: 'fd_p_oil', name: 'Refined Sunflower Oil', key: 'FD-SUNOIL', abbr: 'SNO', description: 'Refined, bleached and deodorised sunflower oil.' },
    { ref: 'fd_p_flour', name: 'Refined Wheat Flour (Maida)', key: 'FD-MAIDA', abbr: 'MDA', description: 'Bakery grade refined wheat flour.' },
    { ref: 'fd_p_water', name: 'Packaged Drinking Water 1 L', key: 'FD-PDW1L', abbr: 'PDW', description: 'Treated packaged drinking water.' },
    { ref: 'fd_p_juice', name: 'Mango Fruit Beverage 200 mL', key: 'FD-MNGJC', abbr: 'MJC', description: 'Pasteurised mango fruit drink.' },
    { ref: 'fd_p_milkpowder', name: 'Skimmed Milk Powder', key: 'FD-SMP', abbr: 'SMP', description: 'Spray dried skimmed milk powder.' },
    { ref: 'fd_p_rusk', name: 'Wheat Rusk', key: 'FD-RUSK', abbr: 'RSK', description: 'Twice baked wheat rusk.' },
    { ref: 'fd_p_salt', name: 'Iodised Table Salt', key: 'FD-ISALT', abbr: 'SLT', description: 'Free flowing iodised table salt.' },
    { ref: 'fd_p_ketchup', name: 'Tomato Ketchup', key: 'FD-KETCH', abbr: 'KTC', description: 'Tomato ketchup with permitted preservatives.' },
  ],

  parameters: [
    { ref: 'fd_t_moisture', name: 'Moisture', key: 'FD-MOIST', scheme_abbr: 'FMO', order: 10, lab: 'fd_lab_food', description: 'Moisture content by oven drying.' },
    { ref: 'fd_t_ash', name: 'Total Ash', key: 'FD-TASH', scheme_abbr: 'FAS', order: 20, lab: 'fd_lab_food', description: 'Total ash on a dry basis.' },
    { ref: 'fd_t_acid', name: 'Acid Value', key: 'FD-ACIDV', scheme_abbr: 'FAV', order: 30, lab: 'fd_lab_food', description: 'Free fatty acid content as mg KOH per gram.' },
    { ref: 'fd_t_peroxide', name: 'Peroxide Value', key: 'FD-PEROX', scheme_abbr: 'FPV', order: 40, lab: 'fd_lab_food', description: 'Primary oxidation products in fats and oils.' },
    { ref: 'fd_t_tpc', name: 'Total Plate Count', key: 'FD-TPC', scheme_abbr: 'FTP', order: 50, lab: 'lab_micro', description: 'Aerobic mesophilic plate count.' },
    { ref: 'fd_t_yeast', name: 'Yeast and Mould Count', key: 'FD-YMC', scheme_abbr: 'FYM', order: 60, lab: 'lab_micro', description: 'Yeast and mould enumeration.' },
    { ref: 'fd_t_coliform', name: 'Coliforms', key: 'FD-COLI', scheme_abbr: 'FCO', order: 70, lab: 'lab_micro', description: 'Coliform count per gram or millilitre.' },
    { ref: 'fd_t_salmonella', name: 'Salmonella', key: 'FD-SALM', scheme_abbr: 'FSL', order: 80, lab: 'lab_micro', description: 'Detection of Salmonella species.' },
    { ref: 'fd_t_brix', name: 'Total Soluble Solids', key: 'FD-BRIX', scheme_abbr: 'FBX', order: 90, lab: 'fd_lab_food', description: 'Total soluble solids as degrees Brix.' },
    { ref: 'fd_t_protein', name: 'Protein Content', key: 'FD-PROT', scheme_abbr: 'FPR', order: 100, lab: 'lab_chem', description: 'Crude protein by the Kjeldahl method.' },
    { ref: 'fd_t_fat', name: 'Total Fat', key: 'FD-FAT', scheme_abbr: 'FFT', order: 110, lab: 'lab_chem', description: 'Total fat by solvent extraction.' },
    { ref: 'fd_t_preservative', name: 'Added Preservatives', key: 'FD-PRSV', scheme_abbr: 'FPS', order: 120, lab: 'lab_instr', description: 'Benzoate and sorbate content.' },
    { ref: 'fd_t_lead', name: 'Lead', key: 'FD-PB', scheme_abbr: 'FPB', order: 130, lab: 'lab_instr', description: 'Lead content as a heavy metal contaminant.' },
    { ref: 'fd_t_iodine', name: 'Iodine Content', key: 'FD-IODN', scheme_abbr: 'FIO', order: 140, lab: 'fd_lab_food', description: 'Iodine as potassium iodate.' },
  ],

  methods: [
    { ref: 'fd_m_moisture', name: 'Moisture - Oven Drying', uuid: 'FD/MOA/MOI/001', description: 'Air oven drying at 105 degC to constant mass, revision 1.0.', decimal_places: 2, parse_num: true, lab: 'fd_lab_food' },
    { ref: 'fd_m_ash', name: 'Total Ash - Gravimetric', uuid: 'FD/MOA/ASH/002', description: 'Incineration at 550 degC, revision 1.0.', decimal_places: 2, parse_num: true, lab: 'fd_lab_food' },
    { ref: 'fd_m_acid', name: 'Acid Value - Titrimetric', uuid: 'FD/MOA/AV/003', description: 'Alcoholic potassium hydroxide titration, revision 1.1.', decimal_places: 2, parse_num: true, lab: 'fd_lab_food' },
    { ref: 'fd_m_peroxide', name: 'Peroxide Value - Iodometric', uuid: 'FD/MOA/PV/004', description: 'Iodometric titration with sodium thiosulphate, revision 1.0.', decimal_places: 2, parse_num: true, lab: 'fd_lab_food' },
    { ref: 'fd_m_plate', name: 'Microbial Enumeration - Pour Plate', uuid: 'FD/MOA/TPC/005', description: 'Pour plate technique, IS 5402, revision 1.2.', decimal_places: 0, parse_num: true, lab: 'lab_micro' },
    { ref: 'fd_m_ym', name: 'Yeast and Mould - Spread Plate', uuid: 'FD/MOA/YM/006', description: 'Spread plate on selective medium, IS 5403, revision 1.0.', decimal_places: 0, parse_num: true, lab: 'lab_micro' },
    { ref: 'fd_m_coliform', name: 'Coliforms - MPN Technique', uuid: 'FD/MOA/COL/007', description: 'Most probable number multiple tube technique, revision 1.0.', decimal_places: 0, parse_num: true, lab: 'lab_micro' },
    { ref: 'fd_m_salmonella', name: 'Salmonella Detection', uuid: 'FD/MOA/SAL/008', description: 'Pre-enrichment, selective enrichment and confirmation, revision 1.1.', decimal_places: 0, parse_num: false, lab: 'lab_micro' },
    { ref: 'fd_m_brix', name: 'Total Soluble Solids - Refractometry', uuid: 'FD/MOA/BRX/009', description: 'Digital refractometer at 20 degC, revision 1.0.', decimal_places: 1, parse_num: true, lab: 'fd_lab_food' },
    { ref: 'fd_m_kjeldahl', name: 'Protein by Kjeldahl', uuid: 'FD/MOA/PRT/010', description: 'Digestion, distillation and titration, revision 1.1.', decimal_places: 2, parse_num: true, lab: 'lab_chem' },
    { ref: 'fd_m_soxhlet', name: 'Total Fat by Soxhlet Extraction', uuid: 'FD/MOA/FAT/011', description: 'Continuous solvent extraction, revision 1.0.', decimal_places: 2, parse_num: true, lab: 'lab_chem' },
    { ref: 'fd_m_hplc', name: 'Preservatives by HPLC', uuid: 'FD/MOA/PRS/012', description: 'Reverse phase HPLC with UV detection, revision 1.1.', decimal_places: 1, parse_num: true, lab: 'lab_instr' },
    { ref: 'fd_m_aas', name: 'Lead by Atomic Absorption', uuid: 'FD/MOA/PB/013', description: 'Graphite furnace AAS after wet digestion, revision 1.2.', decimal_places: 3, parse_num: true, lab: 'lab_instr' },
    { ref: 'fd_m_iodine', name: 'Iodine - Titrimetric', uuid: 'FD/MOA/IOD/014', description: 'Iodometric titration of iodate, revision 1.0.', decimal_places: 1, parse_num: true, lab: 'fd_lab_food' },
  ],

  equipment: [
    { ref: 'fd_e_oven', name: 'Hot Air Oven', key: 'FD-EQP-OVN-01', make: 'Thermolab', model_name: 'TL-HAO-150', serial_number: 'TL-HAO-1129', lab: 'fd_lab_food', calibration_agency: 'Thermal Validation Services' },
    { ref: 'fd_e_muffle', name: 'Muffle Furnace', key: 'FD-EQP-MUF-01', make: 'Nabertherm', model_name: 'L 9/11', serial_number: 'NB-L9-4483', lab: 'fd_lab_food', calibration_agency: 'Thermal Validation Services' },
    { ref: 'fd_e_kjeldahl', name: 'Kjeldahl Digestion and Distillation Unit', key: 'FD-EQP-KJD-01', make: 'Pelican', model_name: 'Kelplus Elite', serial_number: 'PL-KE-7736', lab: 'lab_chem', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'fd_e_soxhlet', name: 'Soxhlet Extraction Unit', key: 'FD-EQP-SOX-01', make: 'Pelican', model_name: 'Socsplus SCS-6', serial_number: 'PL-SCS-2214', lab: 'lab_chem', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'fd_e_autoclave', name: 'Autoclave', key: 'FD-EQP-ACL-01', make: 'Equitron', model_name: 'Medica 7405', serial_number: 'EQ-ACL-5590', lab: 'lab_micro', calibration_agency: 'Thermal Validation Services' },
    { ref: 'fd_e_incubator', name: 'Bacteriological Incubator', key: 'FD-EQP-INC-01', make: 'Thermolab', model_name: 'TL-BI-200', serial_number: 'TL-BI-6647', lab: 'lab_micro', calibration_agency: 'Thermal Validation Services' },
    { ref: 'fd_e_laf', name: 'Laminar Air Flow Unit', key: 'FD-EQP-LAF-01', make: 'Klenzaids', model_name: 'KA-LAF-2', serial_number: 'KZ-LAF-8802', lab: 'lab_micro', calibration_agency: 'Cleanroom Compliance Services' },
    { ref: 'fd_e_refracto', name: 'Digital Refractometer', key: 'FD-EQP-RFR-01', make: 'Atago', model_name: 'RX-5000i', serial_number: 'AT-RX5-3358', lab: 'fd_lab_food', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'fd_e_aas', name: 'Atomic Absorption Spectrometer', key: 'FD-EQP-AAS-01', make: 'Agilent', model_name: '240FS AA', serial_number: 'AGL-240-9917', lab: 'lab_instr', calibration_agency: 'Precision Calibration Services' },
    { ref: 'fd_e_hplc', name: 'HPLC System', key: 'FD-EQP-HPLC-01', make: 'Waters', model_name: 'Arc HPLC', serial_number: 'WT-ARC-4425', lab: 'lab_instr', calibration_agency: 'Precision Calibration Services' },
  ],

  limits: {
    fd_t_moisture: { min: '', max: '14.00', uom: '% w/w', result: '11.42' },
    fd_t_ash: { min: '', max: '0.75', uom: '% w/w', result: '0.48' },
    fd_t_acid: { min: '', max: '0.50', uom: 'mg KOH/g', result: '0.18' },
    fd_t_peroxide: { min: '', max: '10.00', uom: 'meq O2/kg', result: '2.40' },
    fd_t_tpc: { min: '', max: '50000', uom: 'CFU/g', result: '1200' },
    fd_t_yeast: { min: '', max: '100', uom: 'CFU/g', result: '10' },
    fd_t_coliform: { min: '', max: '10', uom: 'CFU/g', text: 'Absent', result: 'Absent' },
    fd_t_salmonella: { min: '', max: '', uom: '', text: 'Absent in 25 g', result: 'Absent' },
    fd_t_brix: { min: '11.0', max: '', uom: 'degrees Brix', result: '13.6' },
    fd_t_protein: { min: '34.00', max: '', uom: '% w/w', result: '35.82' },
    fd_t_fat: { min: '', max: '1.50', uom: '% w/w', result: '0.72' },
    fd_t_preservative: { min: '', max: '250.0', uom: 'mg/kg', result: '112.0' },
    fd_t_lead: { min: '', max: '0.100', uom: 'mg/kg', result: '0.014' },
    fd_t_iodine: { min: '15.0', max: '', uom: 'ppm', result: '28.4' },
  },

  decisionRules: [
    {
      product: 'fd_p_oil',
      category: 'fd_cat_ff',
      rows: [
        { parameter: 'fd_t_moisture', moa: 'fd_m_moisture', days: 1, charges: 350, instruments: ['fd_e_oven'] },
        { parameter: 'fd_t_acid', moa: 'fd_m_acid', days: 1, charges: 450, instruments: [] },
        { parameter: 'fd_t_peroxide', moa: 'fd_m_peroxide', days: 1, charges: 500, instruments: [] },
        { parameter: 'fd_t_lead', moa: 'fd_m_aas', days: 3, charges: 1800, instruments: ['fd_e_aas'] },
        { parameter: 'fd_t_fat', moa: 'fd_m_soxhlet', days: 2, charges: 900, instruments: ['fd_e_soxhlet'] },
      ],
    },
    {
      product: 'fd_p_flour',
      category: 'fd_cat_ri',
      rows: [
        { parameter: 'fd_t_moisture', moa: 'fd_m_moisture', days: 1, charges: 350, instruments: ['fd_e_oven'] },
        { parameter: 'fd_t_ash', moa: 'fd_m_ash', days: 2, charges: 450, instruments: ['fd_e_muffle'] },
        { parameter: 'fd_t_protein', moa: 'fd_m_kjeldahl', days: 2, charges: 1100, instruments: ['fd_e_kjeldahl'] },
        { parameter: 'fd_t_tpc', moa: 'fd_m_plate', days: 4, charges: 800, instruments: ['fd_e_autoclave', 'fd_e_incubator'] },
        { parameter: 'fd_t_yeast', moa: 'fd_m_ym', days: 5, charges: 800, instruments: ['fd_e_incubator', 'fd_e_laf'] },
        { parameter: 'fd_t_lead', moa: 'fd_m_aas', days: 3, charges: 1800, instruments: ['fd_e_aas'] },
      ],
    },
    {
      product: 'fd_p_water',
      category: 'fd_cat_wtr',
      rows: [
        { parameter: 'fd_t_tpc', moa: 'fd_m_plate', days: 3, charges: 700, instruments: ['fd_e_autoclave', 'fd_e_incubator'] },
        { parameter: 'fd_t_coliform', moa: 'fd_m_coliform', days: 3, charges: 750, instruments: ['fd_e_incubator', 'fd_e_laf'] },
        { parameter: 'fd_t_lead', moa: 'fd_m_aas', days: 3, charges: 1800, instruments: ['fd_e_aas'] },
      ],
    },
    {
      product: 'fd_p_juice',
      category: 'fd_cat_pb',
      rows: [
        { parameter: 'fd_t_brix', moa: 'fd_m_brix', days: 1, charges: 400, instruments: ['fd_e_refracto'] },
        { parameter: 'fd_t_preservative', moa: 'fd_m_hplc', days: 3, charges: 1900, instruments: ['fd_e_hplc'] },
        { parameter: 'fd_t_tpc', moa: 'fd_m_plate', days: 4, charges: 800, instruments: ['fd_e_incubator'] },
        { parameter: 'fd_t_yeast', moa: 'fd_m_ym', days: 5, charges: 800, instruments: ['fd_e_incubator'] },
        { parameter: 'fd_t_salmonella', moa: 'fd_m_salmonella', days: 6, charges: 1600, instruments: ['fd_e_autoclave', 'fd_e_laf'] },
      ],
    },
    {
      product: 'fd_p_salt',
      category: 'fd_cat_ri',
      rows: [
        { parameter: 'fd_t_moisture', moa: 'fd_m_moisture', days: 1, charges: 350, instruments: ['fd_e_oven'] },
        { parameter: 'fd_t_iodine', moa: 'fd_m_iodine', days: 1, charges: 550, instruments: [] },
        { parameter: 'fd_t_lead', moa: 'fd_m_aas', days: 3, charges: 1800, instruments: ['fd_e_aas'] },
      ],
    },
  ],

  customers: [
    { ref: 'fd_c_harvest', name: 'Harvest Foods India Pvt Ltd', abbr: 'HFI', city: 'Indore', state: 'Madhya Pradesh' },
    { ref: 'fd_c_dairy', name: 'Sunrise Dairy Cooperative Ltd', abbr: 'SDC', city: 'Anand', state: 'Gujarat' },
    { ref: 'fd_c_beverage', name: 'Freshsip Beverages Pvt Ltd', abbr: 'FSB', city: 'Coimbatore', state: 'Tamil Nadu' },
  ],

  batchSizes: ['15000 packs', '8000 litres', '25 MT', '40000 bottles'],
  manufacturers: ['Harvest Foods - Indore Plant', 'Sunrise Dairy - Anand Unit'],

  /** Consumption per test, keyed by method ref. See pharmaceutical.js. */
  methodMaterials: {
    fd_m_soxhlet: [{ material: 'fd_mat_petroether', quantity: '0.15' }],
    fd_m_kjeldahl: [{ material: 'fd_mat_kjeldahl', quantity: '0.2' }],
    fd_m_peroxide: [{ material: 'fd_mat_thio', quantity: '0.05' }],
    fd_m_plate: [
      { material: 'fd_mat_pca', quantity: '25' },
      { material: 'fd_mat_petri', quantity: '0.1' },
    ],
    fd_m_coliform: [
      { material: 'fd_mat_vrba', quantity: '30' },
      { material: 'fd_mat_petri', quantity: '0.1' },
    ],
    fd_m_aas: [{ material: 'fd_mat_leadstd', quantity: '2' }],
  },

  materials: [
    { ref: 'fd_mat_petroether', name: 'Petroleum Ether 40 To 60 Degrees', key: 'FD-PET-ETH', category: 'mc_reagent', unit: 'Litres', initial_qty: '20', min_qty: '5' },
    { ref: 'fd_mat_kjeldahl', name: 'Kjeldahl Digestion Tablets', key: 'FD-KJEL-TAB', category: 'mc_reagent', unit: 'Packets', initial_qty: '18', min_qty: '5' },
    { ref: 'fd_mat_thio', name: 'Sodium Thiosulphate 0.01N', key: 'FD-THIO-001N', category: 'mc_reagent', unit: 'Litres', initial_qty: '15', min_qty: '4' },
    { ref: 'fd_mat_pca', name: 'Plate Count Agar', key: 'FD-PCA', category: 'mc_media', unit: 'Grams', initial_qty: '3000', min_qty: '700' },
    { ref: 'fd_mat_vrba', name: 'Violet Red Bile Agar', key: 'FD-VRBA', category: 'mc_media', unit: 'Grams', initial_qty: '2000', min_qty: '500' },
    { ref: 'fd_mat_leadstd', name: 'Lead Atomic Absorption Standard', key: 'FD-STD-PB', category: 'mc_standard', unit: 'Millilitres', initial_qty: '250', min_qty: '60' },
    { ref: 'fd_mat_petri', name: 'Sterile Petri Dish 90 mm', key: 'FD-PETRI-90', category: 'mc_consumable', unit: 'Boxes', initial_qty: '22', min_qty: '6' },
  ],

  scenarios: [
    { ref: 'fd_s1', product: 'fd_p_oil', category: 'fd_cat_ff', customer: 'fd_c_harvest', batch: 'SNO-2401', parameters: ['fd_t_moisture', 'fd_t_acid', 'fd_t_peroxide', 'fd_t_lead', 'fd_t_fat'], allocation: 'job', flow: 'coa' },
    { ref: 'fd_s2', product: 'fd_p_flour', category: 'fd_cat_ri', customer: 'fd_c_harvest', batch: 'MDA-2402', parameters: ['fd_t_moisture', 'fd_t_ash', 'fd_t_protein', 'fd_t_tpc', 'fd_t_yeast', 'fd_t_lead'], allocation: 'job', flow: 'pending_approval' },
    { ref: 'fd_s3', product: 'fd_p_water', category: 'fd_cat_wtr', customer: 'fd_c_beverage', batch: 'PDW-2403', parameters: ['fd_t_tpc', 'fd_t_coliform', 'fd_t_lead'], allocation: 'individual', flow: 'coa' },
    { ref: 'fd_s4', product: 'fd_p_juice', category: 'fd_cat_pb', customer: 'fd_c_beverage', batch: 'MJC-2404', parameters: ['fd_t_brix', 'fd_t_preservative', 'fd_t_tpc', 'fd_t_yeast', 'fd_t_salmonella'], allocation: 'job', flow: 'submitted' },
    { ref: 'fd_s5', product: 'fd_p_salt', category: 'fd_cat_ri', customer: 'fd_c_dairy', batch: 'SLT-2405', parameters: ['fd_t_moisture', 'fd_t_iodine'], allocation: 'individual', flow: 'generated' },
    { ref: 'fd_s6', product: 'fd_p_oil', category: 'fd_cat_ff', customer: 'fd_c_dairy', batch: 'SNO-2406', parameters: ['fd_t_acid', 'fd_t_peroxide'], allocation: 'individual', flow: 'allocated', delayedByDays: 2 },
  ],

  multiProductScenario: null,
};

export default foodBeverage;
