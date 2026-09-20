import { HttpError } from '../auth/errors.js';

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Times/emails are replace-on-save lists (current state only), so they follow the same
// dedupe-then-validate shape the client already uses (ReminderTimes UI collects one blank row at
// minimum, blanks are dropped before save).
export function reminderSettingsInput(input) {
  if (!Object.hasOwn(input, 'reminderTimes') && !Object.hasOwn(input, 'reminderEmails')) return null;
  const times = Object.hasOwn(input, 'reminderTimes') ? input.reminderTimes : null;
  const emails = Object.hasOwn(input, 'reminderEmails') ? input.reminderEmails : null;
  let reminderTimes;
  if (times !== null) {
    if (!Array.isArray(times) || times.length > 50) throw new HttpError(400, 'invalid_reminder_times', 'Provide at most 50 reminder times.');
    reminderTimes = [...new Set(times.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
    if (reminderTimes.some((value) => !timePattern.test(value))) throw new HttpError(400, 'invalid_reminder_times', 'Reminder times must use the HH:MM format.');
  }
  let reminderEmails;
  if (emails !== null) {
    if (!Array.isArray(emails) || emails.length > 100) throw new HttpError(400, 'invalid_reminder_emails', 'Provide at most 100 reminder email addresses.');
    reminderEmails = [...new Set(emails.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim().toLowerCase()))];
    if (reminderEmails.some((value) => !emailPattern.test(value) || value.length > 254)) {
      throw new HttpError(400, 'invalid_reminder_emails', 'Enter valid reminder email addresses.');
    }
  }
  return { reminderTimes, reminderEmails };
}

export async function loadReminderSettings(client, identity) {
  const [times, emails] = await Promise.all([
    client.query('SELECT reminder_time::text AS time FROM organization_reminder_times WHERE organization_id=$1 ORDER BY reminder_time', [identity.organization_id]),
    client.query('SELECT email FROM organization_reminder_emails WHERE organization_id=$1 ORDER BY email', [identity.organization_id]),
  ]);
  return { reminderTimes: times.rows.map((row) => row.time.slice(0, 5)), reminderEmails: emails.rows.map((row) => row.email) };
}

export async function saveReminderSettings(client, identity, reminders) {
  if (reminders.reminderTimes !== undefined) {
    await client.query('DELETE FROM organization_reminder_times WHERE organization_id=$1', [identity.organization_id]);
    if (reminders.reminderTimes.length) {
      await client.query('INSERT INTO organization_reminder_times(organization_id,reminder_time) SELECT $1,value::time FROM unnest($2::text[]) AS value',
        [identity.organization_id, reminders.reminderTimes]);
    }
  }
  if (reminders.reminderEmails !== undefined) {
    await client.query('DELETE FROM organization_reminder_emails WHERE organization_id=$1', [identity.organization_id]);
    if (reminders.reminderEmails.length) {
      await client.query('INSERT INTO organization_reminder_emails(organization_id,email) SELECT $1,value FROM unnest($2::text[]) AS value',
        [identity.organization_id, reminders.reminderEmails]);
    }
  }
}
