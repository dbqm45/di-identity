import { AdminError, type Admin } from './admin.ts';
import { organizationByAlias } from './agents.ts';
import { CREATE_ONLY_FLOW } from './configure.ts';

/**
 * An organization's own OIDC identity provider (AC1b.2, docs/plan-admin-console-ac1b.md), set up by its admin in the
 * console with the di-identity service account. One per organization, alias `org-<alias>`, linked to the organization
 * and one of its domains: identity-first sign-in sends people of that domain there. It never trusts the provider's
 * e-mail and never links an existing account (CREATE_ONLY_FLOW); the username comes from the provider's subject (DI3).
 * The client secret stays in Keycloak: it is never read back.
 */
export interface OrgProvider {
  alias: string;
  issuer: string;
  clientId: string;
  domain: string;
}

export interface OrgProviderInput {
  realm: string;
  organization: string;
  issuer: string;
  clientId: string;
  /** Needed the first time; left out, the stored one stays. */
  clientSecret?: string;
  domain: string;
  /** The issuer's OpenID metadata; the console checks the address before fetching it. */
  discover: (issuer: string) => Promise<Record<string, unknown>>;
}

/** Keycloak's placeholder for a secret it does not give back; sent back, it keeps the stored secret. */
const SECRET_KEPT = '**********';
export const providerAlias = (organization: string) => `org-${organization}`;

interface ProviderRep {
  alias: string;
  config: Record<string, string>;
}

async function raw(admin: Admin, realm: string, alias: string): Promise<ProviderRep | null> {
  try {
    return await admin.call<ProviderRep>('GET', `/${realm}/identity-provider/instances/${encodeURIComponent(alias)}`);
  } catch (err) {
    if (err instanceof AdminError && err.status === 404) return null;
    throw err;
  }
}

export async function getOrgProvider(admin: Admin, realm: string, organization: string): Promise<OrgProvider | null> {
  const alias = providerAlias(organization);
  const rep = await raw(admin, realm, alias);
  if (!rep) return null;
  return { alias, issuer: rep.config.issuer ?? '', clientId: rep.config.clientId ?? '', domain: rep.config['kc.org.domain'] ?? '' };
}

const endpoint = (meta: Record<string, unknown>, key: string): string => {
  const value = meta[key];
  if (typeof value !== 'string' || !/^https?:\/\//.test(value)) throw new Error(`the provider's metadata has no ${key}`);
  return value;
};

export async function setOrgProvider(admin: Admin, input: OrgProviderInput): Promise<OrgProvider> {
  const R = `/${input.realm}`;
  const org = await organizationByAlias(admin, input.realm, input.organization);
  const full = await admin.call<{ domains?: { name: string }[] }>('GET', `${R}/organizations/${org.id}`);
  if (!(full.domains ?? []).some((d) => d.name === input.domain)) throw new Error(`the domain ${input.domain} is not one of the organization's domains`);
  const alias = providerAlias(input.organization);
  const existing = await raw(admin, input.realm, alias);
  if (!existing && !input.clientSecret) throw new Error('the client secret is needed to set up the provider');
  const meta = await input.discover(input.issuer);
  if (meta.issuer !== input.issuer) throw new Error("the provider's metadata names another issuer");
  const body = {
    alias,
    displayName: `${input.organization} sign-in`,
    providerId: 'oidc',
    enabled: true,
    trustEmail: false,
    storeToken: false,
    hideOnLogin: true,
    firstBrokerLoginFlowAlias: CREATE_ONLY_FLOW,
    config: {
      issuer: input.issuer,
      authorizationUrl: endpoint(meta, 'authorization_endpoint'),
      tokenUrl: endpoint(meta, 'token_endpoint'),
      jwksUrl: endpoint(meta, 'jwks_uri'),
      useJwksUrl: 'true',
      validateSignature: 'true',
      clientId: input.clientId,
      clientSecret: input.clientSecret ?? SECRET_KEPT,
      clientAuthMethod: 'client_secret_post',
      defaultScope: 'openid email profile',
      pkceEnabled: 'true',
      pkceMethod: 'S256',
      syncMode: 'FORCE',
      'kc.org.domain': input.domain,
      'kc.org.broker.redirect.mode.email-matches': 'true',
    },
  };
  if (existing) await admin.call('PUT', `${R}/identity-provider/instances/${alias}`, body);
  else await admin.call('POST', `${R}/identity-provider/instances`, body);

  const username = { name: 'username from subject', identityProviderAlias: alias, identityProviderMapper: 'oidc-username-idp-mapper', config: { template: '${ALIAS}.${CLAIM.sub}', syncMode: 'FORCE' } };
  const mappers = await admin.call<{ id: string; name: string }[]>('GET', `${R}/identity-provider/instances/${alias}/mappers`);
  const old = mappers.find((m) => m.name === username.name);
  if (old) await admin.call('PUT', `${R}/identity-provider/instances/${alias}/mappers/${old.id}`, { ...username, id: old.id });
  else await admin.call('POST', `${R}/identity-provider/instances/${alias}/mappers`, username);

  const linked = await admin.call<{ alias: string }[]>('GET', `${R}/organizations/${org.id}/identity-providers`);
  if (!linked.some((l) => l.alias === alias)) await admin.call('POST', `${R}/organizations/${org.id}/identity-providers`, alias);
  return { alias, issuer: input.issuer, clientId: input.clientId, domain: input.domain };
}

/** Unlinks and deletes the provider; people it created stay, without a way to sign in until another one is set. */
export async function removeOrgProvider(admin: Admin, realm: string, organization: string): Promise<boolean> {
  const alias = providerAlias(organization);
  if (!(await raw(admin, realm, alias))) return false;
  const org = await organizationByAlias(admin, realm, organization);
  const linked = await admin.call<{ alias: string }[]>('GET', `/${realm}/organizations/${org.id}/identity-providers`);
  if (linked.some((l) => l.alias === alias)) await admin.call('DELETE', `/${realm}/organizations/${org.id}/identity-providers/${alias}`);
  await admin.call('DELETE', `/${realm}/identity-provider/instances/${alias}`);
  return true;
}
