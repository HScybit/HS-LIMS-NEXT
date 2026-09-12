import { fieldsOnly } from './input.js';
import { HttpError } from '../auth/errors.js';

export const imageLayoutLabels = { widthPercent: 'Width(%)', marginTop: 'Margin Top(px)', marginBottom: 'Margin Bottom(px)', marginRight: 'Margin Right(px)', marginLeft: 'Margin Left(px)', alignment: 'Align (start, center, end)' };

export function imageLayout(input = {}) {
  fieldsOnly(input, Object.keys(imageLayoutLabels));
  if (Object.values(input).some((value) => value !== null && value !== undefined && !['string', 'number', 'boolean'].includes(typeof value))) {
    throw new HttpError(400, 'invalid_input', 'Image layout values must be text or numbers.');
  }
  const result = {};
  for (const key of Object.keys(imageLayoutLabels).filter((key) => key !== 'alignment')) {
    const parsed = Number.parseFloat(String(input[key] ?? ''));
    result[key] = Number.isFinite(parsed) ? parsed : key === 'widthPercent' ? 100 : 0;
  }
  const alignment = String(input.alignment || 'start').trim().toLowerCase();
  result.alignment = ['center', 'middle'].includes(alignment) ? 'center' : ['end', 'right', 'flex-end'].includes(alignment) ? 'end' : 'start';
  return result;
}
