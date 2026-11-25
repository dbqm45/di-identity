import type { Admin } from '../keycloak/admin.ts';
import { listAgents, organizationByAlias, setAgentEnabled } from '../keycloak/agents.ts';
import { addMember, findPerson, grantRole, revokeRole } from '../keycloak/people.ts';

/**
 * What the admin console (docs/plan-admin-console.md) reads and changes in Keycloak, with the di-identity service
 * account. Kept behind an interface so the console's rules (organization scope, last admin, the log) are tested
 * without a Keycloak; the calls themselves are tested on a real one (test/keycloak.test.ts).
 */
export interface Person {
  /** The suite `sub`. */
  id: string;
  name: string;
  email: string;
  /** Product roles as `<client>:<role>`. */
  roles: string[];
}

export interface AgentView {
  clientId: string;
  owner: string;
  reviewBy: string;
  enabled: boolean;
}

/** A refusal with a message for the admin (409 in the console). */
export class DirectoryError extends Error {}

export interface Directory {
  /** People of the organization (never agents), with their product roles. */
  people(organization: string): Promise<Person[]>;
  /** Adds a person who has signed in to the suite at least once; DirectoryError otherwise. */
  add(organization: string, email: string): Promise<Person>;
  /** Adds the person with this `sub` (from an invitation); `added` false when they already were a member. */
  join(organization: string, id: string): Promise<{ person: Person; added: boolean }>;
  remove(organization: string, id: string): Promise<void>;
  grant(id: string, role: string): Promise<void>;
  revoke(id: string, role: string): Promise<void>;
  agents(organization: string): Promise<AgentView[]>;
  setAgent(clientId: string, enabled: boolean): Promise<void>;
}

interface Member {
  id: string;
  username?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}

const nameOf = (m: Member) => [m.firstName, m.lastName].filter(Boolean).join(' ') || m.username || m.id;

export function keycloakDirectory(admin: Admin, realm: string, products: Record<string, string[]>): Directory {
  const R = `/${realm}`;
  const rolesOf = async (id: string): Promise<string[]> => {
    const mappings = await admin.call<{ clientMappings?: Record<string, { client?: string; mappings?: { name: string }[] }> }>('GET', `${R}/users/${id}/role-mappings`);
    const out: string[] = [];
    for (const [client, m] of Object.entries(mappings.clientMappings ?? {})) {
      const clientId = m.client ?? client;
      if (!products[clientId]) continue;
      for (const r of m.mappings ?? []) if (products[clientId]!.includes(r.name)) out.push(`${clientId}:${r.name}`);
    }
    return out.sort();
  };
  const person = async (m: Member): Promise<Person> => ({ id: m.id, name: nameOf(m), email: m.email ?? '', roles: await rolesOf(m.id) });
  return {
    async people(organization) {
      const org = await organizationByAlias(admin, realm, organization);
      const members = await admin.call<Member[]>('GET', `${R}/organizations/${org.id}/members?max=1000&briefRepresentation=false`);
      const people = members.filter((m) => !m.username?.startsWith('service-account-'));
      return (await Promise.all(people.map(person))).sort((a, b) => a.name.localeCompare(b.name));
    },
    async add(organization, email) {
      let found;
      try {
        found = await findPerson(admin, realm, email);
      } catch (err) {
        throw new DirectoryError(/is an agent/.test((err as Error).message) ? 'an agent cannot be added as a person' : 'no person with this e-mail has signed in to the suite yet');
      }
      await addMember(admin, { realm, organization, who: found.id });
      return person(found as Member);
    },
    async join(organization, id) {
      const found = await findPerson(admin, realm, id);
      const added = await addMember(admin, { realm, organization, who: found.id });
      return { person: await person(found as Member), added };
    },
    async remove(organization, id) {
      const org = await organizationByAlias(admin, realm, organization);
      await admin.call('DELETE', `${R}/organizations/${org.id}/members/${id}`);
    },
    async grant(id, role) {
      await grantRole(admin, { realm, who: id, role });
    },
    async revoke(id, role) {
      await revokeRole(admin, { realm, who: id, role });
    },
    async agents(organization) {
      return listAgents(admin, realm, organization);
    },
    async setAgent(clientId, enabled) {
      await setAgentEnabled(admin, realm, clientId, enabled);
    },
  };
}
