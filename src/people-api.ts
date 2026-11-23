import type { FastifyInstance } from 'fastify';
import { requireIdentity, requireRole, requireService } from './app.ts';
import type { Verifier } from './auth/oidc.ts';
import type { FoundPerson } from './keycloak/people.ts';

/**
 * `GET /api/people?email=<address>`: the suite person with this verified e-mail, for other suite applications only
 * (a service token with the role `people-reader` of di-identity; first user: DI Channels). 404 when there is no
 * single such person. The answer has `sub`, the display name and organizations; never the e-mail back or anything
 * else about the account.
 */
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

export function peopleRoutes(app: FastifyInstance, input: { verifier: Verifier; lookup: (email: string) => Promise<FoundPerson | null> }): void {
  app.get(
    '/api/people',
    { preHandler: [requireIdentity(input.verifier), requireService(), requireRole('people-reader')] },
    async (request, reply) => {
      const email = String((request.query as Record<string, unknown>).email ?? '').trim().toLowerCase();
      if (!EMAIL.test(email)) return reply.code(400).send({ error: 'email is required' });
      const person = await input.lookup(email);
      if (!person) return reply.code(404).send({ error: 'no single person with this verified e-mail' });
      return person;
    },
  );
}
