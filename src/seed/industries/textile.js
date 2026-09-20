/** Textile testing laboratory: yarn, fabric and garments. Refs are prefixed `tx_`. */

const textile = {
  key: 'textile',

  labs: [
    { ref: 'tx_lab_text', name: 'Textile Testing Laboratory', abbreviation: 'TEX' },
  ],

  categories: [
    { ref: 'tx_cat_yarn', name: 'Yarn Sample', abbr: 'YRN', retention_days: 90, estimated_time_in_days: 4, description: 'Spun and filament yarn lots.' },
    { ref: 'tx_cat_fab', name: 'Fabric Sample', abbr: 'FAB', retention_days: 180, estimated_time_in_days: 6, description: 'Woven and knitted fabric rolls.' },
    { ref: 'tx_cat_gmt', name: 'Garment Sample', abbr: 'GMT', retention_days: 365, estimated_time_in_days: 7, description: 'Finished garments for buyer approval.' },
    { ref: 'tx_cat_dye', name: 'Dyed Material', abbr: 'DYE', retention_days: 120, estimated_time_in_days: 5, description: 'Dyed and printed material for fastness testing.' },
    { ref: 'tx_cat_rct', name: 'Raw Cotton', abbr: 'RCT', retention_days: 60, estimated_time_in_days: 3, description: 'Incoming cotton bales.' },
  ],

  products: [
    { ref: 'tx_p_yarn30', name: 'Cotton Combed Yarn 30s', key: 'TX-YRN30', abbr: 'Y30', description: 'Ring spun combed cotton yarn, 30s count.' },
    { ref: 'tx_p_pcblend', name: 'Polyester Cotton Blend Fabric 65/35', key: 'TX-PC6535', abbr: 'PC65', description: 'Blended shirting fabric, plain weave.' },
    { ref: 'tx_p_poplin', name: '100% Cotton Poplin Shirting', key: 'TX-POPLIN', abbr: 'POP', description: 'Mercerised cotton poplin shirting fabric.' },
    { ref: 'tx_p_denim', name: 'Denim Fabric 12 oz', key: 'TX-DENIM12', abbr: 'DNM', description: 'Indigo dyed 3/1 twill denim.' },
    { ref: 'tx_p_jersey', name: 'Knitted Single Jersey 180 GSM', key: 'TX-JERSEY', abbr: 'JSY', description: 'Cotton single jersey knitted fabric.' },
    { ref: 'tx_p_towel', name: 'Terry Towel 500 GSM', key: 'TX-TOWEL', abbr: 'TWL', description: 'Cotton terry towel, dobby border.' },
    { ref: 'tx_p_thread', name: 'Polyester Sewing Thread 40/2', key: 'TX-THR402', abbr: 'THR', description: 'Spun polyester sewing thread.' },
    { ref: 'tx_p_lining', name: 'Viscose Woven Lining', key: 'TX-VISLIN', abbr: 'VLN', description: 'Viscose filament woven lining fabric.' },
  ],

  parameters: [
    { ref: 'tx_t_gsm', name: 'Fabric Weight (GSM)', key: 'TX-GSM', scheme_abbr: 'TGS', order: 10, lab: 'tx_lab_text', description: 'Mass per unit area of the fabric.' },
    { ref: 'tx_t_tensile', name: 'Tensile Strength', key: 'TX-TENS', scheme_abbr: 'TTN', order: 20, lab: 'lab_phys', description: 'Breaking force in warp and weft direction.' },
    { ref: 'tx_t_tear', name: 'Tearing Strength', key: 'TX-TEAR', scheme_abbr: 'TTR', order: 30, lab: 'lab_phys', description: 'Elmendorf tearing force.' },
    { ref: 'tx_t_wash', name: 'Colour Fastness to Washing', key: 'TX-CFWSH', scheme_abbr: 'TCW', order: 40, lab: 'tx_lab_text', description: 'Shade change and staining after washing.' },
    { ref: 'tx_t_rub', name: 'Colour Fastness to Rubbing', key: 'TX-CFRUB', scheme_abbr: 'TCR', order: 50, lab: 'tx_lab_text', description: 'Dry and wet crocking resistance.' },
    { ref: 'tx_t_shrink', name: 'Dimensional Stability to Washing', key: 'TX-SHRNK', scheme_abbr: 'TDS', order: 60, lab: 'tx_lab_text', description: 'Shrinkage in length and width after washing.' },
    { ref: 'tx_t_ph', name: 'pH of Aqueous Extract', key: 'TX-PHEXT', scheme_abbr: 'TPH', order: 70, lab: 'lab_chem', description: 'pH of the aqueous extract of the material.' },
    { ref: 'tx_t_composition', name: 'Fibre Composition', key: 'TX-FBRCM', scheme_abbr: 'TFC', order: 80, lab: 'tx_lab_text', description: 'Quantitative fibre blend analysis.' },
    { ref: 'tx_t_count', name: 'Yarn Count', key: 'TX-YCNT', scheme_abbr: 'TYC', order: 90, lab: 'tx_lab_text', description: 'Linear density of the yarn in English count.' },
    { ref: 'tx_t_twist', name: 'Twist per Inch', key: 'TX-TPI', scheme_abbr: 'TTP', order: 100, lab: 'tx_lab_text', description: 'Number of turns per inch of yarn.' },
    { ref: 'tx_t_pilling', name: 'Pilling Resistance', key: 'TX-PILL', scheme_abbr: 'TPL', order: 110, lab: 'lab_phys', description: 'Surface pilling grade after abrasion cycles.' },
    { ref: 'tx_t_formaldehyde', name: 'Free Formaldehyde Content', key: 'TX-FORM', scheme_abbr: 'TFM', order: 120, lab: 'lab_chem', description: 'Free and hydrolysed formaldehyde content.' },
    { ref: 'tx_t_azo', name: 'Banned Azo Amines', key: 'TX-AZO', scheme_abbr: 'TAZ', order: 130, lab: 'lab_instr', description: 'Restricted aromatic amines from azo colourants.' },
    { ref: 'tx_t_regain', name: 'Moisture Regain', key: 'TX-REGN', scheme_abbr: 'TMR', order: 140, lab: 'tx_lab_text', description: 'Moisture regain at standard atmosphere.' },
  ],

  methods: [
    { ref: 'tx_m_gsm', name: 'Fabric Mass per Unit Area - Gravimetric', uuid: 'TX/MOA/GSM/001', description: 'Circular cutter and balance, ISO 3801, revision 1.0.', decimal_places: 1, parse_num: true, lab: 'tx_lab_text' },
    { ref: 'tx_m_tensile', name: 'Tensile Strength by CRE Method', uuid: 'TX/MOA/TEN/002', description: 'Constant rate of extension, ISO 13934-1, revision 1.1.', decimal_places: 1, parse_num: true, lab: 'lab_phys' },
    { ref: 'tx_m_tear', name: 'Tearing Strength - Elmendorf', uuid: 'TX/MOA/TER/003', description: 'Ballistic pendulum method, ISO 13937-1, revision 1.0.', decimal_places: 1, parse_num: true, lab: 'lab_phys' },
    { ref: 'tx_m_wash', name: 'Colour Fastness to Washing ISO 105-C06', uuid: 'TX/MOA/CFW/004', description: 'Launder-Ometer with grey scale assessment, revision 1.2.', decimal_places: 1, parse_num: true, lab: 'tx_lab_text' },
    { ref: 'tx_m_rub', name: 'Colour Fastness to Rubbing ISO 105-X12', uuid: 'TX/MOA/CFR/005', description: 'Crockmeter dry and wet rubbing, revision 1.0.', decimal_places: 1, parse_num: true, lab: 'tx_lab_text' },
    { ref: 'tx_m_shrink', name: 'Dimensional Change on Washing ISO 6330', uuid: 'TX/MOA/DIM/006', description: 'Domestic washing and drying procedure, revision 1.1.', decimal_places: 1, parse_num: true, lab: 'tx_lab_text' },
    { ref: 'tx_m_ph', name: 'pH of Aqueous Extract ISO 3071', uuid: 'TX/MOA/PH/007', description: 'Aqueous extraction and potentiometric pH, revision 1.0.', decimal_places: 2, parse_num: true, lab: 'lab_chem' },
    { ref: 'tx_m_fibre', name: 'Quantitative Fibre Analysis', uuid: 'TX/MOA/FBR/008', description: 'Chemical dissolution and microscopy, revision 1.3.', decimal_places: 1, parse_num: true, lab: 'tx_lab_text' },
    { ref: 'tx_m_count', name: 'Yarn Count by Wrap Reel', uuid: 'TX/MOA/CNT/009', description: 'Wrap reel and balance, ISO 2060, revision 1.0.', decimal_places: 2, parse_num: true, lab: 'tx_lab_text' },
    { ref: 'tx_m_twist', name: 'Twist Determination by Untwist Retwist', uuid: 'TX/MOA/TWS/010', description: 'Twist tester, ISO 2061, revision 1.0.', decimal_places: 1, parse_num: true, lab: 'tx_lab_text' },
    { ref: 'tx_m_pilling', name: 'Pilling by Martindale Abrasion', uuid: 'TX/MOA/PIL/011', description: 'Martindale tester with visual grading, revision 1.0.', decimal_places: 1, parse_num: true, lab: 'lab_phys' },
    { ref: 'tx_m_form', name: 'Formaldehyde by Spectrophotometry', uuid: 'TX/MOA/FRM/012', description: 'Acetylacetone spectrophotometric method, ISO 14184-1, revision 1.1.', decimal_places: 1, parse_num: true, lab: 'lab_chem' },
    { ref: 'tx_m_azo', name: 'Azo Amines by GC-MS', uuid: 'TX/MOA/AZO/013', description: 'Reductive cleavage followed by GC-MS, EN 14362-1, revision 1.0.', decimal_places: 1, parse_num: true, lab: 'lab_instr' },
    { ref: 'tx_m_regain', name: 'Moisture Regain - Oven Dry', uuid: 'TX/MOA/REG/014', description: 'Conditioning and oven drying to constant mass, revision 1.0.', decimal_places: 2, parse_num: true, lab: 'tx_lab_text' },
  ],

  equipment: [
    { ref: 'tx_e_tensile', name: 'Universal Tensile Tester', key: 'TX-EQP-TEN-01', make: 'Instron', model_name: '3369', serial_number: 'IN-3369-2201', lab: 'lab_phys', calibration_agency: 'Precision Calibration Services' },
    { ref: 'tx_e_tear', name: 'Elmendorf Tear Tester', key: 'TX-EQP-TER-01', make: 'James Heal', model_name: 'TearTec', serial_number: 'JH-TT-7735', lab: 'lab_phys', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'tx_e_launder', name: 'Launder-Ometer', key: 'TX-EQP-LDR-01', make: 'James Heal', model_name: 'Gyrowash 815', serial_number: 'JH-GW-4418', lab: 'tx_lab_text', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'tx_e_crock', name: 'Crockmeter', key: 'TX-EQP-CRK-01', make: 'SDL Atlas', model_name: 'M238BB', serial_number: 'SD-M238-9902', lab: 'tx_lab_text', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'tx_e_gsm', name: 'GSM Round Cutter and Balance', key: 'TX-EQP-GSM-01', make: 'Paramount', model_name: 'PI-GSM-100', serial_number: 'PM-GSM-3341', lab: 'tx_lab_text', calibration_agency: 'National Weights and Measures' },
    { ref: 'tx_e_martindale', name: 'Martindale Abrasion Tester', key: 'TX-EQP-MRT-01', make: 'James Heal', model_name: 'Nu-Martindale 1309', serial_number: 'JH-NM-6620', lab: 'lab_phys', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'tx_e_twist', name: 'Yarn Twist Tester', key: 'TX-EQP-TWS-01', make: 'Mesdan', model_name: 'Twist Tester 2', serial_number: 'MS-TT2-1174', lab: 'tx_lab_text', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'tx_e_wrapreel', name: 'Electronic Wrap Reel', key: 'TX-EQP-WRP-01', make: 'Mesdan', model_name: 'Wrap Reel 2500', serial_number: 'MS-WR-5583', lab: 'tx_lab_text', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'tx_e_conditioning', name: 'Standard Conditioning Chamber', key: 'TX-EQP-CND-01', make: 'Thermolab', model_name: 'TL-SCC-500', serial_number: 'TL-SCC-8846', lab: 'tx_lab_text', calibration_agency: 'Thermal Validation Services' },
    { ref: 'tx_e_uv', name: 'UV-Visible Spectrophotometer', key: 'TX-EQP-UV-01', make: 'Shimadzu', model_name: 'UV-1800', serial_number: 'SHZ-UV1800-2299', lab: 'lab_chem', calibration_agency: 'Metro Instruments Lab' },
    { ref: 'tx_e_gcms', name: 'GC-MS System', key: 'TX-EQP-GCMS-01', make: 'Shimadzu', model_name: 'GCMS-QP2020 NX', serial_number: 'SHZ-QP-3307', lab: 'lab_instr', calibration_agency: 'Precision Calibration Services' },
  ],

  limits: {
    tx_t_gsm: { min: '170.0', max: '190.0', uom: 'g/m2', result: '181.4' },
    tx_t_tensile: { min: '400.0', max: '', uom: 'N', result: '512.6' },
    tx_t_tear: { min: '15.0', max: '', uom: 'N', result: '22.4' },
    tx_t_wash: { min: '4.0', max: '', uom: 'grade', result: '4.5' },
    tx_t_rub: { min: '3.5', max: '', uom: 'grade', result: '4.0' },
    tx_t_shrink: { min: '-3.0', max: '3.0', uom: '%', result: '-1.8' },
    tx_t_ph: { min: '4.50', max: '7.50', uom: '', result: '6.35' },
    tx_t_composition: { min: '', max: '', uom: '', text: '65% Polyester, 35% Cotton (+/- 3%)', result: '64.2% Polyester, 35.8% Cotton' },
    tx_t_count: { min: '29.50', max: '30.50', uom: 'Ne', result: '30.12' },
    tx_t_twist: { min: '18.0', max: '22.0', uom: 'TPI', result: '20.3' },
    tx_t_pilling: { min: '3.5', max: '', uom: 'grade', result: '4.0' },
    tx_t_formaldehyde: { min: '', max: '75.0', uom: 'mg/kg', result: '18.0' },
    tx_t_azo: { min: '', max: '20.0', uom: 'mg/kg', text: 'Not detected', result: 'Not detected' },
    tx_t_regain: { min: '', max: '8.50', uom: '%', result: '6.80' },
  },

  decisionRules: [
    {
      product: 'tx_p_pcblend',
      category: 'tx_cat_fab',
      rows: [
        { parameter: 'tx_t_gsm', moa: 'tx_m_gsm', days: 1, charges: 450, instruments: ['tx_e_gsm'] },
        { parameter: 'tx_t_tensile', moa: 'tx_m_tensile', days: 2, charges: 950, instruments: ['tx_e_tensile'] },
        { parameter: 'tx_t_composition', moa: 'tx_m_fibre', days: 3, charges: 1400, instruments: [] },
        { parameter: 'tx_t_shrink', moa: 'tx_m_shrink', days: 3, charges: 1100, instruments: ['tx_e_launder'] },
        { parameter: 'tx_t_wash', moa: 'tx_m_wash', days: 3, charges: 1250, instruments: ['tx_e_launder'] },
        { parameter: 'tx_t_ph', moa: 'tx_m_ph', days: 1, charges: 400, instruments: [] },
      ],
    },
    {
      product: 'tx_p_denim',
      category: 'tx_cat_dye',
      rows: [
        { parameter: 'tx_t_gsm', moa: 'tx_m_gsm', days: 1, charges: 450, instruments: ['tx_e_gsm'] },
        { parameter: 'tx_t_tear', moa: 'tx_m_tear', days: 2, charges: 900, instruments: ['tx_e_tear'] },
        { parameter: 'tx_t_rub', moa: 'tx_m_rub', days: 2, charges: 850, instruments: ['tx_e_crock'] },
        { parameter: 'tx_t_wash', moa: 'tx_m_wash', days: 3, charges: 1250, instruments: ['tx_e_launder'] },
        { parameter: 'tx_t_shrink', moa: 'tx_m_shrink', days: 3, charges: 1100, instruments: ['tx_e_launder'] },
        { parameter: 'tx_t_azo', moa: 'tx_m_azo', days: 5, charges: 3400, instruments: ['tx_e_gcms'] },
      ],
    },
    {
      product: 'tx_p_yarn30',
      category: 'tx_cat_yarn',
      rows: [
        { parameter: 'tx_t_count', moa: 'tx_m_count', days: 1, charges: 400, instruments: ['tx_e_wrapreel'] },
        { parameter: 'tx_t_twist', moa: 'tx_m_twist', days: 1, charges: 400, instruments: ['tx_e_twist'] },
        { parameter: 'tx_t_tensile', moa: 'tx_m_tensile', days: 2, charges: 900, instruments: ['tx_e_tensile'] },
        { parameter: 'tx_t_regain', moa: 'tx_m_regain', days: 2, charges: 500, instruments: ['tx_e_conditioning'] },
        { parameter: 'tx_t_composition', moa: 'tx_m_fibre', days: 3, charges: 1400, instruments: [] },
      ],
    },
    {
      product: 'tx_p_jersey',
      category: 'tx_cat_gmt',
      rows: [
        { parameter: 'tx_t_gsm', moa: 'tx_m_gsm', days: 1, charges: 450, instruments: ['tx_e_gsm'] },
        { parameter: 'tx_t_pilling', moa: 'tx_m_pilling', days: 3, charges: 1200, instruments: ['tx_e_martindale'] },
        { parameter: 'tx_t_shrink', moa: 'tx_m_shrink', days: 3, charges: 1100, instruments: ['tx_e_launder'] },
        { parameter: 'tx_t_formaldehyde', moa: 'tx_m_form', days: 3, charges: 1600, instruments: ['tx_e_uv'] },
        { parameter: 'tx_t_ph', moa: 'tx_m_ph', days: 1, charges: 400, instruments: [] },
        { parameter: 'tx_t_wash', moa: 'tx_m_wash', days: 3, charges: 1250, instruments: ['tx_e_launder'] },
      ],
    },
  ],

  customers: [
    { ref: 'tx_c_loom', name: 'Loomcraft Exports Pvt Ltd', abbr: 'LCE', city: 'Tiruppur', state: 'Tamil Nadu' },
    { ref: 'tx_c_weave', name: 'Weavewell Mills Limited', abbr: 'WWM', city: 'Surat', state: 'Gujarat' },
    { ref: 'tx_c_attire', name: 'Attire Global Sourcing Pvt Ltd', abbr: 'AGS', city: 'Ludhiana', state: 'Punjab' },
  ],

  batchSizes: ['5000 metres', '12000 metres', '800 kg', '3000 pieces'],
  manufacturers: ['Weavewell Mills - Unit 3', 'Loomcraft Exports - Knitting Division'],

  /** Consumption per test, keyed by method ref. See pharmaceutical.js. */
  methodMaterials: {
    tx_m_wash: [
      { material: 'tx_mat_detergent', quantity: '0.02' },
      { material: 'tx_mat_multifibre', quantity: '0.1' },
      { material: 'tx_mat_greyscale', quantity: '0.01' },
      { material: 'tx_mat_perspiration', quantity: '0.15' },
    ],
    tx_m_rub: [{ material: 'tx_mat_rubcloth', quantity: '0.1' }],
    tx_m_ph: [{ material: 'tx_mat_beaker', quantity: '0.01' }],
  },

  materials: [
    { ref: 'tx_mat_detergent', name: 'ECE Reference Detergent Without Brightener', key: 'TX-ECE-DET', category: 'mc_reagent', unit: 'Kgs', initial_qty: '15', min_qty: '4' },
    { ref: 'tx_mat_perspiration', name: 'Acid Perspiration Solution', key: 'TX-PERSP-ACID', category: 'mc_reagent', unit: 'Litres', initial_qty: '10', min_qty: '3' },
    { ref: 'tx_mat_greyscale', name: 'Grey Scale For Colour Change', key: 'TX-GREY-CC', category: 'mc_standard', unit: 'Units', initial_qty: '6', min_qty: '2' },
    { ref: 'tx_mat_multifibre', name: 'Multifibre Adjacent Fabric DW', key: 'TX-MULTI-DW', category: 'mc_consumable', unit: 'Packets', initial_qty: '20', min_qty: '5' },
    { ref: 'tx_mat_rubcloth', name: 'Crockmeter Rubbing Cloth', key: 'TX-RUB-CLOTH', category: 'mc_consumable', unit: 'Packets', initial_qty: '14', min_qty: '4' },
    { ref: 'tx_mat_beaker', name: 'Stainless Steel Wash Beaker 550 mL', key: 'TX-BKR-550', category: 'mc_glassware', unit: 'Units', initial_qty: '30', min_qty: '8' },
  ],

  scenarios: [
    { ref: 'tx_s1', product: 'tx_p_pcblend', category: 'tx_cat_fab', customer: 'tx_c_weave', batch: 'PC-2401', parameters: ['tx_t_gsm', 'tx_t_tensile', 'tx_t_composition', 'tx_t_shrink', 'tx_t_wash', 'tx_t_ph'], allocation: 'job', flow: 'coa' },
    { ref: 'tx_s2', product: 'tx_p_denim', category: 'tx_cat_dye', customer: 'tx_c_attire', batch: 'DN-2402', parameters: ['tx_t_gsm', 'tx_t_tear', 'tx_t_rub', 'tx_t_wash', 'tx_t_shrink', 'tx_t_azo'], allocation: 'job', flow: 'approved' },
    { ref: 'tx_s3', product: 'tx_p_yarn30', category: 'tx_cat_yarn', customer: 'tx_c_loom', batch: 'YN-2403', parameters: ['tx_t_count', 'tx_t_twist', 'tx_t_tensile', 'tx_t_regain'], allocation: 'individual', flow: 'submitted', delayedByDays: 3 },
    { ref: 'tx_s4', product: 'tx_p_jersey', category: 'tx_cat_gmt', customer: 'tx_c_loom', batch: 'JS-2404', parameters: ['tx_t_gsm', 'tx_t_pilling', 'tx_t_formaldehyde', 'tx_t_ph'], allocation: 'job', flow: 'pending_approval' },
    { ref: 'tx_s5', product: 'tx_p_pcblend', category: 'tx_cat_fab', customer: 'tx_c_weave', batch: 'PC-2405', parameters: ['tx_t_gsm', 'tx_t_tensile'], allocation: 'individual', flow: 'allocated' },
    { ref: 'tx_s6', product: 'tx_p_yarn30', category: 'tx_cat_rct', customer: 'tx_c_attire', batch: 'RC-2406', parameters: ['tx_t_count', 'tx_t_regain'], allocation: 'individual', flow: 'registered' },
  ],

  multiProductScenario: null,
};

export default textile;
