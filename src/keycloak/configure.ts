import { readFileSync } from 'node:fs';
import { AdminError, type Admin } from './admin.ts';

/**
 * Makes the suite realm match `keycloak/suite.json` (ADR 17 §2.2–2.3, DI2, DI3, DI4). Idempotent: run it after every
 * change of the file or of Keycloak; it creates what is missing and updates what differs, and never deletes
 * organizations, people or agents.
 *
 * - realm `suite` with Organizations on, no self-registration, no password login for people (DI1: no own password
 *   database), brute-force protection, person tokens of `personTokenSeconds`;
 * - client scope `suite-identity`: claims `organization` (list of aliases), `kind` and `owner` (agents, DI4), and the
 *   product roles also in the ID token (`resource_access.<client>.roles`);
 * - one confidential client per product, with its roles and an audience mapper; scope `email` only for clients with
 *   `email: true` (DI3), also removed from the realm defaults so a new client never gets it by accident;
 * - Google as identity provider when its client id and secret are in the environment (DI2).
 */
export interface SuiteClient {
  clientId: string;
  name: string;
  roles: string[];
  email: boolean;
}

export interface SuiteConfig {
  realm: string;
  displayName: string;
  personTokenSeconds: number;
  agentTokenSeconds: number;
  clients: SuiteClient[];
  identityProviders: { alias: string; providerId: string; displayName: string; clientIdEnv: string; clientSecretEnv: string }[];
  /** Roles of other clients given to a client's service account (ADR 17 §2.4), e.g. di-channels → di-identity:people-reader. */
  serviceRoles?: { client: string; roles: string[]; why?: string }[];
  /** realm-management roles of the di-identity service account, for the people lookup API. */
  identityServiceAccount?: { client: string; realmManagementRoles: string[]; why?: string };
}

export const SUITE_FILE = new URL('../../keycloak/suite.json', import.meta.url);
export const loadSuite = (file: URL = SUITE_FILE): SuiteConfig => JSON.parse(readFileSync(file, 'utf8')) as SuiteConfig;

export const SUITE_SCOPE = 'suite-identity';
/**
 * Scopes every product client gets; `email` only for DI3 clients. `basic` carries `sub` in Keycloak 26;
 * `service_account` (Keycloak adds it to clients with a service account) carries `client_id`, by which other suite
 * services recognise a service token (ADR 17 §2.4).
 */
const BASE_SCOPES = ['acr', 'basic', 'profile', 'roles', 'web-origins', 'service_account', SUITE_SCOPE];

interface Named {
  id: string;
  name?: string;
  clientId?: string;
  alias?: string;
}

const mapper = (name: string, protocolMapper: string, config: Record<string, string>) => ({ name, protocol: 'openid-connect', protocolMapper, config });

const SCOPE_MAPPERS = [
  mapper('organization', 'oidc-organization-membership-mapper', {
    'claim.name': 'organization',
    multivalued: 'true',
    'jsonType.label': 'String',
    'access.token.claim': 'true',
    'id.token.claim': 'true',
    'introspection.token.claim': 'true',
  }),
  // Product roles also in the ID token: applications that read roles from it (DI Release Control reads
  // `resource_access.di-release-control.roles` from the ID token) need them there; the built-in `roles` scope puts
  // them only in the access token (checked on Keycloak 26.4).
  mapper('product roles in ID token', 'oidc-usermodel-client-role-mapper', {
    'claim.name': 'resource_access.${client_id}.roles',
    multivalued: 'true',
    'jsonType.label': 'String',
    'id.token.claim': 'true',
    'access.token.claim': 'false',
    'introspection.token.claim': 'false',
    'userinfo.token.claim': 'false',
  }),
  mapper('kind', 'oidc-usermodel-attribute-mapper', { 'user.attribute': 'kind', 'claim.name': 'kind', 'jsonType.label': 'String', 'access.token.claim': 'true', 'introspection.token.claim': 'true' }),
  mapper('owner', 'oidc-usermodel-attribute-mapper', { 'user.attribute': 'owner', 'claim.name': 'owner', 'jsonType.label': 'String', 'access.token.claim': 'true', 'introspection.token.claim': 'true' }),
];

/** Redirect addresses of a client from REDIRECT_<CLIENT_ID> (comma-separated), e.g. REDIRECT_DI_RELEASE. */
export const redirectsFor = (clientId: string, env: NodeJS.ProcessEnv): string[] =>
  (env[`REDIRECT_${clientId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] ?? '').split(',').map((u) => u.trim()).filter(Boolean);

export async function configure(admin: Admin, suite: SuiteConfig, env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = () => {}): Promise<void> {
  const R = `/${suite.realm}`;

  // Realm.
  const realmSettings = {
    realm: suite.realm,
    displayName: suite.displayName,
    enabled: true,
    organizationsEnabled: true,
    registrationAllowed: false,
    resetPasswordAllowed: false,
    rememberMe: false,
    sslRequired: 'external',
    bruteForceProtected: true,
    accessTokenLifespan: suite.personTokenSeconds,
  };
  try {
    await admin.call('GET', R);
    await admin.call('PUT', R, realmSettings);
    log(`realm ${suite.realm}: updated`);
  } catch (err) {
    if (!(err instanceof AdminError) || err.status !== 404) throw err;
    await admin.call('POST', '', realmSettings);
    log(`realm ${suite.realm}: created`);
  }

  // Client scope with the suite claims.
  const scopes = await admin.call<Named[]>('GET', `${R}/client-scopes`);
  let scopeId = scopes.find((s) => s.name === SUITE_SCOPE)?.id;
  if (!scopeId) {
    scopeId = await admin.create(`${R}/client-scopes`, { name: SUITE_SCOPE, protocol: 'openid-connect', attributes: { 'include.in.token.scope': 'false', 'display.on.consent.screen': 'false' } });
    log(`client scope ${SUITE_SCOPE}: created`);
  }
  const present = await admin.call<Named[]>('GET', `${R}/client-scopes/${scopeId}/protocol-mappers/models`);
  for (const m of SCOPE_MAPPERS) {
    const old = present.find((p) => p.name === m.name);
    if (old) await admin.call('PUT', `${R}/client-scopes/${scopeId}/protocol-mappers/models/${old.id}`, { ...m, id: old.id });
    else await admin.call('POST', `${R}/client-scopes/${scopeId}/protocol-mappers/models`, m);
  }
  const scopeIds = new Map((await admin.call<Named[]>('GET', `${R}/client-scopes`)).map((s) => [s.name ?? '', s.id]));

  // Realm defaults: no email for new clients (DI3); the suite scope for every new client.
  const defaults = await admin.call<Named[]>('GET', `${R}/default-default-client-scopes`);
  if (defaults.some((d) => d.name === 'email')) await admin.call('DELETE', `${R}/default-default-client-scopes/${scopeIds.get('email')}`);
  if (!defaults.some((d) => d.name === SUITE_SCOPE)) await admin.call('PUT', `${R}/default-default-client-scopes/${scopeId}`);

  // Product clients.
  for (const c of suite.clients) {
    const redirects = redirectsFor(c.clientId, env);
    const body = {
      clientId: c.clientId,
      name: c.name,
      enabled: true,
      protocol: 'openid-connect',
      publicClient: false,
      clientAuthenticatorType: 'client-secret',
      standardFlowEnabled: true,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: true,
      redirectUris: redirects,
      webOrigins: ['+'],
      attributes: { 'pkce.code.challenge.method': 'S256', 'post.logout.redirect.uris': redirects.join('##') },
    };
    const found = await admin.call<Named[]>('GET', `${R}/clients?clientId=${encodeURIComponent(c.clientId)}`);
    let id = found[0]?.id;
    if (id) await admin.call('PUT', `${R}/clients/${id}`, { ...body, id });
    else id = await admin.create(`${R}/clients`, body);

    const mappers = await admin.call<Named[]>('GET', `${R}/clients/${id}/protocol-mappers/models`);
    const audience = mapper('audience', 'oidc-audience-mapper', { 'included.client.audience': c.clientId, 'access.token.claim': 'true', 'introspection.token.claim': 'true' });
    const old = mappers.find((m) => m.name === 'audience');
    if (old) await admin.call('PUT', `${R}/clients/${id}/protocol-mappers/models/${old.id}`, { ...audience, id: old.id });
    else await admin.call('POST', `${R}/clients/${id}/protocol-mappers/models`, audience);

    const roles = new Set((await admin.call<Named[]>('GET', `${R}/clients/${id}/roles`)).map((r) => r.name));
    for (const role of c.roles) if (!roles.has(role)) await admin.call('POST', `${R}/clients/${id}/roles`, { name: role });

    const want = new Set([...BASE_SCOPES, ...(c.email ? ['email'] : [])]);
    const have = await admin.call<Named[]>('GET', `${R}/clients/${id}/default-client-scopes`);
    for (const s of have) if (!want.has(s.name ?? '')) await admin.call('DELETE', `${R}/clients/${id}/default-client-scopes/${s.id}`);
    for (const name of want) {
      const sid = scopeIds.get(name);
      if (!sid) throw new Error(`client scope ${name} does not exist in realm ${suite.realm}`);
      if (!have.some((s) => s.name === name)) await admin.call('PUT', `${R}/clients/${id}/default-client-scopes/${sid}`);
    }
    log(`client ${c.clientId}: ${found.length ? 'updated' : 'created'} (roles ${c.roles.join(', ')}${c.email ? ', email' : ''}${redirects.length ? '' : ', no redirect addresses yet'})`);
  }

  // Service accounts: roles other suite applications need when they call each other (ADR 17 §2.4).
  const clientUuid = async (clientId: string): Promise<string> => {
    const found = (await admin.call<Named[]>('GET', `${R}/clients?clientId=${encodeURIComponent(clientId)}`))[0];
    if (!found) throw new Error(`client ${clientId} does not exist in realm ${suite.realm}`);
    return found.id;
  };
  const grantToServiceAccount = async (clientId: string, roleClient: string, roleNames: string[]) => {
    const sa = await admin.call<Named>('GET', `${R}/clients/${await clientUuid(clientId)}/service-account-user`);
    const target = await clientUuid(roleClient);
    const have = new Set((await admin.call<Named[]>('GET', `${R}/users/${sa.id}/role-mappings/clients/${target}`)).map((r) => r.name));
    const roles = [];
    for (const name of roleNames) if (!have.has(name)) roles.push(await admin.call('GET', `${R}/clients/${target}/roles/${encodeURIComponent(name)}`));
    if (roles.length) await admin.call('POST', `${R}/users/${sa.id}/role-mappings/clients/${target}`, roles);
  };
  for (const s of suite.serviceRoles ?? []) {
    const byClient = new Map<string, string[]>();
    for (const spec of s.roles) {
      const [roleClient, role] = spec.split(':');
      if (!roleClient || !role) throw new Error(`service role ${spec} is not <client>:<role>`);
      byClient.set(roleClient, [...(byClient.get(roleClient) ?? []), role]);
    }
    for (const [roleClient, roles] of byClient) await grantToServiceAccount(s.client, roleClient, roles);
    log(`service account ${s.client}: ${s.roles.join(', ')}`);
  }
  if (suite.identityServiceAccount) {
    await grantToServiceAccount(suite.identityServiceAccount.client, 'realm-management', suite.identityServiceAccount.realmManagementRoles);
    log(`service account ${suite.identityServiceAccount.client}: realm-management ${suite.identityServiceAccount.realmManagementRoles.join(', ')}`);
  }

  // Identity providers (Google first, DI2); skipped until the client id and secret are set.
  for (const p of suite.identityProviders) {
    const clientId = env[p.clientIdEnv]?.trim();
    const clientSecret = env[p.clientSecretEnv]?.trim();
    if (!clientId || !clientSecret) {
      log(`identity provider ${p.alias}: skipped (${p.clientIdEnv} and ${p.clientSecretEnv} are not set)`);
      continue;
    }
    const body = {
      alias: p.alias,
      providerId: p.providerId,
      displayName: p.displayName,
      enabled: true,
      trustEmail: true,
      storeToken: false,
      config: { clientId, clientSecret, syncMode: 'IMPORT', defaultScope: 'openid email profile', guiOrder: '1' },
    };
    const providers = await admin.call<Named[]>('GET', `${R}/identity-provider/instances`);
    if (providers.some((x) => x.alias === p.alias)) await admin.call('PUT', `${R}/identity-provider/instances/${p.alias}`, body);
    else await admin.call('POST', `${R}/identity-provider/instances`, body);

    // DI3: Google sends no username, and Keycloak would then take the e-mail, which reaches every application as
    // `preferred_username` (seen on Keycloak 26.4.7, 2026-11-25). The username is `<alias>.<subject>` instead, set again
    // at every sign-in (FORCE), so earlier e-mail usernames are replaced at the person's next sign-in.
    const username = {
      name: 'username from subject',
      identityProviderAlias: p.alias,
      identityProviderMapper: 'oidc-username-idp-mapper',
      config: { template: '${ALIAS}.${CLAIM.sub}', syncMode: 'FORCE' },
    };
    const idpMappers = await admin.call<Named[]>('GET', `${R}/identity-provider/instances/${p.alias}/mappers`);
    const oldMapper = idpMappers.find((m) => m.name === username.name);
    if (oldMapper) await admin.call('PUT', `${R}/identity-provider/instances/${p.alias}/mappers/${oldMapper.id}`, { ...username, id: oldMapper.id });
    else await admin.call('POST', `${R}/identity-provider/instances/${p.alias}/mappers`, username);
    log(`identity provider ${p.alias}: configured (username from the provider's subject, never the e-mail)`);
  }

  // A person may not change their username (the review form at the first sign-in offered it): only an administrator.
  const profile = await admin.call<{ attributes: { name: string; permissions?: { view?: string[]; edit?: string[] } }[] }>('GET', `${R}/users/profile`);
  const usernameAttribute = profile.attributes.find((a) => a.name === 'username');
  if (usernameAttribute && JSON.stringify(usernameAttribute.permissions?.edit) !== JSON.stringify(['admin'])) {
    usernameAttribute.permissions = { view: usernameAttribute.permissions?.view ?? ['admin', 'user'], edit: ['admin'] };
    await admin.call('PUT', `${R}/users/profile`, profile);
  }
}
