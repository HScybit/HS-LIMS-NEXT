import { bool, fieldsOnly, integer, uuid } from '../templates/input.js';

export function userStatusInput(value) {
  fieldsOnly(value, ['requestId', 'revision', 'membershipActive']);
  return { requestId: uuid(value.requestId, 'Save request').toLowerCase(),
    revision: integer(value.revision, 'Status revision', 0, 2_147_483_646), membershipActive: bool(value.membershipActive, 'Active membership') };
}
