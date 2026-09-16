import { randomUUID } from 'node:crypto';
import { saveCustomField } from '../../src/masters/custom-fields.js';
import { saveMethod } from '../../src/masters/methods.js';

// Synthetic source-supported controls. The last three fields exercise ordered scheme dependencies.
export async function createMethodFieldFixture(work, { fieldCount, methodCount, userId }) {
  const fields = await work(async (client, identity) => {
    const result = [];
    for (let index = 0; index < fieldCount; index++) {
      const type = ['text', 'number', 'date', 'select', 'longtext', 'checkbox', 'multi_user_select', 'number'][index % 8];
      const generated = index >= fieldCount - 3;
      result.push(await saveCustomField(client, identity, {
        id: randomUUID(), requestId: randomUUID(), revision: 0, key: `field_${index}`, label: `Synthetic field ${index + 1}`,
        associatedWith: 'method_of_analysis', fieldType: generated ? 'text' : type, displayOrder: index,
        showInList: true, showInFilter: true, allowsMultiple: !generated && index % 8 === 7,
        ...(!generated && type === 'select' ? { options: Array.from({ length: 5 }, (_, option) => ({ id: randomUUID(), key: `choice_${option}`, label: `Choice ${option}` })) } : {}),
        ...(generated ? { generatedAt: 'on_init', splitter: '/', paddedNumber: 2,
          scheme: index === fieldCount - 3 ? 'M/{{scheme_counter}}' : `{{field_${index - 1}}}/copy` } : {}),
      }));
    }
    return result;
  });
  const values = fields.map((field, index) => {
    let value = `Synthetic value ${index}`;
    if (index >= fieldCount - 3) value = `M/001${'/copy'.repeat(index - (fieldCount - 3))}`;
    else if (field.allowsMultiple) value = ['0', 'invalid', ...Array.from({ length: 8 }, (_, item) => String(item + 1))];
    else if (field.fieldType === 'date') value = '31/12/2026';
    else if (field.fieldType === 'number') value = '0';
    else if (field.fieldType === 'checkbox') value = false;
    else if (field.fieldType === 'select') value = 'choice_0';
    else if (field.fieldType === 'multi_user_select') value = [userId];
    return { fieldId: field.id, fieldRevision: field.revision, value };
  });
  const method = { name: 'Synthetic performance Method', uuid: 'synthetic-performance', description: '', decimalScale: 4, parseNumber: false, accessUserIds: [userId] };
  const methods = [];
  for (let index = 0; index < methodCount; index++) methods.push(await work((client, identity) => saveMethod(client, identity, {
    ...method, uuid: `synthetic-performance-${index}`, id: randomUUID(), requestId: randomUUID(), revision: 0,
    customFields: values, customFieldTimeZone: 'UTC',
  })));
  return { fields, values, method, methods };
}
