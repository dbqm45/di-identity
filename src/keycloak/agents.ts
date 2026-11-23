import type { Admin } from './admin.ts';

/**
 * Agents as subjects of the suite (ADR 17 §2.6, DI4): one Keycloak client with a service account per agent definition
 * in one organization (`agent-<persona>-<organization>`), with a human owner, a purpose and a review date. The client
 * signs in with private_key_jwt: Keycloak keeps only the public key; the private key stays with whoever runs the
 * agent, outside the phase container (DZ9). Tokens live `agentTokenSeconds` (10 minutes) with no refresh token.
 */
export interface AgentInput {
  realm: string;
  organization: string;
  persona: string;
  /** `sub` of the person responsible; must be a member of the organization. */
  owner: string;
  purpose: string;
  /** Public signing key (JWK, RSA) of the agent. */
  publicJwk: Record<string, unknown> & { kid: string };
  /** Product roles, e.g. `di-decision:viewer`. Never `admin` (DI4). */
  roles: string[];
  tokenSeconds: number;
  reviewDays?: number;
  today?: Date;
}

export interface Agent {
  clientId: string;
  sub: string;
  reviewBy: string;
}

interface Named {
  id: string;
  name?: string;
  clientId?: string;
  alias?: string;
  username?: string;
  enabled?: boolean;
  attributes?: Record<string, string[]>;
}

const SLUG = /^[a-z][a-z0-9-]{0,40}$/;
export const agentClientId = (persona: string, organization: string) => `agent-${persona}-${organization}`;

// `exact=true` would match the name, not the alias (Keycloak 26.4), so the search is filtered by alias here.
async function organizationByAlias(admin: Admin, realm: string, alias: string): Promise<Named> {
  const found = await admin.call<Named[]>('GET', `/${realm}/organizations?search=${encodeURIComponent(alias)}`);
  const org = found.find((o) => o.alias === alias);
  if (!org) throw new Error(`organization ${alias} does not exist`);
  return org;
}

export async function createOrganization(admin: Admin, input: { realm: string; name: string; alias: string; domain?: string }): Promise<string> {
  if (!SLUG.test(input.alias)) throw new Error('the organization alias is lowercase letters, digits and dashes');
  return admin.create(`/${input.realm}/organizations`, {
    name: input.name,
    alias: input.alias,
    enabled: true,
    domains: input.domain ? [{ name: input.domain, verified: false }] : [],
  });
}

export async function createAgent(admin: Admin, a: AgentInput): Promise<Agent> {
  if (!SLUG.test(a.persona)) throw new Error('the persona is lowercase letters, digits and dashes');
  if (!a.purpose.trim()) throw new Error('an agent needs a purpose');
  if (a.publicJwk.kty !== 'RSA' || typeof a.publicJwk.n !== 'string' || 'd' in a.publicJwk) throw new Error('the key must be a public RSA JWK (no private part)');
  const parsed = a.roles.map((r) => {
    const [client, role] = r.split(':');
    if (!client || !role) throw new Error(`role ${r} is not <client>:<role>`);
    if (role === 'admin') throw new Error('an agent never gets the admin role (DI4)');
    return { client, role };
  });
  const R = `/${a.realm}`;
  const org = await organizationByAlias(admin, a.realm, a.organization);
  const members = await admin.call<Named[]>('GET', `${R}/organizations/${org.id}/members?max=1000`);
  if (!members.some((m) => m.id === a.owner)) throw new Error('the owner is not a member of the organization');
  const owner = await admin.call<Named>('GET', `${R}/users/${a.owner}`);
  if (owner.attributes?.kind?.includes('agent')) throw new Error('the owner must be a person, not an agent');

  const clientId = agentClientId(a.persona, a.organization);
  const today = a.today ?? new Date();
  const reviewBy = new Date(today.getTime() + (a.reviewDays ?? 90) * 86_400_000).toISOString().slice(0, 10);
  const id = await admin.create(`${R}/clients`, {
    clientId,
    name: `Agent ${a.persona} (${a.organization})`,
    description: a.purpose,
    enabled: true,
    protocol: 'openid-connect',
    publicClient: false,
    standardFlowEnabled: false,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: true,
    clientAuthenticatorType: 'client-jwt',
    attributes: {
      'use.jwks.string': 'true',
      'jwks.string': JSON.stringify({ keys: [{ ...a.publicJwk, use: 'sig', alg: 'RS256' }] }),
      'token.endpoint.auth.signing.alg': 'RS256',
      'access.token.lifespan': String(a.tokenSeconds),
      'client_credentials.use_refresh_token': 'false',
    },
  });
  const sa = await admin.call<Named>('GET', `${R}/clients/${id}/service-account-user`);
  await admin.call('PUT', `${R}/users/${sa.id}`, {
    ...sa,
    attributes: { kind: ['agent'], owner: [a.owner], purpose: [a.purpose], review_by: [reviewBy], organization: [a.organization] },
  });
  await admin.call('POST', `${R}/organizations/${org.id}/members`, sa.id);
  for (const { client, role } of parsed) {
    const target = (await admin.call<Named[]>('GET', `${R}/clients?clientId=${encodeURIComponent(client)}`))[0];
    if (!target) throw new Error(`client ${client} does not exist`);
    const r = await admin.call<Named>('GET', `${R}/clients/${target.id}/roles/${encodeURIComponent(role)}`);
    await admin.call('POST', `${R}/users/${sa.id}/role-mappings/clients/${target.id}`, [r]);
  }
  return { clientId, sub: sa.id, reviewBy };
}

/** Agents of an organization: client id, owner, review date and whether the agent is on. */
export async function listAgents(admin: Admin, realm: string, organization: string) {
  const R = `/${realm}`;
  const org = await organizationByAlias(admin, realm, organization);
  const members = await admin.call<Named[]>('GET', `${R}/organizations/${org.id}/members?max=1000&briefRepresentation=false`);
  const out: { clientId: string; owner: string; reviewBy: string; enabled: boolean }[] = [];
  for (const m of members) {
    if (!m.username?.startsWith('service-account-agent-')) continue;
    const user = await admin.call<Named>('GET', `${R}/users/${m.id}`);
    if (!user.attributes?.kind?.includes('agent')) continue;
    const clientId = (user.username ?? '').replace(/^service-account-/, '');
    const client = (await admin.call<Named[]>('GET', `${R}/clients?clientId=${encodeURIComponent(clientId)}`))[0];
    out.push({ clientId, owner: user.attributes.owner?.[0] ?? '', reviewBy: user.attributes.review_by?.[0] ?? '', enabled: Boolean(client?.enabled) });
  }
  return out.sort((x, y) => x.clientId.localeCompare(y.clientId));
}

/**
 * Turns an agent off or on. Off: Keycloak issues no new token at once; tokens already issued expire within
 * `agentTokenSeconds` (AN6).
 */
export async function setAgentEnabled(admin: Admin, realm: string, clientId: string, enabled: boolean): Promise<void> {
  if (!clientId.startsWith('agent-')) throw new Error('not an agent client');
  const client = (await admin.call<Named[]>('GET', `/${realm}/clients?clientId=${encodeURIComponent(clientId)}`))[0];
  if (!client) throw new Error(`agent ${clientId} does not exist`);
  await admin.call('PUT', `/${realm}/clients/${client.id}`, { ...client, enabled });
}

/** The organization's kill switch (AN6): every agent of the organization off. Returns the client ids turned off. */
export async function disableOrganizationAgents(admin: Admin, realm: string, organization: string): Promise<string[]> {
  const agents = await listAgents(admin, realm, organization);
  for (const a of agents) if (a.enabled) await setAgentEnabled(admin, realm, a.clientId, false);
  return agents.filter((a) => a.enabled).map((a) => a.clientId);
}
