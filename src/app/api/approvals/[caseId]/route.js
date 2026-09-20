import { authenticated, endpoint, json } from '@/auth/http.js';
import { HttpError } from '@/auth/errors.js';
import { readApprovalCase } from '@/workflows/load.js';

export const GET = endpoint(async (request, context) => {
  const { caseId } = await context.params;
  return json(await authenticated(request, async (client, identity) => {
    const approval = await readApprovalCase(client, identity, { caseId });
    if (!approval) throw new HttpError(404, 'approval_not_found', 'Approval request was not found.');
    return approval;
  }, { readOnly: true }));
});
