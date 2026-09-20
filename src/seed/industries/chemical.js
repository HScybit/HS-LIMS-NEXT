/** Bulk and specialty chemical testing laboratory. Refs are prefixed `ch_`. */

const chemical = {
  key: 'chemical',

  labs: [
    { ref: 'ch_lab_wet', name: 'Wet Chemistry Laboratory', abbreviation: 'WET' },
  ],

  categories: [
    { ref: 'ch_cat_rm', name: 'Chemical Raw Material', abbr: 'CRM', retention_days: 120, estimated_time_in_days: 4, description: 'Incoming solvents, acids and bases.' },
    { ref: 'ch_cat_int', name: 'Intermediate', abbr: 'INT', retention_days: 90, estimated_time_in_days: 3, description: 'In-process reaction intermediates.' },
    { ref: 'ch_cat_fc', name: 'Finished Chemical', abbr: 'FC', retention_days: 365, estimated_time_in_days: 5, description: 'Packed chemical ready for dispatch.' },
    { ref: 'ch_cat_eff', name: 'Effluent Sample', abbr: 'EFF', retention_days: 30, estimated_time_in_days: 3, description: 'Treated and untreated plant effluent.' },
    { ref: 'ch_cat_sr', name: 'Recovered Solvent', abbr: 'RSV', retention_days: 60, estimated_time_in_days: 3, description: 'Solvent recovered from distillation.' },
  ],

  products: [
    { ref: 'ch_p_tol', name: 'Toluene Technical Grade', key: 'CH-TOL', abbr: 'TOL', description: 'Aromatic hydrocarbon solvent.' },
    { ref: 'ch_p_acetic', name: 'Acetic Acid Glacial 99.8%', key: 'CH-ACOH', abbr: 'ACOH', description: 'Glacial acetic acid, synthetic grade.' },
    { ref: 'ch_p_naoh', name: 'Sodium Hydroxide Flakes 98%', key: 'CH-NAOH', abbr: 'NAOH', description: 'Caustic soda flakes, technical grade.' },
    { ref: 'ch_p_h2so4', name: 'Sulphuric Acid 98%', key: 'CH-H2SO4', abbr: 'H2SO4', description: 'Commercial concentrated sulphuric acid.' },
    { ref: 'ch_p_ipa', name: 'Isopropyl Alcohol 99.7%', key: 'CH-IPA', abbr: 'IPA', description: 'Anhydrous isopropanol solvent.' },
    { ref: 'ch_p_h2o2', name: 'Hydrogen Peroxide 50% w/w', key: 'CH-H2O2', abbr: 'H2O2', description: 'Stabilised hydrogen peroxide solution.' },
    { ref: 'ch_p_etac', name: 'Ethyl Acetate 99.5%', key: 'CH-ETAC', abbr: 'ETAC', description: 'Ester solvent for coatings and inks.' },
    { ref: 'ch_p_citric', name: 'Citric Acid Monohydrate', key: 'CH-CIT', abbr: 'CIT', description: 'Food and technical grade citric acid.' },
    { ref: 'ch_p_tio2', name: 'Titanium Dioxide Rutile', key: 'CH-TIO2', abbr: 'TIO2', description: 'White pigment for paints and plastics.' },
  ],

  parameters: [
    { ref: 'ch_t_appear', name: 'Appearance', key: 'CH-APPR', scheme_abbr: 'CAP', order: 10, lab: 'ch_lab_wet', description: 'Visual clarity, colour and physical state.' },
    { ref: 'ch_t_purity', name: 'Purity by Gas Chromatography', key: 'CH-PURGC', scheme_abbr: 'CPG', order: 20, lab: 'lab_instr', description: 'Assay and impurity profile by GC-FID.' },
    { ref: 'ch_t_assay', name: 'Assay by Titration', key: 'CH-ASYTI', scheme_abbr: 'CAT', order: 30, lab: 'ch_lab_wet', description: 'Content by volumetric titration.' },
    { ref: 'ch_t_moisture', name: 'Moisture Content', key: 'CH-MOIST', scheme_abbr: 'CMO', order: 40, lab: 'ch_lab_wet', description: 'Water content by Karl Fischer.' },
    { ref: 'ch_t_acidity', name: 'Acidity', key: 'CH-ACID', scheme_abbr: 'CAC', order: 50, lab: 'ch_lab_wet', description: 'Free acid content as acetic acid.' },
    { ref: 'ch_t_density', name: 'Density at 20 degC', key: 'CH-DENS', scheme_abbr: 'CDN', order: 60, lab: 'lab_phys', description: 'Relative density at 20 degrees Celsius.' },
    { ref: 'ch_t_ri', name: 'Refractive Index', key: 'CH-RI', scheme_abbr: 'CRI', order: 70, lab: 'lab_phys', description: 'Refractive index at 20 degrees Celsius.' },
    { ref: 'ch_t_colour', name: 'Colour (APHA)', key: 'CH-APHA', scheme_abbr: 'CCL', order: 80, lab: 'ch_lab_wet', description: 'Platinum cobalt colour scale.' },
    { ref: 'ch_t_nvm', name: 'Non-volatile Matter', key: 'CH-NVM', scheme_abbr: 'CNV', order: 90, lab: 'ch_lab_wet', description: 'Residue on evaporation.' },
    { ref: 'ch_t_heavy', name: 'Heavy Metals as Lead', key: 'CH-HMET', scheme_abbr: 'CHM', order: 100, lab: 'lab_instr', description: 'Total heavy metal content as lead.' },
    { ref: 'ch_t_chloride', name: 'Chloride Content', key: 'CH-CL', scheme_abbr: 'CCH', order: 110, lab: 'ch_lab_wet', description: 'Chloride as sodium chloride.' },
    { ref: 'ch_t_ash', name: 'Sulphated Ash', key: 'CH-SASH', scheme_abbr: 'CSA', order: 120, lab: 'ch_lab_wet', description: 'Residue after sulphation and ignition.' },
    { ref: 'ch_t_flash', name: 'Flash Point', key: 'CH-FLSH', scheme_abbr: 'CFL', order: 130, lab: 'lab_phys', description: 'Closed cup flash point.' },
    { ref: 'ch_t_ph', name: 'pH of Aqueous Solution', key: 'CH-PH', scheme_abbr: 'CPH', order: 140, lab: 'ch_lab_wet', description: 'pH of a 10% aqueous solution.' },
  ],

  methods: [
    { ref: 'ch_m_gc', name: 'Purity by GC-FID', uuid: 'CH/MOA/GC/001', description: 'Capillary GC with flame ionisation detection, revision 1.4.', decimal_places: 2, parse_num: true, lab: 'lab_instr' },
    { ref: 'ch_m_titr', name: 'Volumetric Acid-Base Titration', uuid: 'CH/MOA/TIT/002', description: 'Potentiometric end point titration, revision 1.1.', decimal_places: 2, parse_num: true, lab: 'ch_lab_wet' },
    { ref: 'ch_m_kf', name: 'Moisture by Karl Fischer', uuid: 'CH/MOA/KF/003', description: 'Volumetric Karl Fischer titration, revision 1.0.', decimal_places: 3, parse_num: true, lab: 'ch_lab_wet' },
    { ref: 'ch_m_grav', name: 'Gravimetric Residue Determination', uuid: 'CH/MOA/GRV/004', description: 'Evaporation and ignition to constant weight, revision 1.0.', decimal_places: 3, parse_num: true, lab: 'ch_lab_wet' },
    { ref: 'ch_m_dens', name: 'Density by Oscillating U-Tube', uuid: 'CH/MOA/DEN/005', description: 'Digital density meter at 20 degC, revision 1.0.', decimal_places: 4, parse_num: true, lab: 'lab_phys' },
    { ref: 'ch_m_ri', name: 'Refractive Index by Refractometry', uuid: 'CH/MOA/RI/006', description: 'Abbe refractometer at 20 degC, revision 1.0.', decimal_places: 4, parse_num: true, lab: 'lab_phys' },
    { ref: 'ch_m_apha', name: 'Colour by APHA Comparison', uuid: 'CH/MOA/CLR/007', description: 'Platinum cobalt visual comparison, revision 1.0.', decimal_places: 0, parse_num: true, lab: 'ch_lab_wet' },
    { ref: 'ch_m_aas', name: 'Heavy Metals by Atomic Absorption', uuid: 'CH/MOA/AAS/008', description: 'Flame AAS after acid digestion, revision 1.2.', decimal_places: 3, parse_num: true, lab: 'lab_instr' },
    { ref: 'ch_m_argento', name: 'Chloride by Argentometric Titration', uuid: 'CH/MOA/ARG/009', description: 'Silver nitrate titration with potentiometric end point, revision 1.0.', decimal_places: 3, parse_num: true, lab: 'ch_lab_wet' },
    { ref: 'ch_m_flash', name: 'Flash Point by Abel Closed Cup', uuid: 'CH/MOA/FLP/010', description: 'Abel closed cup apparatus, revision 1.0.', decimal_places: 1, parse_num: true, lab: 'lab_phys' },
    { ref: 'ch_m_visual', name: 'Appearance by Visual Examination', uuid: 'CH/MOA/VIS/011', description: 'Visual examination against a clear background, revision 1.0.', decimal_places: 0, parse_num: false, lab: 'ch_lab_wet' },
  ],

  equipment: [
    { ref: 'ch_e_gc', name: 'GC-FID System', key: 'CH-EQP-GC-01', make: 'Agilent', model_name: '8890 GC', serial_number: 'AGL-8890-1198', lab: 'lab_instr', calibration_agency: 'Precision Calibration Services' },
    { ref: 'ch_e_titrator', name: 'Automatic Potentiometric Titrator', key: 'CH-EQP-TIT-01', make: 'Metrohm', model_name: '905 Titrando', serial_number: 'MH-905-2288', lab: 'ch_lab_wet', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'ch_e_kf', name: 'Karl Fischer Titrator', key: 'CH-EQP-KF-01', make: 'Metrohm', model_name: '870 KF Titrino', serial_number: 'MH-870-6631', lab: 'ch_lab_wet', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'ch_e_muffle', name: 'Muffle Furnace', key: 'CH-EQP-MUF-01', make: 'Nabertherm', model_name: 'L 15/11', serial_number: 'NB-L15-4402', lab: 'ch_lab_wet', calibration_agency: 'Thermal Validation Services' },
    { ref: 'ch_e_density', name: 'Digital Density Meter', key: 'CH-EQP-DEN-01', make: 'Anton Paar', model_name: 'DMA 4500 M', serial_number: 'AP-DMA-7719', lab: 'lab_phys', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'ch_e_refracto', name: 'Abbe Refractometer', key: 'CH-EQP-RFR-01', make: 'Rudolph Research', model_name: 'J357', serial_number: 'RR-J357-3320', lab: 'lab_phys', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'ch_e_aas', name: 'Atomic Absorption Spectrometer', key: 'CH-EQP-AAS-01', make: 'PerkinElmer', model_name: 'PinAAcle 500', serial_number: 'PE-AAS-9042', lab: 'lab_instr', calibration_agency: 'Precision Calibration Services' },
    { ref: 'ch_e_flash', name: 'Abel Closed Cup Flash Point Apparatus', key: 'CH-EQP-FLP-01', make: 'Stanhope-Seta', model_name: 'Setaflash 3', serial_number: 'SS-SF3-5108', lab: 'lab_phys', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'ch_e_balance', name: 'Analytical Balance', key: 'CH-EQP-BAL-01', make: 'Sartorius', model_name: 'Secura 224', serial_number: 'ST-SC224-8815', lab: 'ch_lab_wet', calibration_agency: 'National Weights and Measures' },
    { ref: 'ch_e_ph', name: 'pH Meter', key: 'CH-EQP-PH-01', make: 'Eutech', model_name: 'pH 700', serial_number: 'EU-PH700-2274', lab: 'ch_lab_wet', calibration_agency: 'Metro Instruments Lab' },
  ],

  limits: {
    ch_t_appear: { min: '', max: '', uom: '', text: 'Clear colourless liquid, free from suspended matter', result: 'Clear colourless liquid' },
    ch_t_purity: { min: '99.50', max: '', uom: '% w/w', result: '99.82' },
    ch_t_assay: { min: '98.00', max: '101.00', uom: '% w/w', result: '99.35' },
    ch_t_moisture: { min: '', max: '0.100', uom: '% w/w', result: '0.043' },
    ch_t_acidity: { min: '', max: '0.010', uom: '% w/w', result: '0.004' },
    ch_t_density: { min: '0.8650', max: '0.8700', uom: 'g/cm3', result: '0.8672' },
    ch_t_ri: { min: '1.4940', max: '1.4980', uom: '', result: '1.4962' },
    ch_t_colour: { min: '', max: '10', uom: 'APHA', result: '5' },
    ch_t_nvm: { min: '', max: '0.005', uom: '% w/w', result: '0.002' },
    ch_t_heavy: { min: '', max: '5.000', uom: 'ppm', result: '0.812' },
    ch_t_chloride: { min: '', max: '0.005', uom: '% w/w', result: '0.001' },
    ch_t_ash: { min: '', max: '0.100', uom: '% w/w', result: '0.018' },
    ch_t_flash: { min: '4.0', max: '', uom: 'degC', result: '6.5' },
    ch_t_ph: { min: '5.00', max: '8.00', uom: '', result: '6.42' },
  },

  decisionRules: [
    {
      product: 'ch_p_tol',
      category: 'ch_cat_rm',
      rows: [
        { parameter: 'ch_t_appear', moa: 'ch_m_visual', days: 1, charges: 200, instruments: [] },
        { parameter: 'ch_t_purity', moa: 'ch_m_gc', days: 2, charges: 1600, instruments: ['ch_e_gc'] },
        { parameter: 'ch_t_moisture', moa: 'ch_m_kf', days: 1, charges: 800, instruments: ['ch_e_kf'] },
        { parameter: 'ch_t_density', moa: 'ch_m_dens', days: 1, charges: 400, instruments: ['ch_e_density'] },
        { parameter: 'ch_t_ri', moa: 'ch_m_ri', days: 1, charges: 350, instruments: ['ch_e_refracto'] },
        { parameter: 'ch_t_colour', moa: 'ch_m_apha', days: 1, charges: 300, instruments: [] },
      ],
    },
    {
      product: 'ch_p_acetic',
      category: 'ch_cat_fc',
      rows: [
        { parameter: 'ch_t_appear', moa: 'ch_m_visual', days: 1, charges: 200, instruments: [] },
        { parameter: 'ch_t_assay', moa: 'ch_m_titr', days: 2, charges: 900, instruments: ['ch_e_titrator', 'ch_e_balance'] },
        { parameter: 'ch_t_moisture', moa: 'ch_m_kf', days: 1, charges: 800, instruments: ['ch_e_kf'] },
        { parameter: 'ch_t_chloride', moa: 'ch_m_argento', days: 2, charges: 700, instruments: ['ch_e_titrator'] },
        { parameter: 'ch_t_heavy', moa: 'ch_m_aas', days: 3, charges: 1900, instruments: ['ch_e_aas'] },
        { parameter: 'ch_t_nvm', moa: 'ch_m_grav', days: 2, charges: 600, instruments: ['ch_e_muffle', 'ch_e_balance'] },
      ],
    },
    {
      product: 'ch_p_naoh',
      category: 'ch_cat_fc',
      rows: [
        { parameter: 'ch_t_appear', moa: 'ch_m_visual', days: 1, charges: 200, instruments: [] },
        { parameter: 'ch_t_assay', moa: 'ch_m_titr', days: 2, charges: 850, instruments: ['ch_e_titrator'] },
        { parameter: 'ch_t_chloride', moa: 'ch_m_argento', days: 2, charges: 700, instruments: ['ch_e_titrator'] },
        { parameter: 'ch_t_heavy', moa: 'ch_m_aas', days: 3, charges: 1900, instruments: ['ch_e_aas'] },
        { parameter: 'ch_t_ash', moa: 'ch_m_grav', days: 2, charges: 650, instruments: ['ch_e_muffle'] },
        { parameter: 'ch_t_ph', moa: 'ch_m_titr', days: 1, charges: 300, instruments: ['ch_e_ph'] },
      ],
    },
    {
      product: 'ch_p_ipa',
      category: 'ch_cat_sr',
      rows: [
        { parameter: 'ch_t_appear', moa: 'ch_m_visual', days: 1, charges: 200, instruments: [] },
        { parameter: 'ch_t_purity', moa: 'ch_m_gc', days: 2, charges: 1600, instruments: ['ch_e_gc'] },
        { parameter: 'ch_t_moisture', moa: 'ch_m_kf', days: 1, charges: 800, instruments: ['ch_e_kf'] },
        { parameter: 'ch_t_acidity', moa: 'ch_m_titr', days: 1, charges: 500, instruments: ['ch_e_titrator'] },
        { parameter: 'ch_t_flash', moa: 'ch_m_flash', days: 1, charges: 650, instruments: ['ch_e_flash'] },
        { parameter: 'ch_t_nvm', moa: 'ch_m_grav', days: 2, charges: 600, instruments: ['ch_e_muffle'] },
      ],
    },
    {
      // V3's ETP scenario includes pH but omitted its decision rule. Keep the
      // same scenario and add the missing relation so fresh seeds are valid.
      product: 'ch_p_acetic',
      category: 'ch_cat_eff',
      rows: [
        { parameter: 'ch_t_ph', moa: 'ch_m_titr', days: 1, charges: 300, instruments: ['ch_e_ph'] },
      ],
    },
  ],

  customers: [
    { ref: 'ch_c_indus', name: 'Indus Petrochem Industries Ltd', abbr: 'IPI', city: 'Vadodara', state: 'Gujarat' },
    { ref: 'ch_c_orbit', name: 'Orbit Coatings Pvt Ltd', abbr: 'OCP', city: 'Nashik', state: 'Maharashtra' },
    { ref: 'ch_c_pinnacle', name: 'Pinnacle Speciality Chemicals Ltd', abbr: 'PSC', city: 'Chennai', state: 'Tamil Nadu' },
  ],

  batchSizes: ['20 MT', '45 MT', '12000 L', '5000 kg'],
  manufacturers: ['Indus Petrochem - Dahej Plant', 'Pinnacle Speciality - Ranipet Plant'],

  /** Consumption per test, keyed by method ref. See pharmaceutical.js. */
  methodMaterials: {
    ch_m_gc: [
      { material: 'ch_mat_std_tol', quantity: '0.5' },
      { material: 'ch_mat_gccol', quantity: '0.01' },
    ],
    ch_m_titr: [
      { material: 'ch_mat_naoh_sol', quantity: '0.08' },
      { material: 'ch_mat_burette', quantity: '0.01' },
      { material: 'ch_mat_hcl_sol', quantity: '0.03' },
    ],
    ch_m_kf: [{ material: 'ch_mat_karl', quantity: '0.05' }],
    ch_m_argento: [{ material: 'ch_mat_agno3', quantity: '2' }],
  },

  materials: [
    { ref: 'ch_mat_naoh_sol', name: 'Sodium Hydroxide 0.1N Volumetric Solution', key: 'CH-NAOH-01N', category: 'mc_reagent', unit: 'Litres', initial_qty: '25', min_qty: '6' },
    { ref: 'ch_mat_hcl_sol', name: 'Hydrochloric Acid 0.1N Volumetric Solution', key: 'CH-HCL-01N', category: 'mc_reagent', unit: 'Litres', initial_qty: '22', min_qty: '6' },
    { ref: 'ch_mat_karl', name: 'Karl Fischer Reagent Composite 5', key: 'CH-KF-5', category: 'mc_reagent', unit: 'Litres', initial_qty: '12', min_qty: '4' },
    { ref: 'ch_mat_agno3', name: 'Silver Nitrate AR', key: 'CH-AGNO3', category: 'mc_reagent', unit: 'Grams', initial_qty: '500', min_qty: '150' },
    { ref: 'ch_mat_std_tol', name: 'Toluene Reference Standard', key: 'CH-RS-TOL', category: 'mc_standard', unit: 'Millilitres', initial_qty: '250', min_qty: '60' },
    { ref: 'ch_mat_gccol', name: 'GC Capillary Column 30 m', key: 'CH-GC-COL30', category: 'mc_consumable', unit: 'Units', initial_qty: '6', min_qty: '2' },
    { ref: 'ch_mat_burette', name: 'Burette 50 mL Class A', key: 'CH-BUR-50', category: 'mc_glassware', unit: 'Units', initial_qty: '24', min_qty: '6' },
  ],

  scenarios: [
    { ref: 'ch_s1', product: 'ch_p_tol', category: 'ch_cat_rm', customer: 'ch_c_indus', batch: 'TOL-2401', parameters: ['ch_t_appear', 'ch_t_purity', 'ch_t_moisture', 'ch_t_density', 'ch_t_ri', 'ch_t_colour'], allocation: 'job', flow: 'coa' },
    { ref: 'ch_s2', product: 'ch_p_acetic', category: 'ch_cat_fc', customer: 'ch_c_pinnacle', batch: 'ACOH-2402', parameters: ['ch_t_appear', 'ch_t_assay', 'ch_t_moisture', 'ch_t_chloride', 'ch_t_heavy', 'ch_t_nvm'], allocation: 'job', flow: 'pending_approval' },
    { ref: 'ch_s3', product: 'ch_p_naoh', category: 'ch_cat_fc', customer: 'ch_c_orbit', batch: 'NAOH-2403', parameters: ['ch_t_appear', 'ch_t_assay', 'ch_t_chloride', 'ch_t_ash', 'ch_t_ph'], allocation: 'individual', flow: 'coa' },
    { ref: 'ch_s4', product: 'ch_p_ipa', category: 'ch_cat_sr', customer: 'ch_c_indus', batch: 'IPA-2404', parameters: ['ch_t_appear', 'ch_t_purity', 'ch_t_moisture', 'ch_t_flash'], allocation: 'job', flow: 'submitted' },
    { ref: 'ch_s5', product: 'ch_p_tol', category: 'ch_cat_int', customer: 'ch_c_pinnacle', batch: 'TOL-2405', parameters: ['ch_t_purity', 'ch_t_density'], allocation: 'individual', flow: 'results' },
    { ref: 'ch_s6', product: 'ch_p_acetic', category: 'ch_cat_eff', customer: 'ch_c_orbit', batch: 'EFF-2406', parameters: ['ch_t_appear', 'ch_t_ph'], allocation: 'individual', flow: 'generated' },
  ],

  multiProductScenario: null,
};

export default chemical;
