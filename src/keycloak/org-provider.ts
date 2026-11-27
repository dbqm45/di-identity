import { AdminError, type Admin } from './admin.ts';
import { organizationByAlias } from './agents.ts';
import { CREATE_ONLY_FLOW } from './configure.ts';

/**
 * An organization's own identity provider, OIDC (AC1b.2, docs/plan-admin-console-ac1b.md) or SAML 2.0
 * (docs/plan-saml.md), set up by its admin in the console with the di-identity service account. One per organization, alias `org-<alias>`, linked to the organization
 * and one of its domains: identity-first sign-in sends people of that domain there. It never trusts the provider's
 * e-mail and never links an existing account (CREATE_ONLY_FLOW); the username comes from the provider's subject (DI3).
 * The client secret stays in Keycloak: it is never read back. SAML: the same rules, the username from the NameID, signed
 * assertions required.
 */
export interface OrgProvider {
  alias: string;
  kind: 'oidc' | 'saml';
  /** OIDC: the issuer; SAML: the provider's entity id. */
  issuer: string;
  /** OIDC only; empty for SAML. */
  clientId: string;
  /** SAML only: where the metadata came from; empty for OIDC. */
  metadataUrl: string;
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
  providerId: string;
  config: Record<string, string>;
}

const METADATA_URL = 'diIdentityMetadataUrl';

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
  const domain = rep.config['kc.org.domain'] ?? '';
  if (rep.providerId === 'saml') return { alias, kind: 'saml', issuer: rep.config.idpEntityId ?? '', clientId: '', metadataUrl: rep.config[METADATA_URL] ?? '', domain };
  return { alias, kind: 'oidc', issuer: rep.config.issuer ?? '', clientId: rep.config.clientId ?? '', metadataUrl: '', domain };
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
  let existing = await raw(admin, input.realm, alias);
  if ((!existing || existing.providerId !== 'oidc') && !input.clientSecret) throw new Error('the client secret is needed to set up the provider');
  const meta = await input.discover(input.issuer);
  if (existing && existing.providerId !== 'oidc') {
    await replaceKind(admin, input.realm, org.id, alias);
    existing = null;
  }
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

  await usernameMapper(admin, input.realm, alias, 'oidc-username-idp-mapper', '${ALIAS}.${CLAIM.sub}');
  await link(admin, input.realm, org.id, alias);
  return { alias, kind: 'oidc', issuer: input.issuer, clientId: input.clientId, metadataUrl: '', domain: input.domain };
}

/** The username from the provider's own stable id (DI3: never the e-mail), synced at every sign-in. */
async function usernameMapper(admin: Admin, realm: string, alias: string, type: string, template: string): Promise<void> {
  const R = `/${realm}`;
  const username = { name: 'username from subject', identityProviderAlias: alias, identityProviderMapper: type, config: { template, syncMode: 'FORCE' } };
  const mappers = await admin.call<{ id: string; name: string }[]>('GET', `${R}/identity-provider/instances/${alias}/mappers`);
  const old = mappers.find((m) => m.name === username.name);
  if (old) await admin.call('PUT', `${R}/identity-provider/instances/${alias}/mappers/${old.id}`, { ...username, id: old.id });
  else await admin.call('POST', `${R}/identity-provider/instances/${alias}/mappers`, username);
}

/**
 * The profile from the assertion's attributes (OIDC brings it in its claims): the X.500 names (SAML2 standard) and
 * Microsoft's claim URIs (Entra ID, AD FS), at the first sign-in only. Without them the person fills it in once.
 * The e-mail stays unverified (trustEmail: false) and reaches only products allowed to see it (DI3).
 */
export const SAML_PROFILE: [string, string][] = [
  ['urn:oid:0.9.2342.19200300.100.1.3', 'email'],
  ['urn:oid:2.5.4.42', 'firstName'],
  ['urn:oid:2.5.4.4', 'lastName'],
  ['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', 'email'],
  ['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname', 'firstName'],
  ['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname', 'lastName'],
];

async function samlProfileMappers(admin: Admin, realm: string, alias: string): Promise<void> {
  const R = `/${realm}/identity-provider/instances/${alias}/mappers`;
  const mappers = await admin.call<{ id: string; name: string }[]>('GET', R);
  for (const [attribute, property] of SAML_PROFILE) {
    const name = `${property} from ${attribute}`;
    const body = { name, identityProviderAlias: alias, identityProviderMapper: 'saml-user-attribute-idp-mapper', config: { 'attribute.name': attribute, 'user.attribute': property, syncMode: 'IMPORT' } };
    const old = mappers.find((m) => m.name === name);
    if (old) await admin.call('PUT', `${R}/${old.id}`, { ...body, id: old.id });
    else await admin.call('POST', R, body);
  }
}

async function link(admin: Admin, realm: string, orgId: string, alias: string): Promise<void> {
  const linked = await admin.call<{ alias: string }[]>('GET', `/${realm}/organizations/${orgId}/identity-providers`);
  if (!linked.some((l) => l.alias === alias)) await admin.call('POST', `/${realm}/organizations/${orgId}/identity-providers`, alias);
}

/** Another kind of provider under the same alias: Keycloak cannot change a provider's type, so it is replaced. */
async function replaceKind(admin: Admin, realm: string, orgId: string, alias: string): Promise<void> {
  const linked = await admin.call<{ alias: string }[]>('GET', `/${realm}/organizations/${orgId}/identity-providers`);
  if (linked.some((l) => l.alias === alias)) await admin.call('DELETE', `/${realm}/organizations/${orgId}/identity-providers/${alias}`);
  await admin.call('DELETE', `/${realm}/identity-provider/instances/${alias}`);
}

export interface OrgSamlProviderInput {
  realm: string;
  organization: string;
  metadataUrl: string;
  domain: string;
  /** The provider's SAML metadata (XML); the console checks the address before fetching it. */
  fetchMetadata: (url: string) => Promise<string>;
}

/**
 * The organization's own SAML 2.0 provider (docs/plan-saml.md). Keycloak parses the metadata the console fetched
 * (import-config with a file, so Keycloak fetches nothing itself); signed assertions, a persistent NameID as the
 * subject, POST bindings and the same first-login and organization rules as OIDC.
 */
export async function setOrgSamlProvider(admin: Admin, input: OrgSamlProviderInput): Promise<OrgProvider> {
  const R = `/${input.realm}`;
  const org = await organizationByAlias(admin, input.realm, input.organization);
  const full = await admin.call<{ domains?: { name: string }[] }>('GET', `${R}/organizations/${org.id}`);
  if (!(full.domains ?? []).some((d) => d.name === input.domain)) throw new Error(`the domain ${input.domain} is not one of the organization's domains`);
  const xml = await input.fetchMetadata(input.metadataUrl);
  const form = new FormData();
  form.append('providerId', 'saml');
  form.append('file', new Blob([xml], { type: 'application/xml' }), 'metadata.xml');
  let parsed: Record<string, string>;
  try {
    parsed = await admin.form<Record<string, string>>(`${R}/identity-provider/import-config`, form);
  } catch (err) {
    if (err instanceof AdminError && err.status < 500) throw new Error("Keycloak could not read the provider's SAML metadata");
    throw err;
  }
  if (!parsed.idpEntityId || !/^https?:\/\//.test(parsed.singleSignOnServiceUrl ?? '')) throw new Error("the provider's SAML metadata has no entity id or sign-in address");
  if (!parsed.signingCertificate) throw new Error("the provider's SAML metadata has no signing certificate");

  const alias = providerAlias(input.organization);
  let existing = await raw(admin, input.realm, alias);
  if (existing && existing.providerId !== 'saml') {
    await replaceKind(admin, input.realm, org.id, alias);
    existing = null;
  }
  const body = {
    alias,
    displayName: `${input.organization} sign-in`,
    providerId: 'saml',
    enabled: true,
    trustEmail: false,
    storeToken: false,
    hideOnLogin: true,
    firstBrokerLoginFlowAlias: CREATE_ONLY_FLOW,
    config: {
      idpEntityId: parsed.idpEntityId,
      singleSignOnServiceUrl: parsed.singleSignOnServiceUrl,
      ...(parsed.singleLogoutServiceUrl ? { singleLogoutServiceUrl: parsed.singleLogoutServiceUrl } : {}),
      signingCertificate: parsed.signingCertificate,
      validateSignature: 'true',
      wantAssertionsSigned: 'true',
      wantAuthnRequestsSigned: parsed.wantAuthnRequestsSigned === 'true' ? 'true' : 'false',
      nameIDPolicyFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
      principalType: 'SUBJECT',
      postBindingResponse: 'true',
      postBindingAuthnRequest: parsed.postBindingAuthnRequest === 'false' ? 'false' : 'true',
      syncMode: 'FORCE',
      [METADATA_URL]: input.metadataUrl,
      'kc.org.domain': input.domain,
      'kc.org.broker.redirect.mode.email-matches': 'true',
    },
  };
  if (existing) await admin.call('PUT', `${R}/identity-provider/instances/${alias}`, body);
  else await admin.call('POST', `${R}/identity-provider/instances`, body);
  await usernameMapper(admin, input.realm, alias, 'saml-username-idp-mapper', '${ALIAS}.${NAMEID}');
  await samlProfileMappers(admin, input.realm, alias);
  await link(admin, input.realm, org.id, alias);
  return { alias, kind: 'saml', issuer: parsed.idpEntityId, clientId: '', metadataUrl: input.metadataUrl, domain: input.domain };
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
