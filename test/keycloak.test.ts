import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { test } from 'node:test';
import { createVerifier, discoveryJwks } from '../src/auth/oidc.ts';
import { buildApp } from '../src/app.ts';
import { keycloakAdmin, keycloakServiceAdmin } from '../src/keycloak/admin.ts';
import { memoryEventStore } from '../src/events/store.ts';
import { loadVocabulary } from '../src/events/envelope.ts';
import { peopleRoutes } from '../src/people-api.ts';
import { createAgent, createOrganization, disableOrganizationAgents, listAgents, organizationByAlias, setAgentEnabled } from '../src/keycloak/agents.ts';
import { configure, loadSuite, CREATE_ONLY_FLOW } from '../src/keycloak/configure.ts';
import { getOrgProvider, removeOrgProvider, setOrgProvider } from '../src/keycloak/org-provider.ts';
import { addMember, grantRole, lookupByEmail, revokeRole } from '../src/keycloak/people.ts';
import { clientSecrets, secretVariable } from '../src/keycloak/secrets.ts';

// Against a real Keycloak 26 when KEYCLOAK_URL is set (CI starts one; locally: docker run, see README.md).
const url = process.env.KEYCLOAK_URL;
const skip = !url && 'KEYCLOAK_URL is not set';
const run = `t${Date.now().toString(36)}`;
// The suite's realm definition in a realm of its own for each run, deleted afterwards: a developer's Keycloak keeps
// its realm `suite` (with their redirect addresses, organizations and people) untouched.
const suite = { ...loadSuite(), realm: `suite-test-${run}` };
const issuer = `${url}/realms/${suite.realm}`;
const admin = keycloakAdmin({ url: url ?? 'http://localhost', username: process.env.KEYCLOAK_ADMIN_USERNAME ?? 'admin', password: process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin' });
const R = `/${suite.realm}`;

const tokenRequest = (form: Record<string, string>) =>
  fetch(`${issuer}/protocol/openid-connect/token`, { method: 'POST', body: new URLSearchParams(form) }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));

function agentAssertion(clientId: string, key: KeyObject, kid: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', typ: 'JWT', kid });
  const body = b64({ iss: clientId, sub: clientId, aud: issuer, jti: randomUUID(), iat: now, exp: now + 60 });
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
}
const agentToken = (clientId: string, key: KeyObject, kid: string) =>
  tokenRequest({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: agentAssertion(clientId, key, kid),
  });

/** Redirect addresses of a product client in the shared realm `suite`, or null when that realm does not exist yet. */
async function sharedRedirects(clientId: string): Promise<string[] | null> {
  const realms = await admin.call<{ realm: string }[]>('GET', '');
  if (!realms.some((r) => r.realm === 'suite')) return null;
  const [c] = await admin.call<{ redirectUris?: string[] }[]>('GET', `/suite/clients?clientId=${clientId}`);
  return c?.redirectUris ?? [];
}

test('the suite realm on a real Keycloak: people, organizations, product roles and agents', { skip }, async (t) => {
  // A developer's local Keycloak holds the realm `suite` with their redirect addresses; the test must not touch it.
  const before = await sharedRedirects('di-release-control');
  t.after(async () => {
    await admin.call('DELETE', R);
    assert.deepEqual(await sharedRedirects('di-release-control'), before, 'the test changed the shared realm suite');
  });

  await t.test('configure is idempotent and keeps email to DI3 clients', async () => {
    await configure(admin, suite, {});
    await configure(admin, suite, {});
    const scopesOf = async (clientId: string) => {
      const [c] = await admin.call<{ id: string }[]>('GET', `${R}/clients?clientId=${clientId}`);
      return (await admin.call<{ name: string }[]>('GET', `${R}/clients/${c!.id}/default-client-scopes`)).map((s) => s.name).sort();
    };
    assert.ok(!(await scopesOf('di-release')).includes('email'));
    assert.ok((await scopesOf('di-channels')).includes('email'));
    assert.ok((await scopesOf('di-release')).includes('suite-identity'));
  });

  // DI3: a person from Google has no username of their own, and Keycloak would make it their e-mail, which then goes to
  // every application as `preferred_username` (checked live on 2026-11-25). The username comes from the provider's
  // subject instead, and a person cannot change it at the first sign-in.
  await t.test('people from an identity provider never get their e-mail as username', async () => {
    const google = { GOOGLE_CLIENT_ID: 'dummy-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'dummy-secret' };
    await configure(admin, suite, google);
    await configure(admin, suite, google);
    const mappers = await admin.call<{ name: string; identityProviderMapper: string; config: Record<string, string> }[]>(
      'GET', `${R}/identity-provider/instances/google/mappers`,
    );
    const username = mappers.filter((m) => m.identityProviderMapper === 'oidc-username-idp-mapper');
    assert.equal(username.length, 1, 'one username mapper, also after a second configure');
    assert.deepEqual(username[0]!.config, { template: '${ALIAS}.${CLAIM.sub}', syncMode: 'FORCE' });
    const profile = await admin.call<{ attributes: { name: string; permissions?: { edit?: string[] } }[] }>('GET', `${R}/users/profile`);
    assert.deepEqual(profile.attributes.find((a) => a.name === 'username')?.permissions?.edit, ['admin']);
  });

  // A person with a password and a public test client exist only in this test: the suite realm has no password login.
  await createOrganization(admin, { realm: suite.realm, alias: run, name: `Test ${run}`, domain: `${run}.test` });
  const person = await admin.create(`${R}/users`, {
    username: `ola-${run}`,
    email: `ola@${run}.test`,
    firstName: 'Ola',
    lastName: 'Nowak',
    enabled: true,
    emailVerified: true,
    credentials: [{ type: 'password', value: 'test-only', temporary: false }],
  });
  await t.test('people commands: add to an organization by e-mail, grant and revoke a product role', async () => {
    assert.equal(await addMember(admin, { realm: suite.realm, organization: run, who: `ola@${run}.test` }), true);
    assert.equal(await addMember(admin, { realm: suite.realm, organization: run, who: `ola-${run}` }), false);
    await grantRole(admin, { realm: suite.realm, who: person, role: 'di-release:editor' });
    await grantRole(admin, { realm: suite.realm, who: person, role: 'di-release:viewer' });
    await revokeRole(admin, { realm: suite.realm, who: person, role: 'di-release:viewer' });
    await assert.rejects(grantRole(admin, { realm: suite.realm, who: person, role: 'di-release:owner' }), /HTTP 404/);
    await assert.rejects(grantRole(admin, { realm: suite.realm, who: 'nobody@nowhere.test', role: 'di-release:viewer' }), /no single person/);
  });
  const login = `test-login-${run}`;
  await admin.create(`${R}/clients`, { clientId: login, publicClient: true, directAccessGrantsEnabled: true, standardFlowEnabled: false });

  await t.test('a person token carries sub, name, organization and product roles, no email by default', async () => {
    const res = await tokenRequest({ grant_type: 'password', client_id: login, username: `ola-${run}`, password: 'test-only', scope: 'openid' });
    assert.equal(res.status, 200);
    const verifier = createVerifier({ issuer, audience: 'di-release', authorizedParties: [login], fetchJwks: discoveryJwks(issuer) });
    const id = await verifier.verify(String(res.body.access_token));
    assert.equal(id.kind, 'person');
    assert.equal(id.sub, person);
    assert.equal(id.name, 'Ola Nowak');
    assert.deepEqual(id.organizations, [run]);
    assert.deepEqual(id.roles, ['editor']);
    assert.equal(id.email, undefined);
    // Product roles also in the ID token, for apps that read roles from it (DI Release Control).
    const idClaims = JSON.parse(Buffer.from(String(res.body.id_token).split('.')[1] ?? '', 'base64url').toString()) as Record<string, unknown>;
    assert.deepEqual((idClaims.resource_access as Record<string, { roles: string[] }>)['di-release']?.roles, ['editor']);
    assert.deepEqual(idClaims.organization, [run]);
    // Without being an authorized party, the same token is refused by di-release.
    const strict = createVerifier({ issuer, audience: 'di-release', fetchJwks: discoveryJwks(issuer) });
    await assert.rejects(strict.verify(String(res.body.access_token)), /issued to another application/);
  });

  // The remote MCP server of pdi (dbqm45/pdi docs/plan-mcp-zdalny.md) is a resource server of DI Decision; Claude Code
  // signs in through this public client with PKCE on a fixed loopback port.
  await t.test('the MCP client of DI Decision is public with PKCE, and its token is only for DI Decision, without email', async () => {
    const [c] = await admin.call<(Record<string, unknown> & { id: string })[]>('GET', `${R}/clients?clientId=di-decision-mcp`);
    assert.ok(c, 'client di-decision-mcp exists');
    assert.equal(c.publicClient, true);
    assert.equal(c.serviceAccountsEnabled, false);
    assert.equal(c.directAccessGrantsEnabled, false);
    assert.equal(c.implicitFlowEnabled, false);
    assert.equal(c.fullScopeAllowed, false);
    assert.equal((c.attributes as Record<string, string>)['pkce.code.challenge.method'], 'S256');
    assert.deepEqual([...(c.redirectUris as string[])].sort(), ['http://127.0.0.1:33418/callback', 'http://localhost:33418/callback']);
    const scopes = (await admin.call<{ name: string }[]>('GET', `${R}/clients/${c.id}/default-client-scopes`)).map((s) => s.name);
    assert.ok(!scopes.includes('email'));
    // MCP clients ask for offline_access (SEP-2207): only that optional scope, with a short offline session (owner's
    // decision 2026-11-25: 24 h without use, 14 days at most); no phone, address or other realm default.
    const optional = await admin.call<{ name: string }[]>('GET', `${R}/clients/${c.id}/optional-client-scopes`);
    assert.deepEqual(optional.map((s) => s.name), ['offline_access']);
    assert.equal((c.attributes as Record<string, string>)['client.offline.session.idle.timeout'], '86400');
    assert.equal((c.attributes as Record<string, string>)['client.offline.session.max.lifespan'], '1209600');
    const realm = await admin.call<{ offlineSessionMaxLifespanEnabled: boolean }>('GET', R);
    assert.equal(realm.offlineSessionMaxLifespanEnabled, true, 'without it Keycloak ignores the client maximum');

    await grantRole(admin, { realm: suite.realm, who: person, role: 'di-decision:viewer' });
    const claims = await admin.call<Record<string, unknown>>(
      'GET', `${R}/clients/${c.id}/evaluate-scopes/generate-example-access-token?userId=${person}&scope=openid`,
    );
    assert.equal(claims.azp, 'di-decision-mcp');
    assert.deepEqual([claims.aud].flat(), ['di-decision']);
    // Only DI Decision's roles, although the person also has a role in DI Release.
    assert.deepEqual(claims.resource_access, { 'di-decision': { roles: ['viewer'] } });
    assert.deepEqual(claims.organization, [run]);
    assert.equal(claims.email, undefined);
    await revokeRole(admin, { realm: suite.realm, who: person, role: 'di-decision:viewer' });
  });

  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = `k-${run}`;
  const publicJwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid };
  const base = { realm: suite.realm, organization: run, owner: person, purpose: 'architect persona of the factory', publicJwk, tokenSeconds: suite.agentTokenSeconds };

  await t.test('agent rules: never admin, owner must be a member', async () => {
    await assert.rejects(createAgent(admin, { ...base, persona: 'boss', roles: ['di-decision:admin'] }), /never gets the admin role/);
    await assert.rejects(createAgent(admin, { ...base, persona: 'stray', owner: randomUUID(), roles: [] }), /not a member/);
    await assert.rejects(createAgent(admin, { ...base, persona: 'leaky', publicJwk: { ...publicJwk, d: 'x' }, roles: [] }), /public RSA JWK/);
  });

  const agent = await createAgent(admin, { ...base, persona: 'tomasz', roles: ['di-decision:viewer'] });

  await t.test('an agent signs in with private_key_jwt and gets a 10-minute token with kind and owner', async () => {
    const res = await agentToken(agent.clientId, privateKey, kid);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.expires_in, 600);
    assert.equal(res.body.refresh_token, undefined);
    const verifier = createVerifier({ issuer, audience: 'di-decision', fetchJwks: discoveryJwks(issuer) });
    const id = await verifier.verify(String(res.body.access_token));
    assert.equal(id.kind, 'agent');
    assert.equal(id.sub, agent.sub);
    assert.equal(id.owner, person);
    assert.deepEqual(id.organizations, [run]);
    assert.deepEqual(id.roles, ['viewer']);
    assert.equal(id.email, undefined);
  });

  await t.test('an assertion cannot be used twice', async () => {
    const assertion = agentAssertion(agent.clientId, privateKey, kid);
    const form = { grant_type: 'client_credentials', client_id: agent.clientId, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion };
    assert.equal((await tokenRequest(form)).status, 200);
    assert.equal((await tokenRequest(form)).status, 400);
  });

  // The admin console (docs/plan-admin-console.md) acts with the di-identity service account, never the master admin.
  // Keycloak 26.4 answers 403 to the organizations API without manage-realm, even to reads (checked 2026-11-25).
  await t.test('the di-identity service account can do what the admin console does', async () => {
    const secrets = await clientSecrets(admin, suite);
    const service = keycloakServiceAdmin({ url: url!, realm: suite.realm, clientId: 'di-identity', clientSecret: secrets.get(secretVariable('di-identity'))! });
    const org = await organizationByAlias(service, suite.realm, run);
    const members = await service.call<{ id: string }[]>('GET', `${R}/organizations/${org.id}/members?max=100`);
    assert.ok(members.some((m) => m.id === person));
    await grantRole(service, { realm: suite.realm, who: person, role: 'di-definition:viewer' });
    await revokeRole(service, { realm: suite.realm, who: person, role: 'di-definition:viewer' });
    assert.ok((await listAgents(service, suite.realm, run)).some((a) => a.clientId === agent.clientId));
    await setAgentEnabled(service, suite.realm, agent.clientId, false);
    await setAgentEnabled(service, suite.realm, agent.clientId, true);
  });

  // AC1b.2 (docs/plan-admin-console-ac1b.md): the organization's own OIDC provider, set up with the service account.
  await t.test("an organization's own OIDC provider is linked to it and never links accounts by e-mail", async () => {
    const cust = `${suite.realm}-cust`;
    await admin.call('POST', '', { realm: cust, enabled: true });
    t.after(() => admin.call('DELETE', `/${cust}`));
    const custIssuer = `${url}/realms/${cust}`;
    const secrets = await clientSecrets(admin, suite);
    const service = keycloakServiceAdmin({ url: url!, realm: suite.realm, clientId: 'di-identity', clientSecret: secrets.get(secretVariable('di-identity'))! });
    const discover = async (issuer: string) => (await fetch(`${issuer}/.well-known/openid-configuration`)).json() as Promise<Record<string, unknown>>;
    const input = { realm: suite.realm, organization: run, issuer: custIssuer, clientId: 'suite-broker', domain: `${run}.test`, discover };

    await assert.rejects(setOrgProvider(service, { ...input }), /secret/, 'the first setup needs the secret');
    await setOrgProvider(service, { ...input, clientSecret: 'test-only-secret' });
    assert.deepEqual(await getOrgProvider(service, suite.realm, run), { alias: `org-${run}`, issuer: custIssuer, clientId: 'suite-broker', domain: `${run}.test` });

    const idp = await admin.call<Record<string, unknown> & { config: Record<string, string> }>('GET', `${R}/identity-provider/instances/org-${run}`);
    assert.equal(idp.trustEmail, false);
    assert.equal(idp.hideOnLogin, true);
    assert.equal(idp.storeToken, false);
    assert.equal(idp.firstBrokerLoginFlowAlias, CREATE_ONLY_FLOW);
    assert.equal(idp.config['kc.org.domain'], `${run}.test`);
    assert.equal(idp.config['kc.org.broker.redirect.mode.email-matches'], 'true');
    assert.equal(idp.config.syncMode, 'FORCE');
    assert.equal(idp.config.pkceEnabled, 'true');
    assert.equal(idp.config.authorizationUrl, `${custIssuer}/protocol/openid-connect/auth`);
    assert.notEqual(idp.config.clientSecret, 'test-only-secret', 'Keycloak never gives the secret back');
    const org = await organizationByAlias(admin, suite.realm, run);
    const linked = await admin.call<{ alias: string }[]>('GET', `${R}/organizations/${org.id}/identity-providers`);
    assert.deepEqual(linked.map((l) => l.alias), [`org-${run}`]);
    const mappers = await admin.call<{ identityProviderMapper: string; config: Record<string, string> }[]>('GET', `${R}/identity-provider/instances/org-${run}/mappers`);
    assert.deepEqual(mappers.map((m) => [m.identityProviderMapper, m.config.template]), [['oidc-username-idp-mapper', '${ALIAS}.${CLAIM.sub}']]);
    // The first sign-in only creates a new user and makes them a member: nothing that links an existing account.
    const flow = await admin.call<{ providerId: string; requirement: string }[]>('GET', `${R}/authentication/flows/${encodeURIComponent(CREATE_ONLY_FLOW)}/executions`);
    assert.deepEqual(flow.map((e) => [e.providerId, e.requirement]), [
      ['idp-review-profile', 'REQUIRED'], ['idp-create-user-if-unique', 'REQUIRED'], ['idp-add-organization-member', 'REQUIRED'],
    ]);

    // An update without the secret keeps it; another client id is taken.
    await setOrgProvider(service, { ...input, clientId: 'suite-broker-2' });
    assert.equal((await getOrgProvider(service, suite.realm, run))?.clientId, 'suite-broker-2');
    await assert.rejects(setOrgProvider(service, { ...input, domain: 'not-theirs.test' }), /domain/);

    assert.equal(await removeOrgProvider(service, suite.realm, run), true);
    assert.equal(await getOrgProvider(service, suite.realm, run), null);
    assert.equal(await removeOrgProvider(service, suite.realm, run), false);
  });

  await t.test('DI Channels finds the person by verified e-mail through the di-identity API', async () => {
    // The secrets as `npm run identity -- secrets` writes them: one per product client.
    const secrets = await clientSecrets(admin, suite);
    assert.equal(secrets.size, suite.clients.length);
    const secretOf = async (clientId: string) => secrets.get(secretVariable(clientId))!;
    // di-identity reads users with its own service account (view-users, query-users from configure).
    const service = keycloakServiceAdmin({ url: url!, realm: suite.realm, clientId: 'di-identity', clientSecret: await secretOf('di-identity') });
    const found = await lookupByEmail(service, suite.realm, `ola@${run}.test`);
    assert.deepEqual(found, { sub: person, name: 'Ola Nowak', organizations: [run] });
    assert.equal(await lookupByEmail(service, suite.realm, `nobody@${run}.test`), null);
    const unverified = await admin.create(`${R}/users`, { username: `nv-${run}`, email: `nv@${run}.test`, enabled: true, emailVerified: false });
    assert.ok(unverified);
    assert.equal(await lookupByEmail(service, suite.realm, `nv@${run}.test`), null);

    // DI Channels calls the API with its own service token (client credentials, role di-identity:people-reader).
    const channels = await tokenRequest({ grant_type: 'client_credentials', client_id: 'di-channels', client_secret: await secretOf('di-channels') });
    assert.equal(channels.status, 200);
    const verifier = createVerifier({ issuer, audience: 'di-identity', serviceClients: ['di-channels'], fetchJwks: discoveryJwks(issuer) });
    const id = await verifier.verify(String(channels.body.access_token));
    assert.equal(id.kind, 'service');
    assert.deepEqual(id.roles, ['people-reader']);
    const app = buildApp({ version: 't', verifier, eventsSecret: 'x'.repeat(32), vocabulary: loadVocabulary(), events: memoryEventStore(), checkDatabase: async () => {} });
    peopleRoutes(app, { verifier, lookup: (email) => lookupByEmail(service, suite.realm, email) });
    const ok = await app.inject({ url: `/api/people?email=ola@${run}.test`, headers: { authorization: `Bearer ${channels.body.access_token}` } });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.json(), { sub: person, name: 'Ola Nowak', organizations: [run] });
    assert.equal((await app.inject({ url: `/api/people?email=nobody@${run}.test`, headers: { authorization: `Bearer ${channels.body.access_token}` } })).statusCode, 404);
    // A person's token, even an admin's, cannot use it.
    const asPerson = await tokenRequest({ grant_type: 'password', client_id: login, username: `ola-${run}`, password: 'test-only', scope: 'openid' });
    const strictPeople = createVerifier({ issuer, audience: 'di-identity', authorizedParties: [login], serviceClients: ['di-channels'], fetchJwks: discoveryJwks(issuer) });
    const app2 = buildApp({ version: 't', verifier: strictPeople, eventsSecret: 'x'.repeat(32), vocabulary: loadVocabulary(), events: memoryEventStore(), checkDatabase: async () => {} });
    peopleRoutes(app2, { verifier: strictPeople, lookup: (email) => lookupByEmail(service, suite.realm, email) });
    assert.notEqual((await app2.inject({ url: `/api/people?email=ola@${run}.test`, headers: { authorization: `Bearer ${asPerson.body.access_token}` } })).statusCode, 200);
  });

  await t.test('people commands refuse agents', async () => {
    await assert.rejects(grantRole(admin, { realm: suite.realm, who: agent.sub, role: 'di-release:editor' }), /is an agent/);
    await assert.rejects(addMember(admin, { realm: suite.realm, organization: run, who: `service-account-${agent.clientId}` }), /is an agent/);
  });

  await t.test('turning an agent off stops new tokens; the organization switch turns all off (AN6)', async () => {
    await setAgentEnabled(admin, suite.realm, agent.clientId, false);
    assert.notEqual((await agentToken(agent.clientId, privateKey, kid)).status, 200);
    await setAgentEnabled(admin, suite.realm, agent.clientId, true);
    assert.equal((await agentToken(agent.clientId, privateKey, kid)).status, 200);
    const listed = await listAgents(admin, suite.realm, run);
    assert.deepEqual(listed.map((a) => [a.clientId, a.owner, a.enabled]), [[agent.clientId, person, true]]);
    assert.deepEqual(await disableOrganizationAgents(admin, suite.realm, run), [agent.clientId]);
    assert.notEqual((await agentToken(agent.clientId, privateKey, kid)).status, 200);
  });
});
