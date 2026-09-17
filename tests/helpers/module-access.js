import { createAccount } from './database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { loadLaboratorySettings, saveLaboratorySettings } from '../../src/organization-settings/service.js';

export const emptyModuleAccess = () => ['customer', 'vendor', 'instrument', 'service_agreements'].map(moduleKey => ({ moduleKey, enabled: false, roleIds: [], userIds: [] }));
export const moduleAccessValues = modules => modules.map(({ moduleKey, enabled, roleIds, userIds }) => ({ moduleKey, enabled, roleIds, userIds }));

export async function saveModuleAccessSettings(actor, modules, changes = {}) {
  return withSession(actor.token, async (client, identity) => {
    const { settings } = await loadLaboratorySettings(client, identity);
    const { updatedBy: _actor, updatedAt: _time, moduleAccessRevision: _revision, moduleAccess: _modules, ...input } = settings;
    return saveLaboratorySettings(client, identity, { ...input, moduleAccess: moduleAccessValues(modules), ...changes });
  });
}

// Tests that exercise customer creation must configure an explicit grant through
// the real settings command. This never seeds access for application accounts.
export async function grantSyntheticCustomerAccess(owner, account) {
  const manager = await createAccount(owner, { organizationId: account.organizationId, permissions: ['settings.manage'] });
  Object.assign(manager, await signIn({ identifier: manager.username, password: manager.password }));
  const modules = (await withSession(manager.token, loadLaboratorySettings, { readOnly: true })).settings.moduleAccess;
  const customer = modules.find(access => access.moduleKey === 'customer');
  customer.enabled = true; customer.userIds = [...new Set([...customer.userIds, account.userId])];
  await saveModuleAccessSettings(manager, modules);
  return manager;
}

export async function grantSyntheticVendorAccess(owner, account) {
  const manager = await createAccount(owner, { organizationId: account.organizationId, permissions: ['settings.manage'] });
  Object.assign(manager, await signIn({ identifier: manager.username, password: manager.password }));
  const modules = (await withSession(manager.token, loadLaboratorySettings, { readOnly: true })).settings.moduleAccess;
  const vendor = modules.find(access => access.moduleKey === 'vendor');
  vendor.enabled = true; vendor.userIds = [...new Set([...vendor.userIds, account.userId])];
  await saveModuleAccessSettings(manager, modules);
  return manager;
}
