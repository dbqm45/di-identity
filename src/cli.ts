/**
 * Administration of the suite realm until Admin Console (AC1) exists. Runs on the host next to Keycloak, against its
 * internal address; the admin API is not public.
 *
 *   npm run identity -- configure
 *   npm run identity -- org create <alias> "<name>" [<domain>]
 *   npm run identity -- agent create <persona> --org <alias> --owner <sub> --purpose "<text>" --key <public.jwk.json> [--role di-decision:viewer ...]
 *   npm run identity -- agent list --org <alias>
 *   npm run identity -- agent disable <client-id> | agent enable <client-id>
 *   npm run identity -- agent disable-all --org <alias>          # kill switch of the organization (AN6)
 *
 * Environment: KEYCLOAK_URL (internal, e.g. http://keycloak:8080), KEYCLOAK_ADMIN_USERNAME, KEYCLOAK_ADMIN_PASSWORD;
 * for configure also GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and REDIRECT_<CLIENT_ID> (see .env.example).
 */
import { readFileSync } from 'node:fs';
import { keycloakAdmin } from './keycloak/admin.ts';
import { createAgent, createOrganization, disableOrganizationAgents, listAgents, setAgentEnabled } from './keycloak/agents.ts';
import { configure, loadSuite } from './keycloak/configure.ts';

const need = (name: string): string => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

function options(args: string[]): { positional: string[]; flags: Map<string, string[]> } {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a.startsWith('--')) {
      const value = args[++i];
      if (value === undefined) throw new Error(`${a} needs a value`);
      flags.set(a.slice(2), [...(flags.get(a.slice(2)) ?? []), value]);
    } else positional.push(a);
  }
  return { positional, flags };
}

async function main(argv: string[]): Promise<void> {
  const suite = loadSuite();
  const admin = keycloakAdmin({ url: need('KEYCLOAK_URL'), username: need('KEYCLOAK_ADMIN_USERNAME'), password: need('KEYCLOAK_ADMIN_PASSWORD') });
  const [area, action, ...rest] = argv;
  const { positional, flags } = options(rest);
  const flag = (name: string): string => {
    const v = flags.get(name)?.[0];
    if (!v) throw new Error(`--${name} is required`);
    return v;
  };

  if (area === 'configure') {
    await configure(admin, suite, process.env, (line) => console.log(`✓ ${line}`));
    return;
  }
  if (area === 'org' && action === 'create') {
    const [alias, name, domain] = positional;
    if (!alias || !name) throw new Error('usage: org create <alias> "<name>" [<domain>]');
    await createOrganization(admin, { realm: suite.realm, alias, name, ...(domain ? { domain } : {}) });
    console.log(`✓ organization ${alias} created`);
    return;
  }
  if (area === 'agent' && action === 'create') {
    const [persona] = positional;
    if (!persona) throw new Error('usage: agent create <persona> --org … --owner … --purpose … --key …');
    const agent = await createAgent(admin, {
      realm: suite.realm,
      persona,
      organization: flag('org'),
      owner: flag('owner'),
      purpose: flag('purpose'),
      publicJwk: JSON.parse(readFileSync(flag('key'), 'utf8')),
      roles: flags.get('role') ?? [],
      tokenSeconds: suite.agentTokenSeconds,
    });
    console.log(`✓ agent ${agent.clientId} created (sub ${agent.sub}, review by ${agent.reviewBy})`);
    return;
  }
  if (area === 'agent' && action === 'list') {
    for (const a of await listAgents(admin, suite.realm, flag('org'))) {
      console.log(`${a.enabled ? 'on ' : 'off'}  ${a.clientId}  owner ${a.owner}  review by ${a.reviewBy}`);
    }
    return;
  }
  if (area === 'agent' && (action === 'disable' || action === 'enable')) {
    const [clientId] = positional;
    if (!clientId) throw new Error(`usage: agent ${action} <client-id>`);
    await setAgentEnabled(admin, suite.realm, clientId, action === 'enable');
    console.log(`✓ agent ${clientId} ${action}d`);
    return;
  }
  if (area === 'agent' && action === 'disable-all') {
    const off = await disableOrganizationAgents(admin, suite.realm, flag('org'));
    console.log(off.length ? `✓ turned off: ${off.join(', ')}` : '✓ no agent was on');
    return;
  }
  throw new Error('unknown command; see the top of src/cli.ts');
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(`✗ ${(err as Error).message}`);
  process.exitCode = 1;
});
