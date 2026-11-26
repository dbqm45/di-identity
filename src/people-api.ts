import type { FastifyInstance } from 'fastify';
import { requireIdentity, requireRole, requireService } from './app.ts';
import type { Verifier } from './auth/oidc.ts';
import type { FoundPerson, PersonWithEmail } from './keycloak/people.ts';

/**
 * People of the suite for other suite applications only (a service token with the role `people-reader` of
 * di-identity):
 * - `GET /api/people?email=<address>`: the person with this verified e-mail (DI Channels: Slack user → suite person).
 *   The answer has `sub`, the display name and organizations; never the e-mail back.
 * - `GET /api/people/<sub>`: the person with their verified e-mail, only for applications that may know e-mails
 *   (`emailClients`, the clients with `email: true` in `keycloak/suite.json`, DI3; DI Channels: a person asked in pdi
 *   → their Slack user). pdi sends only the `sub`, so the e-mail never passes through it.
 * Both answer 404 when there is no single such person.
 */
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function peopleRoutes(
  app: FastifyInstance,
  input: {
    verifier: Verifier;
    lookup: (email: string) => Promise<FoundPerson | null>;
    lookupSub?: (sub: string) => Promise<PersonWithEmail | null>;
    emailClients?: string[];
  },
): void {
  const guard = [requireIdentity(input.verifier), requireService(), requireRole('people-reader')];
  app.get('/api/people', { preHandler: guard }, async (request, reply) => {
    const email = String((request.query as Record<string, unknown>).email ?? '').trim().toLowerCase();
    if (!EMAIL.test(email)) return reply.code(400).send({ error: 'email is required' });
    const person = await input.lookup(email);
    if (!person) return reply.code(404).send({ error: 'no single person with this verified e-mail' });
    return person;
  });

  const lookupSub = input.lookupSub;
  if (!lookupSub) return;
  const emailClients = new Set(input.emailClients ?? []);
  app.get('/api/people/:sub', { preHandler: guard }, async (request, reply) => {
    // A service identity's name is its client id (azp), see auth/oidc.ts.
    if (!request.identity || !emailClients.has(request.identity.name)) return reply.code(403).send({ error: 'this application may not know e-mails' });
    const sub = String((request.params as Record<string, unknown>).sub ?? '');
    if (!UUID.test(sub)) return reply.code(400).send({ error: 'sub must be a suite person id' });
    const person = await lookupSub(sub);
    if (!person) return reply.code(404).send({ error: 'no person with a verified e-mail and this id' });
    return person;
  });
}
