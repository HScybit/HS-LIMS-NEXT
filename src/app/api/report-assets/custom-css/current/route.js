import { authenticated, endpoint, json } from '@/auth/http.js';
import { loadCurrentCustomCss } from '@/report-assets/custom-css.js';

export const GET = endpoint(async (request) => json(await authenticated(request, loadCurrentCustomCss, { readOnly: true })));
