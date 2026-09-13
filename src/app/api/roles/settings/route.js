import { authenticated, endpoint, json } from '@/auth/http.js';
import { loadRoleSettings } from '@/roles/service.js';

export const GET = endpoint(async (request) => json(await authenticated(request, loadRoleSettings, { readOnly: true })));
