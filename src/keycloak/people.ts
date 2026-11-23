import type { Admin } from './admin.ts';
import { organizationByAlias } from './agents.ts';

/**
 * People in the suite realm (ADR 17 §2.2): membership of an organization and product roles, until Admin Console
 * (AC1) does this in a screen. A person signs in through the organization's identity provider (Google first, DI2),
 * which creates the account on the first sign-in; these commands work on accounts that already exist. Agents are
 * not people: their roles are set when they are created (`agent create`), so these commands refuse them.
 */
interface User {
  id: string;
  username?: string;
  email?: string;
  attributes?: Record<string, string[]>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A person by e-mail, user name or `sub`; never an agent. */
export async function findPerson(admin: Admin, realm: string, who: string): Promise<User> {
  const R = `/${realm}`;
  let found: User[];
  if (UUID.test(who)) found = [await admin.call<User>('GET', `${R}/users/${who}`)];
  else if (who.includes('@')) found = await admin.call<User[]>('GET', `${R}/users?email=${encodeURIComponent(who)}&exact=true&briefRepresentation=false`);
  else found = await admin.call<User[]>('GET', `${R}/users?username=${encodeURIComponent(who)}&exact=true&briefRepresentation=false`);
  if (found.length !== 1 || !found[0]) throw new Error(`no single person ${who}; they appear after their first sign-in`);
  const user = found[0];
  if (user.attributes?.kind?.includes('agent') || user.username?.startsWith('service-account-')) throw new Error(`${who} is an agent, not a person`);
  return user;
}

/** Adds a person to an organization; returns false when they already are a member. */
export async function addMember(admin: Admin, input: { realm: string; organization: string; who: string }): Promise<boolean> {
  const R = `/${input.realm}`;
  const org = await organizationByAlias(admin, input.realm, input.organization);
  const person = await findPerson(admin, input.realm, input.who);
  const members = await admin.call<User[]>('GET', `${R}/organizations/${org.id}/members?max=1000`);
  if (members.some((m) => m.id === person.id)) return false;
  await admin.call('POST', `${R}/organizations/${org.id}/members`, person.id);
  return true;
}

async function productRole(admin: Admin, realm: string, spec: string): Promise<{ clientUuid: string; role: unknown; label: string }> {
  const [client, role] = spec.split(':');
  if (!client || !role) throw new Error(`role ${spec} is not <client>:<role>, e.g. di-release-control:admin`);
  if (client.startsWith('agent-')) throw new Error('roles are granted on product clients, not on agents');
  const target = (await admin.call<{ id: string }[]>('GET', `/${realm}/clients?clientId=${encodeURIComponent(client)}`))[0];
  if (!target) throw new Error(`client ${client} does not exist`);
  const r = await admin.call('GET', `/${realm}/clients/${target.id}/roles/${encodeURIComponent(role)}`);
  return { clientUuid: target.id, role: r, label: `${client}:${role}` };
}

/** Grants a product role (`<client>:<role>`) to a person. */
export async function grantRole(admin: Admin, input: { realm: string; who: string; role: string }): Promise<void> {
  const person = await findPerson(admin, input.realm, input.who);
  const { clientUuid, role } = await productRole(admin, input.realm, input.role);
  await admin.call('POST', `/${input.realm}/users/${person.id}/role-mappings/clients/${clientUuid}`, [role]);
}

/** Takes a product role away from a person. */
export async function revokeRole(admin: Admin, input: { realm: string; who: string; role: string }): Promise<void> {
  const person = await findPerson(admin, input.realm, input.who);
  const { clientUuid, role } = await productRole(admin, input.realm, input.role);
  await admin.call('DELETE', `/${input.realm}/users/${person.id}/role-mappings/clients/${clientUuid}`, [role]);
}
