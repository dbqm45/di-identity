import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { adminRoutes, ADMIN_SESSION_COOKIE, ADMIN_LOGIN_COOKIE } from '../src/admin/routes.ts';
import type { Directory, Person, AgentView } from '../src/admin/directory.ts';
import { memoryAdminStore } from '../src/admin/store.ts';
import { buildApp } from '../src/app.ts';
import { createVerifier } from '../src/auth/oidc.ts';
import { loadVocabulary } from '../src/events/envelope.ts';
import { memoryEventStore } from '../src/events/store.ts';
import { ISSUER, JWKS, SECRET, token } from './helpers.ts';

// The admin console, stage AC1 (docs/plan-admin-console.md): sign-in through the suite (client di-admin, code flow with
// PKCE against a fake issuer), people, product roles, agents and the change log of the admin's own organizations.

const PUBLIC = 'http://127.0.0.1:3200';
const PRODUCTS = { 'di-release': ['viewer', 'editor', 'admin'], 'di-admin': ['admin'] };
const ADMIN_SUB = '11111111-1111-4111-8111-111111111111';

const adminToken = (roles = ['admin'], organization: string[] = ['acme'], sub = ADMIN_SUB) =>
  token({ aud: ['di-admin'], azp: 'di-admin', sub, name: 'Adm Test', email: 'adm@acme.test', organization, resource_access: { 'di-admin': { roles } } });

function fakeIssuer() {
  const grants = new Map<string, string>();
  const state = { next: adminToken(), forms: [] as URLSearchParams[] };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`, token_endpoint: `${ISSUER}/protocol/openid-connect/token`, jwks_uri: `${ISSUER}/certs` });
    }
    if (url === `${ISSUER}/protocol/openid-connect/token`) {
      const form = new URLSearchParams(String(init?.body ?? ''));
      state.forms.push(form);
      const challenge = grants.get(form.get('code') ?? '');
      const sent = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      if (!challenge || challenge !== sent) return json({ error: 'invalid_grant' }, 400);
      return json({ access_token: state.next, token_type: 'Bearer', expires_in: 300 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const approve = (location: string) => {
    const q = new URL(location).searchParams;
    const code = `code-${grants.size}`;
    grants.set(code, q.get('code_challenge')!);
    return `code=${code}&state=${q.get('state')}`;
  };
  return { state, fetchImpl, approve };
}

/** People and agents of two organizations, as the console sees them through Keycloak. */
function fakeDirectory() {
  const people = new Map<string, Person[]>([
    ['acme', [
      { id: ADMIN_SUB, name: 'Adm Test', email: 'adm@acme.test', roles: ['di-admin:admin'] },
      { id: 'p-ola', name: 'Ola Test', email: 'ola@acme.test', roles: ['di-release:editor'] },
    ]],
    ['globex', [{ id: 'p-gx', name: 'Gx Person', email: 'gx@globex.test', roles: [] }]],
  ]);
  const known = new Map([['nowa@acme.test', { id: 'p-new', name: 'Nowa Osoba', email: 'nowa@acme.test', roles: [] as string[] }]]);
  const byId = new Map([['p-join', { id: 'p-join', name: 'Zaproszona Osoba', email: '', roles: [] as string[] }]]);
  const agents = new Map<string, AgentView[]>([
    ['acme', [{ clientId: 'agent-tomasz-acme', owner: ADMIN_SUB, reviewBy: '2027-02-20', enabled: true }]],
    ['globex', [{ clientId: 'agent-x-globex', owner: 'p-gx', reviewBy: '2027-02-20', enabled: true }]],
  ]);
  const all = () => [...people.values()].flat();
  const directory: Directory = {
    async people(org) { return structuredClone(people.get(org) ?? []); },
    async add(org, email) {
      const p = known.get(email);
      if (!p) throw new Error('no person with this e-mail has signed in to the suite yet');
      people.get(org)!.push(p);
      return p;
    },
    async join(org, id) {
      const list = people.get(org)!;
      const member = list.find((p) => p.id === id);
      if (member) return { person: member, added: false };
      const p = byId.get(id) ?? [...known.values()].find((x) => x.id === id);
      if (!p) throw new Error('no such person in the suite');
      list.push(p);
      return { person: p, added: true };
    },
    async remove(org, id) { people.set(org, people.get(org)!.filter((p) => p.id !== id)); },
    async grant(id, role) { const p = all().find((x) => x.id === id)!; if (!p.roles.includes(role)) p.roles.push(role); },
    async revoke(id, role) { const p = all().find((x) => x.id === id)!; p.roles = p.roles.filter((r) => r !== role); },
    async agents(org) { return structuredClone(agents.get(org) ?? []); },
    async setAgent(clientId, enabled) { for (const list of agents.values()) for (const a of list) if (a.clientId === clientId) a.enabled = enabled; },
  };
  return { directory, people, agents };
}

function setup(options: { now?: () => number } = {}) {
  const issuer = fakeIssuer();
  const dir = fakeDirectory();
  const store = memoryAdminStore(options.now);
  const app = buildApp({
    version: '0.0.0', eventsSecret: SECRET, vocabulary: loadVocabulary(), events: memoryEventStore(), checkDatabase: async () => {},
    verifier: createVerifier({ issuer: ISSUER, audience: 'di-identity', fetchJwks: async () => JWKS }),
  });
  adminRoutes(app, {
    issuer: ISSUER, clientId: 'di-admin', clientSecret: 'dummy-admin-secret', publicUrl: PUBLIC,
    verifier: createVerifier({ issuer: ISSUER, audience: 'di-admin', fetchJwks: async () => JWKS }),
    store, directory: dir.directory, products: PRODUCTS, fetchImpl: issuer.fetchImpl, ...(options.now ? { now: options.now } : {}),
  });
  return { app, issuer, store, ...dir };
}

type App = ReturnType<typeof setup>['app'];
const cookieOf = (setCookie: string | string[] | undefined, name: string) =>
  [setCookie ?? []].flat().find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`))?.split(';')[0];

async function signIn(app: App, issuer: ReturnType<typeof fakeIssuer>) {
  const start = await app.inject({ url: '/admin/login' });
  const login = cookieOf(start.headers['set-cookie'], ADMIN_LOGIN_COOKIE) ?? '';
  const back = await app.inject({ url: `/admin/callback?${issuer.approve(String(start.headers.location))}`, headers: { cookie: login } });
  return { back, session: cookieOf(back.headers['set-cookie'], ADMIN_SESSION_COOKIE) };
}

const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
const post = (app: App, url: string, session: string, form: Record<string, string>, origin = PUBLIC) =>
  app.inject({ method: 'POST', url, headers: { cookie: session, 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) }, payload: new URLSearchParams(form).toString() });

test('AC-01: the console needs a session; sign-in goes to the suite with PKCE, for the di-admin client', async () => {
  const { app } = setup();
  const res = await app.inject({ url: '/admin/o/acme/people' });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/admin/login');
  const start = await app.inject({ url: '/admin/login' });
  const url = new URL(String(start.headers.location));
  assert.equal(`${url.origin}${url.pathname}`, `${ISSUER}/protocol/openid-connect/auth`);
  assert.equal(url.searchParams.get('client_id'), 'di-admin');
  assert.equal(url.searchParams.get('redirect_uri'), `${PUBLIC}/admin/callback`);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(url.searchParams.get('state') ?? '', /^[\w-]{20,}$/);
  const cookie = [start.headers['set-cookie']].flat().find((c) => String(c).startsWith(`${ADMIN_LOGIN_COOKIE}=`))!;
  assert.match(String(cookie), /HttpOnly/);
  assert.match(String(cookie), /SameSite=Lax/);
  assert.match(String(cookie), /Path=\/admin\/callback/);
});

test('AC-02: an admin of the organization signs in and lands on its people; the session is stored only as a hash', async () => {
  const { app, issuer, store } = setup();
  const { back, session } = await signIn(app, issuer);
  assert.equal(back.statusCode, 302);
  assert.equal(back.headers.location, '/admin');
  assert.ok(session);
  assert.equal(issuer.state.forms.at(-1)?.get('client_secret'), 'dummy-admin-secret');
  const home = await app.inject({ url: '/admin', headers: { cookie: session } });
  assert.equal(home.headers.location, '/admin/o/acme/people');
  const page = await app.inject({ url: '/admin/o/acme/people', headers: { cookie: session } });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Ola Test/);
  assert.match(page.body, /ola@acme\.test/);
  assert.match(page.body, /di-release:editor/);
  assert.doesNotMatch(page.body, /<script/i);
  assert.match(String(page.headers['content-security-policy']), /default-src 'none'/);
  const id = session!.split('=')[1]!;
  assert.ok(!JSON.stringify(store.sessions).includes(id), 'the cookie value itself is never stored');
});

test('AC-03: without di-admin:admin, or as a person of no organization, the console refuses', async () => {
  const { app, issuer } = setup();
  issuer.state.next = adminToken([]);
  const noRole = await signIn(app, issuer);
  assert.equal(noRole.back.statusCode, 403);
  assert.equal(noRole.session, undefined);
  issuer.state.next = adminToken(['admin'], []);
  const noOrg = await signIn(app, issuer);
  assert.equal(noOrg.back.statusCode, 403);
  assert.equal(noOrg.session, undefined);
});

test('AC-04: another organization is not there: pages and changes answer 404', async () => {
  const { app, issuer, people } = setup();
  const { session } = await signIn(app, issuer);
  assert.equal((await app.inject({ url: '/admin/o/globex/people', headers: { cookie: session } })).statusCode, 404);
  const csrf = csrfOf((await app.inject({ url: '/admin/o/acme/people', headers: { cookie: session } })).body);
  assert.equal((await post(app, '/admin/o/globex/people/p-gx/remove', session!, { csrf })).statusCode, 404);
  // A person of another organization cannot be changed through mine either.
  assert.equal((await post(app, '/admin/o/acme/people/p-gx/grant', session!, { csrf, role: 'di-release:admin' })).statusCode, 404);
  assert.deepEqual(people.get('globex')!.map((p) => p.roles), [[]]);
});

test('AC-05: changes need the form token and this origin', async () => {
  const { app, issuer, people } = setup();
  const { session } = await signIn(app, issuer);
  const csrf = csrfOf((await app.inject({ url: '/admin/o/acme/people', headers: { cookie: session } })).body);
  assert.ok(csrf);
  assert.equal((await post(app, '/admin/o/acme/people/p-ola/remove', session!, { csrf: 'forged' })).statusCode, 403);
  assert.equal((await post(app, '/admin/o/acme/people/p-ola/remove', session!, { csrf }, '')).statusCode, 403);
  assert.equal((await post(app, '/admin/o/acme/people/p-ola/remove', session!, { csrf }, 'https://evil.example')).statusCode, 403);
  assert.equal(people.get('acme')!.length, 2);
});

test('AC-06: add a person by e-mail, grant and revoke product roles, remove them; every change is in the log', async () => {
  const { app, issuer, people, store } = setup();
  const { session } = await signIn(app, issuer);
  const csrf = csrfOf((await app.inject({ url: '/admin/o/acme/people', headers: { cookie: session } })).body);
  const added = await post(app, '/admin/o/acme/people/add', session!, { csrf, email: 'Nowa@Acme.test' });
  assert.equal(added.statusCode, 303);
  assert.ok(people.get('acme')!.some((p) => p.id === 'p-new'));
  const unknown = await post(app, '/admin/o/acme/people/add', session!, { csrf, email: 'nikt@acme.test' });
  assert.equal(unknown.statusCode, 409);
  assert.match(unknown.body, /signed in to the suite/);
  assert.equal((await post(app, '/admin/o/acme/people/p-new/grant', session!, { csrf, role: 'di-release:viewer' })).statusCode, 303);
  assert.deepEqual(people.get('acme')!.find((p) => p.id === 'p-new')!.roles, ['di-release:viewer']);
  assert.equal((await post(app, '/admin/o/acme/people/p-new/grant', session!, { csrf, role: 'di-identity:admin' })).statusCode, 400);
  assert.equal((await post(app, '/admin/o/acme/people/p-new/grant', session!, { csrf, role: 'di-release:owner' })).statusCode, 400);
  assert.equal((await post(app, '/admin/o/acme/people/p-new/revoke', session!, { csrf, role: 'di-release:viewer' })).statusCode, 303);
  assert.equal((await post(app, '/admin/o/acme/people/p-new/remove', session!, { csrf })).statusCode, 303);
  assert.ok(!people.get('acme')!.some((p) => p.id === 'p-new'));
  assert.deepEqual(store.events.map((e) => [e.organization, e.actorSub, e.kind, e.subject]), [
    ['acme', ADMIN_SUB, 'person_added', 'Nowa Osoba <nowa@acme.test>'],
    ['acme', ADMIN_SUB, 'role_granted', 'Nowa Osoba: di-release:viewer'],
    ['acme', ADMIN_SUB, 'role_revoked', 'Nowa Osoba: di-release:viewer'],
    ['acme', ADMIN_SUB, 'person_removed', 'Nowa Osoba <nowa@acme.test>'],
  ]);
  const log = await app.inject({ url: '/admin/o/acme/log', headers: { cookie: session } });
  assert.match(log.body, /role_granted/);
  assert.match(log.body, /Adm Test/);
});

test('AC-07: the last admin of the organization keeps di-admin:admin and stays in the organization', async () => {
  const { app, issuer, people } = setup();
  const { session } = await signIn(app, issuer);
  const csrf = csrfOf((await app.inject({ url: '/admin/o/acme/people', headers: { cookie: session } })).body);
  const revoke = await post(app, '/admin/o/acme/people/' + ADMIN_SUB + '/revoke', session!, { csrf, role: 'di-admin:admin' });
  assert.equal(revoke.statusCode, 409);
  assert.match(revoke.body, /last administrator/);
  assert.equal((await post(app, '/admin/o/acme/people/' + ADMIN_SUB + '/remove', session!, { csrf })).statusCode, 409);
  // With a second admin, the first may step down.
  assert.equal((await post(app, '/admin/o/acme/people/p-ola/grant', session!, { csrf, role: 'di-admin:admin' })).statusCode, 303);
  assert.equal((await post(app, '/admin/o/acme/people/' + ADMIN_SUB + '/revoke', session!, { csrf, role: 'di-admin:admin' })).statusCode, 303);
  assert.ok(!people.get('acme')!.find((p) => p.id === ADMIN_SUB)!.roles.includes('di-admin:admin'));
});

test('AC-08: agents of the organization: off, on, and the switch for all; another organization\'s agent is not there', async () => {
  const { app, issuer, agents, store } = setup();
  const { session } = await signIn(app, issuer);
  const page = await app.inject({ url: '/admin/o/acme/agents', headers: { cookie: session } });
  assert.match(page.body, /agent-tomasz-acme/);
  assert.doesNotMatch(page.body, /agent-x-globex/);
  const csrf = csrfOf(page.body);
  assert.equal((await post(app, '/admin/o/acme/agents/agent-tomasz-acme/disable', session!, { csrf })).statusCode, 303);
  assert.equal(agents.get('acme')![0]!.enabled, false);
  assert.equal((await post(app, '/admin/o/acme/agents/agent-tomasz-acme/enable', session!, { csrf })).statusCode, 303);
  assert.equal((await post(app, '/admin/o/acme/agents/agent-x-globex/disable', session!, { csrf })).statusCode, 404);
  assert.equal(agents.get('globex')![0]!.enabled, true);
  assert.equal((await post(app, '/admin/o/acme/agents/disable-all', session!, { csrf })).statusCode, 303);
  assert.equal(agents.get('acme')![0]!.enabled, false);
  assert.deepEqual(store.events.map((e) => e.kind), ['agent_disabled', 'agent_enabled', 'agents_all_disabled']);
});

test('AC-09: sign-out ends the session; a forged callback gets none', async () => {
  const { app, issuer } = setup();
  const forged = await app.inject({ url: '/admin/callback?code=x&state=y' });
  assert.equal(forged.statusCode, 400);
  const { session } = await signIn(app, issuer);
  const csrf = csrfOf((await app.inject({ url: '/admin/o/acme/people', headers: { cookie: session } })).body);
  const out = await post(app, '/admin/logout', session!, { csrf });
  assert.equal(out.statusCode, 303);
  assert.equal((await app.inject({ url: '/admin/o/acme/people', headers: { cookie: session } })).statusCode, 302);
});

// --- AC1b.1: invitations by link (docs/plan-admin-console-ac1b.md) ---

const JOIN_SUB = 'p-join';
const personToken = (sub = JOIN_SUB, organization: string[] = [], roles: string[] = []) =>
  token({ aud: ['di-admin'], azp: 'di-admin', sub, name: 'Zaproszona Osoba', organization, resource_access: { 'di-admin': { roles } } });

async function invite(app: App, session: string, roles: string[], org = 'acme') {
  // The form token of the session, from the admin's own organization's page (another one answers 404).
  const csrf = csrfOf((await app.inject({ url: '/admin/o/acme/invitations', headers: { cookie: session } })).body);
  const form = new URLSearchParams({ csrf });
  for (const r of roles) form.append('role', r);
  return app.inject({ method: 'POST', url: `/admin/o/${org}/invitations`, headers: { cookie: session, 'content-type': 'application/x-www-form-urlencoded', origin: PUBLIC }, payload: form.toString() });
}
const linkOf = (html: string) => new RegExp(`${PUBLIC}/admin/join/([\\w-]{40,})`).exec(html)?.[1] ?? '';

/** The invited person opens the link, signs in through the suite and comes back. */
async function join(app: App, issuer: ReturnType<typeof fakeIssuer>, link: string, as = personToken()) {
  const open = await app.inject({ url: `/admin/join/${link}` });
  if (open.statusCode !== 302) return open;
  issuer.state.next = as;
  const login = cookieOf(open.headers['set-cookie'], ADMIN_LOGIN_COOKIE) ?? '';
  return app.inject({ url: `/admin/callback?${issuer.approve(String(open.headers.location))}`, headers: { cookie: login } });
}

test('AC-10: an admin creates an invitation with product roles; the link shows once and only its hash is stored', async () => {
  const { app, issuer, store } = setup();
  const { session } = await signIn(app, issuer);
  const res = await invite(app, session!, ['di-release:viewer', 'di-release:editor']);
  assert.equal(res.statusCode, 200, res.body);
  const link = linkOf(res.body);
  assert.ok(link, 'the page shows the link');
  assert.ok(!JSON.stringify([...store.invitationsByHash.values()]).includes(link), 'the token itself is never stored');
  const list = await app.inject({ url: '/admin/o/acme/invitations', headers: { cookie: session } });
  assert.match(list.body, /di-release:editor, di-release:viewer/);
  assert.match(list.body, /open/);
  assert.ok(!list.body.includes(link), 'the list never shows the link again');
  assert.equal((await invite(app, session!, ['di-release:owner'])).statusCode, 400);
  assert.equal((await invite(app, session!, [])).statusCode, 400);
  assert.equal((await invite(app, session!, ['di-release:viewer'], 'globex')).statusCode, 404);
  assert.ok(store.events.some((e) => e.kind === 'invitation_created' && e.subject === 'di-release:editor, di-release:viewer'));
});

test('AC-11: the invited person signs in through the suite and joins with the roles; no console session for them', async () => {
  const { app, issuer, people, store } = setup();
  const { session } = await signIn(app, issuer);
  const link = linkOf((await invite(app, session!, ['di-release:viewer'])).body);
  const back = await join(app, issuer, link);
  assert.equal(back.statusCode, 200, back.body);
  assert.match(back.body, /You joined acme/);
  assert.equal(cookieOf(back.headers['set-cookie'], ADMIN_SESSION_COOKIE), undefined);
  assert.deepEqual(people.get('acme')!.find((p) => p.id === JOIN_SUB)?.roles, ['di-release:viewer']);
  const accepted = store.events.find((e) => e.kind === 'invitation_accepted');
  assert.equal(accepted?.actorSub, JOIN_SUB);
  assert.equal(accepted?.subject, 'Zaproszona Osoba: di-release:viewer');
});

test('AC-12: a link works once, not after it expired or was revoked, and an unknown one is not found', async () => {
  let clock = Date.now();
  const { app, issuer } = setup({ now: () => clock });
  const { session } = await signIn(app, issuer);
  const used = linkOf((await invite(app, session!, ['di-release:viewer'])).body);
  assert.equal((await join(app, issuer, used)).statusCode, 200);
  assert.equal((await join(app, issuer, used, personToken('p-new'))).statusCode, 410);

  const revoked = await invite(app, session!, ['di-release:viewer']);
  const id = /data-invitation="([^"]+)"/.exec((await app.inject({ url: '/admin/o/acme/invitations', headers: { cookie: session } })).body)?.[1];
  assert.ok(id);
  const csrf = csrfOf(revoked.body);
  assert.equal((await post(app, `/admin/o/acme/invitations/${id}/revoke`, session!, { csrf }, 'https://evil.example')).statusCode, 403);
  assert.equal((await post(app, `/admin/o/acme/invitations/${id}/revoke`, session!, { csrf })).statusCode, 303);
  assert.equal((await join(app, issuer, linkOf(revoked.body))).statusCode, 410);

  const late = linkOf((await invite(app, session!, ['di-release:viewer'])).body);
  clock += 8 * 24 * 3600 * 1000;
  assert.equal((await join(app, issuer, late)).statusCode, 410);
  assert.equal((await app.inject({ url: `/admin/join/${'x'.repeat(43)}` })).statusCode, 404);
});

test('AC-13: a member who joins again only gets the missing roles and loses none', async () => {
  const { app, issuer, people } = setup();
  const { session } = await signIn(app, issuer);
  const link = linkOf((await invite(app, session!, ['di-release:viewer'])).body);
  assert.equal((await join(app, issuer, link, personToken('p-ola', ['acme']))).statusCode, 200);
  assert.deepEqual(people.get('acme')!.find((p) => p.id === 'p-ola')?.roles.sort(), ['di-release:editor', 'di-release:viewer']);
});

test('AC-14: an agent cannot take an invitation, and the invitation stays open', async () => {
  const { app, issuer, people } = setup();
  const { session } = await signIn(app, issuer);
  const link = linkOf((await invite(app, session!, ['di-release:viewer'])).body);
  const agent = token({ aud: ['di-admin'], azp: 'agent-x-acme', sub: 'agent-sub', kind: 'agent', owner: ADMIN_SUB, organization: ['acme'] });
  const res = await join(app, issuer, link, agent);
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(people.get('acme')!.some((p) => p.id === 'agent-sub'), false);
  assert.equal((await join(app, issuer, link)).statusCode, 200, 'still open for a person');
});
