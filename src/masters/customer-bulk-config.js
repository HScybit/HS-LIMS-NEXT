// CustomerMasterItem order after the source template's metadata exclusions.
export const customerBulkHeaders = Object.freeze(['name', 'gst_number', 'legal_name', 'ship_to_address', 'bill_to_address',
  'default_credit_period', 'contact_person_name', 'contact_person_email', 'contact_person_phone', 'default_invoice_notes',
  'status', 'igst', 'cgst', 'sgst', 'customer_total_balance', 'abbr', 'isFeedback', 'discount', 'is_kaleen_bandhu']);

export const customerBulkExample = Object.freeze({ name: 'Example Customer', gst_number: '27ABCDE1234F1Z5', legal_name: 'Example Customer Pvt Ltd',
  ship_to_address: 'Example shipping address', bill_to_address: 'Example billing address', default_credit_period: '30',
  contact_person_name: 'Example Contact', contact_person_email: 'contact@example.com', contact_person_phone: '9876543210',
  default_invoice_notes: 'Example invoice note', status: 'active', igst: '18', cgst: '0', sgst: '0', customer_total_balance: '0',
  abbr: 'EXC', isFeedback: 'false', discount: '0', is_kaleen_bandhu: 'false' });
