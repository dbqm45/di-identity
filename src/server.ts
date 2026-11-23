import { readFileSync } from 'node:fs';
import { buildApp } from './app.ts';
import { createVerifier, discoveryJwks } from './auth/oidc.ts';
import { loadConfig } from './config.ts';
import { createPool } from './db/pool.ts';
import { runMigrations } from './db/migrate.ts';
import { loadVocabulary } from './events/envelope.ts';
import { postgresEventStore } from './events/store.ts';
import { keycloakServiceAdmin } from './keycloak/admin.ts';
import { lookupByEmail } from './keycloak/people.ts';
import { peopleRoutes } from './people-api.ts';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const config = loadConfig(process.env, version);
const pool = createPool(config);
await runMigrations(pool);

const verifier = createVerifier({
  issuer: config.oidcIssuer,
  audience: config.oidcAudience,
  authorizedParties: config.oidcAuthorizedParties,
  serviceClients: config.oidcServiceClients,
  fetchJwks: discoveryJwks(config.oidcIssuer),
});
const app = buildApp({
  version,
  verifier,
  eventsSecret: config.eventsSecret,
  vocabulary: loadVocabulary(),
  events: postgresEventStore(pool),
  checkDatabase: async () => {
    await pool.query('SELECT 1');
  },
  logger: true,
});

// The people lookup for other suite applications (DI Channels), with the di-identity service account. Off until its
// secret is set: KEYCLOAK_URL (internal) and DI_IDENTITY_CLIENT_SECRET (client di-identity in the suite realm), or
// SUITE_CLIENT_SECRET_DI_IDENTITY as `npm run identity -- secrets --env-file .env` writes it.
const keycloakUrl = process.env.KEYCLOAK_URL?.trim();
const clientSecret = process.env.DI_IDENTITY_CLIENT_SECRET?.trim() || process.env.SUITE_CLIENT_SECRET_DI_IDENTITY?.trim();
if (keycloakUrl && clientSecret) {
  const admin = keycloakServiceAdmin({ url: keycloakUrl, realm: 'suite', clientId: config.oidcAudience, clientSecret });
  peopleRoutes(app, { verifier, lookup: (email) => lookupByEmail(admin, 'suite', email) });
} else {
  app.log.warn('people lookup is off: set KEYCLOAK_URL and DI_IDENTITY_CLIENT_SECRET (or run: npm run identity -- secrets --env-file .env)');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => pool.end());
  });
}

await app.listen({ port: config.port, host: config.host });
