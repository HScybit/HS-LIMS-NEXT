/** Lubricants, greases and petroleum products laboratory. Refs are prefixed `lb_`. */

const lubricants = {
  key: 'lubricants',

  labs: [
    { ref: 'lb_lab_pet', name: 'Petroleum Testing Laboratory', abbreviation: 'PET' },
  ],

  categories: [
    { ref: 'lb_cat_new', name: 'New Oil Sample', abbr: 'NEW', retention_days: 180, estimated_time_in_days: 4, description: 'Fresh lubricant from production or drum.' },
    { ref: 'lb_cat_used', name: 'Used Oil Sample', abbr: 'USD', retention_days: 90, estimated_time_in_days: 3, description: 'In-service oil for condition monitoring.' },
    { ref: 'lb_cat_grs', name: 'Grease Sample', abbr: 'GRS', retention_days: 180, estimated_time_in_days: 5, description: 'Consistency and thermal testing of greases.' },
    { ref: 'lb_cat_ful', name: 'Fuel Sample', abbr: 'FUL', retention_days: 60, estimated_time_in_days: 3, description: 'Diesel and furnace oil samples.' },
    { ref: 'lb_cat_tro', name: 'Transformer Oil', abbr: 'TRO', retention_days: 365, estimated_time_in_days: 4, description: 'Insulating oil for electrical equipment.' },
  ],

  products: [
    { ref: 'lb_p_20w40', name: 'SAE 20W-40 Petrol Engine Oil', key: 'LB-20W40', abbr: '20W40', description: 'Multigrade engine oil for petrol engines.' },
    { ref: 'lb_p_15w40', name: 'SAE 15W-40 Diesel Engine Oil CI-4', key: 'LB-15W40', abbr: '15W40', description: 'Heavy duty diesel engine oil.' },
    { ref: 'lb_p_hyd68', name: 'Hydraulic Oil ISO VG 68', key: 'LB-HYD68', abbr: 'HYD68', description: 'Anti-wear hydraulic oil.' },
    { ref: 'lb_p_gear90', name: 'Gear Oil EP 90', key: 'LB-GEAR90', abbr: 'GR90', description: 'Extreme pressure automotive gear oil.' },
    { ref: 'lb_p_trafo', name: 'Transformer Oil IEC 60296', key: 'LB-TRAFO', abbr: 'TRF', description: 'Inhibited mineral insulating oil.' },
    { ref: 'lb_p_grease2', name: 'Lithium Complex Grease NLGI 2', key: 'LB-GRS2', abbr: 'GRS2', description: 'High temperature lithium complex grease.' },
    { ref: 'lb_p_turb46', name: 'Turbine Oil ISO VG 46', key: 'LB-TRB46', abbr: 'TRB46', description: 'Rust and oxidation inhibited turbine oil.' },
    { ref: 'lb_p_cutting', name: 'Soluble Cutting Oil', key: 'LB-CUTOIL', abbr: 'CUT', description: 'Water miscible metal working fluid.' },
  ],

  parameters: [
    { ref: 'lb_t_kv40', name: 'Kinematic Viscosity at 40 degC', key: 'LB-KV40', scheme_abbr: 'LK4', order: 10, lab: 'lb_lab_pet', description: 'Kinematic viscosity at 40 degrees Celsius.' },
    { ref: 'lb_t_kv100', name: 'Kinematic Viscosity at 100 degC', key: 'LB-KV100', scheme_abbr: 'LK1', order: 20, lab: 'lb_lab_pet', description: 'Kinematic viscosity at 100 degrees Celsius.' },
    { ref: 'lb_t_vi', name: 'Viscosity Index', key: 'LB-VI', scheme_abbr: 'LVI', order: 30, lab: 'lb_lab_pet', description: 'Calculated viscosity index.' },
    { ref: 'lb_t_flash', name: 'Flash Point (COC)', key: 'LB-FLSH', scheme_abbr: 'LFL', order: 40, lab: 'lb_lab_pet', description: 'Cleveland open cup flash point.' },
    { ref: 'lb_t_pour', name: 'Pour Point', key: 'LB-POUR', scheme_abbr: 'LPP', order: 50, lab: 'lb_lab_pet', description: 'Lowest temperature of oil flow.' },
    { ref: 'lb_t_tbn', name: 'Total Base Number', key: 'LB-TBN', scheme_abbr: 'LTB', order: 60, lab: 'lab_chem', description: 'Alkalinity reserve as mg KOH per gram.' },
    { ref: 'lb_t_tan', name: 'Total Acid Number', key: 'LB-TAN', scheme_abbr: 'LTA', order: 70, lab: 'lab_chem', description: 'Acidity as mg KOH per gram.' },
    { ref: 'lb_t_water', name: 'Water Content', key: 'LB-WATER', scheme_abbr: 'LWC', order: 80, lab: 'lab_chem', description: 'Water content by coulometric Karl Fischer.' },
    { ref: 'lb_t_density', name: 'Density at 15 degC', key: 'LB-DENS', scheme_abbr: 'LDN', order: 90, lab: 'lab_phys', description: 'Density at 15 degrees Celsius.' },
    { ref: 'lb_t_copper', name: 'Copper Strip Corrosion', key: 'LB-CUCOR', scheme_abbr: 'LCU', order: 100, lab: 'lb_lab_pet', description: 'Corrosiveness to copper.' },
    { ref: 'lb_t_foam', name: 'Foaming Characteristics', key: 'LB-FOAM', scheme_abbr: 'LFM', order: 110, lab: 'lb_lab_pet', description: 'Foam tendency and stability, sequence I.' },
    { ref: 'lb_t_elemental', name: 'Elemental Analysis (Wear Metals)', key: 'LB-ELEM', scheme_abbr: 'LEL', order: 120, lab: 'lab_instr', description: 'Wear metals and additive elements by ICP.' },
    { ref: 'lb_t_dropping', name: 'Dropping Point', key: 'LB-DROP', scheme_abbr: 'LDP', order: 130, lab: 'lb_lab_pet', description: 'Temperature at which grease passes to liquid.' },
    { ref: 'lb_t_bdv', name: 'Breakdown Voltage', key: 'LB-BDV', scheme_abbr: 'LBV', order: 140, lab: 'lab_instr', description: 'Dielectric breakdown voltage of insulating oil.' },
  ],

  methods: [
    { ref: 'lb_m_kv', name: 'Kinematic Viscosity ASTM D445', uuid: 'LB/MOA/KV/001', description: 'Glass capillary viscometer in a constant temperature bath, revision 1.2.', decimal_places: 2, parse_num: true, lab: 'lb_lab_pet' },
    { ref: 'lb_m_vi', name: 'Viscosity Index ASTM D2270', uuid: 'LB/MOA/VI/002', description: 'Calculation from viscosity at 40 and 100 degC, revision 1.0.', decimal_places: 0, parse_num: true, lab: 'lb_lab_pet' },
    { ref: 'lb_m_flash', name: 'Flash Point ASTM D92 (COC)', uuid: 'LB/MOA/FLP/003', description: 'Cleveland open cup apparatus, revision 1.1.', decimal_places: 0, parse_num: true, lab: 'lb_lab_pet' },
    { ref: 'lb_m_pour', name: 'Pour Point ASTM D97', uuid: 'LB/MOA/PP/004', description: 'Manual pour point apparatus, revision 1.0.', decimal_places: 0, parse_num: true, lab: 'lb_lab_pet' },
    { ref: 'lb_m_tbn', name: 'Total Base Number ASTM D2896', uuid: 'LB/MOA/TBN/005', description: 'Perchloric acid potentiometric titration, revision 1.1.', decimal_places: 2, parse_num: true, lab: 'lab_chem' },
    { ref: 'lb_m_tan', name: 'Total Acid Number ASTM D664', uuid: 'LB/MOA/TAN/006', description: 'Potentiometric titration to inflection, revision 1.1.', decimal_places: 3, parse_num: true, lab: 'lab_chem' },
    { ref: 'lb_m_kf', name: 'Water Content ASTM D6304', uuid: 'LB/MOA/KF/007', description: 'Coulometric Karl Fischer with oil evaporator, revision 1.0.', decimal_places: 0, parse_num: true, lab: 'lab_chem' },
    { ref: 'lb_m_density', name: 'Density ASTM D4052', uuid: 'LB/MOA/DEN/008', description: 'Digital density meter at 15 degC, revision 1.0.', decimal_places: 4, parse_num: true, lab: 'lab_phys' },
    { ref: 'lb_m_copper', name: 'Copper Corrosion ASTM D130', uuid: 'LB/MOA/CU/009', description: 'Copper strip tarnish test, 3 hours at 100 degC, revision 1.0.', decimal_places: 0, parse_num: false, lab: 'lb_lab_pet' },
    { ref: 'lb_m_foam', name: 'Foaming ASTM D892', uuid: 'LB/MOA/FOM/010', description: 'Air diffusion foaming test, sequence I, revision 1.0.', decimal_places: 0, parse_num: true, lab: 'lb_lab_pet' },
    { ref: 'lb_m_icp', name: 'Elemental Analysis ASTM D5185', uuid: 'LB/MOA/ICP/011', description: 'ICP-OES multi element determination, revision 1.3.', decimal_places: 1, parse_num: true, lab: 'lab_instr' },
    { ref: 'lb_m_drop', name: 'Dropping Point ASTM D566', uuid: 'LB/MOA/DRP/012', description: 'Dropping point of lubricating grease, revision 1.0.', decimal_places: 0, parse_num: true, lab: 'lb_lab_pet' },
    { ref: 'lb_m_bdv', name: 'Breakdown Voltage IEC 60156', uuid: 'LB/MOA/BDV/013', description: 'Dielectric breakdown of insulating liquids, revision 1.0.', decimal_places: 1, parse_num: true, lab: 'lab_instr' },
  ],

  equipment: [
    { ref: 'lb_e_viscobath', name: 'Kinematic Viscosity Bath', key: 'LB-EQP-KVB-01', make: 'Koehler', model_name: 'K23370', serial_number: 'KH-K233-1102', lab: 'lb_lab_pet', calibration_agency: 'Precision Calibration Services' },
    { ref: 'lb_e_coc', name: 'Cleveland Open Cup Flash Point Apparatus', key: 'LB-EQP-COC-01', make: 'Koehler', model_name: 'K87390', serial_number: 'KH-K873-4471', lab: 'lb_lab_pet', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'lb_e_pour', name: 'Pour Point Apparatus', key: 'LB-EQP-PP-01', make: 'Tanaka', model_name: 'MPC-102A', serial_number: 'TN-MPC-8830', lab: 'lb_lab_pet', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'lb_e_titrator', name: 'Potentiometric Titrator', key: 'LB-EQP-TIT-01', make: 'Metrohm', model_name: '888 Titrando', serial_number: 'MH-888-3325', lab: 'lab_chem', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'lb_e_kf', name: 'Karl Fischer Coulometer with Oil Evaporator', key: 'LB-EQP-KF-01', make: 'Metrohm', model_name: '899 Coulometer', serial_number: 'MH-899-7714', lab: 'lab_chem', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'lb_e_density', name: 'Digital Density Meter', key: 'LB-EQP-DEN-01', make: 'Anton Paar', model_name: 'DMA 35', serial_number: 'AP-DMA35-5502', lab: 'lab_phys', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'lb_e_icp', name: 'ICP-OES Spectrometer', key: 'LB-EQP-ICP-01', make: 'Agilent', model_name: '5800 ICP-OES', serial_number: 'AGL-5800-9931', lab: 'lab_instr', calibration_agency: 'Precision Calibration Services' },
    { ref: 'lb_e_drop', name: 'Dropping Point Apparatus', key: 'LB-EQP-DRP-01', make: 'Koehler', model_name: 'K18800', serial_number: 'KH-K188-2247', lab: 'lb_lab_pet', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'lb_e_bdv', name: 'Oil Breakdown Voltage Test Set', key: 'LB-EQP-BDV-01', make: 'Megger', model_name: 'OTS60PB', serial_number: 'MG-OTS-6618', lab: 'lab_instr', calibration_agency: 'Precision Calibration Services' },
    { ref: 'lb_e_foam', name: 'Foaming Characteristics Bath', key: 'LB-EQP-FOM-01', make: 'Koehler', model_name: 'K41200', serial_number: 'KH-K412-3390', lab: 'lb_lab_pet', calibration_agency: 'Metro Instruments Lab' },
  ],

  limits: {
    lb_t_kv40: { min: '90.00', max: '110.00', uom: 'cSt', result: '98.42' },
    lb_t_kv100: { min: '12.50', max: '16.30', uom: 'cSt', result: '14.28' },
    lb_t_vi: { min: '95', max: '', uom: '', result: '132' },
    lb_t_flash: { min: '220', max: '', uom: 'degC', result: '242' },
    lb_t_pour: { min: '', max: '-9', uom: 'degC', result: '-24' },
    lb_t_tbn: { min: '8.00', max: '', uom: 'mg KOH/g', result: '9.65' },
    lb_t_tan: { min: '', max: '0.500', uom: 'mg KOH/g', result: '0.084' },
    lb_t_water: { min: '', max: '200', uom: 'ppm', result: '38' },
    lb_t_density: { min: '0.8600', max: '0.9000', uom: 'g/cm3', result: '0.8812' },
    lb_t_copper: { min: '', max: '', uom: 'classification', text: 'Not worse than 1b', result: '1a' },
    lb_t_foam: { min: '', max: '50', uom: 'mL', result: '10' },
    lb_t_elemental: { min: '', max: '20.0', uom: 'ppm Fe', result: '4.6' },
    lb_t_dropping: { min: '260', max: '', uom: 'degC', result: '281' },
    lb_t_bdv: { min: '60.0', max: '', uom: 'kV', result: '72.5' },
  },

  decisionRules: [
    {
      product: 'lb_p_15w40',
      category: 'lb_cat_new',
      rows: [
        { parameter: 'lb_t_kv40', moa: 'lb_m_kv', days: 1, charges: 600, instruments: ['lb_e_viscobath'] },
        { parameter: 'lb_t_kv100', moa: 'lb_m_kv', days: 1, charges: 600, instruments: ['lb_e_viscobath'] },
        { parameter: 'lb_t_vi', moa: 'lb_m_vi', days: 1, charges: 300, instruments: [] },
        { parameter: 'lb_t_flash', moa: 'lb_m_flash', days: 1, charges: 550, instruments: ['lb_e_coc'] },
        { parameter: 'lb_t_tbn', moa: 'lb_m_tbn', days: 2, charges: 1200, instruments: ['lb_e_titrator'] },
        { parameter: 'lb_t_elemental', moa: 'lb_m_icp', days: 3, charges: 2400, instruments: ['lb_e_icp'] },
      ],
    },
    {
      product: 'lb_p_hyd68',
      category: 'lb_cat_new',
      rows: [
        { parameter: 'lb_t_kv40', moa: 'lb_m_kv', days: 1, charges: 600, instruments: ['lb_e_viscobath'] },
        { parameter: 'lb_t_flash', moa: 'lb_m_flash', days: 1, charges: 550, instruments: ['lb_e_coc'] },
        { parameter: 'lb_t_pour', moa: 'lb_m_pour', days: 1, charges: 500, instruments: ['lb_e_pour'] },
        { parameter: 'lb_t_tan', moa: 'lb_m_tan', days: 2, charges: 1100, instruments: ['lb_e_titrator'] },
        { parameter: 'lb_t_copper', moa: 'lb_m_copper', days: 2, charges: 750, instruments: [] },
        { parameter: 'lb_t_foam', moa: 'lb_m_foam', days: 2, charges: 900, instruments: ['lb_e_foam'] },
      ],
    },
    {
      product: 'lb_p_trafo',
      category: 'lb_cat_tro',
      rows: [
        { parameter: 'lb_t_bdv', moa: 'lb_m_bdv', days: 1, charges: 900, instruments: ['lb_e_bdv'] },
        { parameter: 'lb_t_water', moa: 'lb_m_kf', days: 1, charges: 800, instruments: ['lb_e_kf'] },
        { parameter: 'lb_t_tan', moa: 'lb_m_tan', days: 2, charges: 1100, instruments: ['lb_e_titrator'] },
        { parameter: 'lb_t_density', moa: 'lb_m_density', days: 1, charges: 400, instruments: ['lb_e_density'] },
        { parameter: 'lb_t_flash', moa: 'lb_m_flash', days: 1, charges: 550, instruments: ['lb_e_coc'] },
      ],
    },
    {
      product: 'lb_p_grease2',
      category: 'lb_cat_grs',
      rows: [
        { parameter: 'lb_t_dropping', moa: 'lb_m_drop', days: 2, charges: 950, instruments: ['lb_e_drop'] },
        { parameter: 'lb_t_copper', moa: 'lb_m_copper', days: 2, charges: 750, instruments: [] },
        { parameter: 'lb_t_elemental', moa: 'lb_m_icp', days: 3, charges: 2400, instruments: ['lb_e_icp'] },
        { parameter: 'lb_t_water', moa: 'lb_m_kf', days: 1, charges: 800, instruments: ['lb_e_kf'] },
      ],
    },
  ],

  customers: [
    { ref: 'lb_c_torque', name: 'Torque Lubricants India Pvt Ltd', abbr: 'TLI', city: 'Silvassa', state: 'Dadra and Nagar Haveli' },
    { ref: 'lb_c_gridpower', name: 'Gridpower Transmission Limited', abbr: 'GTL', city: 'Nagpur', state: 'Maharashtra' },
    { ref: 'lb_c_fleet', name: 'Fleetline Logistics Pvt Ltd', abbr: 'FLL', city: 'Jamshedpur', state: 'Jharkhand' },
  ],

  batchSizes: ['210 L drum', '20000 L tanker', '180 kg drum', '26000 L'],
  manufacturers: ['Torque Lubricants - Silvassa Blending Plant', 'Gridpower - Nagpur Substation'],

  /** Consumption per test, keyed by method ref. See pharmaceutical.js. */
  methodMaterials: {
    lb_m_kv: [
      { material: 'lb_mat_toluene', quantity: '0.1' },
      { material: 'lb_mat_viscostd', quantity: '2' },
      { material: 'lb_mat_viscotube', quantity: '0.01' },
    ],
    lb_m_tan: [{ material: 'lb_mat_kohsol', quantity: '0.05' }],
    lb_m_tbn: [{ material: 'lb_mat_kohsol', quantity: '0.06' }],
    lb_m_icp: [{ material: 'lb_mat_elemstd', quantity: '3' }],
    lb_m_copper: [{ material: 'lb_mat_copperstrip', quantity: '0.1' }],
  },

  materials: [
    { ref: 'lb_mat_toluene', name: 'Toluene Solvent Grade', key: 'LB-TOL', category: 'mc_reagent', unit: 'Litres', initial_qty: '30', min_qty: '8' },
    { ref: 'lb_mat_kohsol', name: 'Potassium Hydroxide 0.1N Alcoholic', key: 'LB-KOH-01N', category: 'mc_reagent', unit: 'Litres', initial_qty: '18', min_qty: '5' },
    { ref: 'lb_mat_viscostd', name: 'Viscosity Reference Standard N100', key: 'LB-VIS-N100', category: 'mc_standard', unit: 'Millilitres', initial_qty: '500', min_qty: '120' },
    { ref: 'lb_mat_elemstd', name: 'Wear Metals Calibration Standard', key: 'LB-ELEM-STD', category: 'mc_standard', unit: 'Millilitres', initial_qty: '300', min_qty: '80' },
    { ref: 'lb_mat_copperstrip', name: 'Copper Strip For Corrosion Test', key: 'LB-CU-STRIP', category: 'mc_consumable', unit: 'Packets', initial_qty: '16', min_qty: '4' },
    { ref: 'lb_mat_viscotube', name: 'Ubbelohde Viscometer Tube', key: 'LB-VIS-TUBE', category: 'mc_glassware', unit: 'Units', initial_qty: '20', min_qty: '5' },
  ],

  scenarios: [
    { ref: 'lb_s1', product: 'lb_p_15w40', category: 'lb_cat_new', customer: 'lb_c_torque', batch: 'DEO-2401', parameters: ['lb_t_kv40', 'lb_t_kv100', 'lb_t_vi', 'lb_t_flash', 'lb_t_tbn', 'lb_t_elemental'], allocation: 'job', flow: 'coa' },
    { ref: 'lb_s2', product: 'lb_p_hyd68', category: 'lb_cat_new', customer: 'lb_c_torque', batch: 'HYD-2402', parameters: ['lb_t_kv40', 'lb_t_flash', 'lb_t_pour', 'lb_t_tan', 'lb_t_copper', 'lb_t_foam'], allocation: 'job', flow: 'coa' },
    { ref: 'lb_s3', product: 'lb_p_trafo', category: 'lb_cat_tro', customer: 'lb_c_gridpower', batch: 'TRF-2403', parameters: ['lb_t_bdv', 'lb_t_water', 'lb_t_tan', 'lb_t_density', 'lb_t_flash'], allocation: 'individual', flow: 'pending_approval' },
    { ref: 'lb_s4', product: 'lb_p_grease2', category: 'lb_cat_grs', customer: 'lb_c_fleet', batch: 'GRS-2404', parameters: ['lb_t_dropping', 'lb_t_copper', 'lb_t_elemental'], allocation: 'job', flow: 'submitted' },
    { ref: 'lb_s5', product: 'lb_p_15w40', category: 'lb_cat_used', customer: 'lb_c_fleet', batch: 'USD-2405', parameters: ['lb_t_kv40', 'lb_t_tbn', 'lb_t_elemental'], allocation: 'individual', flow: 'generated' },
    { ref: 'lb_s6', product: 'lb_p_hyd68', category: 'lb_cat_used', customer: 'lb_c_gridpower', batch: 'USD-2406', parameters: ['lb_t_kv40', 'lb_t_tan'], allocation: 'individual', flow: 'results' },
  ],

  multiProductScenario: null,
};

export default lubricants;
