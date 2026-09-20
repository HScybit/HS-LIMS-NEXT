// The Customer form retains Meteor's field order, labels and help. Numeric
// bounds and defaults follow the confirmed PERN behavior.
export const customerFormFields = Object.freeze([
  { key: 'name', source: 'name', label: 'Name', type: 'text', required: true, maximum: 250, placeholder: 'Add name of the field', helperText: 'Name of the Customer. This can be the legal name or the name you would like to address' },
  { key: 'legalName', source: 'legal_name', label: 'Legal Name', type: 'text', required: true, maximum: 250, placeholder: 'Add Description of the Customer', helperText: 'The Legal name of the Customer as in GST certificate or other legal papers' },
  { key: 'abbreviation', source: 'abbr', label: 'Abbreviation', type: 'text', maximum: 64, placeholder: 'Add Abbreviation of the Customer', helperText: 'The Abbreviation which will be used in schemes' },
  { key: 'shipToAddress', source: 'ship_to_address', label: 'Ship to Address', type: 'textarea', maximum: 4000, placeholder: 'Ship to Address', helperText: 'The Ship to Address of the Customer' },
  { key: 'billToAddress', source: 'bill_to_address', label: 'Bill to Address', type: 'textarea', maximum: 4000, placeholder: 'Bill to Address', helperText: 'The Billing Address of the Customer' },
  { key: 'defaultInvoiceNotes', source: 'default_invoice_notes', label: 'Notes', type: 'textarea', maximum: 10000, placeholder: 'Notes', helperText: 'The Notes to be added in invoice. This can be changes in invoice' },
  { key: 'feedbackApplicable', source: 'isFeedback', label: 'Applicable for Feedback', type: 'boolean', defaultValue: false },
  { key: 'taxIdentifier', source: 'gst_number', label: 'GST Number', type: 'text', maximum: 100, placeholder: 'GST Number', helperText: 'The GST number of the Customer. Leave blank for unregistered business' },
  { key: 'totalBalance', source: 'customer_total_balance', label: 'Total Balance (in Rs.)', type: 'number', defaultValue: 0 },
  { key: 'igstPercent', source: 'igst', label: 'IGST %', type: 'number', min: 0, max: 100, defaultValue: 18, helperText: 'The IGST % for the customer. Put 0 if not applicable' },
  { key: 'sgstPercent', source: 'sgst', label: 'SGST %', type: 'number', min: 0, max: 100, defaultValue: 0, helperText: 'The SGST % for the customer. Put 0 if not applicable' },
  { key: 'cgstPercent', source: 'cgst', label: 'CGST %', type: 'number', min: 0, max: 100, defaultValue: 0, helperText: 'The CGST % for the customer. Put 0 if not applicable' },
  { key: 'discountPercent', source: 'discount', label: 'Discount %', type: 'number', min: 0, max: 100, defaultValue: 0 },
  { key: 'contactPersonName', source: 'contact_person_name', label: 'Contact Person', type: 'text', required: true, maximum: 200, placeholder: 'Name of the contact person', helperText: 'Name of the contact person' },
  { key: 'contactPersonEmail', source: 'contact_person_email', label: 'Contact Person Email', type: 'email', required: true, maximum: 320, placeholder: 'Email of the contact person', helperText: 'Email of the contact person' },
  { key: 'contactPersonPhone', source: 'contact_person_phone', label: 'Contact Person Phone', type: 'text', required: true, maximum: 50, placeholder: 'Phone of the contact person', helperText: 'Phone of the contact person' },
  { key: 'creditDays', source: 'default_credit_period', label: 'Default Credit Period', type: 'number', min: 0, max: 3650, step: 1, defaultValue: 30, helperText: 'Default Credit Period in Days. This can be changed in Invoice' },
  { key: 'isKaleenBandhu', source: 'is_kaleen_bandhu', label: 'Is Kaleen Bandhu?', type: 'boolean', defaultValue: false },
  { key: 'status', source: 'status', label: 'Status', type: 'select', defaultValue: 'active', options: [{ label: 'Active', value: 'active' }, { label: 'Inactive', value: 'inactive' }] },
].map(Object.freeze));
