import { randomUUID } from 'node:crypto';
import { createAccount } from './database.js';
import { emptyModuleAccess, saveModuleAccessSettings } from './module-access.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { saveVendor } from '../../src/masters/vendors.js';
import { saveInstrumentCore } from '../../src/instruments/core.js';
import { instrumentCoreFields, instrumentCoreInput, instrumentRequestFingerprint } from '../../src/instruments/input.js';

export const agreementWork = (actor, action, readOnly = false) => withSession(actor.token, action, { readOnly });
export async function agreementAccount(owner, options = {}) {
  const actor = await createAccount(owner, { permissions: ['masters.manage'], ...options });
  return { ...actor, ...await signIn({ identifier: actor.username, password: actor.password }) };
}

export async function serviceAgreementFixture(owner) {
  const actor = await agreementAccount(owner, { permissions: ['settings.manage', 'masters.manage', 'instruments.manage', 'roles.manage', 'users.manage'] });
  const modules = emptyModuleAccess();
  for (const entry of modules.slice(1)) Object.assign(entry, { enabled: true, userIds: [actor.userId] });
  await saveModuleAccessSettings(actor, modules);
  const vendor = await agreementWork(actor, (client, identity) => saveVendor(client, identity, {
    id: randomUUID(), revision: 0, requestId: randomUUID(), name: 'Agreement Vendor', legalName: 'Synthetic legal name', status: 'inactive',
    contactPersonName: 'Synthetic contact', contactPersonEmail: 'agreement@example.invalid', contactPersonPhone: '0000',
  }));
  const laboratoryId = randomUUID();
  await owner.query("INSERT INTO laboratories(organization_id,id,code,name) VALUES($1,$2,'AGREEMENT-LAB','Agreement laboratory')", [actor.organizationId, laboratoryId]);
  const instruments = [];
  for (const index of [0, 1]) instruments.push(await agreementWork(actor, (client, identity) => saveInstrumentCore(client, identity, {
    id: randomUUID(), revision: 0, requestId: randomUUID(), name: `Agreement Instrument ${index}`, code: `SA-${randomUUID()}`,
    laboratoryId, dateOfInstallation: '2026-01-01', allowedUserIds: [actor.userId], active: index === 0,
  })));
  return { actor, modules, vendor, instruments, laboratoryId };
}

export const serviceAgreementCommand = (fixture, changes = {}) => ({ id: randomUUID(), revision: 0, requestId: randomUUID(), vendorId: fixture.vendor.id,
  instrumentIds: fixture.instruments.map(instrument => instrument.id), startDate: '2026-01-01', endDate: '2026-12-31', ...changes });

export async function addAgreementInstruments(fixture, total) {
  // Large synthetic catalogs use the same native save command and constraints,
  // without loading every full Instrument document back during fixture setup.
  for (let first = fixture.instruments.length; first < total; first += 100) await agreementWork(fixture.actor, async client => {
    for (let index = first; index < Math.min(first + 100, total); index++) {
      const raw = { id: randomUUID(), revision: 0, requestId: randomUUID(), name: `Choice ${String(index).padStart(5, '0')} échelle`, code: randomUUID(),
        laboratoryId: fixture.laboratoryId, dateOfInstallation: '2026-01-01', allowedUserIds: [fixture.actor.userId], active: index % 2 === 0 };
      const input = instrumentCoreInput(raw); const args = [input.id, 0, input.requestId, instrumentRequestFingerprint(raw, input),
        ...instrumentCoreFields.map(key => input[key]), input.allowedUserIds, false, ...Array.from({ length: 12 }, () => []), 0, false];
      const revision = (await client.query(`SELECT instruments_save(${args.map((_, i) => '$' + (i + 1)).join(',')}) AS revision`, args)).rows[0].revision;
      fixture.instruments.push({ ...input, revision });
    }
  });
  return fixture.instruments;
}
