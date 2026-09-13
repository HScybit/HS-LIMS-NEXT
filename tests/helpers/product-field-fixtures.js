import { randomUUID } from 'node:crypto';
import { saveCustomField } from '../../src/masters/custom-fields.js';
import { saveProduct } from '../../src/masters/products.js';

// Synthetic source-supported controls. The last three fields exercise ordered scheme dependencies.
export async function createProductFieldFixture(work, { fieldCount, productCount, userId }) {
  const fields = await work(async (client, identity) => {
    const result = [];
    for (let index = 0; index < fieldCount; index++) {
      const type = ['text', 'number', 'date', 'select', 'longtext', 'checkbox', 'multi_user_select', 'number'][index % 8];
      const generated = index >= fieldCount - 3;
      result.push(await saveCustomField(client, identity, {
        id: randomUUID(), requestId: randomUUID(), revision: 0, key: `field_${index}`, label: `Synthetic field ${index + 1}`,
        associatedWith: 'product', fieldType: generated ? 'text' : type, displayOrder: index,
        showInList: true, showInFilter: true, allowsMultiple: !generated && index % 8 === 7,
        ...(!generated && type === 'select' ? { options: Array.from({ length: 5 }, (_, option) => ({ id: randomUUID(), key: `choice_${option}`, label: `Choice ${option}` })) } : {}),
        ...(generated ? { generatedAt: 'on_init', splitter: '/', paddedNumber: 2,
          scheme: index === fieldCount - 3 ? 'P/{{scheme_counter}}' : `{{field_${index - 1}}}/copy` } : {}),
      }));
    }
    return result;
  });
  const values = fields.map((field, index) => {
    let value = `Synthetic value ${index}`;
    if (index >= fieldCount - 3) value = `P/001${'/copy'.repeat(index - (fieldCount - 3))}`;
    else if (field.allowsMultiple) value = ['0', 'invalid', ...Array.from({ length: 8 }, (_, item) => String(item + 1))];
    else if (field.fieldType === 'date') value = '31/12/2026';
    else if (field.fieldType === 'number') value = '0';
    else if (field.fieldType === 'checkbox') value = false;
    else if (field.fieldType === 'select') value = 'choice_0';
    else if (field.fieldType === 'multi_user_select') value = [userId];
    return { fieldId: field.id, fieldRevision: field.revision, value };
  });
  const product = { name: 'Synthetic performance Product', key: 'synthetic-performance', description: '', abbreviation: 'P', jobTemplateId: null, tagIds: [] };
  const products = [];
  for (let index = 0; index < productCount; index++) products.push(await work((client, identity) => saveProduct(client, identity, {
    ...product, key: `synthetic-performance-${index}`, id: randomUUID(), requestId: randomUUID(), revision: 0,
    customFields: values, customFieldTimeZone: 'UTC',
  })));
  return { fields, values, product, products };
}
