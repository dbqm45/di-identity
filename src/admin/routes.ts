import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { TokenError, type Verifier } from '../auth/oidc.ts';
import { DirectoryError, type Directory, type Person } from './directory.ts';
import { page, peopleBody, invitationsBody, joinedPage, agentsBody, logBody, refusal } from './pages.ts';
import type { AdminSession, AdminStore, Invitation } from './store.ts';

/**
 * The admin console, stage AC1 (docs/plan-admin-console.md): people of the admin's organizations, their product
 * roles, the organizations' agents and the change log; AC1b.1 (docs/plan-admin-console-ac1b.md): invitations by link. Sign-in through the suite (client `di-admin`, code flow with
 * PKCE); the access token is checked by the template's verifier; only a person with `di-admin:admin` gets in, and
 * only to the organizations in their token. Sessions live in the store (only a SHA-256 of the cookie value); every
 * change needs the form token of the session and this origin, and goes to the log.
 */
export const ADMIN_SESSION_COOKIE = 'di_admin_session';
export const ADMIN_LOGIN_COOKIE = 'di_admin_login';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 5000;
const ADMIN_ROLE = 'di-admin:admin';
const ORG = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const ID = /^[A-Za-z0-9-]{1,64}$/;
const AGENT = /^agent-[a-z0-9-]{1,100}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AdminInput {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** The console's public origin, e.g. http://127.0.0.1:3200; the suite sends people back to /admin/callback. */
  publicUrl: string;
  /** Checks access tokens issued to `clientId`. */
  verifier: Verifier;
  store: AdminStore;
  directory: Directory;
  /** Product clients and their roles, from keycloak/suite.json (without di-identity itself). */
  products: Record<string, string[]>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const random = () => randomBytes(32).toString('base64url');
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function cookie(request: FastifyRequest, name: string): string {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}

export function adminRoutes(app: FastifyInstance, input: AdminInput): void {
  const now = input.now ?? Date.now;
  const fetchImpl = input.fetchImpl ?? fetch;
  const origin = new URL(input.publicUrl).origin;
  const secure = input.publicUrl.startsWith('https://') ? '; Secure' : '';
  const redirectUri = `${origin}/admin/callback`;
  // A sign-in in progress; `join` is the token hash of the invitation it was started for (AC1b.1).
  const pending = new Map<string, { verifier: string; expires: number; join?: string }>();
  let discovery: { authorization_endpoint: string; token_endpoint: string; at: number } | null = null;

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    // A repeated field (the roles of an invitation) becomes a list.
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of new URLSearchParams(body as string)) {
      const had = out[k];
      out[k] = had === undefined ? v : [had, v].flat();
    }
    done(null, out);
  });

  const discover = async () => {
    if (discovery && now() - discovery.at < 3_600_000) return discovery;
    const res = await fetchImpl(`${input.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
    const meta = (await res.json()) as Record<string, unknown>;
    if (!res.ok || meta.issuer !== input.issuer || typeof meta.authorization_endpoint !== 'string' || typeof meta.token_endpoint !== 'string') {
      throw new Error('the identity service metadata does not match the issuer');
    }
    discovery = { authorization_endpoint: meta.authorization_endpoint, token_endpoint: meta.token_endpoint, at: now() };
    return discovery;
  };

  const html = (reply: FastifyReply, status: number, body: string) =>
    reply
      .code(status)
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'same-origin')
      .header('cache-control', 'no-store')
      .send(body);

  const sessionOf = async (request: FastifyRequest): Promise<{ idHash: string; session: AdminSession } | null> => {
    const id = cookie(request, ADMIN_SESSION_COOKIE);
    if (!id) return null;
    const idHash = sha256(id);
    const session = await input.store.session(idHash);
    return session ? { idHash, session } : null;
  };

  // --- sign-in ---

  const startSignIn = async (request: FastifyRequest, reply: FastifyReply, join?: string) => {
    let meta;
    try {
      meta = await discover();
    } catch (err) {
      request.log.warn({ err: (err as Error).message }, 'the suite identity service is not reachable');
      return html(reply, 502, refusal('The suite identity service is not reachable. Try again in a moment.'));
    }
    for (const [k, v] of pending) if (v.expires < now()) pending.delete(k);
    const state = random();
    const verifier = random();
    pending.set(state, { verifier, expires: now() + LOGIN_TTL_MS, ...(join ? { join } : {}) });
    const url = new URL(meta.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: input.clientId, response_type: 'code', scope: 'openid profile email', redirect_uri: redirectUri, state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    }).toString();
    reply.header('set-cookie', `${ADMIN_LOGIN_COOKIE}=${state}; Path=/admin/callback; Max-Age=${LOGIN_TTL_MS / 1000}; HttpOnly; SameSite=Lax${secure}`);
    return reply.redirect(url.toString());
  };

  app.get('/admin/login', async (request, reply) => startSignIn(request, reply));

  const isOpen = (i: Invitation) => !i.usedAt && !i.revokedAt && i.expiresAt.getTime() > now();
  const GONE = 'This invitation was already used, revoked or has expired. Ask the administrator for a new link.';

  // An invitation link (AC1b.1): the person signs in through the suite first; the callback lets them join.
  app.get('/admin/join/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const invitation = TOKEN.test(token) ? await input.store.invitationByHash(sha256(token)) : null;
    if (!invitation) return html(reply, 404, refusal('No such invitation.'));
    if (!isOpen(invitation)) return html(reply, 410, refusal(GONE));
    return startSignIn(request, reply, sha256(token));
  });

  app.get('/admin/callback', async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const state = typeof q.state === 'string' ? q.state : '';
    const code = typeof q.code === 'string' ? q.code : '';
    reply.header('set-cookie', `${ADMIN_LOGIN_COOKIE}=; Path=/admin/callback; Max-Age=0; HttpOnly; SameSite=Lax${secure}`);
    const entry = state ? pending.get(state) : undefined;
    if (state) pending.delete(state);
    const fromCookie = cookie(request, ADMIN_LOGIN_COOKIE);
    if (!entry || !fromCookie || !same(fromCookie, state) || entry.expires < now() || !code) {
      return html(reply, 400, refusal('The sign-in expired or did not start here. <a href="/admin/login">Sign in again</a>.', true));
    }
    let identity;
    try {
      const meta = await discover();
      const res = await fetchImpl(meta.token_endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: input.clientId, client_secret: input.clientSecret, code_verifier: entry.verifier }).toString(),
      });
      const tokens = (await res.json()) as { access_token?: unknown };
      if (!res.ok || typeof tokens.access_token !== 'string') throw new TokenError('the identity service did not accept the sign-in');
      identity = await input.verifier.verify(tokens.access_token);
    } catch (err) {
      request.log.warn({ err: (err as Error).message }, 'admin console sign-in failed');
      return html(reply, 502, refusal('The sign-in through the suite failed. <a href="/admin/login">Try again</a>.', true));
    }
    if (entry.join) {
      const invitation = await input.store.invitationByHash(entry.join);
      if (!invitation || !isOpen(invitation)) return html(reply, 410, refusal(GONE));
      if (identity.kind !== 'person') return html(reply, 403, refusal('An invitation is for a person, not an agent.'));
      if (!(await input.store.useInvitation(invitation.id, identity.sub, new Date(now())))) return html(reply, 410, refusal(GONE));
      const { person } = await input.directory.join(invitation.organization, identity.sub);
      const granted = invitation.roles.filter((r) => !person.roles.includes(r));
      for (const role of granted) await input.directory.grant(person.id, role);
      await input.store.record({
        organization: invitation.organization, actorSub: identity.sub, actorName: identity.name, kind: 'invitation_accepted',
        subject: `${person.name}: ${invitation.roles.join(', ')}`,
      });
      return html(reply, 200, joinedPage(invitation.organization, granted));
    }
    if (identity.kind !== 'person' || !identity.roles.includes('admin')) {
      return html(reply, 403, refusal('The admin console is for people with the admin role of DI Admin Console (di-admin:admin).'));
    }
    if (!identity.organizations.length) return html(reply, 403, refusal('Your suite account is in no organization.'));
    const id = random();
    await input.store.saveSession(sha256(id), {
      sub: identity.sub, name: identity.name, organizations: identity.organizations.filter((o) => ORG.test(o)), csrf: random(), expiresAt: new Date(now() + SESSION_TTL_MS),
    });
    reply.header('set-cookie', `${ADMIN_SESSION_COOKIE}=${id}; Path=/admin; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; SameSite=Lax${secure}`);
    return reply.redirect('/admin');
  });

  // --- pages ---

  app.get('/admin', async (request, reply) => {
    const found = await sessionOf(request);
    if (!found) return reply.redirect('/admin/login');
    return reply.redirect(`/admin/o/${found.session.organizations[0]}/people`);
  });

  const pageFor = (section: 'people' | 'invitations' | 'agents' | 'log') => async (request: FastifyRequest, reply: FastifyReply) => {
    const found = await sessionOf(request);
    if (!found) return reply.redirect('/admin/login');
    const org = (request.params as { org: string }).org;
    if (!found.session.organizations.includes(org)) return html(reply, 404, refusal('No such organization.'));
    const ctx = { session: found.session, org, section };
    if (section === 'people') return html(reply, 200, page(ctx, peopleBody(org, await input.directory.people(org), input.products, found.session.csrf)));
    if (section === 'invitations') {
      return html(reply, 200, page(ctx, invitationsBody(org, await input.store.invitations(org), input.products, found.session.csrf, new Date(now()))));
    }
    if (section === 'agents') return html(reply, 200, page(ctx, agentsBody(org, await input.directory.agents(org), found.session.csrf)));
    return html(reply, 200, page(ctx, logBody(await input.store.latest(org, 100))));
  };
  app.get('/admin/o/:org/people', pageFor('people'));
  app.get('/admin/o/:org/invitations', pageFor('invitations'));
  app.get('/admin/o/:org/agents', pageFor('agents'));
  app.get('/admin/o/:org/log', pageFor('log'));

  // --- changes ---

  /** The checks every change passes: a session, this origin, the session's form token and (when given) the organization. */
  const change = async (request: FastifyRequest, reply: FastifyReply, org?: string): Promise<AdminSession | null> => {
    const found = await sessionOf(request);
    if (!found) {
      await reply.redirect('/admin/login', 303);
      return null;
    }
    const from = request.headers.origin ?? request.headers.referer ?? '';
    if (!from || new URL(from, 'http://invalid').origin !== origin) {
      await html(reply, 403, refusal('This change did not come from the admin console.'));
      return null;
    }
    const csrf = String((request.body as Record<string, unknown> | undefined)?.csrf ?? '');
    if (!same(csrf, found.session.csrf)) {
      await html(reply, 403, refusal('The form expired. Open the page again.'));
      return null;
    }
    if (org !== undefined && !found.session.organizations.includes(org)) {
      await html(reply, 404, refusal('No such organization.'));
      return null;
    }
    return found.session;
  };

  const record = (session: AdminSession, org: string, kind: string, subject: string) =>
    input.store.record({ organization: org, actorSub: session.sub, actorName: session.name, kind, subject });

  const label = (p: Person) => (p.email ? `${p.name} <${p.email}>` : p.name);
  const back = (reply: FastifyReply, org: string, section: string) => reply.redirect(`/admin/o/${org}/${section}`, 303);
  const productRole = (role: string) => {
    const [client, name] = role.split(':');
    return Boolean(client && name && input.products[client]?.includes(name));
  };

  app.post('/admin/logout', async (request, reply) => {
    const session = await change(request, reply);
    if (!session) return reply;
    const found = await sessionOf(request);
    if (found) await input.store.endSession(found.idHash);
    reply.header('set-cookie', `${ADMIN_SESSION_COOKIE}=; Path=/admin; Max-Age=0; HttpOnly; SameSite=Lax${secure}`);
    return reply.redirect('/admin/login', 303);
  });

  app.post('/admin/o/:org/people/add', async (request, reply) => {
    const { org } = request.params as { org: string };
    const session = await change(request, reply, org);
    if (!session) return reply;
    const email = String((request.body as Record<string, unknown>).email ?? '').trim().toLowerCase();
    if (!EMAIL.test(email)) return html(reply, 400, refusal('Give the e-mail address the person signs in with.'));
    try {
      const added = await input.directory.add(org, email);
      await record(session, org, 'person_added', label(added));
    } catch (err) {
      if (!(err instanceof DirectoryError) && !/signed in to the suite|agent/.test((err as Error).message)) throw err;
      return html(reply, 409, refusal((err as Error).message));
    }
    return back(reply, org, 'people');
  });

  /** A person of this organization, or a 404 page (another organization's person is not there). */
  const personIn = async (reply: FastifyReply, org: string, id: string): Promise<{ person: Person; people: Person[] } | null> => {
    const people = ID.test(id) ? await input.directory.people(org) : [];
    const person = people.find((p) => p.id === id);
    if (!person) {
      await html(reply, 404, refusal('No such person in this organization.'));
      return null;
    }
    return { person, people };
  };
  const lastAdmin = (people: Person[], id: string) => {
    const admins = people.filter((p) => p.roles.includes(ADMIN_ROLE));
    return admins.length === 1 && admins[0]!.id === id;
  };

  app.post('/admin/o/:org/people/:id/remove', async (request, reply) => {
    const { org, id } = request.params as { org: string; id: string };
    const session = await change(request, reply, org);
    if (!session) return reply;
    const found = await personIn(reply, org, id);
    if (!found) return reply;
    if (lastAdmin(found.people, id)) return html(reply, 409, refusal('The organization would be left without its last administrator.'));
    await input.directory.remove(org, id);
    await record(session, org, 'person_removed', label(found.person));
    return back(reply, org, 'people');
  });

  for (const action of ['grant', 'revoke'] as const) {
    app.post(`/admin/o/:org/people/:id/${action}`, async (request, reply) => {
      const { org, id } = request.params as { org: string; id: string };
      const session = await change(request, reply, org);
      if (!session) return reply;
      const role = String((request.body as Record<string, unknown>).role ?? '');
      if (!productRole(role)) return html(reply, 400, refusal('No such product role.'));
      const found = await personIn(reply, org, id);
      if (!found) return reply;
      if (action === 'revoke' && role === ADMIN_ROLE && lastAdmin(found.people, id)) {
        return html(reply, 409, refusal('The organization would be left without its last administrator.'));
      }
      await (action === 'grant' ? input.directory.grant(id, role) : input.directory.revoke(id, role));
      await record(session, org, action === 'grant' ? 'role_granted' : 'role_revoked', `${found.person.name}: ${role}`);
      return back(reply, org, 'people');
    });
  }

  app.post('/admin/o/:org/invitations', async (request, reply) => {
    const { org } = request.params as { org: string };
    const session = await change(request, reply, org);
    if (!session) return reply;
    const given = (request.body as Record<string, unknown>).role;
    const roles = [...new Set([given ?? []].flat().map(String))].sort();
    if (!roles.length || !roles.every(productRole)) return html(reply, 400, refusal('Choose at least one product role.'));
    const token = random();
    await input.store.createInvitation(sha256(token), {
      id: randomUUID(), organization: org, roles, createdBySub: session.sub, createdByName: session.name, expiresAt: new Date(now() + INVITATION_TTL_MS),
    });
    await record(session, org, 'invitation_created', roles.join(', '));
    const ctx = { session, org, section: 'invitations' as const };
    return html(reply, 200, page(ctx, invitationsBody(org, await input.store.invitations(org), input.products, session.csrf, new Date(now()), `${origin}/admin/join/${token}`)));
  });

  app.post('/admin/o/:org/invitations/:id/revoke', async (request, reply) => {
    const { org, id } = request.params as { org: string; id: string };
    const session = await change(request, reply, org);
    if (!session) return reply;
    if (!UUID.test(id) || !(await input.store.revokeInvitation(org, id, new Date(now())))) return html(reply, 404, refusal('No open invitation like that in this organization.'));
    await record(session, org, 'invitation_revoked', id);
    return back(reply, org, 'invitations');
  });

  app.post('/admin/o/:org/agents/disable-all', async (request, reply) => {
    const { org } = request.params as { org: string };
    const session = await change(request, reply, org);
    if (!session) return reply;
    const on = (await input.directory.agents(org)).filter((a) => a.enabled);
    for (const a of on) await input.directory.setAgent(a.clientId, false);
    await record(session, org, 'agents_all_disabled', on.map((a) => a.clientId).join(', ') || 'none was on');
    return back(reply, org, 'agents');
  });

  for (const action of ['disable', 'enable'] as const) {
    app.post(`/admin/o/:org/agents/:clientId/${action}`, async (request, reply) => {
      const { org, clientId } = request.params as { org: string; clientId: string };
      const session = await change(request, reply, org);
      if (!session) return reply;
      const agents = AGENT.test(clientId) ? await input.directory.agents(org) : [];
      if (!agents.some((a) => a.clientId === clientId)) return html(reply, 404, refusal('No such agent in this organization.'));
      await input.directory.setAgent(clientId, action === 'enable');
      await record(session, org, action === 'enable' ? 'agent_enabled' : 'agent_disabled', clientId);
      return back(reply, org, 'agents');
    });
  }
}
