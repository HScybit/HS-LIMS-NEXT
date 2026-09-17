// Source Vendor order, labels and help; numeric defaults follow confirmed PERN behavior.
export const vendorFormFields = Object.freeze([
  { key: 'name', source: 'name', label: 'Name', type: 'text', required: true, maximum: 250, placeholder: 'Add name of the field', helperText: 'Name of the vendor. This can be the legal name or the name you would like to address' },
  { key: 'legalName', source: 'legal_name', label: 'Legal Name', type: 'text', required: true, maximum: 250, placeholder: 'Add Description of the vendor', helperText: 'The Legal name of the vendor as in GST certificate or other legal papers' },
  { key: 'abbreviation', source: 'abbr', label: 'Abbreviation', type: 'text', maximum: 64, placeholder: 'Add Abbreviation of the vendor', helperText: 'The Abbreviation which will be used in schemes' },
  { key: 'taxIdentifier', source: 'gst_number', label: 'GST Number', type: 'text', maximum: 100, placeholder: 'GST Number', helperText: 'The GST number of the vendor. Leave blank for unregistered business' },
  { key: 'totalBalance', source: 'vendor_total_balance', label: 'Total Balance (in Rs.)', type: 'number', defaultValue: 0, placeholder: 'Total Balance (in Rs.)' },
  { key: 'contactPersonName', source: 'contact_person_name', label: 'Contact Person', type: 'text', required: true, maximum: 200, placeholder: 'Name of the contact person', helperText: 'Name of the contact person' },
  { key: 'contactPersonEmail', source: 'contact_person_email', label: 'Contact Person Email', type: 'email', required: true, maximum: 320, placeholder: 'Email of the contact person', helperText: 'Email of the contact person' },
  { key: 'contactPersonPhone', source: 'contact_person_phone', label: 'Contact Person Phone', type: 'text', required: true, maximum: 50, placeholder: 'Phone of the contact person', helperText: 'Phone of the contact person' },
].map(Object.freeze));
