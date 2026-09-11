export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function requireText(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new HttpError(400, 'invalid_input', `${label} is required and must not exceed ${max} characters.`);
  }
  return value;
}
