// Source date-control parsing. This formats an editing buffer; it is not the captured-value validator.
function pad(value) {
  return String(value).padStart(2, '0');
}

function toIsoDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function toDisplayDate(date) {
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

function toDateFromParts(day, month, year) {
  const parsed = new Date(Number(year), Number(month) - 1, Number(day));

  if (
    parsed.getFullYear() === Number(year) &&
    parsed.getMonth() === Number(month) - 1 &&
    parsed.getDate() === Number(day)
  ) {
    return parsed;
  }

  return null;
}

export function parseVisibleDate(value) {
  const trimmed = String(value ?? '').trim();

  if (!trimmed) {
    return { display: '', iso: '' };
  }

  const dateTimeMatch = trimmed.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[\s,]+(\d{1,2}):(\d{2}))?$/
  );

  if (dateTimeMatch) {
    const [, day, month, year] = dateTimeMatch;
    const parsed = toDateFromParts(day, month, year);

    if (parsed) {
      return { display: toDisplayDate(parsed), iso: toIsoDate(parsed) };
    }
  }

  const namedMonthMatch = trimmed.match(
    /(?:\d{1,2}:\d{2}\s*(?:am|pm)\s*)?(\d{1,2})\s+([a-z]+)\s+(\d{4})/i
  );

  if (namedMonthMatch) {
    const [, day, monthName, year] = namedMonthMatch;
    const monthIndex = [
      'january',
      'february',
      'march',
      'april',
      'may',
      'june',
      'july',
      'august',
      'september',
      'october',
      'november',
      'december',
    ].indexOf(monthName.toLowerCase());

    if (monthIndex >= 0) {
      const parsed = toDateFromParts(day, monthIndex + 1, year);

      if (parsed) {
        return { display: toDisplayDate(parsed), iso: toIsoDate(parsed) };
      }
    }
  }

  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    const parsed = toDateFromParts(day, month, year);

    if (parsed) {
      return { display: toDisplayDate(parsed), iso: trimmed };
    }
  }

  const fallback = new Date(trimmed);
  if (!Number.isNaN(fallback.getTime())) {
    return { display: toDisplayDate(fallback), iso: toIsoDate(fallback) };
  }

  return null;
}

export function formatDateInput(value) {
  const digits = value.replace(/\D/g, '').slice(0, 8);
  const day = digits.slice(0, 2);
  const month = digits.slice(2, 4);
  const year = digits.slice(4, 8);

  return [day, month, year].filter(Boolean).join('/');
}
