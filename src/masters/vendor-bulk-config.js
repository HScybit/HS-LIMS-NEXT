import { vendorFormFields } from './vendor-fields.js';

// VendorMasterItem order after metadata exclusions. The optional abbreviation
// and balance columns are also accepted, preserving the confirmed PERN behavior.
export const vendorBulkHeaders = Object.freeze(['name', 'gst_number', 'legal_name', 'contact_person_name', 'contact_person_email', 'contact_person_phone', 'status']);
export const vendorBulkFields = Object.freeze([...vendorFormFields, Object.freeze({ key: 'status', source: 'status', type: 'select' })]);
export const vendorBulkExample = Object.freeze({ name: 'Example Vendor', gst_number: '27ABCDE1234F1Z5', legal_name: 'Example Vendor Pvt Ltd',
  contact_person_name: 'Example Contact', contact_person_email: 'vendor@example.com', contact_person_phone: '9876543210', status: 'active' });
