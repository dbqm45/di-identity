import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';
import { createVerifier } from '../src/auth/oidc.ts';
import { loadVocabulary } from '../src/events/envelope.ts';
import { memoryEventStore } from '../src/events/store.ts';
import type { FoundPerson, PersonWithEmail } from '../src/keycloak/people.ts';
import { peopleRoutes } from '../src/people-api.ts';
import { AUDIENCE, ISSUER, JWKS, SECRET, agentToken, serviceToken, token } from './helpers.ts';

const SUB = '4d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1a';
const OLA: PersonWithEmail = { sub: SUB, name: 'Ola Nowak', email: 'ola@acme.test', organizations: ['acme'] };

const setup = (over: { emailClients?: string[] } = {}) => {
  const verifier = createVerifier({ issuer: ISSUER, audience: AUDIENCE, serviceClients: ['di-channels', 'di-definition'], fetchJwks: async () => JWKS });
  const app = buildApp({ version: 't', verifier, eventsSecret: SECRET, vocabulary: loadVocabulary(), events: memoryEventStore(), checkDatabase: async () => {} });
  const asked: string[] = [];
  peopleRoutes(app, {
    verifier,
    lookup: async (): Promise<FoundPerson | null> => null,
    lookupSub: async (sub) => {
      asked.push(sub);
      return sub === SUB ? OLA : null;
    },
    emailClients: over.emailClients ?? ['di-channels'],
  });
  return { app, asked };
};

const reader = (client = 'di-channels') => serviceToken(client);

test('GET /api/people/<sub> gives the person with the verified e-mail to an application that may know e-mails', async () => {
  const { app } = setup();
  const res = await app.inject({ url: `/api/people/${SUB}`, headers: { authorization: `Bearer ${reader()}` } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), OLA);
  const none = await app.inject({ url: '/api/people/00000000-0000-4000-8000-000000000000', headers: { authorization: `Bearer ${reader()}` } });
  assert.equal(none.statusCode, 404);
});

test('GET /api/people/<sub> refuses applications without e-mail (DI3), people, agents and a bad sub', async () => {
  const { app, asked } = setup();
  const noEmail = await app.inject({ url: `/api/people/${SUB}`, headers: { authorization: `Bearer ${reader('di-definition')}` } });
  assert.equal(noEmail.statusCode, 403);
  const noRole = await app.inject({ url: `/api/people/${SUB}`, headers: { authorization: `Bearer ${serviceToken('di-channels', { resource_access: { [AUDIENCE]: { roles: [] } } })}` } });
  assert.equal(noRole.statusCode, 403);
  const person = await app.inject({ url: `/api/people/${SUB}`, headers: { authorization: `Bearer ${token({ resource_access: { [AUDIENCE]: { roles: ['people-reader'] } } })}` } });
  assert.equal(person.statusCode, 403);
  const agent = await app.inject({ url: `/api/people/${SUB}`, headers: { authorization: `Bearer ${agentToken({ resource_access: { [AUDIENCE]: { roles: ['people-reader'] } } })}` } });
  assert.equal(agent.statusCode, 403);
  const bad = await app.inject({ url: '/api/people/ola', headers: { authorization: `Bearer ${reader()}` } });
  assert.equal(bad.statusCode, 400);
  assert.equal((await app.inject({ url: `/api/people/${SUB}` })).statusCode, 401);
  assert.deepEqual(asked, [], 'no lookup for a refused call');
});

test('GET /api/people?email= still answers without the e-mail back', async () => {
  const { app } = setup();
  const res = await app.inject({ url: '/api/people?email=nobody@acme.test', headers: { authorization: `Bearer ${reader('di-definition')}` } });
  assert.equal(res.statusCode, 404);
});
