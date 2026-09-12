import { HttpError } from '../auth/errors.js';
import { uuid } from './input.js';

// Mutation authorization/context queries are separate from the bounded 8+3
// definition/capture data reads. PostgreSQL verifies this ID against live access.
export async function setCaptureContext(client, instanceId) {
  uuid(instanceId, 'Capture');
  await client.query("SELECT set_config('app.capture_id', $1, true)", [instanceId]);
}

export async function requireCaptureWrite(client, instanceId) {
  await setCaptureContext(client, instanceId);
  await client.query(`SELECT laboratory_lock_request_sample(sheet.test_request_id) FROM datasheets sheet
    WHERE sheet.organization_id=nullif(current_setting('app.organization_id',true),'')::uuid AND sheet.template_instance_id=$1`, [instanceId]);
  // Assignment changes lock the request too. A save and reassignment therefore
  // have one order instead of authorizing against a mid-transaction assignment.
  await client.query(`SELECT request.id FROM test_requests request JOIN datasheets sheet
    ON sheet.organization_id = request.organization_id AND sheet.test_request_id = request.id
    WHERE sheet.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
      AND sheet.template_instance_id = $1 FOR SHARE OF request`, [instanceId]);
  const result = await client.query('SELECT laboratory_capture_can_write() AS allowed');
  if (!result.rows[0].allowed) throw new HttpError(403, 'capture_write_denied', 'You cannot edit this datasheet in its current state.');
}
