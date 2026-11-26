import { readFileSync } from 'node:fs';
import { buildApp } from './app.ts';
import { createVerifier, discoveryJwks } from './auth/oidc.ts';
import { loadConfig } from './config.ts';
import { createPool } from './db/pool.ts';
import { runMigrations } from './db/migrate.ts';
import { loadVocabulary } from './events/envelope.ts';
import { postgresEventStore } from './events/store.ts';
import { keycloakServiceAdmin } from './keycloak/admin.ts';
import { lookupByEmail, lookupBySub } from './keycloak/people.ts';
import { peopleRoutes } from './people-api.ts';
import { adminRoutes } from './admin/routes.ts';
import { keycloakDirectory } from './admin/directory.ts';
import { discoverIssuer } from './admin/discovery.ts';
import { postgresAdminStore } from './admin/store.ts';
import { loadSuite } from './keycloak/configure.ts';

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
  // E-mails only for applications that may know them (DI3): the clients with `email: true` in keycloak/suite.json.
  const emailClients = loadSuite().clients.filter((c) => c.email).map((c) => c.clientId);
  peopleRoutes(app, {
    verifier,
    lookup: (email) => lookupByEmail(admin, 'suite', email),
    lookupSub: (sub) => lookupBySub(admin, 'suite', sub),
    emailClients,
  });
} else {
  app.log.warn('people lookup is off: set KEYCLOAK_URL and DI_IDENTITY_CLIENT_SECRET (or run: npm run identity -- secrets --env-file .env)');
}

// The admin console, stage AC1 (docs/plan-admin-console.md): sign-in with the di-admin client, changes with the
// di-identity service account. Off until both secrets are set (`npm run identity -- secrets --env-file .env` writes them)
// and the realm has the redirect address REDIRECT_DI_ADMIN=<ADMIN_PUBLIC_URL>/* (configure).
const adminSecret = process.env.ADMIN_CLIENT_SECRET?.trim() || process.env.SUITE_CLIENT_SECRET_DI_ADMIN?.trim();
if (keycloakUrl && clientSecret && adminSecret) {
  const suite = loadSuite();
  const products = Object.fromEntries(suite.clients.filter((c) => c.clientId !== 'di-identity').map((c) => [c.clientId, c.roles]));
  const service = keycloakServiceAdmin({ url: keycloakUrl, realm: suite.realm, clientId: config.oidcAudience, clientSecret });
  const publicUrl = process.env.ADMIN_PUBLIC_URL?.trim() || `http://127.0.0.1:${config.port}`;
  // A console on localhost is local mode: an organization's own provider may be a local Keycloak realm over http.
  const allowLocalProviders = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(publicUrl).hostname);
  adminRoutes(app, {
    issuer: config.oidcIssuer,
    clientId: 'di-admin',
    clientSecret: adminSecret,
    publicUrl,
    verifier: createVerifier({ issuer: config.oidcIssuer, audience: 'di-admin', fetchJwks: discoveryJwks(config.oidcIssuer) }),
    store: postgresAdminStore(pool),
    directory: keycloakDirectory(service, suite.realm, products, (issuer) => discoverIssuer(issuer, { allowLocal: allowLocalProviders })),
    products,
    allowLocalProviders,
  });
  app.log.info(`admin console: ${publicUrl}/admin`);
} else {
  app.log.warn('admin console is off: set KEYCLOAK_URL, the di-identity secret and ADMIN_CLIENT_SECRET (or SUITE_CLIENT_SECRET_DI_ADMIN)');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => pool.end());
  });
}

await app.listen({ port: config.port, host: config.host });
