import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { test } from 'node:test';
import { createVerifier, discoveryJwks } from '../src/auth/oidc.ts';
import { keycloakAdmin } from '../src/keycloak/admin.ts';
import { createAgent, createOrganization, disableOrganizationAgents, listAgents, setAgentEnabled } from '../src/keycloak/agents.ts';
import { configure, loadSuite } from '../src/keycloak/configure.ts';

// Against a real Keycloak 26 when KEYCLOAK_URL is set (CI starts one; locally: docker run, see README.md).
const url = process.env.KEYCLOAK_URL;
const skip = !url && 'KEYCLOAK_URL is not set';
const suite = loadSuite();
const issuer = `${url}/realms/${suite.realm}`;
const admin = keycloakAdmin({ url: url ?? 'http://localhost', username: process.env.KEYCLOAK_ADMIN_USERNAME ?? 'admin', password: process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin' });
const R = `/${suite.realm}`;
const run = `t${Date.now().toString(36)}`;

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

test('the suite realm on a real Keycloak: people, organizations, product roles and agents', { skip }, async (t) => {
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
  // `exact=true` matches the name, not the alias (Keycloak 26.4), so filter by alias.
  const org = (await admin.call<{ id: string; alias: string }[]>('GET', `${R}/organizations?search=${run}`)).find((o) => o.alias === run);
  await admin.call('POST', `${R}/organizations/${org!.id}/members`, person);
  const [release] = await admin.call<{ id: string }[]>('GET', `${R}/clients?clientId=di-release`);
  const editor = await admin.call('GET', `${R}/clients/${release!.id}/roles/editor`);
  await admin.call('POST', `${R}/users/${person}/role-mappings/clients/${release!.id}`, [editor]);
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
    // Without being an authorized party, the same token is refused by di-release.
    const strict = createVerifier({ issuer, audience: 'di-release', fetchJwks: discoveryJwks(issuer) });
    await assert.rejects(strict.verify(String(res.body.access_token)), /issued to another application/);
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
