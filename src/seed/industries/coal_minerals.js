/** Coal, coke and mineral ore testing laboratory. Refs are prefixed `cl_`. */

const coalMinerals = {
  key: 'coal_minerals',

  labs: [
    { ref: 'cl_lab_coal', name: 'Coal and Minerals Laboratory', abbreviation: 'COL' },
    { ref: 'cl_lab_prep', name: 'Sample Preparation Section', abbreviation: 'PREP' },
  ],

  categories: [
    { ref: 'cl_cat_coal', name: 'Coal Sample', abbr: 'CSL', retention_days: 90, estimated_time_in_days: 4, description: 'Steam and coking coal consignments.' },
    { ref: 'cl_cat_coke', name: 'Coke Sample', abbr: 'CKS', retention_days: 90, estimated_time_in_days: 4, description: 'Metallurgical and petroleum coke.' },
    { ref: 'cl_cat_ore', name: 'Iron Ore Sample', abbr: 'IOS', retention_days: 180, estimated_time_in_days: 5, description: 'Iron ore fines and lumps.' },
    { ref: 'cl_cat_flux', name: 'Flux and Additive', abbr: 'FLX', retention_days: 180, estimated_time_in_days: 4, description: 'Limestone, dolomite and other fluxes.' },
    { ref: 'cl_cat_ash', name: 'Fly Ash Sample', abbr: 'FAS', retention_days: 60, estimated_time_in_days: 3, description: 'Power plant fly ash for cement use.' },
  ],

  products: [
    { ref: 'cl_p_steam', name: 'Steam Coal Grade G11', key: 'CL-STMG11', abbr: 'STM11', description: 'Domestic non-coking steam coal.' },
    { ref: 'cl_p_coking', name: 'Imported Coking Coal', key: 'CL-COKING', abbr: 'CKC', description: 'Low ash metallurgical coking coal.' },
    { ref: 'cl_p_petcoke', name: 'Petroleum Coke', key: 'CL-PETCOKE', abbr: 'PTC', description: 'Calcined petroleum coke for anode use.' },
    { ref: 'cl_p_ironore', name: 'Iron Ore Fines Fe 62%', key: 'CL-IOF62', abbr: 'IOF', description: 'Beneficiated iron ore fines.' },
    { ref: 'cl_p_limestone', name: 'Limestone Chips 10-40 mm', key: 'CL-LMSTN', abbr: 'LMS', description: 'Metallurgical grade limestone.' },
    { ref: 'cl_p_bauxite', name: 'Bauxite Ore', key: 'CL-BAUX', abbr: 'BXT', description: 'Refractory grade bauxite ore.' },
    { ref: 'cl_p_flyash', name: 'Fly Ash Class F', key: 'CL-FLYASH', abbr: 'FAF', description: 'Siliceous fly ash for blended cement.' },
    { ref: 'cl_p_dolomite', name: 'Dolomite Lumps', key: 'CL-DOLO', abbr: 'DOL', description: 'Calcined dolomite for steel making.' },
  ],

  parameters: [
    { ref: 'cl_t_tm', name: 'Total Moisture', key: 'CL-TM', scheme_abbr: 'CTM', order: 10, lab: 'cl_lab_prep', description: 'Total moisture on an as received basis.' },
    { ref: 'cl_t_im', name: 'Inherent Moisture', key: 'CL-IM', scheme_abbr: 'CIM', order: 20, lab: 'cl_lab_coal', description: 'Moisture in the air dried sample.' },
    { ref: 'cl_t_ash', name: 'Ash Content', key: 'CL-ASH', scheme_abbr: 'CAS', order: 30, lab: 'cl_lab_coal', description: 'Residue after complete combustion.' },
    { ref: 'cl_t_vm', name: 'Volatile Matter', key: 'CL-VM', scheme_abbr: 'CVM', order: 40, lab: 'cl_lab_coal', description: 'Volatile matter on an air dried basis.' },
    { ref: 'cl_t_fc', name: 'Fixed Carbon', key: 'CL-FC', scheme_abbr: 'CFC', order: 50, lab: 'cl_lab_coal', description: 'Fixed carbon by difference.' },
    { ref: 'cl_t_gcv', name: 'Gross Calorific Value', key: 'CL-GCV', scheme_abbr: 'CGV', order: 60, lab: 'cl_lab_coal', description: 'Gross calorific value by bomb calorimetry.' },
    { ref: 'cl_t_sulphur', name: 'Total Sulphur', key: 'CL-TS', scheme_abbr: 'CTS', order: 70, lab: 'cl_lab_coal', description: 'Total sulphur content.' },
    { ref: 'cl_t_aft', name: 'Ash Fusion Temperature', key: 'CL-AFT', scheme_abbr: 'CAF', order: 80, lab: 'cl_lab_coal', description: 'Initial deformation temperature of ash.' },
    { ref: 'cl_t_hgi', name: 'Hardgrove Grindability Index', key: 'CL-HGI', scheme_abbr: 'CHG', order: 90, lab: 'lab_phys', description: 'Relative ease of pulverisation.' },
    { ref: 'cl_t_fe', name: 'Iron (Fe) Content', key: 'CL-FE', scheme_abbr: 'CFE', order: 100, lab: 'lab_chem', description: 'Total iron content of the ore.' },
    { ref: 'cl_t_sio2', name: 'Silica (SiO2) Content', key: 'CL-SIO2', scheme_abbr: 'CSI', order: 110, lab: 'lab_chem', description: 'Silicon dioxide content.' },
    { ref: 'cl_t_al2o3', name: 'Alumina (Al2O3) Content', key: 'CL-AL2O3', scheme_abbr: 'CAL', order: 120, lab: 'lab_instr', description: 'Aluminium oxide content.' },
    { ref: 'cl_t_cao', name: 'Calcium Oxide (CaO) Content', key: 'CL-CAO', scheme_abbr: 'CCO', order: 130, lab: 'lab_chem', description: 'Calcium oxide content.' },
    { ref: 'cl_t_loi', name: 'Loss on Ignition', key: 'CL-LOI', scheme_abbr: 'CLI', order: 140, lab: 'cl_lab_coal', description: 'Mass loss on ignition at 1000 degC.' },
  ],

  methods: [
    { ref: 'cl_m_tm', name: 'Total Moisture ASTM D3302', uuid: 'CL/MOA/TM/001', description: 'Air drying followed by oven drying, revision 1.1.', decimal_places: 2, parse_num: true, lab: 'cl_lab_prep' },
    { ref: 'cl_m_prox', name: 'Proximate Analysis ASTM D3173-D3175', uuid: 'CL/MOA/PRX/002', description: 'Moisture, ash and volatile matter determination, revision 1.2.', decimal_places: 2, parse_num: true, lab: 'cl_lab_coal' },
    { ref: 'cl_m_gcv', name: 'Calorific Value ASTM D5865', uuid: 'CL/MOA/GCV/003', description: 'Isoperibol bomb calorimetry, revision 1.3.', decimal_places: 0, parse_num: true, lab: 'cl_lab_coal' },
    { ref: 'cl_m_sulphur', name: 'Total Sulphur ASTM D4239', uuid: 'CL/MOA/TS/004', description: 'High temperature combustion with infrared detection, revision 1.1.', decimal_places: 3, parse_num: true, lab: 'cl_lab_coal' },
    { ref: 'cl_m_aft', name: 'Ash Fusion Temperature ASTM D1857', uuid: 'CL/MOA/AFT/005', description: 'Reducing atmosphere ash cone fusion, revision 1.0.', decimal_places: 0, parse_num: true, lab: 'cl_lab_coal' },
    { ref: 'cl_m_hgi', name: 'Hardgrove Grindability ASTM D409', uuid: 'CL/MOA/HGI/006', description: 'Hardgrove machine with sieve analysis, revision 1.0.', decimal_places: 0, parse_num: true, lab: 'lab_phys' },
    { ref: 'cl_m_titr', name: 'Iron by Titrimetric Determination', uuid: 'CL/MOA/FE/007', description: 'Dichromate titration after stannous reduction, revision 1.0.', decimal_places: 2, parse_num: true, lab: 'lab_chem' },
    { ref: 'cl_m_grav', name: 'Silica by Gravimetric Determination', uuid: 'CL/MOA/SI/008', description: 'Double dehydration and ignition, revision 1.0.', decimal_places: 2, parse_num: true, lab: 'lab_chem' },
    { ref: 'cl_m_xrf', name: 'Oxide Analysis by XRF', uuid: 'CL/MOA/XRF/009', description: 'Fused bead wavelength dispersive XRF, revision 1.2.', decimal_places: 2, parse_num: true, lab: 'lab_instr' },
    { ref: 'cl_m_loi', name: 'Loss on Ignition - Gravimetric', uuid: 'CL/MOA/LOI/010', description: 'Ignition at 1000 degC to constant mass, revision 1.0.', decimal_places: 2, parse_num: true, lab: 'cl_lab_coal' },
  ],

  equipment: [
    { ref: 'cl_e_calorimeter', name: 'Bomb Calorimeter', key: 'CL-EQP-CAL-01', make: 'Parr', model_name: '6400', serial_number: 'PR-6400-2218', lab: 'cl_lab_coal', calibration_agency: 'Precision Calibration Services' },
    { ref: 'cl_e_muffle', name: 'Muffle Furnace 1100 degC', key: 'CL-EQP-MUF-01', make: 'Nabertherm', model_name: 'LT 15/12', serial_number: 'NB-LT15-7741', lab: 'cl_lab_coal', calibration_agency: 'Thermal Validation Services' },
    { ref: 'cl_e_oven', name: 'Hot Air Oven', key: 'CL-EQP-OVN-01', make: 'Thermolab', model_name: 'TL-HAO-300', serial_number: 'TL-HAO-3392', lab: 'cl_lab_prep', calibration_agency: 'Thermal Validation Services' },
    { ref: 'cl_e_sulphur', name: 'Sulphur Analyser', key: 'CL-EQP-SUL-01', make: 'LECO', model_name: 'S832', serial_number: 'LC-S832-6604', lab: 'cl_lab_coal', calibration_agency: 'Precision Calibration Services' },
    { ref: 'cl_e_aft', name: 'Ash Fusion Furnace', key: 'CL-EQP-AFT-01', make: 'Carbolite', model_name: 'CAF G5', serial_number: 'CB-CAF-5527', lab: 'cl_lab_coal', calibration_agency: 'Thermal Validation Services' },
    { ref: 'cl_e_hgi', name: 'Hardgrove Grindability Machine', key: 'CL-EQP-HGI-01', make: 'Preiser', model_name: 'HGI-2000', serial_number: 'PS-HGI-1183', lab: 'lab_phys', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'cl_e_xrf', name: 'XRF Spectrometer', key: 'CL-EQP-XRF-01', make: 'Bruker', model_name: 'S8 TIGER', serial_number: 'BR-S8-9048', lab: 'lab_instr', calibration_agency: 'Precision Calibration Services' },
    { ref: 'cl_e_crusher', name: 'Jaw Crusher', key: 'CL-EQP-CRS-01', make: 'Retsch', model_name: 'BB 200', serial_number: 'RT-BB200-4416', lab: 'cl_lab_prep', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'cl_e_pulveriser', name: 'Disc Pulveriser', key: 'CL-EQP-PLV-01', make: 'Retsch', model_name: 'RS 200', serial_number: 'RT-RS200-8873', lab: 'cl_lab_prep', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'cl_e_balance', name: 'Analytical Balance', key: 'CL-EQP-BAL-01', make: 'Mettler Toledo', model_name: 'ME204', serial_number: 'MT-ME204-2265', lab: 'cl_lab_coal', calibration_agency: 'National Weights and Measures' },
  ],

  limits: {
    cl_t_tm: { min: '', max: '12.00', uom: '% (ar)', result: '8.42' },
    cl_t_im: { min: '', max: '6.00', uom: '% (adb)', result: '4.18' },
    cl_t_ash: { min: '', max: '34.00', uom: '% (adb)', result: '28.65' },
    cl_t_vm: { min: '19.00', max: '28.00', uom: '% (adb)', result: '23.40' },
    cl_t_fc: { min: '35.00', max: '', uom: '% (adb)', result: '43.77' },
    cl_t_gcv: { min: '4000', max: '', uom: 'kcal/kg', result: '4620' },
    cl_t_sulphur: { min: '', max: '0.600', uom: '%', result: '0.412' },
    cl_t_aft: { min: '1150', max: '', uom: 'degC', result: '1280' },
    cl_t_hgi: { min: '45', max: '', uom: '', result: '58' },
    cl_t_fe: { min: '62.00', max: '', uom: '%', result: '63.15' },
    cl_t_sio2: { min: '', max: '4.50', uom: '%', result: '2.86' },
    cl_t_al2o3: { min: '', max: '3.00', uom: '%', result: '1.92' },
    cl_t_cao: { min: '52.00', max: '', uom: '%', result: '54.28' },
    cl_t_loi: { min: '', max: '6.00', uom: '%', result: '2.14' },
  },

  decisionRules: [
    {
      product: 'cl_p_steam',
      category: 'cl_cat_coal',
      rows: [
        { parameter: 'cl_t_tm', moa: 'cl_m_tm', days: 1, charges: 400, instruments: ['cl_e_oven'] },
        { parameter: 'cl_t_im', moa: 'cl_m_prox', days: 1, charges: 400, instruments: ['cl_e_oven'] },
        { parameter: 'cl_t_ash', moa: 'cl_m_prox', days: 2, charges: 500, instruments: ['cl_e_muffle', 'cl_e_balance'] },
        { parameter: 'cl_t_vm', moa: 'cl_m_prox', days: 2, charges: 500, instruments: ['cl_e_muffle'] },
        { parameter: 'cl_t_gcv', moa: 'cl_m_gcv', days: 2, charges: 1200, instruments: ['cl_e_calorimeter'] },
        { parameter: 'cl_t_sulphur', moa: 'cl_m_sulphur', days: 2, charges: 900, instruments: ['cl_e_sulphur'] },
      ],
    },
    {
      product: 'cl_p_coking',
      category: 'cl_cat_coal',
      rows: [
        { parameter: 'cl_t_im', moa: 'cl_m_prox', days: 1, charges: 400, instruments: ['cl_e_oven'] },
        { parameter: 'cl_t_ash', moa: 'cl_m_prox', days: 2, charges: 500, instruments: ['cl_e_muffle'] },
        { parameter: 'cl_t_vm', moa: 'cl_m_prox', days: 2, charges: 500, instruments: ['cl_e_muffle'] },
        { parameter: 'cl_t_sulphur', moa: 'cl_m_sulphur', days: 2, charges: 900, instruments: ['cl_e_sulphur'] },
        { parameter: 'cl_t_aft', moa: 'cl_m_aft', days: 3, charges: 1800, instruments: ['cl_e_aft'] },
        { parameter: 'cl_t_hgi', moa: 'cl_m_hgi', days: 2, charges: 1000, instruments: ['cl_e_hgi'] },
      ],
    },
    {
      product: 'cl_p_ironore',
      category: 'cl_cat_ore',
      rows: [
        { parameter: 'cl_t_fe', moa: 'cl_m_titr', days: 2, charges: 1100, instruments: ['cl_e_balance'] },
        { parameter: 'cl_t_sio2', moa: 'cl_m_grav', days: 3, charges: 1300, instruments: ['cl_e_muffle'] },
        { parameter: 'cl_t_al2o3', moa: 'cl_m_xrf', days: 2, charges: 1400, instruments: ['cl_e_xrf'] },
        { parameter: 'cl_t_loi', moa: 'cl_m_loi', days: 2, charges: 600, instruments: ['cl_e_muffle'] },
        { parameter: 'cl_t_tm', moa: 'cl_m_tm', days: 1, charges: 400, instruments: ['cl_e_oven'] },
      ],
    },
    {
      product: 'cl_p_limestone',
      category: 'cl_cat_flux',
      rows: [
        { parameter: 'cl_t_cao', moa: 'cl_m_titr', days: 2, charges: 900, instruments: [] },
        { parameter: 'cl_t_sio2', moa: 'cl_m_grav', days: 3, charges: 1300, instruments: ['cl_e_muffle'] },
        { parameter: 'cl_t_al2o3', moa: 'cl_m_xrf', days: 2, charges: 1400, instruments: ['cl_e_xrf'] },
        { parameter: 'cl_t_loi', moa: 'cl_m_loi', days: 2, charges: 600, instruments: ['cl_e_muffle'] },
      ],
    },
  ],

  customers: [
    { ref: 'cl_c_bharat', name: 'Bharat Thermal Power Corporation', abbr: 'BTP', city: 'Korba', state: 'Chhattisgarh' },
    { ref: 'cl_c_steelworks', name: 'Deccan Steelworks Limited', abbr: 'DSW', city: 'Bellary', state: 'Karnataka' },
    { ref: 'cl_c_cement', name: 'Sahyadri Cement Industries Ltd', abbr: 'SCI', city: 'Chandrapur', state: 'Maharashtra' },
  ],

  batchSizes: ['5000 MT rake', '2500 MT barge', '1000 MT stockpile', '40 MT truck'],
  manufacturers: ['Bharat Thermal - Korba Unit 4', 'Deccan Steelworks - Sinter Plant'],

  /** Consumption per test, keyed by method ref. See pharmaceutical.js. */
  methodMaterials: {
    cl_m_gcv: [
      { material: 'cl_mat_benzoic', quantity: '1.2' },
      { material: 'cl_mat_fusewire', quantity: '0.1' },
    ],
    cl_m_prox: [{ material: 'cl_mat_crucible', quantity: '0.02' }],
    cl_m_xrf: [
      { material: 'cl_mat_flux', quantity: '0.008' },
      { material: 'cl_mat_orestd', quantity: '0.5' },
    ],
    cl_m_titr: [
      { material: 'cl_mat_hf', quantity: '0.02' },
      { material: 'cl_mat_crucible', quantity: '0.02' },
    ],
  },

  materials: [
    { ref: 'cl_mat_benzoic', name: 'Benzoic Acid Calorimetric Standard', key: 'CL-BENZOIC', category: 'mc_standard', unit: 'Grams', initial_qty: '400', min_qty: '100' },
    { ref: 'cl_mat_orestd', name: 'Iron Ore Certified Reference Material', key: 'CL-CRM-IRON', category: 'mc_standard', unit: 'Grams', initial_qty: '250', min_qty: '60' },
    { ref: 'cl_mat_hf', name: 'Hydrofluoric Acid 40 Percent', key: 'CL-HF-40', category: 'mc_reagent', unit: 'Litres', initial_qty: '8', min_qty: '3' },
    { ref: 'cl_mat_flux', name: 'Lithium Tetraborate Fusion Flux', key: 'CL-FLUX-LTB', category: 'mc_reagent', unit: 'Kgs', initial_qty: '12', min_qty: '3' },
    { ref: 'cl_mat_fusewire', name: 'Bomb Calorimeter Fuse Wire', key: 'CL-FUSE-WIRE', category: 'mc_consumable', unit: 'Packets', initial_qty: '25', min_qty: '6' },
    { ref: 'cl_mat_crucible', name: 'Silica Crucible With Lid', key: 'CL-CRUC-SIL', category: 'mc_glassware', unit: 'Units', initial_qty: '40', min_qty: '10' },
  ],

  scenarios: [
    { ref: 'cl_s1', product: 'cl_p_steam', category: 'cl_cat_coal', customer: 'cl_c_bharat', batch: 'RAKE-2401', parameters: ['cl_t_tm', 'cl_t_im', 'cl_t_ash', 'cl_t_vm', 'cl_t_gcv', 'cl_t_sulphur'], allocation: 'job', flow: 'coa' },
    { ref: 'cl_s2', product: 'cl_p_coking', category: 'cl_cat_coal', customer: 'cl_c_steelworks', batch: 'CKC-2402', parameters: ['cl_t_im', 'cl_t_ash', 'cl_t_vm', 'cl_t_sulphur', 'cl_t_aft', 'cl_t_hgi'], allocation: 'job', flow: 'approved' },
    { ref: 'cl_s3', product: 'cl_p_ironore', category: 'cl_cat_ore', customer: 'cl_c_steelworks', batch: 'IOF-2403', parameters: ['cl_t_fe', 'cl_t_sio2', 'cl_t_al2o3', 'cl_t_loi', 'cl_t_tm'], allocation: 'individual', flow: 'submitted', delayedByDays: 5 },
    { ref: 'cl_s4', product: 'cl_p_limestone', category: 'cl_cat_flux', customer: 'cl_c_cement', batch: 'LMS-2404', parameters: ['cl_t_cao', 'cl_t_sio2', 'cl_t_loi'], allocation: 'job', flow: 'results' },
    { ref: 'cl_s5', product: 'cl_p_steam', category: 'cl_cat_coal', customer: 'cl_c_cement', batch: 'RAKE-2405', parameters: ['cl_t_tm', 'cl_t_ash', 'cl_t_gcv'], allocation: 'individual', flow: 'allocated' },
    { ref: 'cl_s6', product: 'cl_p_ironore', category: 'cl_cat_ore', customer: 'cl_c_bharat', batch: 'IOF-2406', parameters: ['cl_t_fe', 'cl_t_tm'], allocation: 'individual', flow: 'registered' },
  ],

  multiProductScenario: null,
};

export default coalMinerals;
