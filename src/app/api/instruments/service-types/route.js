import { authenticated, endpoint, json } from '@/auth/http.js';
import { instrumentServiceTypes } from '@/instruments/options.js';

export const GET = endpoint(async request => json(await authenticated(request, instrumentServiceTypes, { readOnly: true })));
