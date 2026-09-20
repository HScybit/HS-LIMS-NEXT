import { authenticated, endpoint, json } from '@/auth/http.js';
import { templateFieldRoleOptions } from '@/templates/authoring.js';

export const GET = endpoint(async (request) => json(await authenticated(request, (client, identity) => templateFieldRoleOptions(client, identity), { readOnly: true, permission: 'templates.manage' })));
