import { authenticated, endpoint, json } from '@/auth/http.js';
import { listDataTransferEntities } from '@/masters/data-transfer.js';

export const GET = endpoint(async request => json(await authenticated(request, (client, identity) => listDataTransferEntities(client, identity), { readOnly: true })));
