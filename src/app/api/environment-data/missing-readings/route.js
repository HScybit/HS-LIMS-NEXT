import { authenticated, endpoint, json } from '@/auth/http.js';
import { laboratoriesMissingReadings } from '@/environment/service.js';

export const GET = endpoint(async (request) => json(await authenticated(request, laboratoriesMissingReadings, { readOnly: true })));
