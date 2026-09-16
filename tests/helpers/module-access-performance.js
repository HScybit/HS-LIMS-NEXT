import { randomUUID } from 'node:crypto';
import { createAccount } from './database.js';
import { signIn } from '../../src/auth/service.js';
import { emptyModuleAccess, saveModuleAccessSettings } from './module-access.js';

export async function createModuleAccessPerformanceFixture(owner, count, selections = 0) {
  const actor = await createAccount(owner, { permissions: ['settings.manage'] });
  Object.assign(actor, await signIn({ identifier: actor.username, password: actor.password }));
  const roleIds = [actor.roleId, ...Array.from({ length: count - 1 }, () => randomUUID())];
  const userIds = [actor.userId, ...Array.from({ length: count - 1 }, () => randomUUID())];
  await owner.query("INSERT INTO roles(organization_id,id,name) SELECT $1,id,'Access role '||lpad(position::text,5,'0')||repeat('R',120) FROM unnest($2::uuid[]) WITH ORDINALITY AS selected(id,position)", [actor.organizationId, roleIds.slice(1)]);
  await owner.query("INSERT INTO users(id,username,email,display_name,must_change_password) SELECT id,'access-'||id,id||'@example.invalid','Access user '||lpad(position::text,5,'0')||repeat('U',120),false FROM unnest($1::uuid[]) WITH ORDINALITY AS selected(id,position)", [userIds.slice(1)]);
  await owner.query('INSERT INTO memberships(organization_id,user_id) SELECT $1,id FROM unnest($2::uuid[]) AS selected(id)', [actor.organizationId, userIds.slice(1)]);
  await owner.query("UPDATE roles SET name='ZZZ Étalon Prüfgerät' WHERE organization_id=$1 AND id=$2", [actor.organizationId, roleIds.at(-1)]);
  await owner.query("UPDATE users SET display_name='ZZZ Zoë Référence',revision=revision+1 WHERE id=$1", [userIds.at(-1)]);
  const modules = emptyModuleAccess().map(access => ({ ...access, enabled: true, roleIds: roleIds.slice(0, selections), userIds: userIds.slice(0, selections) }));
  await saveModuleAccessSettings(actor, modules);
  return { actor, roleIds, userIds, modules };
}
