import { randomUUID } from 'node:crypto';
import { saveCustomField } from '../../src/masters/custom-fields.js';
import { saveVendor } from '../../src/masters/vendors.js';

// Synthetic source-supported controls. The last three fields exercise ordered scheme dependencies.
export async function createVendorFieldFixture(work, { fieldCount, vendorCount, userId }) {
  const fields = await work(async (client, identity) => {
    const result = [];
    for (let index = 0; index < fieldCount; index++) {
      const type = ['text', 'number', 'date', 'select', 'longtext', 'checkbox', 'multi_user_select', 'number'][index % 8];
      const generated = index >= fieldCount - 3;
      result.push(await saveCustomField(client, identity, {
        id: randomUUID(), requestId: randomUUID(), revision: 0, key: `field_${index}`, label: `Synthetic field ${index + 1}`,
        associatedWith: 'vendor', fieldType: generated ? 'text' : type, displayOrder: index,
        showInList: true, showInFilter: true, allowsMultiple: !generated && index % 8 === 7,
        ...(!generated && type === 'select' ? { options: Array.from({ length: 5 }, (_, option) => ({ id: randomUUID(), key: `choice_${option}`, label: `Choice ${option}` })) } : {}),
        ...(generated ? { generatedAt: 'on_init', splitter: '/', paddedNumber: 2,
          scheme: index === fieldCount - 3 ? 'C/{{scheme_counter}}' : `{{field_${index - 1}}}/copy` } : {}),
      }));
    }
    return result;
  });
  const values = fields.map((field, index) => {
    let value = `Synthetic value ${index}`;
    if (index >= fieldCount - 3) value = `C/001${'/copy'.repeat(index - (fieldCount - 3))}`;
    else if (field.allowsMultiple) value = ['0', 'invalid', ...Array.from({ length: 8 }, (_, item) => String(item + 1))];
    else if (field.fieldType === 'date') value = '31/12/2026';
    else if (field.fieldType === 'number') value = '0';
    else if (field.fieldType === 'checkbox') value = false;
    else if (field.fieldType === 'select') value = 'choice_0';
    else if (field.fieldType === 'multi_user_select') value = [userId];
    return { fieldId: field.id, fieldRevision: field.revision, value };
  });
  const vendor = { name: 'Synthetic performance Vendor', legalName: 'Synthetic legal name', abbreviation: 'C', contactPersonName: 'Synthetic contact', contactPersonEmail: 'synthetic@example.invalid', contactPersonPhone: '000', totalBalance: '0' };
  const vendors = [];
  for (let index = 0; index < vendorCount; index++) vendors.push(await work((client, identity) => saveVendor(client, identity, {
    ...vendor, code: `C-${index}`, name: `Synthetic performance Vendor ${index}`, id: randomUUID(), requestId: randomUUID(), revision: 0,
    customFields: values, customFieldTimeZone: 'UTC',
  })));
  return { fields, values, vendor, vendors };
}
