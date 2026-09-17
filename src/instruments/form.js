import { parseCalendarDate } from '../components/ui/date-input.js';

const textFields = ['name', 'code', 'laboratoryId', 'serialNumber', 'make', 'modelName', 'dateOfInstallation', 'description',
  'calibrationAgency', 'costOfEquipment', 'purchaseFileId', 'currentLocation', 'manufacturerSupplier'];
const serviceFields = ['templateId', 'workflowId', 'reminderBeforeDays', 'frequencyDays', 'lastPerformedOn', 'reminderFrequencyDays', 'nextReminderOn'];
export const isBreakdownService = code => String(code).toLowerCase().replace(/[^a-z0-9]/g, '').includes('breakdown');

export function instrumentFormDraft(instrument, types, createId = () => crypto.randomUUID()) {
  return { ...Object.fromEntries(textFields.map(key => [key, instrument?.[key] ?? ''])),
    active: instrument?.active ?? true, calibrated: instrument?.calibrated ?? true, allowedUserIds: instrument?.allowedUserIds ?? [],
    serviceConfigurations: types.map(type => {
      const prior = instrument?.serviceConfigurations.find(item => item.serviceDefinitionId === type.id);
      return { id: prior?.id ?? createId(), serviceCode: type.serviceCode, active: true, reminderRoleIds: prior?.reminderRoleIds ?? [],
        ...Object.fromEntries(serviceFields.map(key => [key, prior?.[key] ?? ''])) };
    }) };
}

function calendarDate(value) {
  const parsed = parseCalendarDate(value);
  return parsed?.iso ? new Date(parsed.iso + 'T00:00:00.000Z') : null;
}
export function instrumentNextReminder(service) {
  if (!service.lastPerformedOn || service.frequencyDays === '' || service.frequencyDays == null) return service.nextReminderOn || null;
  const date = calendarDate(service.lastPerformedOn); const frequency = Number(service.frequencyDays);
  if (!date || !Number.isInteger(frequency) || frequency < 1 || frequency > 36500) return null;
  date.setUTCDate(date.getUTCDate() + frequency);
  if (date.getUTCFullYear() > 9999) throw new Error('Next service date must be no later than 31/12/9999.');
  return date.toISOString().slice(0, 10);
}
export function instrumentFormErrors(draft) {
  const errors = {};
  for (const [key, label] of [['name', 'Name'], ['code', 'Unique key'], ['laboratoryId', 'Lab'], ['dateOfInstallation', 'Date of installation']]) {
    if (!String(draft[key] ?? '').trim()) errors[key] = `${label} is required.`;
  }
  if (draft.code && !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(draft.code.trim())) errors.code = 'Use up to 64 letters, numbers, dots, slashes, underscores or hyphens.';
  if (draft.dateOfInstallation && !calendarDate(draft.dateOfInstallation)) errors.dateOfInstallation = 'Enter a valid date.';
  if (!draft.allowedUserIds.length || draft.allowedUserIds.length > 500) errors.allowedUserIds = 'Select between 1 and 500 access users.';
  for (const service of draft.serviceConfigurations) Object.assign(errors, instrumentServiceErrors(service));
  return errors;
}
export function instrumentServiceErrors(service) {
  const errors = {}; const prefix = service.id + ':';
  for (const [key, label, minimum, maximum] of [['frequencyDays', 'Frequency', 1, 36500], ['reminderBeforeDays', 'Remind before days', 0, 3650], ['reminderFrequencyDays', 'Reminder frequency', 1, 3650]]) {
    const value = service[key]; const number = Number(value);
    if (value !== '' && value != null && (!Number.isInteger(number) || number < minimum || number > maximum)) errors[prefix + key] = `${label} must be a whole number from ${minimum} to ${maximum}.`;
  }
  if (service.lastPerformedOn && !calendarDate(service.lastPerformedOn)) errors[prefix + 'lastPerformedOn'] = 'Enter a valid date.';
  try { instrumentNextReminder(service); } catch (failure) { errors[prefix + 'frequencyDays'] = failure.message; }
  if (Boolean(service.templateId) !== Boolean(service.workflowId)) errors[prefix + (service.templateId ? 'workflowId' : 'templateId')] = 'Select Template and Workflow together.';
  if (service.reminderRoleIds.length > 500 || service.templateId && !service.reminderRoleIds.length) errors[prefix + 'reminderRoleIds'] = 'Select between 1 and 500 reminder roles.';
  return errors;
}
export function instrumentFormSubmission(draft) {
  return { ...draft, dateOfInstallation: parseCalendarDate(draft.dateOfInstallation)?.iso ?? draft.dateOfInstallation,
    serviceConfigurations: draft.serviceConfigurations.map(service => ({ ...service,
    templateId: service.templateId || null, workflowId: service.workflowId || null,
    lastPerformedOn: parseCalendarDate(service.lastPerformedOn)?.iso || service.lastPerformedOn || null, nextReminderOn: instrumentNextReminder(service),
    reminderBeforeDays: service.reminderBeforeDays === '' ? 0 : Number(service.reminderBeforeDays),
    frequencyDays: service.frequencyDays === '' ? null : Number(service.frequencyDays),
    reminderFrequencyDays: service.reminderFrequencyDays === '' ? null : Number(service.reminderFrequencyDays),
  })) };
}
